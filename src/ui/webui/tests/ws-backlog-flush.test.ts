// ============================================================
// ws-backlog-flush.test.ts —— 积压消息 flush 队列回归
//
// 背景 bug（用户实报）：
//   控制台反复出现 `[WS Client] 正在发送 1 条积压消息`，但该消息
//   「一直积压没有发送」。
//
// 根因：flushPending 先逐条 send、最后才清空队列，且不在 try 内——
//   若某条积压消息的 payload 无法 JSON 序列化（循环引用/BigInt 等，
//   入队时不序列化、只有真正发送时才 stringify），send 抛出的异常
//   会带着 onopen 一起中断，`pendingMessages = []` 永不执行：
//   毒消息永久滞留队列 → 每次重连（90s 静默看门狗也周期性触发重连）
//   都再次 flush → 再次抛错 → 「正在发送 1 条积压消息」无限复读。
//
// 本文件钉住的不变量：
//   ① 页面加载竞态（WS 握手中发的 agent.list）flush 一次后队列即清空，
//     重连不重发；
//   ② flush 中单条失败只丢弃该条（ERROR 日志可诊断），不阻断其余消息、
//     不再把异常抛出 onopen、更不能让毒消息无限重试；
//   ③ CLOSING 窗口发的消息在新连接上补发（现行设计），旧 socket 迟到
//     的 close 不影响新连接（身份守卫）。
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from '../src/utils/logger';
import { WebSocketClient } from '../src/services/websocket';

// ── Fake WebSocket（手动生命周期）──
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

class FakeWebSocket {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  /** send 抛错开关（模拟浏览器 send 失败，如连接已死） */
  sendShouldThrow = false;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.sendShouldThrow) throw new Error('SEND_FAILED');
    this.sent.push(data);
  }

  close(): void {
    /* 生命周期由测试手动控制 */
  }

  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  simulateClose(): void {
    this.readyState = CLOSED;
    this.onclose?.();
  }
}

let instances: FakeWebSocket[];

describe('WebSocketClient 积压消息 flush', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
    instances = FakeWebSocket.instances;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function newClient(): WebSocketClient {
    return new WebSocketClient('ws://test/ws');
  }

  it('① 握手中入队的消息在连接建立后 flush 一次，重连不重发（页面加载竞态）', () => {
    const c = newClient();
    c.connect(); // ws[0] CONNECTING

    // agent.list 在握手完成前发出 → 静默入队（CONNECTING 分支）
    c.send('agent.list', {});
    expect(instances[0].sent).toEqual([]);

    instances[0].simulateOpen();
    expect(instances[0].sent).toEqual([JSON.stringify({ type: 'agent.list', data: {} })]);

    // 队列已清空：断线 → 自动重连 → 新连接不再补发同一条
    instances[0].simulateClose();
    vi.advanceTimersByTime(2100); // reconnectDelay 2000
    expect(instances.length).toBe(2);
    instances[1].simulateOpen();
    expect(instances[1].sent).toEqual([]);
    const flushLogs = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      .map((c2) => String(c2[0]))
      .filter((m) => m.includes('积压消息'));
    expect(flushLogs.length).toBe(1); // 只在第一次连接 flush 过一次
    expect(flushLogs[0]).toContain('agent.list'); // 日志带消息类型（可诊断）
  });

  it('② 毒消息（循环引用 payload）：不中断 onopen、单条丢弃、不无限重试', () => {
    const c = newClient();
    c.connect();

    // 循环引用：入队时不序列化（静默），只有 flush 真正 send 时才爆炸
    const poison: any = { to: 'agent-a', content: 'hi' };
    poison.self = poison;
    c.send('chat.send', poison);

    const ws1 = instances[0];
    // 修复前：simulateOpen 会抛 TypeError（flush 未捕获），毒消息滞留队列
    expect(() => ws1.simulateOpen()).not.toThrow();
    expect(ws1.sent).toEqual([]); // 毒消息未上线
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('chat.send'),
      expect.anything(),
    );

    // 毒消息已被丢弃：重连后不再重复失败（修复前会无限复读）
    ws1.simulateClose();
    vi.advanceTimersByTime(2100);
    const ws2 = instances[1];
    expect(() => ws2.simulateOpen()).not.toThrow();
    expect(ws2.sent).toEqual([]);
  });

  it('②b 毒消息只影响自己：同批其余积压消息正常发出', () => {
    const c = newClient();
    c.connect();

    c.send('agent.list', {});
    const poison: any = { big: 1n }; // BigInt 同样无法 JSON 序列化
    c.send('chat.send', poison);
    c.send('chat.subscribe', { to: 'agent-a' });

    const ws1 = instances[0];
    expect(() => ws1.simulateOpen()).not.toThrow();
    expect(ws1.sent).toEqual([
      JSON.stringify({ type: 'agent.list', data: {} }),
      JSON.stringify({ type: 'chat.subscribe', data: { to: 'agent-a' } }),
    ]);
  });

  it('③ CLOSING 窗口的消息在新连接上补发，旧 socket 迟到关闭不影响（身份守卫）', () => {
    const c = newClient();
    c.connect();
    instances[0].simulateOpen();

    // 半开看门狗 close() 后的 CLOSING 窗口：send 走「入队 + 重建连接」
    instances[0].readyState = CLOSING;
    c.send('chat.subscribe', { to: 'agent-a' });
    expect(instances.length).toBe(2); // 立即重建

    instances[1].simulateOpen();
    expect(instances[1].sent).toEqual([
      JSON.stringify({ type: 'chat.subscribe', data: { to: 'agent-a' } }),
    ]);

    // 旧 socket 迟到的 close 事件被身份守卫忽略：新连接仍然存活
    instances[0].simulateClose();
    expect(c.isConnected).toBe(true);
  });
});
