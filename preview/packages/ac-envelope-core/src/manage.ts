// ============================================================
// manage.ts —— 控制面 socket 帧（管理面往返：与拉起所有权解耦）
//
// 壳的控制面（admin / preview / bench / interrupt / tool）此前只经
// stdin/stdout——通道绑在「谁拉的壳」上：宿主换代后活壳（持
// activation.lock、父宿主已死）的管道已随旧宿主消失，控制帧只能靠
// 再 spawn 一只壳 → 单例锁必拒（boot 早退 code=1，用户面看到「壳进程
// 早退（code=1）——未达 boot.ready」）。本帧把同一个 control() 面开在壳
// 的 transportHint socket 上（帧层与信封/旁带同一条 ipc 连接，载荷语义
// 在此收口），因此控制点不依赖 spawn 所有权：
//
//   request  { manage: { id, frame } }
//   reply    { manage: { id, ok: true, value } }
//          | { manage: { id, ok: false, error } }
//
// id = 请求方自铸关联键（同一连接可并发；宿主按 id 谓词取自己的回执）。
// 控制面 vs 数据面：信封走 requestId/幂等/阅后即焚那套；manage 帧是管理
// 面往返，不入 AdmissionGate、不落账、不转投。
// ============================================================

/** 控制面请求帧（frame 载荷 = 壳 control() 的入参，词汇归壳侧） */
export interface ManageRequest {
  manage: { id: string; frame: Record<string, unknown> };
}

/** 控制面回执帧（ok:false 时 error = 壳侧抛错的 message） */
export interface ManageReply {
  manage: { id: string; ok: boolean; value?: unknown; error?: string };
}

export function makeManageRequest(id: string, frame: Record<string, unknown>): ManageRequest {
  return { manage: { id, frame } };
}

export function makeManageReply(id: string, outcome: { ok: true; value: unknown } | { ok: false; error: string }): ManageReply {
  return outcome.ok ? { manage: { id, ok: true, value: outcome.value } } : { manage: { id, ok: false, error: outcome.error } };
}

/** 请求帧判定（管理面 inbound 分流用） */
export function isManageRequest(payload: unknown): payload is ManageRequest {
  if (payload === null || typeof payload !== "object") return false;
  const manage = (payload as { manage?: unknown }).manage;
  if (manage === null || typeof manage !== "object") return false;
  const m = manage as { id?: unknown; frame?: unknown };
  return typeof m.id === "string" && m.id !== "" && m.frame !== null && typeof m.frame === "object";
}

/** 回执帧判定（按关联键取自己的回执——同连接并发安全） */
export function isManageReply(payload: unknown, id: string): payload is ManageReply {
  if (payload === null || typeof payload !== "object") return false;
  const manage = (payload as { manage?: unknown }).manage;
  if (manage === null || typeof manage !== "object") return false;
  const m = manage as { id?: unknown; ok?: unknown };
  return m.id === id && typeof m.ok === "boolean";
}
