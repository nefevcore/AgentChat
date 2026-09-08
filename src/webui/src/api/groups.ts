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
import {
  createGroup as pkgCreateGroup,
  updateGroup as pkgUpdateGroup,
  deleteGroup as pkgDeleteGroup,
  setGroupMemoryOwner as pkgSetGroupMemoryOwner,
} from 'ac-client-ui-conversation/client/groupApi.ts';

export type { GroupInfo } from 'ac-client-ui-group/client';
export { fetchGroups } from 'ac-client-ui-group/client';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

export function createGroup(
  payload: { name?: string; participants?: string[]; description?: string },
  rpc: Rpc = wireRpc,
): Promise<{ group?: { group_id?: string }; success?: boolean; error?: string }> {
  return pkgCreateGroup(payload, rpc);
}

/** 更新（改名 / 简介 / 成员差量）——owning =
 *  ac-client-ui-conversation/client/groupApi.ts（薄包装补 wireRpc 缺省） */
export function updateGroup(
  groupId: string,
  payload: Record<string, unknown>,
  rpc: Rpc = wireRpc,
): Promise<{ success?: boolean; error?: string }> {
  return pkgUpdateGroup(groupId, payload, rpc);
}

export function deleteGroup(groupId: string, rpc: Rpc = wireRpc): Promise<{ success?: boolean; error?: string }> {
  return pkgDeleteGroup(groupId, rpc);
}

/**
 * 群主（记忆属主）设定/解除（agentId 空 = 解除——后端 optStr 把空串归一
 * undefined；属主须为已注册 Agent 且群成员，退群自动解除。设定后全体
 * 成员共享注入属主那份群记忆，轮转升级为属主 LLM 整理）
 */
export function setGroupMemoryOwner(
  groupId: string,
  agentId: string,
  rpc: Rpc = wireRpc,
): Promise<{ success?: boolean; error?: string }> {
  return pkgSetGroupMemoryOwner(groupId, agentId, rpc);
}

/** 群组历史（薄包装维持旧签名——rpc 缺省 wireRpc） */
export const fetchGroupHistory = (
  groupId: string,
  offset = 0,
  limit = 50,
  rpc: Rpc = wireRpc,
) => pkgFetchGroupHistory(groupId, offset, limit, rpc);
