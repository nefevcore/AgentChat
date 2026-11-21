// ============================================================
// stream.ts —— B3 流式旁带帧（协议规格 B3，2026-10-15 定向 R7-3）
//
// run 进行中的流式 token 帧 = ipc 连接上的瞬态旁带，非信封：无 uuid /
// requestId / budget 语义（不幂等、不确认、不入发件箱——outbox 转投
// 半截流是重复播放，比丢弃更糟；正确语义 = 壳死即丢，客户端从账本
// 收束态对齐——账本兜底本来就在）。生命周期 = run 生命周期；路由 =
// 经宿主转发至 webui（单安全边界 + 连接风暴吸收，〈webui 读投影〉）。
// ============================================================

/** 旁带流标识（同一 ipc 连接可并发多流——路由键 = agent + 流 id） */
export type StreamId = string;

import * as crypto from 'node:crypto';

/** B3 帧（瞬态——JSON 载荷走 frame.ts 长度前缀帧，帧层不辨语义） */
export type StreamFrame =
  | {
    stream: StreamId; kind: 'delta'; text: string; meta?: StreamMeta;
    /** 思考分片直播（cr-586：思考模型思考期全 reasoning 零正文——不帧化
     * 则前端整个思考期静默。主线 llm/delta chunk.reasoning 同词汇）。 */
    reasoning?: string;
    /** 工具调用分片直播（cr-586：同 chunk.toolCalls——前端 preparing 卡）。 */
    toolCalls?: unknown[];
  }
  | { stream: StreamId; kind: 'end'; finish: 'ok' | 'interrupted' | 'error'; meta?: StreamMeta }
  /** run 启动通知（cr-592）：宿主桥接成主线 loop/run-started 前端帧
   * （前端 run 级忙态点亮 + run 计时锚重置）。stream = runId。 */
  | { stream: StreamId; kind: 'run-started'; meta?: StreamMeta }
  /** 工具执行通知（cr-593）：主线 tool/started / tool/progress 直转——
   * 前端工具卡的执行期直播（run_code 子调用占位 / 长任务进度）。call =
   * 主线 ToolCall 透传（路由身份全在 call 上）；stream = toolCallId ??
   * runId。终值不走本族——durable 事实经 ledger-event 的
   * step/tool-call-result 行投影（tool/result 前端帧）。 */
  | { stream: StreamId; kind: 'tool-started'; call: unknown; meta?: StreamMeta }
  | { stream: StreamId; kind: 'tool-progress'; call: unknown; chunk: string; meta?: StreamMeta }
  /** 事件日志追加通知（cr-976 B 案，D3-2 壳 ipc 事件面）：rows = 单个
   * 串行队列切片内追加到 messages.jsonl 的行全集（含 seq，fsync 后发射）。
   * 宿主投影转发层据此产出步级/工具/收束前端帧（帧 = 事件的视图，
   * 收敛信号 = type:'run-end' 行——与 durable 落盘同一因果，E-2 根治）。
   * stream = 首个带 run 键行的 run ?? conversationId（路由用，无语义）。 */
  | { stream: StreamId; kind: 'ledger-event'; rows: Array<Record<string, unknown>>; meta?: StreamMeta }
  /** 队列快照推送（cr-579）：壳 ConversationMachine 队列变更点发射、宿主
   * 桥接成主线 conversation/queue-changed 前端帧（权威全量快照直接套用）。
   * stream = conversationId（路由键）；handle = 桶句柄；items = 快照行。 */
  | { stream: StreamId; kind: 'queue-changed'; handle: string; items: QueuedItemFrame[]; meta?: StreamMeta }
  /** 持久化交互通知（cr-625）：主线 durable-interaction/{opened,replied,closed}
   * 事件旁带——前端 ask_questions 弹窗 / 审批卡 live 消费该三帧（主线
   * chat-core 既有 case）；缺席 = Agent 发起提问后前端零直播，交互卡只能
   * 刷新经 interaction/list 恢复路径出现。stream = interaction id；
   * record = 主线 DurableInteraction 记录原样透传（wire 整形住宿主桥接）。 */
  | { stream: StreamId; kind: 'interaction-opened'; record: unknown; meta?: StreamMeta }
  | { stream: StreamId; kind: 'interaction-replied'; record: unknown; meta?: StreamMeta }
  | { stream: StreamId; kind: 'interaction-closed'; record: unknown; meta?: StreamMeta }
  /** 上下文注入通知（cr-625）：主线 session/context-injected 事件旁带——
   * 前端流式运行期注入可见性（feed 事件分隔行：已收到用户回答/技能加载
   * 等 label 直出）。stream = conversationId；宿主直转主线同名帧。 */
  | { stream: StreamId; kind: 'context-injected'; source: string; label?: string; injectionId?: string; meta?: StreamMeta }
  /** 后台任务通知（cr-677）：主线 job/started · job/settled 事件旁带——
   * 前端 jobBoard（运行跟踪面板后台任务区/会话头 chip）帧驱动刷新唯一源。
   * stream = job id；job = 主线 JobSnapshot 透传（meta 预览化住宿主面）。 */
  | { stream: StreamId; kind: 'job-event'; phase: 'started' | 'settled'; job: unknown; meta?: StreamMeta }
  /** 子Agent 清单变更通知（cr-677）：主线 subagents/updated 事件旁带——
   * 前端 subagentBoard（运行跟踪面板子Agent 区）帧驱动刷新唯一源。
   * stream = 子 Agent id；info = 变更后投影（list 口径）；action = 变更词。 */
  | { stream: StreamId; kind: 'subagents-updated'; info: unknown; action: string; meta?: StreamMeta }
  /** 低频机制事件直通（cr-1188）：壳 cordis 事件（archive/completed 等）帧化
   * 上行，宿主直转同名前端帧（args = [payload] 单参）。stream = conversationId
   *（路由键）；name = 事件名；payload 原样透传。 */
  | { stream: StreamId; kind: 'event'; name: string; payload: unknown; meta?: StreamMeta };

