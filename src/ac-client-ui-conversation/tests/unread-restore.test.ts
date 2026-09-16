// ============================================================
// ac-client-ui-conversation/tests/unread-restore.test.ts ——
// 未读徽章刷新恢复回归
//
// 需求锚：未读数字徽章（名册 Agent/群行 + 活动栏聚合）刷新后不丢。
// 状态住 feed 分区 DialogFeed.unread（纯内存）——本回归锁定持久化
// 链路：persistUnread 开 → 未读增量全量写穿 localStorage 单键
// agentchat.unread；重建实例（= 刷新）→ 工厂期水合恢复徽章数字；
// clearUnread → 写穿抹除（刷新不复活）。
//
// 手法：内存 localStorage 桩（先于被测模块注入——模块 import 时捕获
// globalThis.localStorage；与 compose-prefs.test 同款）+ offline rpc
// 拒绝面 + ingestFrame 直喂事件帧。persistUnread 缺省关——既有
// feed 状态机测试族（webui/tests/feed-*）不写快照、互不污染。
// ============================================================
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { directDialog, groupDialog, singleDialog } from '../client/feed.ts';

/** 内存 localStorage 桩（Map 语义） */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
}

let storage: MemoryStorage;
let feedCore: typeof import('../client/feed-core.ts');
let unreadStore: typeof import('../client/unreadStore.ts');

/** offline rpc 桩（call 拒绝 + 订阅 noop——与 feedStore.offlineRpc 同形） */
const offlineRpc = {
  call: () => Promise.reject(new Error('offline')),
  onEvent: () => () => undefined,
} as const;

beforeAll(async () => {
  storage = new MemoryStorage();
  (globalThis as unknown as { localStorage: unknown }).localStorage = storage;
  feedCore = await import('../client/feed-core.ts');
  unreadStore = await import('../client/unreadStore.ts');
});

beforeEach(() => {
  storage.clear();
});

