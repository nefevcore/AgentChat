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

/** 可控 rpc：history 响应挂起由测试决定何时放行（构造切档在途竞态） */
function deferredRpc() {
  const pending: Array<{ params: Record<string, unknown>; resolve: (v: unknown) => void }> = [];
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    pending,
    call: (method: string, params: Record<string, unknown>) => {
      if (method !== 'session/history') return Promise.resolve({});
      calls.push(params);
      return new Promise((resolve) => { pending.push({ params, resolve }); });
    },
    onEvent: () => {},
    onOpen: undefined,
  };
}

/** 放行一个挂起的 history 响应（records 为服务端记录形） */
function settle(entry: { resolve: (v: unknown) => void }, records: Array<Record<string, unknown>>) {
  entry.resolve({ records, hasMore: false });
}

const CONV = 'alpha~user';
const meta = { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' };

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

  it('cr-1334：IM 档 run 收束不建终稿内容载体（trace 档照常补气泡）', async () => {
    const rpc = spyRpc();
    const feed = newFeed(rpc);
    const settled: [string, unknown[]] = ['run/settled', [{
      agent: 'alpha', conversationId: 'alpha~user', run: 'r1', finish: 'stop', text: '终稿正文',
    }]];
    // trace 档：收束帧携带的最终内容补出气泡（增量帧丢失兜底）
    feed.ensureById(DIRECT as never);
    feed.ingestFrame(...settled);
    expect(feed.getRaw(DIRECT as never).some((m) => m.content === '终稿正文')).toBe(true);
    // IM 档：内容载体不建（终稿归轨迹档；权威行由收束重拉补）
    const imFeed = newFeed(rpc);
    imFeed.ensureById(DIRECT as never).viewMode = 'im';
    imFeed.ingestFrame(...settled);
    expect(imFeed.getRaw(DIRECT as never).some((m) => m.content === '终稿正文')).toBe(false);
    await new Promise((r) => setTimeout(r, 20)); // 收束重拉定时器排空
  });

  it('cr-1336：切档在途的异档响应被档位校验丢弃（不污染新档分区、不卡 loading）', async () => {
    const rpc = deferredRpc();
    const feed = newFeed(rpc);
    feed.ensureById(DIRECT as never);
    // trace 档请求在途（未放行）
    feed.loadHistory(DIRECT as never, 'user', 'alpha');
    const traceReq = rpc.pending.at(-1)!;
    expect(rpc.calls.at(-1)!.view).toBeUndefined();
    // 切 IM 档：新请求带 view:im
    feed.toggleViewMode(DIRECT as never);
    const imReq = rpc.pending.at(-1)!;
    expect(imReq.params.view).toBe('im');
    // 旧 trace 响应迟到 → 档位不符整响应弃用
    settle(traceReq, [{ role: 'assistant', content: '轨迹档行', agent_id: 'alpha', message_id: 'x1', timestamp: '2026-11-26T00:00:00.000Z' }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(feed.getRaw(DIRECT as never).some((m) => m.content === '轨迹档行')).toBe(false);
    // 新 IM 响应照常合并（用户消息入流）
    settle(imReq, [{ role: 'user', content: '用户问题', message_id: 'u1', timestamp: '2026-11-26T00:00:01.000Z' }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(feed.getRaw(DIRECT as never).some((m) => m.content === '用户问题')).toBe(true);
    expect(feed.getDialog(DIRECT as never)!.status).toBe('ready');
    expect(feed.getDialog(DIRECT as never)!.viewMode).toBe('im');
  });

  it('cr-1336：IM 档不建直播过程行（步相位/工具卡/注入卡），trace 档照建', async () => {
    const rpc = spyRpc();
    // trace 档对照：步相位帧建步行
    const traceFeed = newFeed(rpc);
    traceFeed.ensureById(DIRECT as never);
    traceFeed.ingestFrame('step/journaled', [{ agent: 'alpha', conversationId: CONV, run: 'r1', step: 0, stepId: 'r1:0', seq: 1, rows: [{ type: 'step/content', text: '步正文', ts: 1 }] }]);
    expect(traceFeed.getRaw(DIRECT as never).some((m) => m.content?.includes('步正文') || m.stepId === 'r1:0')).toBe(true);
    // IM 档：步相位/工具终值/注入卡都不建行
    const imFeed = newFeed(rpc);
    imFeed.ensureById(DIRECT as never).viewMode = 'im';
    imFeed.ingestFrame('step/journaled', [{ agent: 'alpha', conversationId: CONV, run: 'r1', step: 0, stepId: 'r1:0', seq: 1, rows: [{ type: 'step/content', text: '步正文', ts: 1 }] }]);
    imFeed.ingestFrame('tool/result', [{ agent: 'alpha', conversationId: CONV, run: 'r1', toolCallId: 'tc1', result: { ok: true, output: 'out' } }]);
    imFeed.ingestFrame('session/context-injected', [CONV, 'alpha', { source: 'skill', label: '已注入技能', injectionId: 'inj-1' }]);
    await new Promise((r) => setTimeout(r, 20));
    const rows = imFeed.getRaw(DIRECT as never);
    expect(rows.some((m) => m.role === 'tool')).toBe(false);
    expect(rows.some((m) => m.role === 'event')).toBe(false);
    expect(rows.some((m) => m.stepId === 'r1:0')).toBe(false);
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
