// ============================================================
// api/runs.ts —— 运行跟踪 Port B（阶段二第五梯）
//
// runs/snapshot·interrupt + session/history（pair 视角）直连。
// RunsSnapshot 合成（src 矩阵契约：members/pairs/groups/running/
// convKey ~ 分隔格式）与 convKey→conversationId 换算是本模块视图
// 代码；热力时间窗（h1/dN）preview 无面对全零（显式降级，README 记录）。
// ============================================================

import { wireRpc } from './wire.ts';
import type { PAgentConfig } from './roster.ts';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

// ---- src 视图契约（RunTracking.vue / stores/runs.ts 消费形状） ----

export interface RunsMember {
  id: string;
  name: string;
  kind: 'agent' | 'virtual' | 'preset' | 'group' | 'system' | 'unknown';
  participants?: string[];
}

export interface WindowCounts { h1: number; d1: number; d3: number; d7: number; d30: number }

export interface RunsPairSession {
  key: string;
  a: string;
  b: string;
  messageCount: number;
  lastActivity: number;
  bytes: number;
  /** 热力时间窗计数（h1/dN 消息量）；preview 无面 → 缺省（UI 回退总量色阶） */
  windows?: WindowCounts;
}

export interface RunsGroupSession {
  key: string;
  groupId: string;
  messageCount: number;
  lastActivity: number;
  bytes: number;
  /** 热力时间窗计数（preview 无面 → 缺省；见 RunsPairSession.windows） */
  windows?: WindowCounts;
}

export interface RunsSingleSession {
  key: string;
  id: string;
  agentId: string;
  title?: string;
  status?: string;
  workspaceId?: string;
  messageCount: number;
  lastActivity: number;
}

export interface RunsRunningEntry {
  convKey: string;
  kind: 'chat' | 'group' | 'single';
  agentId: string;
  startedAt: number;
  source?: { kind?: string; form?: string; summary?: string };
}

export interface RunsGroupArchive {
  groupId: string;
  agentId: string;
  lastActivity: number;
}

export interface RunsSubagent {
  id: string;
  parentId: string;
  name: string;
  status: 'running' | 'done' | 'error' | 'timeout' | 'killed';
  task: string;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
}

export interface RunsSnapshot {
  generatedAt: string;
  members: RunsMember[];
  pairs: RunsPairSession[];
  groups: RunsGroupSession[];
  groupArchives: RunsGroupArchive[];
  singles: RunsSingleSession[];
  running: RunsRunningEntry[];
  subagents: { active: RunsSubagent[]; completed: RunsSubagent[] };
  coverage: { matrixSessions: number; pairSessions: number; groupSessions: number; singleSessions: number; runningTotal: number; runningSingles: number; unknownMembers: string[] };
}

/** pair 历史消息（宽松形态，按 role 渲染；feed.pairMessageToChatMessage 消费） */
export interface PairHistoryMessage {
  role: string;
  content: string | null;
  agent_id?: string;
  message_id?: string;
  timestamp?: string;
  label?: string;
  reasoning_content?: string;
}

// ---- preview 形状 ----

export interface PRunsSnapshot {
  conversations: Array<{
    conversationId: string;
    messageCount?: number;
    size?: number;
    updatedAt?: number;
    /** 热力时间窗（后端按记录时间戳统计；缺失 = 旧后端，UI 回退总量色阶） */
    windows?: { h1: number; d1: number; d3: number; d7: number; d30: number };
    /** 尾部一条摘要（P4 名册 lastMessage 合成源） */
    last?: { role: string; text: string; ts: string; name?: string };
  }>;
  running: Array<{ agentId: string; conversationId: string; handle: string; startedAt: number }>;
  groups: Array<{ groupId: string; name: string; memberCount: number }>;
}

export interface PSessionRecord {
  role: string;
  content: string;
  message_id: string;
  timestamp: string;
  /** 说话人端点（中性格式归属标记，M21/D13——一切真实发言 role:'agent' 必有） */
  agent_id?: string;
  /** 旧 baked 格式说话人标注（兼容读取） */
  name?: string;
  /** 事件来源标注（role:'event' 行；P3） */
  source?: string;
  /** 思维链全文（agent 回复行；P3——刷新后恢复 thinking 折叠栏） */
  reasoning_content?: string;
  /** ReAct 步记录（agent 回复行；M18 #6——刷新后按步重建工具卡片） */
  steps?: PSessionStep[];
}

export interface PSessionStep {
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    /** 参数原始 JSON 字符串 */
    arguments: string;
    /** 工具体返回的 ToolResult（对象原样） */
    result: unknown;
  }>;
}

// ---- 合成 ----

