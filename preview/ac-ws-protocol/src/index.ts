// ============================================================
// ac-ws-protocol —— WebSocket 帧协议纯库（零 cordis 依赖）
//
// src 轨道 ws/protocol.ts 的 preview 形态（地图 §3.3）：
//   · 帧格式原样：{ type, data } JSON 单行；
//   · 词汇表收敛：src 的 18 类 chat.* 私有词汇**不再镜像**——出站业务帧
//     type = 事件名直转（`loop/after-step`、`group/message-posted`…），
//     机器可读事件目录即协议目录（sdk/protocol 跨端契约消解的推论）；
//   · 控制帧仅三种（本包固定词汇）：
//       rpc/call    入站：显式注册的 RPC 调用（弃 src 反射全量）
//       rpc/result  出站：RPC 应答（ok/result | error）
//       ws/ack      出站：投递回执（deduped / busy / parked）
//
// ack 语义（src WSHandler 的 preview 归位，地图 §2）：
//   · deduped —— 传输层幂等去重命中（同 requestId 短窗重发不重复投递；
//     src #53/#91 重连 flush 重复持久化事故的教训）
//   · busy    —— 会话忙，消息已进队列/注入（conversation outcome
//     steered/queued 的上报形态）
//   · parked  —— placement='next-run' 等待空闲停靠（outcome timeout 前
//     的中间态上报）
// ============================================================

/** 一个 WS 帧（业务帧 type = 事件名；控制帧见下方常量） */
export interface WsFrame {
  type: string;
  data?: unknown;
}

// ---- 控制帧词汇（传输层自有，不进事件目录） ----

export const RPC_CALL = 'rpc/call';
export const RPC_RESULT = 'rpc/result';
export const WS_ACK = 'ws/ack';
export const WS_READY = 'ws/ready';

/** rpc/call 载荷 */
export interface RpcCallPayload {
  method: string;
  /** 幂等键：同 method+requestId 短窗内重发 → deduped ack，不重复执行 */
  requestId: string;
  params?: unknown;
}

/** ws/ack 的回执种类 */
export type WsAckKind = 'deduped' | 'busy' | 'parked';

/** ws/ack 载荷（与 ac-web-server 的 ws/ack 事件载荷同形） */
export interface WsAckPayload {
  requestId: string;
  kind: WsAckKind;
  /** 附加上下文（如 busy 时 { queued: true, handle }） */
  info?: Record<string, unknown>;
}

// ---- 后台源判定（信封 source 拓扑词；string 而非 union——避免纯库反向依赖 loop 域） ----

/**
 * 后台会话判定：source='event'（timer/archive/restart/late-reply 等
 * 机制触发的信封拓扑类）。src isBackgroundRunSource 的 preview 收敛——
 * 前台 = user 直答与 agent 委托，后台 = event 触发的自主推理。
 * 边界事件（run-started/after-run）不过滤，src 同款语义。
 * M19：信封身份（sender=端点 id）与拓扑（source）分离后，本判定消费
 * source；参数名保留 sender 兼容既有调用面（值为拓扑词）。
 */
export function isBackgroundSender(sender: string | undefined): boolean {
  return sender === 'event';
}

// ---- 帧编解码 ----

/** 解析入站原始文本为帧；非法 JSON / 缺 type 返回 null（静默丢弃） */
export function parseFrame(raw: string): WsFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { type } = parsed as { type?: unknown };
  if (typeof type !== 'string' || type === '') return null;
  return { type, data: (parsed as { data?: unknown }).data ?? {} };
}

/** 构建出站帧文本 */
export function buildFrame(type: string, data?: unknown): string {
  return JSON.stringify({ type, data: data ?? {} });
}

/** rpc/call 载荷校验（缺 method/requestId → null） */
export function parseRpcCall(frame: WsFrame): RpcCallPayload | null {
  if (frame.type !== RPC_CALL) return null;
  const data = frame.data as Partial<RpcCallPayload> | undefined;
  if (typeof data?.method !== 'string' || data.method === '') return null;
  if (typeof data?.requestId !== 'string' || data.requestId === '') return null;
  return { method: data.method, requestId: data.requestId, params: data.params };
}
