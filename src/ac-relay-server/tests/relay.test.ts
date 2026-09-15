import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RelayCore, TokenBucket, DEFAULT_LIMITS, type RelayConn } from '../src/index.ts';

// ---- 测试替身：内存连接 ----
class FakeConn implements RelayConn {
  sent: string[] = [];
  closed = false;
  private msgHandlers: ((raw: string) => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  constructor(readonly ip: string) {}
  send(s: string): void { this.sent.push(s); }
  close(): void { if (this.closed) return; this.closed = true; this.closeHandlers.forEach((h) => h()); }
  terminate(): void { this.close(); }
  onMessage(h: (raw: string) => void): void { this.msgHandlers.push(h); }
  onClose(h: () => void): void { this.closeHandlers.push(h); }
  // 测试驱动口
  recv(raw: string): void { this.msgHandlers.forEach((h) => h(raw)); }
  lastOp(): any { return this.sent.length ? JSON.parse(this.sent[this.sent.length - 1]) : null; }
}

function joinOk(c: FakeConn, room: string): boolean {
  c.recv(JSON.stringify({ op: 'join', room }));
  return c.lastOp()?.op === 'joined';
}

describe('TokenBucket', () => {
  it('突发容量内放行、耗尽后拒绝、随时间恢复', () => {
    vi.useFakeTimers();
    const b = new TokenBucket({ burst: 3, ratePerSec: 1 });
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(b.take()).toBe(true);
    vi.useRealTimers();
  });
});

describe('RelayCore 房间生命周期', () => {
  it('两方 join 成功，第三方法律上不可见（统一 room-unavailable）', () => {
    const core = new RelayCore();
    const a = new FakeConn('1.1.1.1');
    const b = new FakeConn('2.2.2.2');
    const c = new FakeConn('3.3.3.3');
    core.accept(a); core.accept(b); core.accept(c);
    const room = 'a'.repeat(32);
    expect(joinOk(a, room)).toBe(true);
    expect(joinOk(b, room)).toBe(true);
    c.recv(JSON.stringify({ op: 'join', room }));
    expect(c.lastOp()).toEqual({ op: 'room-unavailable' });
    // 首次 join 合法格式房间 = 创建（无独立 create op——配对双方先到者建）；
    // 之后的重复 join / 非法格式 / 满员 全部同码——扫描无回声
    const d = new FakeConn('4.4.4.4');
    core.accept(d);
    d.recv(JSON.stringify({ op: 'join', room: 'z'.repeat(32) }));
    expect(d.lastOp()?.op).toBe('joined');                     // 首 join = 创建
    d.recv(JSON.stringify({ op: 'join', room: 'y'.repeat(32) }));
    expect(d.lastOp()).toEqual({ op: 'room-unavailable' });    // 已在房间
    d.recv(JSON.stringify({ op: 'join', room: 'short' }));
    expect(d.lastOp()).toEqual({ op: 'room-unavailable' });    // 非法格式
    a.recv(JSON.stringify({ op: 'join', room: 'b'.repeat(32) }));
    expect(a.lastOp()).toEqual({ op: 'room-unavailable' });    // 重复 join
  });

  it('帧 opaque 原样转发给对方', () => {
    const core = new RelayCore();
    const a = new FakeConn('1.1.1.1');
    const b = new FakeConn('2.2.2.2');
    core.accept(a); core.accept(b);
    joinOk(a, 'r'.repeat(32)); joinOk(b, 'r'.repeat(32));
    a.recv(JSON.stringify({ op: 'frame', data: { n: 1, ct: '密文块==' } }));
    expect(b.sent).toHaveLength(2); // joined 回执 + 1 帧
    expect(JSON.parse(b.sent[1])).toEqual({ op: 'frame', data: { n: 1, ct: '密文块==' } });
    expect(a.sent).toHaveLength(1); // 自己只有 joined，不回声帧
  });

  it('任一离线 → 房间销毁，双方都断', () => {
    const core = new RelayCore();
    const a = new FakeConn('1.1.1.1');
    const b = new FakeConn('2.2.2.2');
    core.accept(a); core.accept(b);
    const room = 'c'.repeat(32);
    joinOk(a, room); joinOk(b, room);
    a.close();
    expect(b.closed).toBe(true);
    expect(core.roomCount).toBe(0);
  });

  it('未入房间发 frame → 断连', () => {
    const core = new RelayCore();
    const a = new FakeConn('1.1.1.1');
    core.accept(a);
    a.recv(JSON.stringify({ op: 'frame', data: 'x' }));
    expect(a.closed).toBe(true);
  });

  it('ping/pong 与心跳：超时成员被 sweep 清除', () => {
    vi.useFakeTimers();
    const core = new RelayCore(DEFAULT_LIMITS);
    const a = new FakeConn('1.1.1.1');
    const b = new FakeConn('2.2.2.2');
    core.accept(a); core.accept(b);
    joinOk(a, 'd'.repeat(32)); joinOk(b, 'd'.repeat(32));
    a.recv(JSON.stringify({ op: 'ping' }));
    expect(a.lastOp()).toEqual({ op: 'pong' });
    vi.advanceTimersByTime(DEFAULT_LIMITS.heartbeatTimeoutMs + 1000);
    core.sweep();
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    vi.useRealTimers();
  });

  it('未封闭房间 TTL 过期销毁', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    const core = new RelayCore(DEFAULT_LIMITS);
    const a = new FakeConn('1.1.1.1');
    core.accept(a);
    joinOk(a, 'e'.repeat(32));
    vi.advanceTimersByTime(DEFAULT_LIMITS.openRoomTtlMs + 1000);
    core.sweep();
    expect(a.closed).toBe(true);
    expect(core.roomCount).toBe(0);
    vi.useRealTimers();
  });
});

