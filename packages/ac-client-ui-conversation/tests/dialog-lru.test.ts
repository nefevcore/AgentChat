// ============================================================
// ac-client-ui-conversation/tests/dialog-lru.test.ts ——
// dialogs 热集 LRU + 字节预算（session-cache-and-frame-ordering-plan A2）
//
// 场景：超限淘汰最冷分区（壳保留：unread/lastMessage 不丢；内容/水位/
// 指纹/派生态全弃）；活跃分区与流式中分区永不淘汰。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
let offlineRpc: typeof import('../client/feedStore.ts').offlineRpc;

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  offlineRpc = (await import('../client/feedStore.ts')).offlineRpc;
});

function dialogOf(agent: string): string {
  return 'pair:' + [agent, 'user'].sort().join('|');
}

function newFeed(opts?: { lruMaxDialogs?: number; lruByteBudget?: number }) {
  return feedCore.createFeedCore(offlineRpc as never, () => new RosterCore(), opts);
}

function msg(id: string, content: string, agent: string) {
  return { id, role: 'agent', content, timestamp: Date.now(), agent_id: agent } as never;
}

describe('A2：dialogs 热集 LRU', () => {
  it('超限淘汰最冷分区；壳与活跃分区保留', () => {
    const feed = newFeed({ lruMaxDialogs: 2, lruByteBudget: 1024 * 1024 });
    const a = dialogOf('alpha') as never;
    const b = dialogOf('beta') as never;
    const c = dialogOf('gamma') as never;
    feed.append(a, msg('a1', 'first', 'alpha'));
    feed.append(b, msg('b1', 'second', 'beta'));
    feed.append(c, msg('c1', 'third', 'gamma'));
    feed.maybeEvict();
    // 非空分区 ≤ 2：最冷的 a 被淘汰（rawMessages 清空、壳保留）
    const nonEmpty = [a, b, c].filter((id) => feed.getRaw(id).length > 0);
    expect(nonEmpty).toHaveLength(2);
    expect(feed.getRaw(a)).toHaveLength(0);
    expect(feed.getDialog(a)).not.toBeNull(); // 壳保留
    expect(feed.getRaw(b).length + feed.getRaw(c).length).toBe(2);
  });

  it('LRU 序：后续访问刷新新鲜度，淘汰跳过最近使用过的分区', () => {
    const feed = newFeed({ lruMaxDialogs: 2, lruByteBudget: 1024 * 1024 });
    const a = dialogOf('alpha') as never;
    const b = dialogOf('beta') as never;
    const c = dialogOf('gamma') as never;
    feed.append(a, msg('a1', 'first', 'alpha'));
    feed.append(b, msg('b1', 'second', 'beta'));
    feed.ensureById(a); // a 变热（访问 → noteLru）
    feed.append(c, msg('c1', 'third', 'gamma'));
    feed.maybeEvict();
    // a 已被访问刷新 → 最冷是 b
    expect(feed.getRaw(a).length).toBe(1);
    expect(feed.getRaw(b)).toHaveLength(0);
    expect(feed.getRaw(c).length).toBe(1);
  });

  it('字节预算：重分区超预算被淘汰（即使未超条数上限）', () => {
    const feed = newFeed({ lruMaxDialogs: 30, lruByteBudget: 200 });
    const a = dialogOf('alpha') as never;
    const b = dialogOf('beta') as never;
    feed.append(a, msg('a1', 'x'.repeat(20), 'alpha')); // 40B
    feed.append(b, msg('b1', 'y'.repeat(200), 'beta')); // 400B > 预算
    feed.maybeEvict();
    expect(feed.getRaw(b)).toHaveLength(0); // 超预算的最冷重分区淘汰
  });

  it('流式中分区（占位在场）永不淘汰', () => {
    const feed = newFeed({ lruMaxDialogs: 1, lruByteBudget: 1024 * 1024 });
    const a = dialogOf('alpha') as never;
    const b = dialogOf('beta') as never;
    feed.append(b, msg('b1', 'cold', 'beta'));
    feed.append(a, { id: 'a1', role: 'agent', content: 'live', timestamp: Date.now(), agent_id: 'alpha', isStreaming: true } as never);
    feed.maybeEvict();
    // a 占位在场 → 即使它是候选也须留下；淘汰落到 b
    expect(feed.getRaw(a).length).toBe(1);
    expect(feed.getRaw(b)).toHaveLength(0);
  });
});
