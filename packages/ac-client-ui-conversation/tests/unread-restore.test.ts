// ============================================================
// ac-client-ui-conversation/tests/unread-restore.test.ts ——
// 未读服务端权威源回归（cr-1146——localStorage 快照退役）
//
// 需求锚：未读徽章刷新后不丢 + 多端读位互通。权威源 = 服务端
//（session/unread 批量对账 + 首屏旁带 + clearUnread → session/mark-read
// RPC）。本回归锁定前端消费链路：启动期批量对账水合、clearUnread 发
// mark-read（锚 = 分区已见行）、对账响应覆盖乐观增量。
// 手法：rpc 桩捕获调用 + ingestFrame 直喂事件帧。
// ============================================================
import { describe, it, expect } from 'vitest';
import { directDialog, groupDialog, singleDialog } from '../client/feed.ts';

let feedCore: typeof import('../client/feed-core.ts');

async function importFeed() {
  if (!feedCore) feedCore = await import('../client/feed-core.ts');
  return feedCore;
}

/** rpc 桩：记录调用（mark-read 断言用）+ 可注入批量对账响应 */
function makeRpc(unread?: Array<{ conversationId: string; unreadCount: number }>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    call: (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'session/unread') return Promise.resolve({ conversations: unread ?? [] });
      if (method === 'session/history') return Promise.resolve({ records: [], hasMore: false });
      return Promise.resolve({});
    },
    onEvent: () => () => undefined,
  };
}

async function makeFeed(rpc: ReturnType<typeof makeRpc>) {
  const { RosterCore } = await import('ac-client-ui-agents/client');
  const fc = await importFeed();
  return fc.createFeedCore(rpc as never, () => new RosterCore());
}

describe('未读服务端权威源（cr-1146）', () => {
  it('启动期批量对账：session/unread 响应水合全部徽章（页面关闭期间的产生补计）', async () => {
    const rpc = makeRpc([{ conversationId: 'alpha~user', unreadCount: 2 }, { conversationId: 'sess-1', unreadCount: 4 }]);
    const feed = await makeFeed(rpc);
    feed.init();
    await new Promise((r) => setTimeout(r, 0)); // 对账 promise 落定
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(2);
    expect(feed.getUnreadCount('alpha')).toBe(2);
    expect(feed.getDialog(singleDialog('sess-1'))!.unread).toBe(4);
    // 恢复只设徽章数字——分区消息体不预载
    expect(feed.getDialog(directDialog('alpha'))!.rawMessages.length).toBe(0);
  });

  it('clearUnread → session/mark-read RPC（seq 锚优先，空分区无锚不发）', async () => {
    const rpc = makeRpc();
    const feed = await makeFeed(rpc);
    // 种历史行：seq 3 > 1（B1 行级锚取 max）
    feed.append(directDialog('alpha'), { id: 'a1', role: 'agent', content: 'x', timestamp: 1, agent_id: 'alpha', seq: 1, persistedMsgId: 'm-1' });
    feed.append(directDialog('alpha'), { id: 'a2', role: 'agent', content: 'y', timestamp: 2, agent_id: 'alpha', seq: 3, persistedMsgId: 'm-3' });
    const d = feed.getDialog(directDialog('alpha'))!;
    d.unread = 2;
    feed.clearUnread(directDialog('alpha'));
    expect(d.unread).toBe(0);
    const mk = rpc.calls.find((c) => c.method === 'session/mark-read');
    expect(mk).toBeDefined();
    expect(mk!.params.conversationId).toBe('alpha~user');
    expect(mk!.params.seq).toBe(3);
    // 空分区（无已见行）清未读：不发 RPC（无锚不回写）
    feed.ensureById(groupDialog('room-a'));
    feed.clearUnread(groupDialog('room-a'));
    expect(rpc.calls.filter((c) => c.method === 'session/mark-read').length).toBe(1);
  });

  it('历史首屏响应旁带 unreadCount 覆盖分区未读（权威纠偏乐观增量）', async () => {
    // rpc 桩返回带 unreadCount 的首屏 + 一条带 seq 的记录行
    const rpc = {
      call: (method: string) => {
        if (method === 'session/history') return Promise.resolve({
          records: [], hasMore: false,
          unreadCount: 7,
        });
        return Promise.resolve({});
      },
      onEvent: () => () => undefined,
    };
    const feed = await makeFeed(rpc as never);
    feed.loadHistory(directDialog('alpha'), 'user', 'alpha');
    await new Promise((r) => setTimeout(r, 10));
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(7);
  });

  it('persistUnread 选项退役：传该选项不再报错（宽容面），localStorage 不再读写', async () => {
    const rpc = makeRpc();
    const fc = await importFeed();
    const { RosterCore } = await import('ac-client-ui-agents/client');
    // @ts-expect-error 旧调用面（宽容——选项已退役）
    const feed = fc.createFeedCore(rpc as never, () => new RosterCore(), { persistUnread: true });
    feed.ingestFrame('router/message-received', ['alpha', { role: 'user', content: '私信' }, 'alpha~user', 'alpha', 'agent']);
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(1);
    expect((globalThis as { localStorage?: { length: number } }).localStorage?.length ?? 0).toBe(0); // 不落 localStorage
  });

  it('对账响应缺 conversations / 失败静默（旧后端兼容——本地态保持）', async () => {
    const rpc = {
      call: (method: string) => method === 'session/unread' ? Promise.reject(new Error('旧后端')) : Promise.resolve({}),
      onEvent: () => () => undefined,
    };
    const feed = await makeFeed(rpc as never);
    feed.init(); // 拒绝静默——不炸
    await new Promise((r) => setTimeout(r, 0));
    expect(feed.getDialog(directDialog('alpha'))).toBeNull(); // 无分区（未水合）
  });

  it('pruneSingleUnread 对账：active 集外的 single 未读清（孤儿未读根修，cr-290 语义保持）', async () => {
    const rpc = makeRpc([{ conversationId: 'sess-1', unreadCount: 2 }, { conversationId: 'gone-1', unreadCount: 5 }]);
    const feed = await makeFeed(rpc);
    feed.init();
    await new Promise((r) => setTimeout(r, 0));
    feed.pruneSingleUnread(['sess-1']);
    expect(feed.getDialog(singleDialog('sess-1'))!.unread).toBe(2); // live 不动
    expect(feed.getDialog(singleDialog('gone-1'))!.unread).toBe(0); // 孤儿清零
  });

  it('非 viewer pair（矩阵只读分区）不入对账轴——dialogIdOfConversation 过滤', async () => {
    const rpc = makeRpc([{ conversationId: 'beta~gamma', unreadCount: 3 }]);
    const feed = await makeFeed(rpc);
    feed.init();
    await new Promise((r) => setTimeout(r, 0));
    expect(feed.getDialog('pair:beta|gamma' as never)).toBeNull(); // 非 viewer 对桶不水合
  });
});
