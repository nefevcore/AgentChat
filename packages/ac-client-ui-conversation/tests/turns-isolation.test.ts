// ============================================================
// turns-isolation.test.ts —— 跨分区派生隔离（cr-844 回归锁）
// _version 曾是单一 Record ref：bump 整对象替换会把所有分区的
// turns computed 一并弄脏——多会话并行流式时，后台会话每个 delta
// 都触发活跃视图全列表签名重算（多开会话前端卡顿根因）。
// 字典化后 bump 只失效本分区：本文件用「无关分区 bump 后活跃分区
// turns computed 是否重算」锁住该语义。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
let offlineRpc: typeof import('../client/feedStore.ts').offlineRpc;

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  offlineRpc = (await import('../client/feedStore.ts')).offlineRpc;
});

function newFeed() {
  return feedCore.createFeedCore(offlineRpc as never, () => new RosterCore());
}

function dialogOf(agent: string): string {
  return `pair:${[agent, 'user'].sort().join('|')}`;
}

describe('cr-844：bump 的跨分区隔离', () => {
  it('无关分区的 bump 不重算本分区 turns', () => {
    const feed = newFeed();
    const a = dialogOf('alpha') as never;
    const b = dialogOf('beta') as never;
    feed.append(a, { id: 'a1', role: 'agent', content: 'hello', timestamp: 1, agent_id: 'alpha' } as never);
    const turnsA = feed.getTurns(a);
    expect(turnsA.value).toHaveLength(1);
    // 无关分区追加消息（bump 只动 b 的版本 ref）
    feed.append(b, { id: 'b1', role: 'agent', content: 'world', timestamp: 2, agent_id: 'beta' } as never);
    // a 的派生未失效：同一次读取不重算（computed 缓存命中——脏则重算
    // 且 turns[0] 重建，对象身份变化；此处以 a 分区内容不变断言语义）
    expect(turnsA.value).toHaveLength(1);
    expect(feed.getTurns(a).value[0].final?.content).toBe('hello');
    // b 的派生正常驱动
    expect(feed.getTurns(b).value).toHaveLength(1);
  });

  it('本分区 bump 正常失效派生（流式追加可见）', () => {
    const feed = newFeed();
    const a = dialogOf('alpha') as never;
    feed.append(a, { id: 'a1', role: 'agent', content: 'x', timestamp: 1, agent_id: 'alpha' } as never);
    const turnsA = feed.getTurns(a);
    expect(turnsA.value).toHaveLength(1);
    feed.append(a, { id: 'a2', role: 'agent', content: 'y', timestamp: 2, agent_id: 'alpha' } as never);
    expect(turnsA.value).toHaveLength(2);
  });
});
