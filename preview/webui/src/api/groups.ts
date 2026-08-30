// ============================================================
// api/groups.ts —— 群名册 Port B（阶段二第三梯）
//
// group/list·create·delete·rename·join·leave·history 直连。
// GroupInfo 合成（group_id/participants/created_at 词汇）是本模块
// 视图代码；成员差量（PATCH participants）经 group/list 取现值。
// ============================================================

import { wireRpc } from './wire.ts';
import { parseToolArgs } from './runs.ts';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

// ---- preview 形状 ----

export interface PGroupConfig {
  id: string;
  name: string;
  members: string[];
  description?: string;
  createdAt?: number;
}

export interface GroupInfo {
  group_id: string;
  name: string;
  participants: string[];
  created_at: number;
  description?: string;
  /** 最近活动时间戳（P4：runs/snapshot 群会话桶 updatedAt 合成；实时侧 WS bump 覆盖） */
  lastActivity?: number;
}

export function toGroupInfo(g: PGroupConfig): GroupInfo {
  return {
    group_id: g.id,
    name: g.name,
    participants: g.members,
    created_at: g.createdAt ?? 0,
    ...(g.description !== undefined ? { description: g.description } : {}),
  };
}

// ---- 名册 ----

/** 群名册（P4：聚合 runs/snapshot 群会话桶 lastActivity；snapshot 失败静默降级） */
export async function fetchGroups(rpc: Rpc = wireRpc): Promise<{ groups: GroupInfo[] }> {
  const [r, snapR] = await Promise.all([
    rpc.call<{ groups?: PGroupConfig[] }>('group/list'),
    rpc
      .call<{ conversations?: Array<{ conversationId: string; updatedAt?: number }> }>('runs/snapshot')
      .catch(() => undefined),
  ]);
  const convOf = new Map((snapR?.conversations ?? []).map((c) => [c.conversationId, c]));
  return {
    groups: (r.groups ?? []).map((g) => {
      const lastActivity = convOf.get(g.id)?.updatedAt;
      return { ...toGroupInfo(g), ...(lastActivity !== undefined ? { lastActivity } : {}) };
    }),
  };
}

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

/** 更新（改名 / 成员差量：join/leave 逐个对账现成员表） */
export async function updateGroup(groupId: string, payload: Record<string, unknown>, rpc: Rpc = wireRpc): Promise<{ success?: boolean; error?: string }> {
  if (typeof payload.name === 'string' && payload.name) {
    await rpc.call('group/rename', { groupId, name: payload.name });
  }
  if (Array.isArray(payload.participants)) {
    const next = payload.participants.map(String);
    const cur = await rpc.call<{ groups?: PGroupConfig[] }>('group/list');
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

// ---- 群历史 ----

/** 群历史行（feed.groupMessageToChatMessage 的宽松输入形状） */
export interface GroupHistoryMessage {
  role: string;
  content: string | null;
  agent_id: string;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  toolName?: string;
  reasoning_content?: string;
  label?: string;
  timestamp: string;
}

/** group/history RPC 行（D11：本体投影——成员回复行带 steps[]/reasoning） */
interface PGroupRecord {
  id?: string;
  from?: string;
  content?: string;
  at?: number;
  reasoning?: string;
  steps?: Array<{
    content?: string;
    reasoning?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: string; result?: unknown }>;
  }>;
}

/**
 * 本体行 → feed 消息（D11：steps 按步展开——与 toHistoryMessages 的
 * 1v1 展开同构：每步 agent 气泡[tool_calls/thinking] + 配对 tool 气泡；
 * 用户发言直通）。群成员工具卡片/思维链刷新后不丢。
 */
function expandGroupRecord(m: PGroupRecord): GroupHistoryMessage[] {
  const base = {
    agent_id: m.from ?? '',
    name: m.from,
    timestamp: new Date(m.at ?? Date.now()).toISOString(),
  };
  if (!m.steps || m.steps.length === 0) {
    return [
      {
        role: 'agent',
        content: m.content ?? '',
        ...base,
        ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
      },
    ];
  }
  const out: GroupHistoryMessage[] = [];
  for (const s of m.steps) {
    const toolCalls = (s.toolCalls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: parseToolArgs(tc.arguments),
      result: tc.result ?? '',
      label: tc.name,
    }));
    out.push({
      role: 'agent',
      content: s.content || '',
      ...(s.reasoning ? { reasoning_content: s.reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...base,
    });
    for (const tc of s.toolCalls ?? []) {
      out.push({
        role: 'tool',
        content: JSON.stringify(tc.result ?? ''),
        tool_call_id: tc.id,
        label: tc.name,
        ...base,
        name: tc.name, // 工具名（覆盖基座的说话人标注——tool 气泡归工具）
        toolName: tc.name, // 与 1v1 展开（toHistoryMessages）同款词汇
      });
    }
  }
  return out;
}

/** 群组历史（分页：最新 limit 条 + offset 上翻更早；首屏满页 50 = hasMore） */
export async function fetchGroupHistory(
  groupId: string,
  offset = 0,
  limit = 50,
  rpc: Rpc = wireRpc,
): Promise<{ messages: GroupHistoryMessage[] }> {
  const r = await rpc.call<{ messages?: PGroupRecord[] }>('group/history', {
    groupId,
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(offset > 0 ? { offset } : {}),
  });
  return { messages: (r.messages ?? []).flatMap(expandGroupRecord) };
}
