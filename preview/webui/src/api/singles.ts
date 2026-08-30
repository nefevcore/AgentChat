// ============================================================
// api/singles.ts —— 独立会话 Port B（阶段二第四梯）
//
// singles/list·create·update·archive·delete RPC 直连。sid 集合同步
// 登记 chatPresence.knownSingles（A/B 并存桥——WS 侧 dialogId 合成
// [single~sid 判别]依赖该集合；适配器退役时集合随聊天模块收编）。
// src DELETE 语义（无 purge=归档 / purge=1 硬删）在此分派。
// ============================================================

import { wireRpc } from './wire.ts';
import { chatPresence } from './chat-ops';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

/** 独立会话元数据（= preview SingleSessionMeta） */
export interface SingleSession {
  id: string;
  agentId: string;
  model?: string | Record<string, unknown>;
  title?: string;
  /** 所属用户工作区（workspaceId 引用；缺省/空 = 未分组） */
  workspaceId?: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  lastActivity?: string;
}

function track(meta: Record<string, unknown> | undefined, removed = false): void {
  if (meta && typeof meta.id === 'string') {
    if (removed) chatPresence.knownSingles.delete(meta.id);
    else chatPresence.knownSingles.add(meta.id);
  }
}

export async function fetchSingles(rpc: Rpc = wireRpc): Promise<{ singles: SingleSession[] }> {
  const r = await rpc.call<{ singles?: SingleSession[] }>('singles/list');
  for (const s of r.singles ?? []) track(s as unknown as Record<string, unknown>);
  return { singles: r.singles ?? [] };
}

export async function createSingle(
  payload: {
    agentId?: string;
    model?: string | Record<string, unknown>;
    title?: string;
    workspaceId?: string;
    /** true = 已存在空会话时复用（不重复建空白条目） */
    reuse?: boolean;
  },
  rpc: Rpc = wireRpc,
): Promise<{ session: SingleSession; reused?: boolean }> {
  const r = await rpc.call<{ single?: SingleSession; reused?: boolean }>('singles/create', {
    ...(payload.agentId ? { agentId: payload.agentId } : {}),
    ...(payload.model !== undefined ? { model: payload.model } : {}),
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
    ...(payload.reuse === true ? { reuse: true } : {}),
  });
  track(r.single as unknown as Record<string, unknown>);
  return { session: r.single as SingleSession, ...(r.reused ? { reused: r.reused } : {}) };
}

/** 更新会话设置（agentId ''=清空待选[已有消息时后端拒绝]；model null=清除覆盖；workspaceId ''=未分组） */
export async function updateSingle(
  id: string,
  payload: { agentId?: string; model?: string | Record<string, unknown> | null; title?: string; workspaceId?: string },
  rpc: Rpc = wireRpc,
): Promise<{ session: SingleSession }> {
  const r = await rpc.call<{ single?: SingleSession }>('singles/update', {
    id,
    ...(payload.agentId !== undefined ? { agentId: payload.agentId } : {}),
    ...(payload.model !== undefined ? { model: payload.model } : {}),
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.workspaceId !== undefined ? { workspaceId: payload.workspaceId } : {}),
  });
  track(r.single as unknown as Record<string, unknown>);
  return { session: r.single as SingleSession };
}

/** 归档（软删，消息保留）——src DELETE（无 purge）语义 */
export async function archiveSingle(id: string, rpc: Rpc = wireRpc): Promise<{ session: SingleSession }> {
  const r = await rpc.call<{ single?: SingleSession }>('singles/archive', { id });
  return { session: r.single as SingleSession };
}

/** 删除（硬删：元数据 + 消息记录，不可恢复）——src DELETE?purge=1 语义 */
export async function deleteSingle(id: string, rpc: Rpc = wireRpc): Promise<{ deleted: boolean }> {
  await rpc.call('singles/delete', { id });
  chatPresence.knownSingles.delete(id);
  return { deleted: true };
}
