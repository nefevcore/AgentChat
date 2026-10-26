// ============================================================
// ac-conversation 单测（M3.4 验收）：双队列路由 / budget 消费 /
// user 重置 / 串行化门 / receipt 不进 inbox
// ============================================================
import { describe, it, expect } from 'vitest';
import { ConversationMachine } from '../src/state.ts';

const msg = (sender: string, requestId: string, extra: Partial<Parameters<ConversationMachine['plan']>[0]> = {}) => ({
  kind: 'message' as const, sender, requestId, admitted: true, ...extra,
});

describe('投递决策', () => {
  it('空闲 + user 直发 → run（预算重置）', () => {
    const m = new ConversationMachine('alpha', 0); // 预算耗尽态
    expect(m.plan(msg('user', 'r1'))).toEqual({ action: 'run', budgetAfter: 3 });
  });

  it('receipt / grant / revoke → ledger-only（A4 不进 inbox）', () => {
    const m = new ConversationMachine('alpha');
    expect(m.plan({ kind: 'receipt', sender: 'host', requestId: 'r', admitted: true }))
      .toEqual({ action: 'ledger-only', reason: 'receipt' });
    expect(m.plan({ kind: 'grant', sender: 'user', requestId: 'r2', admitted: true }))
      .toEqual({ action: 'ledger-only', reason: 'control' });
  });

  it('budget=0 + 非 user → ledger-only（只落账不激活）', () => {
    const m = new ConversationMachine('alpha', 0);
    expect(m.plan(msg('agent-b', 'r1'))).toEqual({ action: 'ledger-only', reason: 'budget-exhausted' });
  });

  it('幂等命中 → deduped', () => {
    const m = new ConversationMachine('alpha');
    expect(m.plan(msg('user', 'r1', { admitted: false }))).toEqual({ action: 'deduped' });
  });
});

describe('busy 路由（inbox 双队列）', () => {
  it('next-step 缺省 steer（注入活跃 run）；placement=next-run 降级 queue', () => {
    const m = new ConversationMachine('alpha');
    m.plan(msg('user', 'r0'));
    m.runStarted('run-1');
    expect(m.plan(msg('user', 'r1'))).toEqual({ action: 'steer', runId: 'run-1', budgetAfter: 3 });
    expect(m.plan(msg('user', 'r2', { placement: 'next-run' }))).toEqual({ action: 'queue', lane: 'next-turn', budgetAfter: 3 });
  });

  it('next-turn 入队；收束后按 FIFO 消费', () => {
    const m = new ConversationMachine('alpha');
    m.plan(msg('user', 'r0'));
    m.runStarted('run-1');
    m.plan(msg('user', 'r1', { lane: 'next-turn' }));
    m.plan(msg('user', 'r2', { lane: 'next-turn' }));
    expect(m.state().queuedTurns).toBe(2);
    expect(m.runSettled(false)).toEqual({ requestId: 'r1' });
    expect(m.runSettled(false)).toEqual({ requestId: 'r2' });
    expect(m.runSettled(false)).toBeNull();
  });

  it('cr-627 requeue 补入队尾（steer 落空转投）+ runSettled 随行 conversationId', () => {
    const m = new ConversationMachine('alpha');
    m.plan(msg('user', 'r0', { conversationId: 'c0' }));
    m.runStarted('run-1');
    m.plan(msg('user', 'r1', { lane: 'next-turn', conversationId: 'c1' }));
    // steer 落空转投：其他会话的信补入队尾（收束点链跑按随行会话键取信）
    m.requeue({ requestId: 'r9', conversationId: 'c9', preview: '跨会话信', sender: 'user', source: 'user' });
    expect(m.state().queuedTurns).toBe(2);
    const first = m.runSettled(false);
    expect(first).toEqual({ requestId: 'r1', conversationId: 'c1' });
    const second = m.runSettled(false);
    expect(second).toEqual({ requestId: 'r9', conversationId: 'c9' });
    expect(m.runSettled(false)).toBeNull();
  });

  it('队列读写面：快照（会话过滤）+ 删除 + steer 取件/放回', () => {
    const m = new ConversationMachine('alpha');
    m.plan(msg('user', 'r0'));
    m.runStarted('run-1');
    m.plan(msg('user', 'r1', { lane: 'next-turn', conversationId: 'c1', preview: '甲', source: 'user' }));
    m.plan(msg('user', 'r2', { lane: 'next-turn', conversationId: 'c2', preview: '乙' }));
    // 快照按会话过滤；条目形 = id/preview/sender/queuedAt（+source/conversationId）
    const c1 = m.queued('c1');
    expect(c1).toHaveLength(1);
    expect(c1[0]).toMatchObject({ id: 'r1', preview: '甲', sender: 'user', source: 'user', conversationId: 'c1' });
    expect(m.queued('c2')[0]).toMatchObject({ id: 'r2', preview: '乙' });
    expect(m.queued()).toHaveLength(2);
    // 删除：命中出队、未命中 null
    expect(m.removeQueued('ghost')).toBeNull();
    // steer：取件出队 → 放回原位（顺序不丢）
    const taken = m.steerTake('r1')!;
    expect(taken.item.requestId).toBe('r1');
    expect(m.queued()).toHaveLength(1);
    m.steerRestore(taken.item, taken.index);
    expect(m.queued().map((q) => q.id)).toEqual(['r1', 'r2']);
    expect(m.removeQueued('r2')!.requestId).toBe('r2');
    expect(m.queued().map((q) => q.id)).toEqual(['r1']);
  });
});

describe('串行化门与 budget 消费', () => {
  it('busy 时 runStarted 抛错（单参与者串行）', () => {
    const m = new ConversationMachine('alpha');
    m.plan(msg('user', 'r0'));
    m.runStarted('run-1');
    expect(() => m.runStarted('run-2')).toThrow(/串行化门冲突/);
  });

  it('自动唤醒 -1 至 0（防自激链收敛）', () => {
    const m = new ConversationMachine('alpha', 3);
    m.plan(msg('agent-b', 'r0'));
    m.runStarted('run-1');
    m.runSettled(true);
    expect(m.state().budget).toBe(2);
    m.runStarted('run-2');
    m.runSettled(true);
    expect(m.state().budget).toBe(1);
    m.runStarted('run-3');
    m.runSettled(true);
    expect(m.state().budget).toBe(0);
    // 耗尽后 agent 信只落账
    expect(m.plan(msg('agent-b', 'r9'))).toMatchObject({ action: 'ledger-only' });
    // user 回归重置
    expect(m.plan(msg('user', 'r10'))).toEqual({ action: 'run', budgetAfter: 3 });
  });
});
