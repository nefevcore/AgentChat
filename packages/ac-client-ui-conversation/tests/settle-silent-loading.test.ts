// ============================================================
// settle-silent-loading.test.ts —— cr-793 收敛静默化回归：
// run-settled/收敛路径的首屏重拉不得点亮「加载历史消息」指示器
//（loadingHistory 仅由用户可见加载点亮：切会话首屏/上翻分页）；
// 互斥锁语义保留（收敛在途挡上翻分页，offset 不竞写）。真时钟
//（避免 fake timer 与 vue/pinia 响应式调度互扰，同 settlement-converge）。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { ref } from 'vue';

let feedCore: typeof import('../client/feed-core.ts');
let feedFns: typeof import('../client/feed.ts');

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  feedFns = await import('../client/feed.ts');
});

const CONV = 'alpha~user';

/** 挂起型 rpc 桩：session/history 不自动 resolve（保住在途窗口），手动 flush 放行 */
function pendingRpc() {
  const calls: number[] = [];
  let release: (resp: unknown) => void = () => undefined;
  return {
    calls,
    flush(resp: unknown) { release(resp); },
    call(method: string) {
      if (method === 'session/history') {
        calls.push(calls.length);
        return new Promise((r) => { release = r; });
      }
      return Promise.resolve({});
    },
    onEvent() { return () => undefined; },
  };
}

function newFeed(rpc: unknown) {
  // roster 桩：activeAgentId = alpha（directDialog(alpha) 即活跃分区，
  // loadingHistory 投影命中）
  return feedCore.createFeedCore(rpc as never, () => ({ activeAgentId: ref('alpha'), agents: ref([]) } as never));
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('收敛静默化（cr-793）', () => {
  it('run-settled 收敛重拉不点亮 loadingHistory（静默在途）', async () => {
    const rpc = pendingRpc();
    const feed = newFeed(rpc);
    feed.ingestFrame('session/run-settled', [CONV, 'alpha', { runId: 'r1' }]);
    await tick(30); // delay=0 定时器落火，请求在途
    expect(rpc.calls.length).toBe(1); // 收敛请求已发出（对账语义保留）
    expect(feed.loadingHistory.value).toBe(false); // 关键：不点亮加载指示器
    const id = feedFns.directDialog('alpha');
    expect(feed.getDialog(id)?.status).toBe('converging'); // 在途态（互斥锁档位）
    rpc.flush({ records: [], hasMore: false });
    await tick(10);
    expect(feed.getDialog(id)?.status).toBe('ready');
  });

  it('切会话首屏装载仍点亮 loadingHistory（用户可见加载不回归）', async () => {
    const rpc = pendingRpc();
    const feed = newFeed(rpc);
    const id = feedFns.directDialog('alpha');
    feed.loadHistory(id, 'user', 'alpha');
    expect(feed.loadingHistory.value).toBe(true);
    rpc.flush({ records: [], hasMore: false });
    await tick(10);
    expect(feed.loadingHistory.value).toBe(false);
  });

  it('收敛在途时上翻分页被挡（offset 不竞写）', async () => {
    const rpc = pendingRpc();
    const feed = newFeed(rpc);
    const id = feedFns.directDialog('alpha');
    feed.loadHistory(id, 'user', 'alpha');
    rpc.flush({ records: [], hasMore: true });
    await tick(10);
    expect(feed.getDialog(id)?.status).toBe('ready');
    // 触发收敛（重拉在途）→ 上翻分页应被互斥锁挡下
    feed.ingestFrame('session/run-settled', [CONV, 'alpha', { runId: 'r2' }]);
    await tick(30);
    expect(rpc.calls.length).toBe(2);
    feed.loadMoreHistory(id);
    expect(rpc.calls.length).toBe(2); // 没有第三个请求：被 converging 挡
    rpc.flush({ records: [], hasMore: false });
    await tick(10);
    expect(feed.getDialog(id)?.status).toBe('ready');
  });
});
