// ============================================================
// ac-client-ui-conversation/client/groupApi.ts —— 群写侧数据面
//（M27.2-2 conversation 视图半边随件迁：GroupDrawer/DialogView 的
// 消费子集——群改名/简介/成员差量/删除/记忆属主）
//
// rpc 必传（RpcClientFace 契约面）；webui api/groups.ts 薄包装补
// wireRpc 缺省维持旧路径（createGroup 消费面 = CreateGroupDialog
// 随 layout 件走）。群清单读面归 ac-client-ui-group/client。
// ============================================================
import type { RpcClientFace } from 'ac-client-runtime';

type Rpc = Pick<RpcClientFace, 'call'>;

/** 创建群组（M27.2-2 layout 件出包随件迁：CreateGroupDialog 消费） */
export async function createGroup(
  payload: { name?: string; participants?: string[]; description?: string },
  rpc: Rpc,
): Promise<{ group?: { group_id?: string }; success?: boolean; error?: string }> {
  const r = await rpc.call<{ group?: { id?: string } }>('group/create', {
    name: String(payload.name ?? '未命名群组'),
    ...(Array.isArray(payload.participants) ? { members: payload.participants.map(String) } : {}),
    ...(payload.description !== undefined ? { description: String(payload.description) } : {}),
  });
  return { group: { group_id: r.group?.id }, success: true };
}

/** 更新（改名 / 简介 / 成员差量：join/leave 逐个对账现成员表） */
export async function updateGroup(
  groupId: string,
  payload: Record<string, unknown>,
  rpc: Rpc,
): Promise<{ success?: boolean; error?: string }> {
  if (typeof payload.name === 'string' && payload.name) {
    await rpc.call('group/rename', { groupId, name: payload.name });
  }
  // 简介：string 即发送（空串 = 清空——后端 optStr 空→undefined；曾漏发
  // 致群聊抽屉改简介「本地回写成功、刷新即丢」）
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

export async function deleteGroup(groupId: string, rpc: Rpc): Promise<{ success?: boolean; error?: string }> {
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
  rpc: Rpc,
): Promise<{ success?: boolean; error?: string }> {
  await rpc.call('group/set-memory-owner', { groupId, ...(agentId ? { memoryOwner: agentId } : {}) });
  return { success: true };
}
