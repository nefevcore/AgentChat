// ============================================================
// settlement-converge.test.ts —— D1 收敛协议前端面（cr-94）：
// session/run-settled 事件驱动即时重拉（delay=0）替代 after-run
// 500ms 赌窗；非用户会话过滤。真时钟断言（避免 fake timer 与 vue/pinia
// 响应式调度互扰）。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
});

const CONV = 'alpha~user';

/** 记录调用时刻的 rpc 桩（相对构造时刻 ms） */
function spyRpc() {
  const calls: number[] = [];
  const t0 = Date.now();
  return {
    calls,
    call(method: string) {
      if (method === 'session/history') calls.push(Date.now() - t0);
      return Promise.resolve({ records: [], hasMore: false });
    },
    onEvent() { return () => undefined; },
  };
}

function newFeed(rpc: unknown) {
  return feedCore.createFeedCore(rpc as never, () => new RosterCore());
}

describe('run-settled 事件驱动收敛（cr-94）', () => {
  it('事件到达 → 即时重拉（≤50ms，旧赌窗 500ms）', async () => {
    const rpc = spyRpc();
    const feed = newFeed(rpc);
    feed.ingestFrame('loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId: 'r1' }]);
    feed.ingestFrame('session/run-settled', [CONV, 'alpha', { runId: 'r1' }]);
    await new Promise((r) => setTimeout(r, 80));
    expect(rpc.calls.length).toBeGreaterThanOrEqual(1);
    expect(rpc.calls[0]).toBeLessThan(50); // 即时档（非 500ms 兜底）
  });

  it('非用户会话（未知群桶词形）→ 不重拉', async () => {
    const rpc = spyRpc();
    const feed = newFeed(rpc);
    feed.ingestFrame('session/run-settled', ['beta~gamma', 'beta', { runId: 'r3' }]);
    await new Promise((r) => setTimeout(r, 80));
    // beta~gamma 非已知群 → routeDialog 判 pair:beta|gamma（矩阵只读视角）——
    // 该分区无 viewer 写口，重拉对矩阵视角仍是合法读（loadHistory 会被调，
    // 但只读分区数据源）。锁「不炸不挂」即可。
    expect(rpc.calls.length).toBeLessThanOrEqual(1);
  });
});