/** preview snapshot → src RunsSnapshot（矩阵渲染活；热力窗口后端按记录
 *  时间戳统计，旧后端缺失 → UI 检测回退「全部」+ 总量色阶）。
 *  成员去重：agents 名册已含 'user'（ac-workspace 注册，名 = 显示名）时
 *  不再合成占位 user——否则矩阵出现两行同 id（"user" 与用户显示名）。
 *  M19 对桶统一：全部 'a~b' 键（含 user~agent 直答与 a~a 自会话）按同一
 *  规则进 pairs——user 只是端点之一，无 user 特判。 */
export function toRunsSnapshot(s: PRunsSnapshot, agents: PAgentConfig[]): RunsSnapshot {
  const convOf = new Map((s.conversations ?? []).map((c) => [c.conversationId, c]));
  const agentMembers = agents.map((a) => ({ id: a.id, name: a.description ?? a.id, kind: 'agent' as const }));
  const groupMembers = (s.groups ?? []).map((g) => ({ id: g.groupId, name: g.name, kind: 'group' as const }));
  const agentIds = new Set(agentMembers.map((m) => m.id));
  const groupIds = new Set(groupMembers.map((m) => m.id));
  const hasUser = agentMembers.some((m) => m.id === 'user');
  // 会话桶分类（M19）：对桶 'a~b'（两端都是注册端点——viewer 虚拟端点也在
  // 名册）→ pairs；群 gid / 独立会话 sid 不进 pairs（群走 groups、singles
  // 维持「矩阵外独立」既有降级）
  const pairs = (s.conversations ?? [])
    .filter((c) => {
      if (groupIds.has(c.conversationId)) return false;
      if (!c.conversationId.includes('~')) return false;
      const parts = c.conversationId.split('~');
      return parts.length === 2 && parts.every((p) => agentIds.has(p));
    })
    .map((c) => {
      const [a, b] = c.conversationId.split('~') as [string, string];
      return {
        // 对桶已排序（pairKey 构造时 sort）——chat~ 前缀 + 桶名即 src 键
        key: `chat~${c.conversationId}`,
        a,
        b,
        messageCount: c.messageCount ?? 0,
        lastActivity: c.updatedAt ?? 0,
        bytes: c.size ?? 0,
        ...(c.windows ? { windows: c.windows } : {}),
      };
    });
  return {
    generatedAt: new Date().toISOString(),
    members: [
      // agents 已含 user（显示名如实）则直接用；否则合成占位（虚拟端点）
      ...(hasUser ? [] : [{ id: 'user', name: 'user', kind: 'virtual' as const }]),
      ...agentMembers,
      ...groupMembers,
      { id: 'system', name: 'system', kind: 'system' },
    ],
    pairs,
    groups: (s.groups ?? []).map((g) => {
      const conv = convOf.get(g.groupId);
      return {
        key: `group~${g.groupId}`,
        groupId: g.groupId,
        messageCount: conv?.messageCount ?? 0,
        lastActivity: conv?.updatedAt ?? 0,
        bytes: conv?.size ?? 0,
        ...(conv?.windows ? { windows: conv.windows } : {}),
      };
    }),
    groupArchives: [],
    singles: [],
    running: (s.running ?? []).map((r) => {
      // 分类（M19）：群 gid（groups 名单内）→ group~gid；对桶 'a~b'（含
      // user~agent 与 a~a）→ chat~<桶名>；其余（独立会话 sid）→ single~sid
      const conv = r.conversationId;
      const isGroup = groupIds.has(conv);
      const isPair = !isGroup && conv.includes('~') && conv.split('~').length === 2;
      const kind: 'chat' | 'group' | 'single' = isGroup ? 'group' : isPair ? 'chat' : 'single';
      const convKey = isGroup
        ? `group~${conv}${r.agentId && r.agentId !== conv ? `~${r.agentId}` : ''}`
        : isPair
          ? `chat~${conv}`
          : `single~${conv}`;
      return {
        convKey,
        kind,
        agentId: r.agentId,
        startedAt: r.startedAt,
        source: { kind: 'chat' },
      };
    }),
    subagents: { active: [], completed: [] },
    coverage: {
      matrixSessions: pairs.length,
      pairSessions: pairs.length,
      groupSessions: (s.groups ?? []).length,
      singleSessions: 0,
      runningTotal: (s.running ?? []).length,
      runningSingles: 0,
      unknownMembers: [],
    },
  };
}

/**
 * SessionRecord[] → src 历史消息行（pair 视角 + WS history.response 共用）。
 * 【M21/D13 中性格式】role:'agent' 行 = 一切真实发言，归属 agent_id（取代
 * name）；'error' 行 = run 错误收束（错误分隔符）。旧 baked 行（user/
 * assistant + name）兼容读取，产出同构输出。带 steps 的回复行（M18 #6）→
 * 按步重建：每步一个 assistant 气泡（含 thinking/toolCalls）+ 每个工具调用
 * 一个 tool 气泡（与直播/resume 快照同构——工具卡片刷新后不丢）；event 行
 * （P3：timer/机制触发）→ role:'event' 事件分隔符。
 */
