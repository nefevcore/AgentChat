// ============================================================
// tests/webui-feed-incremental.test.ts
// buildTurnsIncremental：流式增长时完成轮次保持对象身份，仅重建最后一个 turn
// ============================================================

import { describe, it, expect } from 'vitest';
import { buildTurnsIncremental, type TurnsMemo } from '../src/ui/webui/src/utils/feed';
import type { ChatMessage } from '../src/ui/webui/src/types';

function userMsg(content: string, id = 'u1'): ChatMessage {
  return { id, role: 'agent', content, agent_id: 'user', timestamp: 1000 };
}

function asstMsg(content: string, id = 'a1'): ChatMessage {
  return { id, role: 'agent', content, agent_id: 'agent-1', timestamp: 2000, isStreaming: true };
}

describe('buildTurnsIncremental', () => {
  it('首帧全量构建', () => {
    const msgs = [userMsg('hi'), asstMsg('')];
    const memo = buildTurnsIncremental(null, msgs);
    // 空白流式占位被跳过 → 只有用户 turn
    expect(memo.turns).toHaveLength(1);
    expect(memo.turns[0].final?.content).toBe('hi');
  });

  it('流式增长：完成轮次对象身份保持，仅重建最后一个 turn', () => {
    const msgs = [userMsg('hi'), asstMsg('Hel')];
    const memo1 = buildTurnsIncremental(null, msgs);
    expect(memo1.turns).toHaveLength(2);

    // 原地追加内容（模拟 feed store 的 asst.content += delta）
    msgs[1]!.content = 'Hello';
    const memo2 = buildTurnsIncremental(memo1, msgs);

    // 前缀（用户消息）未变 → 用户 turn 复用同一对象身份
    expect(memo2.turns[0]).toBe(memo1.turns[0]);
    // 最后（流式）turn 重建且内容正确
    expect(memo2.turns[1]).not.toBe(memo1.turns[1]);
    expect(memo2.turns[1].final?.content).toBe('Hello');

    // 继续增长 → 再次只重建最后一个 turn
    msgs[1]!.content = 'Hello world';
    const memo3 = buildTurnsIncremental(memo2, msgs);
    expect(memo3.turns[0]).toBe(memo1.turns[0]);
    expect(memo3.turns[1].final?.content).toBe('Hello world');
  });

  it('无实际变化：直接返回同一 memo（零重建）', () => {
    const msgs = [userMsg('hi'), asstMsg('Hello')];
    const memo1 = buildTurnsIncremental(null, msgs);
    const memo2 = buildTurnsIncremental(memo1, msgs);
    expect(memo2).toBe(memo1);
  });

  it('结构变化（追加新消息）→ 全量重建，结果正确', () => {
    const msgs = [userMsg('hi'), asstMsg('Hello')];
    const memo1 = buildTurnsIncremental(null, msgs);
    expect(memo1.turns).toHaveLength(2);

    // 新用户消息加入 → 结构变化
    const next = [...msgs, userMsg('second question', 'u2')];
    const memo2 = buildTurnsIncremental(memo1, next);
    expect(memo2.turns).toHaveLength(3);
    expect(memo2.turns[2].final?.content).toBe('second question');
  });

  it('工具结果流式更新：前缀复用，最后一个 turn 重建', () => {
    const asst = asstMsg('正在调用工具', 'a1');
    asst.toolCalls = [{ id: 'tc1', name: 'bash', arguments: { cmd: 'ls' } }] as any;
    const msgs = [userMsg('运行命令', 'u1'), asst];
    const memo1 = buildTurnsIncremental(null, msgs);
    expect(memo1.turns).toHaveLength(2);
    expect(memo1.turns[0].final?.content).toBe('运行命令');

    // 工具消息追加（结构性变化）→ 全量重建（前缀身份不保证复用，但结果正确）
    const toolMsg: ChatMessage = {
      id: 'tool-tc1', role: 'tool', content: 'file1', toolName: 'bash', tool_call_id: 'tc1', timestamp: 3000,
    };
    const withTool = [...msgs, toolMsg];
    const memo2 = buildTurnsIncremental(memo1, withTool);
    expect(memo2.turns).toHaveLength(2);
    expect(memo2.turns[1].steps.flatMap((s) => s.tools).some((t) => t.content === 'file1')).toBe(true);

    // 工具结果流式写入（最后一条消息内容变化）→ 复用 memo2 前缀，只重建最后一个 turn
    toolMsg.content = 'file1\nfile2';
    const memo3 = buildTurnsIncremental(memo2, withTool);
    expect(memo3.turns[0]).toBe(memo2.turns[0]);
    const lastTools = memo3.turns[1].steps.flatMap((s) => s.tools);
    expect(lastTools.some((t) => t.content === 'file1\nfile2')).toBe(true);
  });

  it('前缀消息变化（长度变化）→ 回退全量重建（身份不复用但结果正确）', () => {
    const msgs = [userMsg('old question'), asstMsg('answer')];
    const memo1 = buildTurnsIncremental(null, msgs);

    msgs[0]!.content = 'new question!'; // 长度变化 → 签名变化 → 全量重建
    const memo2 = buildTurnsIncremental(memo1, msgs);
    expect(memo2.turns).toHaveLength(2);
    expect(memo2.turns[0].final?.content).toBe('new question!');
    expect(memo2.turns[1].final?.content).toBe('answer');
  });

  it('同长度编辑前缀消息：纯函数按设计依赖 store 失效（传 null 模拟失效 → 结果正确）', () => {
    const msgs = [userMsg('old question'), asstMsg('answer')];
    const memo1 = buildTurnsIncremental(null, msgs);
    msgs[0]!.content = 'new question'; // 与 'old question' 同长度
    // 纯函数长度签名相同 → 复用（这是设计：同长度编辑由 feed store 的 replaceMessage 显式失效 memo）
    expect(buildTurnsIncremental(memo1, msgs)).toBe(memo1);
    // 模拟 store 失效（prev=null）→ 全量重建，结果正确
    const memo2 = buildTurnsIncremental(null, msgs);
    expect(memo2.turns[0].final?.content).toBe('new question');
  });
});