/** 队列快照行（主线 ConversationQueuedItem 同形——前端 useQueuedMessages 直接套用） */
export interface QueuedItemFrame {
  id: string;
  preview: string;
  sender: string;
  source: string;
  queuedAt: number;
}

/**
 * 流路由 meta（additive，8.5d）：前端流式帧按 agent/conversationId/stepId
 * 寻址会话与步载体——旁带帧携带 llm meta 子集即可路由。路由寻址非信封
 * 语义（不参与幂等/确认——B3 语义不变）。
 */
export interface StreamMeta {
  agent?: string;
  conversationId?: string;
  sender?: string;
  source?: string;
  runId?: string;
  stepId?: string;
  /** run 机制旗标透传（cr-1188）：run-started 帧携带 LoopRunRequest.meta 全程——
   * archive-review 等标记；前端 archive-review 判定等消费面据此路由。此前
   * 在宿主桥接段丢失（run meta 丢弃 = 判定恒 false）。 */
  runMeta?: Record<string, unknown>;
}

/**
 * llm/delta 事件参数 → 旁带帧序列（壳发射面纯函数，8.5d）：
 * delta 增量（含 reasoning / toolCalls 分片——cr-586 思考与工具直播）与
 * finish 收束同流发射；stepId 缺席（无身份贯通 meta）、空帧（全分片空）
 * 或无分片只有 finish 时不出 delta 帧。finish 词汇映射：stop→ok、
 * error→error、其余（length 等）→interrupted。
 */
