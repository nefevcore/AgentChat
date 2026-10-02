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

export { createBridgeCatalog, type BridgeEvent, type BridgeCatalog, type CatalogDeps } from './bridge-events.ts';

/** llm/delta 线帧的 input 投影（瘦身：剥 messages/tools 等全量上下文） */
export function wireLlmInput(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const { model, meta } = input as { model?: unknown; meta?: unknown };
  return { model, meta };
}

/** 高频流事件微批合帧词汇（传输层自有，不进事件目录） */
export const LLM_DELTA_BATCH = 'llm/delta-batch';

/** 通用下行批帧词汇（cr-112：单批器漏斗——全事件帧合批发送） */
export const WIRE_EVENT_BATCH = 'wire/event-batch';

/**
 * 必须原生直发（不进批窗）的事件类前缀（cr-112）：
 * 交互卡投递延迟 = 用户可感知的卡顿（ask_questions 弹窗、审批卡）；close/reply
 * 类帧若压批窗尾，批帧乱序到达会短暂复活已移除的卡片。这些帧量级稀少
 * （每 run 至多条），直发不构成速率面。
 */
const DIRECT_EVENT_PREFIXES = ['durable-interaction/', 'ws/', 'remote/', 'system/'];

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
 * 单批器漏斗（cr-112）：远程链路全部下行帧的唯一出口。
 *
 * 结构动机：事件帧曾逐帧直发（只有 delta 合批），供给速率无界——流式期
 * 工具事件突发叠加 delta 批帧，轻易越过 relay 帧速率闸（30/s），超速即静默
 * close → 断链重连风暴。修法不是抬闸，是让供给成为自律属性：一切帧过同一
 * 漏斗，窗口到点合为单帧（wire/event-batch）发送——稳态供给 ≤ 1/窗口。
 *
 * 与 LlmDeltaBatcher 的分工：那是 delta 家族的投影+合批词汇层（帧形
 * llm/delta-batch 与前端解包契约在两链路共享）；本类是 remote 链路的
 * 排队+合批出口，把「每秒发多少帧」从到达率解耦为窗口常量。
 *
 * 交互类帧（DIRECT_EVENT_PREFIXES）原生直发不进窗：投递延迟即用户可感
 * 卡顿，且量级稀少不构成速率面。
 */
export class WireBatcher {
  private queue: Array<{ type: string; data: { args: unknown[] } }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly send: (frame: { type: string; data: { args: unknown[] } }) => void;
  private readonly windowMs: number;

  constructor(
    send: (frame: { type: string; data: { args: unknown[] } }) => void,
    windowMs: number = 100,
  ) {
    this.send = send;
    this.windowMs = windowMs;
  }

  /** 入队一帧（delta 家族之外的通用事件帧）；交互类直发。 */
  push(type: string, args: unknown[]): void {
    if (DIRECT_EVENT_PREFIXES.some((p) => type.startsWith(p))) {
      this.flushNow();
      this.send({ type, data: { args } });
      return;
    }
    this.queue.push({ type, data: { args } });
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.fire();
      }, this.windowMs);
    }
  }

  /** 清空在途队列（行卸载/直发帧前——保序：直发帧不得早于在途帧到达） */
  flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.fire();
  }

  private fire(): void {
    if (this.queue.length === 0) return;
    const events = this.queue;
    this.queue = [];
    this.send({ type: WIRE_EVENT_BATCH, data: { args: [events] } });
  }
}

/**
 * 批帧解包（前端 wire 入口消费）：批帧词汇展开为 [type, args] 序列，其余帧
 * 原样返回。旧后端无批帧 = 行为不变（兼容词汇两代并存）。
 */
export function unpackWireFrames(
  type: string,
  args: unknown[],
): Array<[string, unknown[]]> {
  if (type === LLM_DELTA_BATCH) {
    const first = args[0] as { deltas?: unknown } | undefined;
    const deltas = first && typeof first === 'object' && Array.isArray(first.deltas) ? first.deltas : [];
    return (deltas as unknown[][]).map((d) => ['llm/delta', d]);
  }
  if (type === WIRE_EVENT_BATCH) {
    const first = args[0] as unknown[] | undefined;
    if (!Array.isArray(first)) return [];
    return first.map((e) => {
      const ev = e as { type?: unknown; data?: { args?: unknown } } | null;
      return [
        typeof ev?.type === 'string' ? ev.type : '',
        ev && Array.isArray(ev.data?.args) ? ev.data.args as unknown[] : [],
      ] as [string, unknown[]];
    });
  }
  return [[type, args]];
}