// ============================================================
// domain/turns.ts —— Turn 构建纯函数（零 UI 依赖）
//
// 从消息流构建 Turn 树：这是 ChatView/GroupChat 双管线的共同
// 数据变换核心，v2 收敛为唯一实现。
// ============================================================

import type { ChatMessage, Turn, TurnStep } from './types';

/** 同 sender 连续消息的时间合并阈值：间隔超过该值视为不同会话轮次（如定时广播） */
export const MERGE_GAP_MS = 10 * 60 * 1000;

/** 历史消息内部缓冲结构（流式增量构建用） */
export interface AgentMsg {
  /** 消息来源 Agent ID */
  agent_id: string;
  thinking: string;
  tool_calls: any[];
  content: string;
  ts: number;
  label?: string;
}

export interface AgentTurnEntry {
  agent_id: string;
  turns: AgentMsg[];
  final: AgentMsg | null;
}

/**
 * 将 AgentMsg 数组转换为 TurnStep[] + final。
 * 纯函数：输入输出皆为普通数据，可单测。
 */
export function agentMsgsToSteps(msgs: AgentMsg[], streaming: boolean, agentId: string): Turn {
  const steps: TurnStep[] = msgs.map((t, i) => {
    const ts = t.ts || Date.now();
    const asst: ChatMessage = {
      id: `step-${ts}-${i}`,
      role: 'agent',
      content: t.content || '',
      label: t.label || '',
      thinking: t.thinking,
      reasoning_content: t.thinking,
      toolCalls: (t.tool_calls || []).map((tc: any) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) as any,
      timestamp: ts,
    };
    const tools: ChatMessage[] = (t.tool_calls || []).map((tc: any) => ({
      id: `tool-${tc.id}`,
      role: 'tool',
      content: tc.result || '',
      name: tc.name,
      toolName: tc.name,
      tool_call_id: tc.id,
      label: tc.label || tc.name || '',
      timestamp: ts,
    }));
    return { assistant: asst, tools };
  });
  const last = msgs[msgs.length - 1];
  const final: ChatMessage = {
    id: `final-${last?.ts || Date.now()}`,
    role: 'agent',
    content: last?.content || '',
    timestamp: last?.ts || Date.now(),
  };
  return { agent_id: agentId, steps, final };
}

/**
 * 历史消息 → Turns（含 trigger 分隔符与轮次切分）。
 * 纯函数，与 chat store 完全解耦。
 */
export function buildTurnsForHistory(agentId: string, msgs: ChatMessage[]): Turn[] {
  const allTurns: Turn[] = [];
  let cur: AgentMsg[] = [];

  const flush = () => {
    if (cur.length) {
      allTurns.push(agentMsgsToSteps(cur, false, cur[0]?.agent_id || agentId));
      cur = [];
    }
  };

  for (const msg of msgs) {
    // trigger 系统触发消息 → 独立系统分隔符
    if (msg.role === 'trigger') {
      flush();
      allTurns.push({
        agent_id: 'system',
        steps: [],
        final: {
          id: `trig-${msg.id || msg.timestamp}`,
          role: 'trigger',
          content: msg.content || '',
          timestamp: msg.timestamp || Date.now(),
          agent_id: 'system',
        },
      });
      continue;
    }
    if (msg.role === 'agent') {
      const senderId = msg.agent_id || agentId;
      const ts = msg.timestamp || Date.now();
      const lastTurn = cur[cur.length - 1];
      const gapTooLong = !!lastTurn && ts - lastTurn.ts > MERGE_GAP_MS;
      if (cur.length && (cur[0].agent_id !== senderId || gapTooLong)) flush();
      cur.push({
        thinking: msg.reasoning_content || msg.thinking || '',
        label: (msg as any).label || '',
        tool_calls: (msg.toolCalls || []).map((tc: any) => ({
          id: tc.id,
          name: tc.name || tc.function?.name || '',
          arguments: tc.arguments || tc.function?.arguments || '',
          result: '',
          label: tc.label || tc.name || '',
        })),
        content: msg.content || '',
        ts,
        agent_id: senderId,
      });
    }
    if (msg.role === 'tool' && cur.length) {
      const last = cur[cur.length - 1];
      const tc = last.tool_calls.find((t: any) => t.id === msg.tool_call_id);
      if (tc) {
        tc.result = msg.content || '';
        tc.label = msg.label || msg.name || tc.name;
      }
    }
  }
  flush();
  return allTurns;
}
