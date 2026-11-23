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
//   probe 帧（cr-1255）：{ ctrl: 'probe' } —— activation 持有者探针（无副作
//   用只读，任何帧处理体不得上锁/长阻塞；探针语义归 lock.ts 裁决面）。
//   request  { manage: { id, frame } }
//   reply    { manage: { id, ok: true, value } }
//          | { manage: { id, ok: false, error } }
//
// id = 请求方自铸关联键（同一连接可并发；宿主按 id 谓词取自己的回执）。
// 控制面 vs 数据面：信封走 requestId/幂等/阅后即焚那套；manage 帧是管理
// 面往返，不入 AdmissionGate、不落账、不转投。
// ============================================================
import { IpcClient } from "./ipc.ts";

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

/**
 * manage 往返（每次独立连接——cr-656 缓存连接被换代带走的教训；cr-1128
 * 批 3b 自 apps/host/orchestrator 上移：控制面全量切 manage 通道后宿主
 * adopt 面与子壳拉起面（ac-shell-subagent）双端同语义单源）。
 * ok:false = 壳侧 control() 抛错（error 原样上抛）；超时 ms 到即弃。
 */
export async function manageRoundTrip(address: string, frame: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const client = new IpcClient();
  const id = "manage-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  await client.connect(address);
  try {
    // 内层 request 缺省 15s 超时与外层同拍传 ms（内层先到即内层语义——cr-1046）
    const reply = await Promise.race([
      client.request(makeManageRequest(id, frame), (f) => isManageReply(f, id)),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("manage 回执超时（" + timeoutMs + "ms）")), timeoutMs).unref();
      }),
    ]) as ManageReply;
    if (reply.manage.ok !== true) throw new Error(reply.manage.error ?? "manage 帧执行失败");
    return reply.manage.value;
  } finally {
    client.close();
  }
}
/**
 * activation 持有者能力探针（cr-1255——refused 的诊断定谳面）：connect transportHint
 * 发 probe 帧核对 bootId——应答 bootId 匹配 = 持有者真活（证真）；
 * connect 失败 / 超时 / 应答不匹配 = 内核裁决旧壳已亡（证死——pid 复用
 * 现场无关进程占 pid，socket 却无人应答）。返回判死凭据（证真返回 null）。
 */
export async function probeActivationHolder(holder: { transportHint: string; bootId: string; pid: number }, timeoutMs = 2_000): Promise<string | null> {
  const client = new IpcClient();
  try {
    await client.connect(holder.transportHint);
  } catch {
    return '探针无法连接 ' + holder.transportHint + '（pid ' + holder.pid + '）——旧壳 ipc 已亡';
  }
  try {
    const reply = await Promise.race([
      client.request(makeManageRequest('probe-activation', { ctrl: 'probe' }), (f) => isManageReply(f, 'probe-activation')),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('probe 超时（' + timeoutMs + 'ms）')), timeoutMs).unref();
      }),
    ]) as ManageReply;
    if (reply.manage.ok !== true) return '探针帧执行失败：' + reply.manage.error;
    const bootId = (reply.manage.value as { bootId?: unknown } | null)?.bootId;
    if (bootId !== holder.bootId) return '探针应答 bootId 不匹配（应答 ' + String(bootId) + ' ≠ 锁 ' + holder.bootId + '）';
    return null; // 证真——pid 与 socket 同属一代，持有者活
  } catch (err: unknown) {
    return '探针无应答：' + (err instanceof Error ? err.message : String(err));
  } finally {
    client.close();
  }
}

