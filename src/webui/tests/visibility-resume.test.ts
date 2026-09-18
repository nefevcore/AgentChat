// @vitest-environment jsdom
// ============================================================
// webui/tests/visibility-resume.test.ts —— 前台化恢复链验收
//
// 2026-11-28 可见性缺口补齐（desktop 托盘形态的"切回卡顿/回来不动"）：
//   ① wire：resumeFromBackground（断线态前台化 = 取消退避等待立即重连）
//   ② runview：兜底轮询后台顺延（visible 首 tick 即刷 + 下一轮重排，
//      消除"切回后要等满一个 interval（空闲态 60s）"死区）
//   ③ feed-core：onOpen 重连恢复链补历史对账（断线窗口漏帧的确定性
//      补偿——此前只清占位不补数据，缺帧要等兜底轮询或手动切会话）
//
// 浏览器节流机制（背景：被补的缺口本体）：后台标签/托盘隐藏 → rAF 停摆、
// 定时器 ≥1s（Chrome 后台 5 分钟后强节流至分钟级）——重连定时器与兜底
// 轮询在后台被无限拖延，前台化（visibilitychange → visible）是恢复服务
// 的唯一即时信号。
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { createClient, type Fiber, type RpcClientFace } from 'ac-client-runtime';
import { RunsClientService, runviewClientPlugin } from 'ac-client-ui-runview/client';
import { createFeedCore } from 'ac-client-ui-conversation/client/feed-core.ts';
import { RosterCore } from 'ac-client-ui-agents/client';
import { setWireSocketFactory, wireRpc, RECONNECT_BASE_MS } from '../src/api/wire';

// ---- 可见性桩（jsdom 的 visibilityState 只读，defineProperty 顶替；
//      silent = 只改状态不发事件——beforeEach 初始化用，防误触监听器）----
function setVisibility(state: 'visible' | 'hidden', silent = false): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  if (!silent) document.dispatchEvent(new Event('visibilitychange'));
}

// ---- 假 WebSocket 工厂（wire 的 setWireSocketFactory 注入点）----
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.last = this;
    FakeWebSocket.instances.push(this);
  }
  send(text: string): void { this.sent.push(text); }
  close(): void { /* 测试桩：状态由 simulate* 驱动 */ }
  // 测试驱动口
  simulateOpen(): void { this.readyState = 1; this.onopen?.(); }
  simulateClose(): void { this.readyState = 3; this.onclose?.(); }
}

