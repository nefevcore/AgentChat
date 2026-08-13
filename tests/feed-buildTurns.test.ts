// ============================================================
// buildTurns 单元测试 —— rawMessages → Turn[] 派生纯函数
//
// 背景（2026-08-09）：统一信息流重构。单一真相源 = rawMessages，
// turns 由 buildTurns 派生。本测试锁定派生行为的正确性：
//   - 消息分组 / gap 拆分 / trigger 分隔
//   - 空流式占位跳过 / isStreaming 保留
//   - tool 结果回填
// ============================================================

import { describe, it, expect } from 'vitest';
import { buildTurns, MERGE_GAP_MS } from '../src/ui/webui/src/utils/feed';
import type { ChatMessage } from '../src/ui/webui/src/types';

function raw(p: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'agent',
    content: '',
    agent_id: '',
    timestamp: Date.now(),
    ...p,
  } as ChatMessage;
}

describe('buildTurns', () => {
  it('用户消息 + Agent 纯文本回复 → 两个独立 turn', () => {
    const msgs = [
      raw({ id: 'u1', content: '你好', agent_id: 'user', role: 'agent' }),
      raw({ id: 'a1', content: '你好！有什么可以帮你？', agent_id: 'ai_ji', role: 'agent' }),
    ];
    const turns = buildTurns(msgs);
    expect(turns.length).toBe(2);
    expect(turns[0].agent_id).toBe('user');
    expect(turns[0].final?.content).toBe('你好');
    expect(turns[1].agent_id).toBe('ai_ji');
    expect(turns[1].final?.content).toBe('你好！有什么可以帮你？');
  });

  it('thinking + toolCalls + tool 结果 → 单 turn 含 steps，tool 结果回填', () => {
    const msgs = [
      raw({
        id: 'a1', agent_id: 'ai_ji', role: 'agent',
        content: '', thinking: '需要查询',
        toolCalls: [{ id: 't1', name: 'bash', arguments: {} }] as any,
      }),
      raw({
        id: 'tool1', agent_id: 'ai_ji', role: 'tool',
        tool_call_id: 't1', toolName: 'bash', name: 'bash', content: '查询结果',
      }),
      raw({ id: 'a2', agent_id: 'ai_ji', role: 'agent', content: '完成', thinking: '' }),
    ];
    const turns = buildTurns(msgs);
    expect(turns.length).toBe(1);
    const t = turns[0]!;
    expect(t.steps.length).toBe(2); // thinking 步 + 纯文本步
    expect(t.steps[0]!.assistant.thinking).toBe('需要查询');
    expect(t.steps[0]!.tools.length).toBe(1);
    expect(t.steps[0]!.tools[0]!.content).toBe('查询结果');
    expect(t.final?.content).toBe('完成');
  });

  it('trigger 消息 → 独立系统 turn（渲染为分隔符）', () => {
    const msgs = [
      raw({ id: 'tr', role: 'trigger', content: '<trigger>归档整理</trigger>', agent_id: 'system' }),
    ];
    const turns = buildTurns(msgs);
    expect(turns.length).toBe(1);
    expect(turns[0]!.agent_id).toBe('system');
    expect(turns[0]!.final?.role).toBe('trigger');
  });

  it('error 消息 → 独立系统 turn（渲染为错误分隔符，不再被丢弃）', () => {
    const msgs = [
      raw({ id: 'u1', content: '问', agent_id: 'user', role: 'agent' }),
      raw({ id: 'e1', role: 'error', content: 'LLM 流式调用失败：连接超时', agent_id: undefined }),
    ];
    const turns = buildTurns(msgs);
    expect(turns.length).toBe(2);
    expect(turns[1]!.agent_id).toBe('system');
    expect(turns[1]!.final?.role).toBe('error');
    expect(turns[1]!.final?.content).toBe('LLM 流式调用失败：连接超时');
    expect(turns[1]!.steps.length).toBe(0);
  });

  it('完全空白的流式占位消息被跳过（不产生空气泡）', () => {
    const msgs = [
      raw({ id: 'a1', agent_id: 'ai_ji', role: 'agent', content: '', thinking: '', isStreaming: true }),
    ];
    const turns = buildTurns(msgs);
    expect(turns.length).toBe(0);
  });

  it('流式消息保留 isStreaming 标记（驱动思维链自动展开）', () => {
    const msgs = [
      raw({ id: 'a1', agent_id: 'ai_ji', role: 'agent', content: '部分', thinking: '思考中', isStreaming: true }),
    ];
    const turns = buildTurns(msgs);
    expect(turns.length).toBe(1);
    expect(turns[0]!.steps.length).toBe(1);
    expect(turns[0]!.steps[0]!.assistant.isStreaming).toBe(true);
  });

  it('同 sender 连续消息合并为单 turn 的多 steps', () => {
    const base = Date.now();
    const msgs = [
      raw({ id: 'a1', agent_id: 'ai_ji', role: 'agent', content: '', thinking: '第一步', timestamp: base }),
      raw({ id: 'a2', agent_id: 'ai_ji', role: 'agent', content: '第二步', thinking: '', timestamp: base + 1000 }),
    ];
    const turns = buildTurns(msgs);
    expect(turns.length).toBe(1);
    expect(turns[0]!.steps.length).toBe(2);
  });

  it('同 sender 但间隔超过 MERGE_GAP_MS → 拆分为独立轮次（定时广播）', () => {
    const base = Date.now();
    const msgs = [
      raw({ id: 'a1', agent_id: 'ai_ji', role: 'agent', content: '第一条', timestamp: base }),
      raw({ id: 'a2', agent_id: 'ai_ji', role: 'agent', content: '第二条', timestamp: base + MERGE_GAP_MS + 1000 }),
    ];
    const turns = buildTurns(msgs);
    expect(turns.length).toBe(2);
  });

  it('sender 交替（user/agent/user）→ 各自独立 turn', () => {
    const msgs = [
      raw({ id: 'u1', content: '问1', agent_id: 'user', role: 'agent' }),
      raw({ id: 'a1', content: '答1', agent_id: 'ai_ji', role: 'agent' }),
      raw({ id: 'u2', content: '问2', agent_id: 'user', role: 'agent' }),
    ];
    const turns = buildTurns(msgs);
    expect(turns.map(t => t.agent_id)).toEqual(['user', 'ai_ji', 'user']);
  });
});
