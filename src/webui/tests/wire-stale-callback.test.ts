// @vitest-environment jsdom
// ============================================================
// webui/tests/wire-stale-callback.test.ts —— 连接回调归属守卫验收
//
// 2026-09-26 前端流式叠词反馈根因：WireRpcClient 的连接生命周期回调
// （onopen/onerror/onclose/onmessage）不校验发起方 socket 是否仍是
// 当前 this.ws——旧连接被顶替后，其迟到回调仍无条件改写共享单例态。
// 复现链：A 断网（onclose 在事件队列排队中）→ visibilitychange/rpc.call
// 抢先构造 B（this.ws = B）→ A 的 onclose 迟到执行：this.ws = null
//（擦掉 B 的引用）+ scheduleReconnect → 退避到点再建 C → B/C 双连接
// 并行，服务端 broadcast 双写、两端 onmessage 都分发 → 事件帧双投递
// → feed 的 asst.content += delta 执行两次 → 逐字叠词。
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setWireSocketFactory, wireRpc, RECONNECT_BASE_MS } from '../src/api/wire';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  send(): void { /* 桩：无出站断言 */ }
  close(): void { this.readyState = 3; }
  simulateOpen(): void { this.readyState = 1; this.onopen?.(); }
  simulateClose(): void { this.readyState = 3; this.onclose?.(); }
  /** 服务端广播帧注入（readyState=OPEN 的连接才真会收到） */
  emit(type: string, data: unknown): void {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  setWireSocketFactory(FakeWebSocket as unknown as typeof WebSocket);
  wireRpc.disposeForTest();
});

afterEach(() => {
  wireRpc.disposeForTest();
  setWireSocketFactory(null);
  vi.useRealTimers();
});

it('被顶替连接的迟到 onclose 不得擦除新连接（双连接 = 每帧双投递，叠词根因）', async () => {
  const frames: string[] = [];
  wireRpc.onWireEvent((type) => frames.push(type)); // 拉起连接 A
  const a = FakeWebSocket.instances.at(-1)!;
  a.simulateOpen();
  // 竞态窗：TCP 半开——readyState 已离 OPEN（CLOSING），onclose 尚在
  // 事件队列；前台化恢复抢先进来构造 B
  a.readyState = 2;
  wireRpc.resumeFromBackground();
  const b = FakeWebSocket.instances.at(-1)!;
  expect(b).not.toBe(a);
  b.simulateOpen();
  // A 的 onclose 迟到到达：不得擦掉 B 的引用、不得触发再重连
  a.simulateClose();
  await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * 4);
  expect(FakeWebSocket.instances).toHaveLength(2); // 出现第 3 条即竞态得逞
  // 双连接投递面：所有 OPEN 连接各投一帧（服务端 broadcast 语义）——
  // 每个事件必须只到达订阅者一次
  for (const ws of FakeWebSocket.instances) ws.emit('llm/delta', { args: [{ delta: '前' }] });
  expect(frames.filter((t) => t === 'llm/delta')).toHaveLength(1);
});

it('迟到 onopen 不 flush 队列/不点火 openHooks（新连接的生命周期归新连接）', () => {
  let opens = 0;
  wireRpc.onWireOpen(() => { opens += 1; });
  wireRpc.onWireEvent(() => undefined); // 拉起 A
  const a = FakeWebSocket.instances.at(-1)!;
  a.simulateOpen(); // A 已 open（connecting 已清）——真实连接态
  expect(opens).toBe(1);
  a.readyState = 2; // A 进 CLOSING，onclose 尚在事件队列
  wireRpc.resumeFromBackground(); // 前台化抢先构造 B
  const b = FakeWebSocket.instances.at(-1)!;
  expect(b).not.toBe(a);
  b.simulateOpen(); // B 真实 open：hooks 点火（累计 2 次——两次真实连接）
  expect(opens).toBe(2);
  a.simulateOpen(); // A 迟到 open（病态桩序回 OPEN）：不得再点火/flush
  expect(opens).toBe(2);
});

it('当前连接正常断开仍走退避重连（守卫不吞正常路径）', () => {
  wireRpc.onWireEvent(() => undefined);
  const a = FakeWebSocket.instances.at(-1)!;
  a.simulateOpen();
  a.simulateClose();
  vi.advanceTimersByTime(RECONNECT_BASE_MS);
  expect(FakeWebSocket.instances).toHaveLength(2);
});