// ---- feed-core 用的最小 rpc 桩（onOpen 可控触发）----
function makeFeedRpc(): { impl: RpcClientFace; open(): void; seen: Array<[string, unknown?]> } {
  const seen: Array<[string, unknown?]> = [];
  const openHandlers: Array<() => void> = [];
  return {
    seen,
    open: () => { for (const h of [...openHandlers]) h(); },
    impl: {
      async call<T>(method: string, params?: unknown): Promise<T> {
        seen.push([method, params]);
        return { records: [], messages: [] } as T;
      },
      onEvent: () => () => undefined,
      onOpen: (h: () => void) => { openHandlers.push(h); return () => undefined; },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  FakeWebSocket.last = null;
  setWireSocketFactory(FakeWebSocket as unknown as typeof WebSocket);
  wireRpc.disposeForTest(); // 单例复位（上一用例的 ws/connecting/退避清零）
  setVisibility('visible', true); // 静默初始化——不发事件防误触重连
});

afterEach(() => {
  wireRpc.disposeForTest();
  setWireSocketFactory(null);
  vi.useRealTimers();
});

describe('① wire · resumeFromBackground（前台化即重连）', () => {
  it('断线 + 退避计时器挂起中 → visible 取消等待立即重连（新 WebSocket 构造）', () => {
    wireRpc.onWireEvent(() => undefined); // 拉起连接
    const first = FakeWebSocket.last!;
    first.simulateOpen();
    first.simulateClose(); // → scheduleReconnect（2s 退避计时中）
    expect(FakeWebSocket.instances).toHaveLength(1);

    // 前台化：不等退避，立刻发起新连接
    setVisibility('visible'); // 模块级监听 → resumeFromBackground
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.last!.url).toMatch(/\/ws$/);

    // 退避归零：新连接再断，下一轮等待回到 base（2s），非指数积累值
    FakeWebSocket.last!.simulateOpen();
    FakeWebSocket.last!.simulateClose();
    vi.advanceTimersByTime(RECONNECT_BASE_MS - 1);
    expect(FakeWebSocket.instances).toHaveLength(2); // 未到 base 不重连
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('连接健康时前台化 = 无操作（不断不重连）', () => {
    wireRpc.onWireEvent(() => undefined);
    FakeWebSocket.last!.simulateOpen();
    setVisibility('visible');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('后台期间 visible 守卫不误触发：hidden 不发起重连', () => {
    wireRpc.onWireEvent(() => undefined);
    FakeWebSocket.last!.simulateOpen();
    FakeWebSocket.last!.simulateClose();
    setVisibility('hidden');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('② runview · 兜底轮询后台顺延', () => {
  it('hidden 期间 tick 扑空不刷新；visible 首个 tick 即刷新并把下一轮重排到 interval 后', async () => {
    const ctx = await createClient();
    await ctx.plugin({
      name: 'test-rpc-stub',
      apply(c: any) {
        c.provide('rpc', {
          call: async () => ({}),
          onEvent: () => () => undefined,
        });
      },
    });
    const fiber: Fiber = await ctx.plugin(runviewClientPlugin);
    const svc: RunsClientService = ctx.runs;
    const orig = svc.refresh.bind(svc);
    const refreshCalls: number[] = [];
    svc.refresh = async () => { refreshCalls.push(Date.now()); await orig(); };

    svc.ensurePolling();
    await vi.advanceTimersByTimeAsync(1);
    refreshCalls.length = 0; // ensurePolling 的首发不计

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(120_000); // 后台 2 分钟：零刷新
    expect(refreshCalls).toHaveLength(0);

    // 前台化立即刷新（一阶语义）：不等下一 tick——消"切回后最多再等
    // 一个 interval"的死区。
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshCalls.length).toBeGreaterThanOrEqual(1);

    // 顺延重排（二阶语义）：hidden 期间有过 tick 扑空 → visible 首 tick
    // 刷新后定时器相位锚回前台。此后 60s 内无第二次刷新（advance 闭区间
    // ——59_997/3 切分避开毫秒边界）。
    const before = refreshCalls.length;
    await vi.advanceTimersByTimeAsync(59_997);
    expect(refreshCalls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(3);
    expect(refreshCalls.length).toBeGreaterThanOrEqual(before + 1); // 下一 tick 到来

    svc.stopPolling();
    await (fiber as Fiber).dispose(); // 卸载：轮询/秒针/visibility 监听一并回收
  });
});

describe('③ feed-core · onOpen 历史对账', () => {
  function bootFeed(rpc: RpcClientFace) {
    const roster = new RosterCore();
    const feed = createFeedCore(rpc, () => roster);
    feed.init();
    return { roster, feed };
  }

  it('重连时对活跃 direct 会话发起 session/history（断线窗口漏帧的确定性补偿）', async () => {
    const rpc = makeFeedRpc();
    const { roster } = bootFeed(rpc.impl);
    roster.activeAgentId.value = 'alpha';
    await nextTick();

    rpc.seen.length = 0;
    rpc.open(); // 模拟重连
    await nextTick();

    const hist = rpc.seen.find(([m]) => m === 'session/history');
    expect(hist).toBeTruthy();
    expect((hist![1] as { conversationId: string }).conversationId).toBe('alpha~user');
  });

  it('群会话活跃 → group/history 重拉；single → session/history 带 session 键', async () => {
    const rpc = makeFeedRpc();
    const { feed } = bootFeed(rpc.impl);
    feed.setActiveGroup('g1');
    await nextTick();
    rpc.seen.length = 0;
    rpc.open();
    await nextTick();
    expect(rpc.seen.some(([m]) => m === 'group/history')).toBe(true);

    feed.clearActiveGroup();
    feed.setActiveSingle('s1', 'beta');
    await nextTick();
    rpc.seen.length = 0;
    rpc.open();
    await nextTick();
    const hist = rpc.seen.find(([m]) => m === 'session/history');
    expect(hist).toBeTruthy();
    expect((hist![1] as { conversationId: string }).conversationId).toBe('s1');
  });

  it('无活跃对话 → 重连不发起任何历史请求', async () => {
    const rpc = makeFeedRpc();
    bootFeed(rpc.impl);
    await nextTick();
    rpc.seen.length = 0;
    rpc.open();
    await nextTick();
    expect(rpc.seen).toHaveLength(0);
  });

  it('init 重入守卫：二次 init 不再累积 onOpen 订阅（对账只发一次）', async () => {
    const rpc = makeFeedRpc();
    const { roster, feed } = bootFeed(rpc.impl);
    feed.init(); // 重入
    roster.activeAgentId.value = 'alpha';
    await nextTick();
    rpc.seen.length = 0;
    rpc.open();
    await nextTick();
    expect(rpc.seen.filter(([m]) => m === 'session/history')).toHaveLength(1);
  });
});
