// ============================================================
// api/groups.ts —— 群名册 Port B
//
// group/create·delete·rename·join·leave 直连。群清单读面
//（fetchGroups + GroupInfo 合成）已随 UI 行走迁
// ac-client-ui-group/client（M27.1——本模块 re-export 维持旧路径）；
// 成员差量（PATCH participants）经 group/list 取现值。
// M27.2-2：群历史（fetchGroupHistory + 本体展开）已随 conversation
// 件迁 ac-client-ui-conversation/client/historyApi.ts——薄包装维持
// 旧签名（rpc 缺省 wireRpc）。
// ============================================================

import { wireRpc } from './wire.ts';
import { fetchGroupHistory as pkgFetchGroupHistory } from 'ac-client-ui-conversation/client/historyApi.ts';

export type { GroupInfo } from 'ac-client-ui-group/client';
export { fetchGroups } from 'ac-client-ui-group/client';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

export async function createGroup(
  payload: { name?: string; participants?: string[]; description?: string },
  rpc: Rpc = wireRpc,
): Promise<{ group?: { group_id?: string }; success?: boolean; error?: string }> {
  const r = await rpc.call<{ group?: { id?: string } }>('group/create', {
    name: String(payload.name ?? '未命名群组'),
    ...(Array.isArray(payload.participants) ? { members: payload.participants.map(String) } : {}),
    ...(payload.description !== undefined ? { description: String(payload.description) } : {}),
  });
  return { group: { group_id: r.group?.id }, success: true };
}

/** 更新（改名 / 简介 / 成员差量：join/leave 逐个对账现成员表） */
export async function updateGroup(groupId: string, payload: Record<string, unknown>, rpc: Rpc = wireRpc): Promise<{ success?: boolean; error?: string }> {
  if (typeof payload.name === 'string' && payload.name) {
    await rpc.call('group/rename', { groupId, name: payload.name });
  }
  // 简介：string 即发送（空串 = 清空——后端 optStr 空→undefined；曾漏发
  // 致群聊抽屉改简介"本地回写成功、刷新即丢"）
  if (typeof payload.description === 'string') {
    await rpc.call('group/set-description', { groupId, description: payload.description });
  }
  if (Array.isArray(payload.participants)) {
    const next = payload.participants.map(String);
    const cur = await rpc.call<{ groups?: Array<{ id: string; members?: string[] }> }>('group/list');
    const current = cur.groups?.find((g) => g.id === groupId)?.members ?? [];
    for (const m of next) if (!current.includes(m)) await rpc.call('group/join', { groupId, agentId: m });
    for (const m of current) if (!next.includes(m)) await rpc.call('group/leave', { groupId, agentId: m });
  }
  return { success: true };
}

export async function deleteGroup(groupId: string, rpc: Rpc = wireRpc): Promise<{ success?: boolean; error?: string }> {
  await rpc.call('group/delete', { groupId });
  return { success: true };
}

/**
 * 群主（记忆属主）设定/解除（agentId 空 = 解除——后端 optStr 把空串归一
 * undefined；属主须为已注册 Agent 且群成员，退群自动解除。设定后全体
 * 成员共享注入属主那份群记忆，轮转升级为属主 LLM 整理）
 */
export async function setGroupMemoryOwner(
  groupId: string,
  agentId: string,
  rpc: Rpc = wireRpc,
): Promise<{ success?: boolean; error?: string }> {
  await rpc.call('group/set-memory-owner', { groupId, ...(agentId ? { memoryOwner: agentId } : {}) });
  return { success: true };
}

/** 群组历史（薄包装维持旧签名——rpc 缺省 wireRpc） */
export const fetchGroupHistory = (
  groupId: string,
  offset = 0,
  limit = 50,
  rpc: Rpc = wireRpc,
) => pkgFetchGroupHistory(groupId, offset, limit, rpc);
