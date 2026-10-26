// @vitest-environment jsdom
// ============================================================
// rpc-wire.test.ts —— 浏览器 wire 事件帧解包验收（cr-586）
//
// 根因回归锁：preview rpc-wire 曾是主线 wire.ts 的旧平移——事件帧直转
// 不解包批帧，llm/delta-batch（stream-bridge 经 LlmDeltaBatcher 合帧的
// 下行词汇）原样到达 feed-core，而 feed-core 只有 case 'llm/delta' →
// 流式 delta 全部静默丢弃（前端不流式的根因）。本件锁：批帧在 wire
// 入口展开为逐帧 llm/delta（参数序 [input(投影), chunk, meta]）。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { wireRpcBrowser, setWireSocketFactory, RECONNECT_BASE_MS } from '../client/rpc-wire.ts';
// jsdom location 自带（ws URL 构造用）；vitest 单测间单例跨用例共享，
// disposeForTest 不在 beforeEach 调——onEvent 卸载靠返回的 disposer缺失无碍（hook 幂等累积不破坏断言面）

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 1; // OPEN（构造即通——惰性建连不需要握手态机）
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor() {
    FakeWebSocket.instances.push(this);
    // 处理器在 socket() 内构造后同步挂载——微任务时点触发 open（建连即通）
    queueMicrotask(() => this.onopen?.());
  }
  send(text: string): void { this.sent.push(text); }
  close(): void { this.readyState = 3; }
  /** 注入一帧下行 */
  feed(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/** 客户端当前持有的 socket（socket() 惰性建连自建实例——本地 new 不是它） */
function currentSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

describe('cr-586 · rpc-wire 批帧解包', () => {
  beforeEach(() => {
    setWireSocketFactory(FakeWebSocket as unknown as typeof WebSocket);
  });

  it('llm/delta-batch 展开为逐帧 llm/delta（feed-core 可消费参数序）', () => {
    const got: Array<[string, unknown[]]> = [];
    wireRpcBrowser.onEvent((type, args) => got.push([type, args]));
    currentSocket().feed({
      type: 'llm/delta-batch',
      data: { args: [{ deltas: [['__standard__', { delta: '你' }, { agent: 'a' }], ['__standard__', { delta: '好' }, { agent: 'a' }]] }] },
    });
    expect(got.map(([t]) => t)).toEqual(['llm/delta', 'llm/delta']);
    expect(got[0][1]).toEqual(['__standard__', { delta: '你' }, { agent: 'a' }]);
  });

  it('普通事件帧原样直转（解包不改变非批帧行为）', () => {
    const got: Array<[string, unknown[]]> = [];
    wireRpcBrowser.onEvent((type, args) => got.push([type, args]));
    currentSocket().feed({ type: 'llm/delta-end', data: { args: [{ model: 'm', meta: {} }, {}] } });
    expect(got).toEqual([['llm/delta-end', [{ model: 'm', meta: {} }, {}]]]);
  });

  it('rpc/result 路由不因事件面改动受扰', async () => {
    const ws = currentSocket();
    const p = wireRpcBrowser.call('conversation/stats', undefined, 'req-1', 1000);
    await new Promise((r) => setTimeout(r, 0)); // send 在 socket() 的微任务链上
    expect(JSON.parse(ws.sent[0]).data.method).toBe('conversation/stats');
    ws.feed({ type: 'rpc/result', data: { requestId: 'req-1', ok: true, result: { busy: 0 } } });
    await expect(p).resolves.toEqual({ busy: 0 });
  });

  it('RECONNECT_BASE_MS 导出面维持（重连语义未动）', () => {
    expect(RECONNECT_BASE_MS).toBe(2000);
  });
});