export function toHistoryMessages(records: PSessionRecord[], conversationId: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const r of records) {
    if (r.role === 'user') {
      out.push({ role: 'agent', content: r.content, agent_id: r.agent_id ?? r.name ?? 'user', message_id: r.message_id, timestamp: r.timestamp });
      continue;
    }
    if (r.role === 'agent' || r.role === 'assistant') {
      const agentId = r.agent_id ?? r.name ?? conversationId;
      if (r.steps && r.steps.length > 0) {
        for (let i = 0; i < r.steps.length; i++) {
          const s = r.steps[i];
          // 键名用 src 持久化约定 tool_calls（historyMsgToChatMessage 消费下划线形）
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
            thinking: s.reasoning || undefined,
            reasoning_content: s.reasoning,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            agent_id: agentId,
            name: r.name,
            message_id: `${r.message_id}-s${i}`,
            timestamp: r.timestamp,
          });
          for (const tc of s.toolCalls ?? []) {
            out.push({
              role: 'tool',
              content: tc.result ?? '',
              agent_id: agentId,
              name: tc.name,
              toolName: tc.name,
              tool_call_id: tc.id,
              label: tc.name,
              message_id: tc.id || `${r.message_id}-s${i}-t`,
              timestamp: r.timestamp,
            });
          }
        }
        continue;
      }
      out.push({
        role: 'agent',
        content: r.content,
        agent_id: agentId,
        name: r.name,
        message_id: r.message_id,
        timestamp: r.timestamp,
        ...(r.reasoning_content !== undefined ? { reasoning_content: r.reasoning_content } : {}),
      });
      continue;
    }
    if (r.role === 'error') {
      // run 错误收束（D12/F7）：错误分隔符（feed 渲染 system 级错误行）
      out.push({ role: 'error', content: r.content, agent_id: 'system', message_id: r.message_id, timestamp: r.timestamp });
      continue;
    }
    if (r.role === 'tool') {
      out.push({ role: 'tool', content: r.content, agent_id: r.agent_id ?? r.name ?? conversationId, name: r.name, tool_call_id: r.message_id, message_id: r.message_id, timestamp: r.timestamp });
      continue;
    }
    out.push({ role: 'event', content: r.content, agent_id: r.agent_id ?? r.name ?? 'system', message_id: r.message_id, timestamp: r.timestamp });
  }
  return out;
}

/** 工具参数 JSON 字符串 → 对象（失败降级原串——卡片少显示参数不崩）。
 *  导出供群历史展开（groups.ts）同款复用——唯一解析点，防两处漂移 */
export function parseToolArgs(raw: string | undefined): Record<string, unknown> | string {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
}

/** src convKey（chat~a~b / group~g~a / single~s）→ preview conversationId（M19：
 *  chat 对键双向保留——'chat~a~b' → 'a~b'，不再剥 user 特判） */
export function convKeyToId(convKey: string): string {
  if (convKey.startsWith('single~')) return convKey.slice('single~'.length);
  if (convKey.startsWith('group~')) return convKey.split('~')[1] ?? convKey;
  if (convKey.startsWith('chat~')) return convKey.slice('chat~'.length);
  return convKey;
}

// ---- API ----

/** 运行跟踪快照（3s 轮询；snapshot + agents/list 双 RPC 聚合） */
export async function fetchRuns(rpc: Rpc = wireRpc): Promise<RunsSnapshot> {
  const [snapshot, agentsR] = await Promise.all([
    rpc.call<PRunsSnapshot>('runs/snapshot'),
    rpc.call<{ agents?: PAgentConfig[] }>('agents/list'),
  ]);
  return toRunsSnapshot(snapshot ?? {}, agentsR.agents ?? []);
}

/** 中断指定会话键的运行中 run（软中断：run 走完 runEnd 落盘后退出） */
export async function interruptRun(convKey: string, rpc: Rpc = wireRpc): Promise<{ success: boolean; error?: string }> {
  const r = await rpc.call<{ aborted?: number }>('runs/interrupt', { conversationId: convKeyToId(convKey) });
  return { success: (r.aborted ?? 0) > 0 };
}

/** Agent 会话对（pair）只读历史（矩阵格子点击视角；conversationId = 对桶键
 *  pairKey(a,b)——M19 与后端寻址同词表） */
export async function fetchPairHistory(from: string, to: string, limit = 100, offset = 0, rpc: Rpc = wireRpc): Promise<{ messages: PairHistoryMessage[] }> {
  void from; // from 仅参与对键（与 to 合成）；保留签名兼容
  const conversationId = [from, to].sort().join('~');
  const r = await rpc.call<{ records?: PSessionRecord[] }>('session/history', {
    conversationId,
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(offset > 0 ? { offset } : {}),
  });
  return { messages: toHistoryMessages(r.records ?? [], conversationId) as unknown as PairHistoryMessage[] };
}
