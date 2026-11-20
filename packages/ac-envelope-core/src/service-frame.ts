// ============================================================
// service-frame.ts —— 服务帧通道（cr-1175 宿主服务通道批 1）
//
// 协议位：信封帧必含 uuid/kind，服务帧必含 svc——同口（邮局 socket）
// 不同形，与 manage 通道 ctrl 帧先例同构。服务通信是基础设施语义，
// 永不进可达表 / registry / outbox（D4：掐断劫持与自激链）。
// ============================================================

/** request 档（要回执）：期望对端回 ServiceAck（reqId 配对） */
export interface ServiceRequestFrame {
  svc: string;
  reqId: string;
  payload: unknown;
}

/** report 档（fire-and-forget 可丢）：单发即忘，无回执 */
export interface ServiceReportFrame {
  svc: string;
  payload: unknown;
}

export type ServiceFrame = ServiceRequestFrame | ServiceReportFrame;

/** request 档回执帧（对端 → 发送方） */
export type ServiceAck =
  | { reqId: string; ok: true; result?: unknown }
  | { reqId: string; ok: false; error: string };

/** 服务帧判定（协议位——svc 必为 string；reqId 可缺 = report 档） */
export function isServiceFrame(frame: unknown): frame is ServiceFrame {
  return typeof (frame as { svc?: unknown } | null)?.svc === 'string';
}

/** request 档判定 */
export function isServiceRequest(frame: unknown): frame is ServiceRequestFrame {
  return isServiceFrame(frame) && typeof (frame as { reqId?: unknown }).reqId === 'string';
}

/** 回执帧判定（svc 不带——回的是 reqId 配对面） */
export function isServiceAck(frame: unknown): frame is ServiceAck {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as { reqId?: unknown; ok?: unknown };
  return typeof f.reqId === 'string' && typeof f.ok === 'boolean';
}

/** 组装 request 帧 */
export function makeServiceRequest(svc: string, reqId: string, payload: unknown): ServiceRequestFrame {
  return { svc, reqId, payload };
}

/** 组装 report 帧 */
export function makeServiceReport(svc: string, payload: unknown): ServiceReportFrame {
  return { svc, payload };
}