export function streamFrameFromDelta(
  meta: StreamMeta | undefined,
  chunk: { delta?: string; reasoning?: string; toolCalls?: unknown[]; finish?: string },
): StreamFrame[] {
  const stream = meta?.stepId ?? meta?.runId;
  if (stream === undefined) return [];
  const out: StreamFrame[] = [];
  const hasDelta = typeof chunk.delta === 'string' && chunk.delta !== '';
  const hasReasoning = typeof chunk.reasoning === 'string' && chunk.reasoning !== '';
  const hasToolCalls = Array.isArray(chunk.toolCalls) && chunk.toolCalls.length > 0;
  if (hasDelta || hasReasoning || hasToolCalls) {
    out.push({
      stream,
      kind: 'delta',
      text: hasDelta ? chunk.delta! : '',
      ...(hasReasoning ? { reasoning: chunk.reasoning } : {}),
      ...(hasToolCalls ? { toolCalls: chunk.toolCalls } : {}),
      ...(meta !== undefined ? { meta } : {}),
    });
  }
  if (chunk.finish !== undefined) {
    out.push({
      stream,
      kind: 'end',
      finish: chunk.finish === 'error' ? 'error' : chunk.finish === 'stop' ? 'ok' : 'interrupted',
      ...(meta !== undefined ? { meta } : {}),
    });
  }
  return out;
}

/** 帧判别（读侧路由——非 StreamFrame 形态返回 null） */
export function isStreamFrame(payload: unknown): payload is StreamFrame {
  if (payload === null || typeof payload !== 'object') return false;
  const f = payload as { stream?: unknown; kind?: unknown };
  if (typeof f.stream !== 'string' || f.stream.length === 0) return false;
  if (f.kind === 'delta' && typeof (f as { text?: unknown }).text === 'string') return true;
  if (f.kind === 'end' && typeof (f as { finish?: unknown }).finish === 'string') return true;
  if (f.kind === 'run-started') return true;
  if (f.kind === 'tool-started' && 'call' in f) return true;
  if (f.kind === 'tool-progress' && typeof (f as { chunk?: unknown }).chunk === 'string') return true;
  if (f.kind === 'ledger-event' && Array.isArray((f as { rows?: unknown }).rows)
    && (f as { rows: unknown[] }).rows.length > 0) return true;
  if (f.kind === 'queue-changed' && typeof (f as { handle?: unknown }).handle === 'string'
    && Array.isArray((f as { items?: unknown }).items)) return true;
  if (f.kind === 'interaction-opened' && 'record' in f) return true;
  if (f.kind === 'interaction-replied' && 'record' in f) return true;
  if (f.kind === 'interaction-closed' && 'record' in f) return true;
  if (f.kind === 'context-injected' && typeof (f as { source?: unknown }).source === 'string') return true;
  if (f.kind === 'job-event' && ((f as { phase?: unknown }).phase === 'started' || (f as { phase?: unknown }).phase === 'settled') && 'job' in f) return true;
  if (f.kind === 'subagents-updated' && 'info' in f) return true;
  if (f.kind === 'event' && typeof (f as { name?: unknown }).name === 'string' && (f as { name: string }).name !== '') return true;
  return false;
}

/**
 * 流会话面：壳侧发射器（run 生命周期内累积 delta、收束发 end）。
 * 与信封半边正交——同一 ipc 连接上旁带帧与信封/ack 帧混走，读侧按
 * isStreamFrame 分流。
 */
export class StreamEmitter {
  private readonly send: (frame: StreamFrame) => void;
  private ended = false;

  constructor(send: (frame: StreamFrame) => void) {
    this.send = send;
  }

  /** delta 帧（run 进行中 token 增量） */
  delta(text: string): void {
    if (this.ended) return;
    this.send({ stream: this.streamId, kind: 'delta', text });
  }

  /** end 帧（run 收束——finish 与 settlement finish 同词汇） */
  end(finish: 'ok' | 'interrupted' | 'error'): void {
    if (this.ended) return;
    this.ended = true;
    this.send({ stream: this.streamId, kind: 'end', finish });
  }

  private readonly streamId: StreamId = crypto.randomUUID();
}