describe('RelayCore 防滥用限额', () => {
  it('单 IP 并发连接上限', () => {
    const core = new RelayCore({ ...DEFAULT_LIMITS, maxConnPerIp: 2 });
    const a = new FakeConn('9.9.9.9');
    const b = new FakeConn('9.9.9.9');
    const c = new FakeConn('9.9.9.9');
    expect(core.accept(a)).toBe(true);
    expect(core.accept(b)).toBe(true);
    expect(core.accept(c)).toBe(false);
    a.close();
    const d = new FakeConn('9.9.9.9');
    expect(core.accept(d)).toBe(true); // 断开释放名额
  });

  it('join 频控：超 10/min 后拒绝（同码）', () => {
    vi.useFakeTimers();
    const core = new RelayCore({ ...DEFAULT_LIMITS, maxConnPerIp: 10 });
    // 单连接只进一个房间 → 频控测试用独立连接（同 IP）
    const mk = () => { const c = new FakeConn('8.8.8.8'); core.accept(c); return c; };
    for (let i = 0; i < 5; i++) {
      const c = mk();
      c.recv(JSON.stringify({ op: 'join', room: 'f'.repeat(30) + i.toString().padStart(2, '0') }));
      expect(c.lastOp()?.op).toBe('joined');
    }
    const g = mk();
    g.recv(JSON.stringify({ op: 'join', room: 'g'.repeat(32) }));
    expect(g.lastOp()).toEqual({ op: 'room-unavailable' }); // burst 耗尽
    vi.useRealTimers();
  });

  it('超限帧 → 断连', () => {
    const core = new RelayCore({ ...DEFAULT_LIMITS, maxFrameBytes: 100 });
    const a = new FakeConn('1.1.1.1');
    const b = new FakeConn('2.2.2.2');
    core.accept(a); core.accept(b);
    joinOk(a, 'h'.repeat(32)); joinOk(b, 'h'.repeat(32));
    a.recv('x'.repeat(200));
    expect(a.closed).toBe(true);
  });

  it('单房间日流量上限 → 房间销毁', () => {
    const core = new RelayCore({ ...DEFAULT_LIMITS, roomDailyBytes: 300 });
    const a = new FakeConn('1.1.1.1');
    const b = new FakeConn('2.2.2.2');
    core.accept(a); core.accept(b);
    joinOk(a, 'i'.repeat(32)); joinOk(b, 'i'.repeat(32));
    for (let k = 0; k < 10 && !a.closed; k++) {
      a.recv(JSON.stringify({ op: 'frame', data: 'x'.repeat(30) }));
    }
    expect(a.closed).toBe(true);
    expect(core.roomCount).toBe(0);
  });

  it('全局房间数上限', () => {
    const core = new RelayCore({ ...DEFAULT_LIMITS, maxRooms: 1 });
    const a = new FakeConn('1.1.1.1');
    const b = new FakeConn('2.2.2.2');
    core.accept(a); core.accept(b);
    joinOk(a, 'j'.repeat(32));
    b.recv(JSON.stringify({ op: 'join', room: 'k'.repeat(32) }));
    expect(b.lastOp()).toEqual({ op: 'room-unavailable' });
  });

  it('非 JSON / 非法 op → 断连', () => {
    const core = new RelayCore();
    const a = new FakeConn('1.1.1.1');
    core.accept(a);
    a.recv('not-json');
    expect(a.closed).toBe(true);
  });
});
