// ============================================================
// ac-wire-format —— 下行线格式纯库（零 cordis 依赖；cr-85）
//
// 问题：llm/delta 事件载荷的 input 携带完整 messages（长会话 MB 级），
// 且以 SSE chunk 频率逐帧发射。两条下行链路曾各自为政：
//   · ws-bridge：2026-09-05 OOM 事故后建了私有瘦身投影（wireLlmInput）
//     ——但没有合批；
//   · remote-link：{args} 原样转发——既无瘦身也无合批，MB 级载荷逐帧
//     过公网（手机端流式逐字卡顿的根因）。
// 本库是两条链路的**同源线格式层**：
//   · wireLlmInput：帧面只保留前端实际消费的 {model, meta}（语义自
//     ws-bridge 私有实现提升并源，进程内事件契约不变）；
//   · LlmDeltaBatcher：30ms 微批攒 llm/delta 帧——帧量降一个数量级，
//     慢消费端（WAN/移动网络）不再逐帧摊 RTT。
// ============================================================

/** llm/delta 线帧的 input 投影（瘦身：剥 messages/tools 等全量上下文） */
export function wireLlmInput(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const { model, meta } = input as { model?: unknown; meta?: unknown };
  return { model, meta };
}

/** 高频流事件微批合帧词汇（传输层自有，不进事件目录） */
export const LLM_DELTA_BATCH = 'llm/delta-batch';

interface BatchedArgs {
  /** 每元素 = 一次 llm/delta 的参数序 [input(已投影), chunk, meta] */
  deltas: unknown[][];
}

type FlushFn = (args: BatchedArgs) => void;

/**
 * llm/delta 微批攒帧器（30ms 窗口）。
 *
 * 语义：push 进来的 (input, chunk, meta) 先投影瘦身再入队；窗口到点或
 * flush() 显式调用（delta-end 边界/行卸载）即整队以单帧
 * {type:'llm/delta-batch', data:{args:[{deltas:[...]}]}} 下发。窗口内首帧
 * 立即发（保首字延迟），其后帧进窗口——流式起步不因合批变慢。
 */
export class LlmDeltaBatcher {
  private queue: unknown[][] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  // 参数属性是 Node strip-only 加载器红线（显式字段赋值）
  private readonly flush: FlushFn;
  private readonly windowMs: number;

  constructor(flush: FlushFn, windowMs: number = 30) {
    this.flush = flush;
    this.windowMs = windowMs;
  }

  /** 入队一帧 delta（input 自动投影）。首帧立即下发，其后攒窗口。 */
  push(input: unknown, chunk: unknown, meta: unknown): void {
    this.queue.push([wireLlmInput(input), chunk, meta]);
    if (this.timer === null && this.queue.length === 1) {
      // 窗口首帧立即发：流式起步延迟为零；窗口内的后续帧与它同帧下发
      this.fire();
      this.timer = setTimeout(() => {
        this.timer = null;
        this.fire();
      }, this.windowMs);
    }
  }

  /** 边界/卸载时清空在途队列（delta-end 到达前不丢帧） */
  flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.fire();
  }

  private fire(): void {
    if (this.queue.length === 0) return;
    const deltas = this.queue;
    this.queue = [];
    this.flush({ deltas });
  }
}

/**
 * 批帧解包（前端 wire 入口消费）：type 为 LLM_DELTA_BATCH 时展开为
 * [type, args] 序列，其余帧原样返回。旧后端无批帧 = 行为不变。
 */
export function unpackWireFrames(
  type: string,
  args: unknown[],
): Array<[string, unknown[]]> {
  if (type !== LLM_DELTA_BATCH) return [[type, args]];
  const first = args[0] as { deltas?: unknown } | undefined;
  const deltas = first && typeof first === 'object' && Array.isArray(first.deltas) ? first.deltas : [];
  return (deltas as unknown[][]).map((d) => ['llm/delta', d]);
}