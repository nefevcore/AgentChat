// ============================================================
// feed-view-mode.test.ts —— 视图档切换（cr-1326 dual-view P2）
//
// toggleViewMode：trace ⇄ im 档切换 → 历史重拉请求携带 view 参数；
// 群分区无档（IM 即现状）；指纹清空（换档必全量）。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
});

/** 拦截 rpc：call 记录参数；session/history 返回空页（幂等可重入） */
function spyRpc() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'session/history') return { records: [] };
      return {};
    },
    onEvent: () => {},
    onOpen: undefined,
  };
}

function newFeed(rpc: unknown) {
  return feedCore.createFeedCore(rpc as never, () => new RosterCore());
}

const DIRECT = 'pair:alpha|user'; // viewer 直答对桶（排序后 user 在前）

describe('cr-1326 P2：视图档切换', () => {
  it('toggleViewMode：im 档历史重拉携带 view:im；切回 trace 不带 view；指纹清空', async () => {
    const rpc = spyRpc();
    const feed = newFeed(rpc);
    const d = feed.ensureById(DIRECT as never);
    expect(d.viewMode).toBe('trace'); // 缺省轨迹
    // 切 im：重拉首屏（force）——请求带 view:im
    feed.toggleViewMode(DIRECT as never);
    expect(feed.getDialog(DIRECT as never)!.viewMode).toBe('im');
    const imCalls = rpc.calls.filter((c) => c.method === 'session/history');
    expect(imCalls.length).toBeGreaterThanOrEqual(1);
    expect(imCalls.at(-1)!.params.view).toBe('im');
    // 指纹清空（换档必全量——指纹是 chat 档行的指纹）
    expect(feed.getDialog(DIRECT as never)!.historyFingerprint).toBeUndefined();
    // 切回 trace：重拉不带 view（chat 缺省）
    rpc.calls.length = 0;
    feed.toggleViewMode(DIRECT as never);
    expect(feed.getDialog(DIRECT as never)!.viewMode).toBe('trace');
    const traceCalls = rpc.calls.filter((c) => c.method === 'session/history');
    expect(traceCalls.length).toBeGreaterThanOrEqual(1);
    expect(traceCalls.at(-1)!.params.view).toBeUndefined();
    // 短暂等重试 timeout 排空（防测试进程挂起——catch 路径 800ms 重试）
    await new Promise((r) => setTimeout(r, 900));
  });

  it('群分区无档：toggleViewMode 早退不改状态', () => {
    const rpc = spyRpc();
    const feed = newFeed(rpc);
    const g = 'group:g-x';
    feed.ensureById(g as never);
    feed.toggleViewMode(g as never);
    expect(feed.getDialog(g as never)!.viewMode).toBe('trace');
    expect(rpc.calls.filter((c) => c.method === 'session/history')).toHaveLength(0);
  });
});
