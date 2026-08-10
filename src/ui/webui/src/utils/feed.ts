// ============================================================
// utils/feed.ts —— 统一信息流纯函数层
//
// 单一真相源原则：
//   rawMessages（append-only 事件流） → buildTurns() 纯函数 → Turn[]
//   视图只消费派生结果，不直接维护第二份展示数据。
//
// 设计文档：docs/feed-architecture.md
// ============================================================

import type { ChatMessage, Turn, TurnStep } from '../types';

// ── Dialog 标识 ──

export type DialogKind = 'direct' | 'group';

/** 对话 ID：direct:${agentId}（用户↔Agent 一对一） | group:${groupId}（群聊） */
export type DialogId = `direct:${string}` | `group:${string}`;

/** 构造 direct 对话 ID */
export function directDialog(agentId: string): DialogId {
  return `direct:${agentId}`;
}

/** 构造 group 对话 ID */
export function groupDialog(groupId: string): DialogId {
  return `group:${groupId}`;
}

/** 解析 DialogId → { kind, key } */
export function parseDialogId(id: DialogId): { kind: DialogKind; key: string } {
  const sep = id.indexOf(':');
  const kind = id.slice(0, sep) as DialogKind;
  const key = id.slice(sep + 1);
  return { kind, key };
}

/** 是否为群聊对话 */
export function isGroupDialog(id: DialogId): boolean {
  return id.startsWith('group:');
}

/** 群聊对话取 group_id；direct 返回 null */
export function groupIdOf(id: DialogId): string | null {
  return isGroupDialog(id) ? parseDialogId(id).key : null;
}

// ── 历史分页合并（原 chat.ts 迁移，保持纯函数）──

/**
 * 历史分页合并：新返回的较早消息在前 + 已有较晚消息在后，按 message_id 去重防重复。
 * 返回 [合并去重后的消息, 该页 user 链数]（userCount 用于按轮次校准分页 offset）。
 */
export function mergeHistoryPage(
  incoming: ChatMessage[],
  existing: ChatMessage[],
  isFirstPage: boolean,
): { merged: ChatMessage[]; userCount: number } {
  const raw = isFirstPage ? incoming : [...incoming, ...existing];
  const seen = new Set<string>();
  const merged = raw.filter((m) => {
    if (m.persistedMsgId && seen.has(m.persistedMsgId)) return false;
    if (m.persistedMsgId) seen.add(m.persistedMsgId);
    return true;
  });
  const userCount = incoming.filter((m) => m.agent_id === 'user').length;
  return { merged, userCount };
}

// ── Turn 构建（rawMessages → Turn[]）──

/** 流式内部消息形态（thinking + tool_calls + content） */
export interface FeedAgentMsg {
  thinking: string;
  tool_calls: any[];
  content: string;
  ts: number;
  label?: string;
  /** 流式中（用于派生 turns 保留 isStreaming，驱动思维链自动展开） */
  isStreaming?: boolean;
}

/** 同 sender 连续消息的时间合并阈值：间隔超过该值视为不同会话轮次（如定时广播），不合并 */
export const MERGE_GAP_MS = 10 * 60 * 1000;

/**
 * 将 AgentMsg 数组转换为 TurnStep[] + final ChatMessage（原 _agentMsgsToSteps）。
 * 纯函数：输入不可变，输出全新对象。
 */
export function buildTurnFromAgentMsgs(msgs: FeedAgentMsg[], streaming: boolean, agentId: string): Turn {
  const steps: TurnStep[] = msgs.map((t, i) => {
    const ts = t.ts || Date.now();
    const stepStreaming = streaming || (i === msgs.length - 1 && !!t.isStreaming);
    const asst: ChatMessage = {
      id: `step-${ts}-${i}`, role: 'agent', content: t.content || '',
      label: t.label || '', thinking: t.thinking, reasoning_content: t.thinking,
      toolCalls: (t.tool_calls || []).map((tc: any) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) as any,
      isStreaming: stepStreaming && i === msgs.length - 1, timestamp: ts,
    };
    const tools: ChatMessage[] = (t.tool_calls || []).map((tc: any) => ({
      id: `tool-${tc.id}`, role: 'tool', content: tc.result || '',
      name: tc.name, toolName: tc.name, tool_call_id: tc.id, label: tc.label || tc.name || '',
      isStreaming: stepStreaming ? (tc.running || !tc.result) : !tc.result,
      status: stepStreaming && (tc.running || !tc.result) ? 'running' : undefined, timestamp: ts,
    } as ChatMessage));
    return { assistant: asst, tools, isStreaming: stepStreaming && i === msgs.length - 1 };
  });
  const last = msgs[msgs.length - 1];
  const final: ChatMessage = {
    id: `final-${last.ts || Date.now()}`, role: 'agent',
    content: last.content || '',
    reasoning_content: '', thinking: '',
    isStreaming: false, timestamp: last.ts || Date.now(),
  };
  return { agent_id: agentId, steps, final };
}

