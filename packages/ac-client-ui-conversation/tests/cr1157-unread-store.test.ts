// cr1157-unread-store.test.ts —— 前端未读徽章状态（take 水合/live bump/markRead）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUnreadStore } from '../client/unreadStore.ts';
import type { RpcClientFace } from 'ac-client-runtime';

/** rpc 桩：call 记录 + 可编程返回；onEvent/onOpen 收订阅。
 *  session/unread 按 host 真语义桩：take 取走即清（下次返回空表）。 */
function stubRpc(entries: Record<string, { n: number }> = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const handlers: Array<(type: string, args: unknown[]) => void> = [];
  const opens: Array<() => void> = [];
  let taken = false;
  const rpc = {
    call: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === 'session/unread') {
        const out = taken ? { entries: {} as Record<string, { n: number }> } : { entries };
        taken = true;
        return out;
      }
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
    // 私信轴：帧带真实会话键（cr-1339 语境路由——pair 直用对桶轴 / uuid 直用 single 轴）
    s.emit('router/message-received', ['alpha', { role: 'user', content: 'hi', message_id: 'm1' }, 'alpha~user', 'alpha']);
    expect(store.counts.value['alpha~user']).toBe(3);
    // single 桶私信（uuid 键）→ single 轴（此前硬编码对桶轴 = 记错轴，cr-1339 修）
    s.emit('router/message-received', ['alpha', { role: 'user', content: 'hi2', message_id: 'm3' }, '22222222-3333-4444-5555-666666666666', 'alpha']);
    expect(store.counts.value['22222222-3333-4444-5555-666666666666']).toBe(1);
    expect(store.counts.value['alpha~user']).toBe(3); // single 桶帧不误记对桶轴
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

  it('take 竞争窗：RPC 在途帧先暂存，响应后叠加不丢不重', async () => {
    let resolveTake: ((v: unknown) => void) | null = null;
    const calls: string[] = [];
    const handlers: Array<(t: string, a: unknown[]) => void> = [];
    const rpc = {
      call: vi.fn((method: string) => {
        calls.push(method);
        if (method === 'session/unread') {
          // 首调立即返回空表；次调挂起（模拟在途窗）
          if (calls.filter((c) => c === 'session/unread').length === 1) return Promise.resolve({ entries: {} });
          return new Promise((res) => { resolveTake = res; });
        }
        return Promise.resolve({});
      }),
      onEvent: (h: (t: string, a: unknown[]) => void) => { handlers.push(h); return () => {}; },
      onOpen: () => () => {},
    } as unknown as RpcClientFace;
    const store = createUnreadStore(rpc);
    store.init();
    await vi.advanceTimersByTimeAsync(10);
    // 触发第二次 take（慢周期）→ 在途
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    // 在途窗内到达 live 帧
    handlers[0]!('run/settled', [{ agent: 'alpha', conversationId: 'alpha~user', run: 'r1' }]);
    expect(store.counts.value['alpha~user']).toBeUndefined(); // 暂存中
    // 响应回来（快照已含同一事件 n=1）→ 叠加暂存应为 2（快照 1 + 窗内 1）
    resolveTake!({ entries: { 'alpha~user': { n: 1 } } });
    await vi.advanceTimersByTimeAsync(10);
    expect(store.counts.value['alpha~user']).toBe(2);
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

  it('cr-1184：take 活跃轴不入基线（观看期 host 累积不回放）', async () => {
    const s = stubRpc({ 'alpha~user': { n: 2 }, 'g-1': { n: 1 } });
    const store = createUnreadStore(s.rpc);
    store.setActiveAxis(() => 'alpha~user');
    store.init();
    await vi.advanceTimersByTimeAsync(10);
    // 活跃轴被滤除、非活跃轴照常入基线
    expect(store.counts.value['alpha~user']).toBeUndefined();
    expect(store.counts.value['g-1']).toBe(1);
    // 活跃轴离开后（非活跃）：下一次 take 照常回放（host 已被本次 take 清，
    // 该轴此后累积 = 真未读）
    store.setActiveAxis(() => undefined);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(store.counts.value['alpha~user']).toBeUndefined(); // host 已清，无回放
  });

  it('cr-1184：markRead 本地 0 也发 RPC（host 侧观看期累积补清）', async () => {
    const s = stubRpc({});
    const store = createUnreadStore(s.rpc);
    store.init();
    await vi.advanceTimersByTimeAsync(10);
    // 本地无计数（live 被活跃门控拦）——RPC 仍须发出（host 侧有累积）
    store.markRead('alpha~user');
    const marks = s.calls.filter((c) => c.method === 'session/mark-read');
    expect(marks.length).toBeGreaterThanOrEqual(1);
    expect((marks[0]!.params as { conversationId?: string }).conversationId).toBe('alpha~user');
  });
});
