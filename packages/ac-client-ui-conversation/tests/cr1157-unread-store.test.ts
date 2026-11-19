// cr1157-unread-store.test.ts —— 前端未读徽章状态（take 水合/live bump/markRead）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUnreadStore } from '../client/unreadStore.ts';
import type { RpcClientFace } from 'ac-client-runtime';

/** rpc 桩：call 记录 + 可编程返回；onEvent/onOpen 收订阅 */
function stubRpc(entries: Record<string, { n: number }> = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const handlers: Array<(type: string, args: unknown[]) => void> = [];
  const opens: Array<() => void> = [];
  const rpc = {
    call: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === 'session/unread') return { entries };
      return {};
    }),
    onEvent: (h: (type: string, args: unknown[]) => void) => { handlers.push(h); return () => {}; },
    onOpen: (h: () => void) => { opens.push(h); return () => {}; },
  } as unknown as RpcClientFace;
  return { rpc, calls, handlers, opens, emit: (t: string, a: unknown[]) => { for (const h of handlers) h(t, a); } };
}

describe('unreadStore（cr-1157 前端面）', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('init：take 水合 + live 帧按轴键 bump', async () => {
    const s = stubRpc({ 'alpha~user': { n: 2 }, 'g-1': { n: 1 } });
    const store = createUnreadStore(s.rpc);
    store.init();
    await vi.advanceTimersByTimeAsync(10);
    expect(store.counts.value['alpha~user']).toBe(2);
    expect(store.counts.value['g-1']).toBe(1);
    // live 帧：settled（single uuid 轴直用）
    s.emit('run/settled', [{ agent: 'alpha', conversationId: '11111111-2222-3333-4444-555555555555', run: 'r1' }]);
    expect(store.counts.value['11111111-2222-3333-4444-555555555555']).toBe(1);
    // 私信轴 = pairKey(agent,user)
    s.emit('router/message-received', ['alpha', { role: 'user', content: 'hi', message_id: 'm1' }, 'conv', 'alpha']);
    expect(store.counts.value['alpha~user']).toBe(3);
    // 群轴 = gid
    s.emit('group/message-posted', ['g-1', { id: 'm2', from: 'beta' }]);
    expect(store.counts.value['g-1']).toBe(2);
  });

  it('markRead：本地即时清 + mark-read RPC；countOfAgent 聚合对桶轴', async () => {
    const s = stubRpc({ 'alpha~user': { n: 2 } });
    const store = createUnreadStore(s.rpc);
    store.init();
    await vi.advanceTimersByTimeAsync(10);
    expect(store.countOfAgent('alpha')).toBe(2); // user~alpha 对桶折算到 alpha
    store.markRead('alpha~user');
    expect(store.counts.value['alpha~user']).toBeUndefined();
    expect(s.calls.some((c) => c.method === 'session/mark-read' && (c.params as { conversationId?: string }).conversationId === 'alpha~user')).toBe(true);
    expect(store.total()).toBe(0);
  });

  it('活动栏双路聚合：agentsTotal（对桶+群）与 sessionsTotal（single）分口径', async () => {
    const s = stubRpc({ 'alpha~user': { n: 2 }, 'g-1': { n: 1 }, '11111111-2222-3333-4444-555555555555': { n: 3 } });
    const store = createUnreadStore(s.rpc);
    store.init();
    await vi.advanceTimersByTimeAsync(10);
    expect(store.agentsTotal()).toBe(3); // 对桶 2 + 群 1
    expect(store.sessionsTotal()).toBe(3); // single uuid 轴
    expect(store.total()).toBe(6);
  });

  it('慢周期兜底：10min take 刷新基线', async () => {
    const s = stubRpc({});
    const store = createUnreadStore(s.rpc);
    store.init();
    await vi.advanceTimersByTimeAsync(10);
    s.emit('run/settled', [{ agent: 'alpha', conversationId: 'alpha~user', run: 'r1' }]);
    expect(store.counts.value['alpha~user']).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    // 周期 take 返回空表（host 已被首次 take 清）→ 基线重放为 0
    expect(store.counts.value['alpha~user']).toBeUndefined();
  });

  it('修二回归：自会话/agent⇄agent 对/群 run 不计数（防串台双倍）', async () => {
    const s = stubRpc({});
    const store = createUnreadStore(s.rpc);
    store.init();
    await vi.advanceTimersByTimeAsync(10);
    // news 定时 run 在自会话收束——不计（动静走 roster；计入即与私信合流双倍）
    s.emit('run/settled', [{ agent: 'news', conversationId: 'news~news', run: 'r1' }]);
    // agent⇄agent 对桶——不计
    s.emit('run/settled', [{ agent: 'alpha', conversationId: 'alpha~beta', run: 'r2' }]);
    // 群成员 run（conversationId = gid）——不计（群由 group/message-posted 单源计）
    s.emit('run/settled', [{ agent: 'alpha', conversationId: 'g-1', run: 'r3' }]);
    // 对照：user 参与的对桶照计
    s.emit('run/settled', [{ agent: 'alpha', conversationId: 'alpha~user', run: 'r4' }]);
    expect(store.counts.value['news~news']).toBeUndefined();
    expect(store.counts.value['alpha~beta']).toBeUndefined();
    expect(store.counts.value['g-1']).toBeUndefined();
    expect(store.counts.value['alpha~user']).toBe(1);
  });

  it('修二回归：正在看的会话不计数（活跃轴门控）', async () => {
    const s = stubRpc({});
    const store = createUnreadStore(s.rpc);
    store.setActiveAxis(() => 'alpha~user');
    store.init();
    await vi.advanceTimersByTimeAsync(10);
    s.emit('run/settled', [{ agent: 'alpha', conversationId: 'alpha~user', run: 'r1' }]);
    s.emit('group/message-posted', ['g-1', { id: 'm1', from: 'beta' }]);
    expect(store.counts.value['alpha~user']).toBeUndefined();
    expect(store.counts.value['g-1']).toBe(1); // 非活跃轴照计
  });
});