/**
 * 由原始消息流构建 Turn[]（原 _buildAgentTurnsForHistory）。
 * - trigger 消息（定时/归档/重启）→ 独立 system turn（渲染为分隔符）
 * - agent/user 消息按 sender 分组为 turn 链；同 sender 但间隔过长 → 拆分为独立轮次
 * - tool 消息匹配 tool_call_id 补 result/label
 */
export function buildTurns(msgs: ChatMessage[]): Turn[] {
  const allTurns: Turn[] = [];
  let cur: { agent_id: string; turns: FeedAgentMsg[] } | null = null;

  const flush = () => {
    if (cur?.turns.length) {
      allTurns.push(buildTurnFromAgentMsgs([...cur.turns], false, cur.agent_id));
      cur = null;
    }
  };

  for (const msg of msgs) {
    // trigger 系统触发消息：渲染为独立系统分隔符，不进普通 turn 链
    if (msg.role === 'trigger') {
      flush();
      const ts = msg.timestamp || Date.now();
      allTurns.push({
        agent_id: 'system',
        steps: [],
        final: { id: `trig-${ts}-${allTurns.length}`, role: 'trigger', content: msg.content || '', timestamp: ts, agent_id: 'system' },
      });
      continue;
    }
    if (msg.role === 'agent' || (msg.role as string) === 'user') {
      // 跳过完全空白的流式占位（thinking/content/toolCalls 皆空），避免产生空气泡
      const empty = !msg.content && !msg.thinking && !msg.reasoning_content && !(msg.toolCalls?.length);
      if (empty) continue;
      const senderId = msg.agent_id || '';
      const ts = msg.timestamp || Date.now();
      const lastTurn = cur?.turns[cur.turns.length - 1];
      const gapTooLong = !!cur && !!lastTurn && (ts - lastTurn.ts) > MERGE_GAP_MS;
      if (!cur || cur.agent_id !== senderId || gapTooLong) {
        flush();
        cur = { agent_id: senderId, turns: [] };
      }
      cur.turns.push({
        thinking: msg.reasoning_content || msg.thinking || '',
        label: (msg as any).label || '',
        tool_calls: (msg.toolCalls || []).map((tc: any) => ({
          id: tc.id, name: tc.name || tc.function?.name || '',
          arguments: tc.arguments || tc.function?.arguments || '',
          result: '', label: tc.label || tc.name || '',
        })),
        content: msg.content || '',
        ts,
        isStreaming: msg.isStreaming,
      });
    }
    if (msg.role === 'tool' && cur?.turns.length) {
      const last = cur.turns[cur.turns.length - 1];
      const tc = last.tool_calls.find((t: any) => t.id === msg.tool_call_id);
      if (tc) { tc.result = msg.content || ''; tc.label = msg.label || msg.name || tc.name; }
    }
  }
  flush();
  return allTurns;
}

/** 从消息中查找最后一条流式消息（可选 role 过滤） */
export function lastStreaming(msgs: ChatMessage[], role?: 'agent' | 'tool'): ChatMessage | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.isStreaming && (!role || m.role === role)) return m;
  }
  return null;
}

/** 关闭所有流式标记 */
export function closeAllStreaming(msgs: ChatMessage[]): void {
  for (const m of msgs) { if (m.isStreaming) m.isStreaming = false; }
}

/** 群组持久化消息 → ChatMessage（REST 群组历史加载用） */
export function groupMessageToChatMessage(m: {
  role: string;
  content: string | null;
  agent_id: string;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
  reasoning_content?: string;
  label?: string;
  timestamp: string;
}): ChatMessage {
  const id = `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    role: (m.role === 'tool' ? 'tool' : 'agent') as ChatMessage['role'],
    content: m.content ?? '',
    agent_id: m.agent_id,
    name: m.name,
    label: m.label,
    timestamp: new Date(m.timestamp).getTime(),
  };
}
