// ============================================================
// src/services/interactions 单元测试 —— 交互桥（L4）
// ============================================================
import { EventEmitter } from 'events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InteractionBridge } from '../src/services/interactions';

afterEach(() => {
  vi.useRealTimers();
});

describe('InteractionBridge', () => {
  it('askUser 注册 pending 并推 chat.interaction 事件；respond 解析', async () => {
    const bus = new EventEmitter();
    const bridge = new InteractionBridge(bus);
    const events: any[] = [];
    bus.on('chat.interaction', (d) => events.push(d));

    const p = bridge.askUser({ agentId: 'a', convKey: 'user__a', question: '继续?', options: ['是', '否'], timeoutMs: 5000 });
    expect(bridge.pendingCount).toBe(1);
    expect(events.length).toBe(1);
    expect(events[0].interaction_id).toBeTruthy();
    expect(events[0].agent_id).toBe('a');

    const res = bridge.respond(events[0].interaction_id, '是');
    expect(res.ok).toBe(true);
    await expect(p).resolves.toBe('是');
    expect(bridge.pendingCount).toBe(0);
  });

  it('respond 未知 id 返回错误', () => {
    const bridge = new InteractionBridge(new EventEmitter());
    const res = bridge.respond('nope', 'x');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/不存在或已超时/);
  });

  it('abort signal → reject ToolInterrupt', async () => {
    const bridge = new InteractionBridge(new EventEmitter());
    const ac = new AbortController();
    const p = bridge.askUser({ agentId: 'a', convKey: 'user__a', question: 'q', options: ['x'], signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'ToolInterrupt' });
    expect(bridge.pendingCount).toBe(0);
  });

  it('超时 → reject 交互超时', async () => {
    vi.useFakeTimers();
    const bridge = new InteractionBridge(new EventEmitter());
    const p = bridge.askUser({ agentId: 'a', convKey: 'user__a', question: 'q', options: ['x'], timeoutMs: 100 });
    vi.advanceTimersByTime(200);
    await expect(p).rejects.toThrow(/交互超时/);
    expect(bridge.pendingCount).toBe(0);
  });

  it('askQuestions 批量逐题串行，全部答完一起 resolve', async () => {
    const bus = new EventEmitter();
    const bridge = new InteractionBridge(bus);
    const ids: string[] = [];
    bus.on('chat.interaction', (d) => ids.push(d.interaction_id));

    const p = bridge.askQuestions({
      agentId: 'a', convKey: 'user__a',
      questions: [{ question: 'Q1', options: ['1', '2'] }, { question: 'Q2', options: ['3', '4'] }],
    });

    // 第一题 pending 已注册（串行）
    expect(ids.length).toBe(1);
    expect(bridge.pendingCount).toBe(1);
    bridge.respond(ids[0], '1');

    // 等待第二题注册
    await new Promise((r) => setTimeout(r, 10));
    expect(ids.length).toBe(2);
    bridge.respond(ids[1], '4');

    await expect(p).resolves.toEqual(['1', '4']);
    expect(bridge.pendingCount).toBe(0);
  });

  it('abortAgent / abortAll 清理 pending', async () => {
    const bridge = new InteractionBridge(new EventEmitter());
    const p1 = bridge.askUser({ agentId: 'a', convKey: 'user__a', question: 'q', options: ['x'] });
    const p2 = bridge.askUser({ agentId: 'b', convKey: 'user__b', question: 'q', options: ['x'] });

    bridge.abortAgent('a');
    await expect(p1).rejects.toMatchObject({ name: 'ToolInterrupt' });
    expect(bridge.pendingCount).toBe(1);

    bridge.abortAll();
    await expect(p2).rejects.toMatchObject({ name: 'ToolInterrupt' });
    expect(bridge.pendingCount).toBe(0);
  });
});