describe('未读持久化与刷新恢复（persistUnread 链路）', () => {
  it('persistUnread 开：未读增量写穿快照；重建实例（= 刷新）水合恢复', async () => {
    // ── 会话一：产生 direct + group 未读 ──
    const { RosterCore } = await import('ac-client-ui-agents/client');
    const roster = new RosterCore();
    const feed = feedCore.createFeedCore(offlineRpc as never, () => roster, { persistUnread: true });
    feed.ingestFrame('router/message-received', ['alpha', { role: 'user', content: '私信一' }, 'alpha~user', 'alpha', 'agent']);
    feed.ingestFrame('router/message-received', ['alpha', { role: 'user', content: '私信二' }, 'alpha~user', 'alpha', 'agent']);
    feed.ingestFrame('group/message-posted', ['room-a', { from: 'beta', content: '群消息' }]);
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(2);
    expect(feed.getDialog(groupDialog('room-a'))!.unread).toBe(1);

    // ── 刷新 = 全新实例（新 roster/新工厂调用）水合同一份快照 ──
    const feed2 = feedCore.createFeedCore(offlineRpc as never, () => new RosterCore(), { persistUnread: true });
    expect(feed2.getDialog(directDialog('alpha'))!.unread).toBe(2);
    expect(feed2.getDialog(groupDialog('room-a'))!.unread).toBe(1);
    // 徽章消费面（AgentList unreadCountOf / ActivityBar 聚合）同源恢复
    expect(feed2.getUnreadCount('alpha')).toBe(2);
    // 恢复只设徽章数字——分区消息体仍懒加载（不因水合预载历史）
    expect(feed2.getDialog(directDialog('alpha'))!.rawMessages.length).toBe(0);
  });

  it('clearUnread 写穿抹除：读过的会话刷新后不复活', async () => {
    const { RosterCore } = await import('ac-client-ui-agents/client');
    const roster = new RosterCore();
    const feed = feedCore.createFeedCore(offlineRpc as never, () => roster, { persistUnread: true });
    feed.ingestFrame('router/message-received', ['alpha', { role: 'user', content: '私信' }, 'alpha~user', 'alpha', 'agent']);
    feed.ingestFrame('group/message-posted', ['room-a', { from: 'beta', content: '群消息' }]);
    feed.clearUnread(directDialog('alpha')); // 点开 Agent（AgentList 选中路径同款）
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(0);

    const feed2 = feedCore.createFeedCore(offlineRpc as never, () => new RosterCore(), { persistUnread: true });
    // 读过的会话不在快照 → 新实例无分区，徽章消费面（getUnreadCount）回落 0
    expect(feed2.getUnreadCount('alpha')).toBe(0);
    expect(feed2.getDialog(directDialog('alpha'))).toBeNull();
    expect(feed2.getDialog(groupDialog('room-a'))!.unread).toBe(1); // 未读的群不受牵连
  });

  it('persistUnread 缺省关：增量不写快照（既有测试隔离面——webui feed 状态机族无 localStorage 依赖）', async () => {
    const { RosterCore } = await import('ac-client-ui-agents/client');
    const feed = feedCore.createFeedCore(offlineRpc as never, () => new RosterCore());
    feed.ingestFrame('router/message-received', ['alpha', { role: 'user', content: '私信' }, 'alpha~user', 'alpha', 'agent']);
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(1);
    expect(unreadStore.loadUnreadSnapshot()).toBeNull(); // 不落盘
  });

  it('single 会话未读同链路恢复（AgentList 聚合徽章口径）', async () => {
    // single 分区经 ingestFrame 无直接入站口——用测试面造快照（load 校验
    // 形状）后水合，锁定恢复端契约（single:sid 键合法）
    unreadStore.saveUnreadSnapshot({ [singleDialog('sess-1')]: 4 });
    const { RosterCore } = await import('ac-client-ui-agents/client');
    const feed = feedCore.createFeedCore(offlineRpc as never, () => new RosterCore(), { persistUnread: true });
    expect(feed.getDialog(singleDialog('sess-1'))!.unread).toBe(4);
  });

  it('进入 single 会话清未读（setActiveSingle——与 setActiveGroup 进群同语义，幽灵未读修复回归）', async () => {
    // 造 single 未读快照 → 水合恢复 → 进入会话（SessionList selectSingle →
    // chat.setSingleContext → feed.setActiveSingle 同款调用）→ 未读清零且
    // 写穿（刷新后不复活——single 无名册行，不清则活动栏聚合永久残留）
    unreadStore.saveUnreadSnapshot({ [singleDialog('sess-1')]: 3, [groupDialog('room-a')]: 2 });
    const { RosterCore } = await import('ac-client-ui-agents/client');
    const feed = feedCore.createFeedCore(offlineRpc as never, () => new RosterCore(), { persistUnread: true });
    feed.setActiveSingle('sess-1', 'alpha');
    expect(feed.getDialog(singleDialog('sess-1'))!.unread).toBe(0);
    // 写穿：别的分区不受牵连；重建实例（= 刷新）single 未读不复活
    const snap = unreadStore.loadUnreadSnapshot();
    expect(snap![groupDialog('room-a')]).toBe(2);
    expect(snap![singleDialog('sess-1')]).toBeUndefined();
    const feed2 = feedCore.createFeedCore(offlineRpc as never, () => new RosterCore(), { persistUnread: true });
    expect(feed2.getDialog(singleDialog('sess-1'))).toBeNull();
    expect(feed2.getDialog(groupDialog('room-a'))!.unread).toBe(2);
  });

  it('脏快照防御：损坏 JSON / 非法键 / 非正整数 → 整份丢弃不恢复', async () => {
    unreadStore.__setUnreadSnapshotRaw('{broken json');
    const { RosterCore } = await import('ac-client-ui-agents/client');
    const broken = feedCore.createFeedCore(offlineRpc as never, () => new RosterCore(), { persistUnread: true });
    expect(broken.getUnreadCount('alpha')).toBe(0);

    unreadStore.__setUnreadSnapshotRaw(JSON.stringify({ 'junk:key': 1, [directDialog('alpha')]: 0, [groupDialog('g')]: -3, [singleDialog('s')]: 'x' }));
    const junk = feedCore.createFeedCore(offlineRpc as never, () => new RosterCore(), { persistUnread: true });
    expect(junk.getDialog(directDialog('alpha'))).toBeNull();
    expect(junk.getDialog(groupDialog('g'))).toBeNull();
    expect(junk.getDialog(singleDialog('s'))).toBeNull();
  });

  it('非 viewer pair（矩阵只读分区）不恢复——徽章无此消费面，与增量口径一致', async () => {
    const { RosterCore } = await import('ac-client-ui-agents/client');
    const roster = new RosterCore();
    const feed = feedCore.createFeedCore(offlineRpc as never, () => roster, { persistUnread: true });
    // agent⇄agent 对桶（a~b 不含 viewer）：消息照常进分区（矩阵只读视角
    // 实时显示），但 viewerRelevant=false 不计未读——快照恒无此键
    feed.ingestFrame('router/message-received', ['beta', { role: 'user', content: '委托' }, 'beta~gamma', 'beta', 'agent']);
    expect(feed.getDialog('pair:beta|gamma' as never)!.unread).toBe(0);
    expect(unreadStore.loadUnreadSnapshot()).toBeNull();
  });
});
