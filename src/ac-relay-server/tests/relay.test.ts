import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RelayCore, TokenBucket, DEFAULT_LIMITS, normalizeIp, type RelayConn } from '../src/index.ts';

describe('normalizeIp（F-2：IPv6 /64 聚合）', () => {
  it('IPv6 截前 4 组；IPv4 / 映射地址 / 非 IP 串原样或归一', () => {
    expect(normalizeIp('2001:db8:1:2:0:0:0:a')).toBe('2001:db8:1:2');
    expect(normalizeIp('2001:db8:1:2::dead:beef')).toBe('2001:db8:1:2');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80:0:0:0'); // 展开为 fe80:0:0:0:0:0:0:1 后取前 4 组
    expect(normalizeIp('::ffff:9.9.9.9')).toBe('9.9.9.9');
    expect(normalizeIp('9.9.9.9')).toBe('9.9.9.9');
    expect(normalizeIp('unknown')).toBe('unknown');
  });
});

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

  it('任一离线 → 房间保留，幸存者收 peer-left（cr-70 常住方模型）', () => {
    const core = new RelayCore();
    const a = new FakeConn('1.1.1.1');
    const b = new FakeConn('2.2.2.2');
    core.accept(a); core.accept(b);
    const room = 'c'.repeat(32);
    joinOk(a, room); joinOk(b, room);
    a.close();
    // 幸存者不被断，收到 peer-left 通知；房间保留（1 席）
    expect(b.closed).toBe(false);
    expect(b.lastOp()).toEqual({ op: 'peer-left' });
    expect(core.roomCount).toBe(1);
    // 对端回归：新连接 join 同房间 → 成功，幸存者收 peer-arrived
    const a2 = new FakeConn('1.1.1.1');
    core.accept(a2);
    expect(joinOk(a2, room)).toBe(true);
    expect(b.lastOp()).toEqual({ op: 'peer-arrived' });
  });

  it('帧 opaque 原样转发给对方', () => {
    const core = new RelayCore();
    const a = new FakeConn('1.1.1.1');
    const b = new FakeConn('2.2.2.2');
    core.accept(a); core.accept(b);
    joinOk(a, 'r'.repeat(32)); joinOk(b, 'r'.repeat(32));
    a.recv(JSON.stringify({ op: 'frame', data: { n: 1, ct: '密文块==' } }));
    expect(b.lastOp()).toEqual({ op: 'frame', data: { n: 1, ct: '密文块==' } });
    // a：joined 回执 + peer-arrived（b 加入通知，cr-70），无回声帧
    expect(a.sent.every((s) => JSON.parse(s).op !== 'frame')).toBe(true);
  });

  it('全员离线 → 房间销毁（cr-70：无幸存者即收尾）', () => {
    const core = new RelayCore();
    const a = new FakeConn('1.1.1.1');
    const b = new FakeConn('2.2.2.2');
    core.accept(a); core.accept(b);
    const room = 'c2'.repeat(16);
    joinOk(a, room); joinOk(b, room);
    a.close();
    b.close();
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
    // b 保持心跳（advance 后仍活跃），a 只在 join 时 touch 过——61s 后必超时
    vi.advanceTimersByTime(DEFAULT_LIMITS.heartbeatTimeoutMs / 2);
    b.recv(JSON.stringify({ op: 'ping' }));
    vi.advanceTimersByTime(DEFAULT_LIMITS.heartbeatTimeoutMs / 2 + 2000);
    core.sweep();
    // cr-70：只清超时成员 a；b（有心跳）幸存并收 peer-left
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
    expect(b.lastOp()).toEqual({ op: 'peer-left' });
    vi.useRealTimers();
  });

  it('曾封闭的常住房回落 1 席 → TTL 不杀（cr-72：由心跳保活）', () => {
    vi.useFakeTimers();
    const core = new RelayCore(DEFAULT_LIMITS);
    const a = new FakeConn('1.1.1.1');
    const b = new FakeConn('2.2.2.2');
    core.accept(a); core.accept(b);
    const room = 'e9'.repeat(16);
    joinOk(a, room); joinOk(b, room); // 封闭过
    b.close(); // 回落 1 席（a 幸存，收 peer-left）
    // 远超 openRoomTtl 的 5 分钟——只要 a 持续心跳，房间活着
    for (let round = 0; round < 8; round++) {
      vi.advanceTimersByTime(45_000);
      a.recv(JSON.stringify({ op: 'ping' }));
      core.sweep();
    }
    expect(core.roomCount).toBe(1);
    // a 停止心跳 → 心跳超时兜底收房
    vi.advanceTimersByTime(DEFAULT_LIMITS.heartbeatTimeoutMs + 2000);
    core.sweep();
    expect(core.roomCount).toBe(0);
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

  it('join 频控：burst 耗尽后拒绝（cr-43 ⑬ 参数：30/min·burst 20）', () => {
    vi.useFakeTimers();
    // maxOpenRoomsPerIp 放开到 burst 之上——本测试聚焦频控语义，不与 cr-64 房间配额纠缠
    const core = new RelayCore({ ...DEFAULT_LIMITS, maxConnPerIp: 40, maxOpenRoomsPerIp: 40 });
    // 单连接只进一个房间 → 频控测试用独立连接（同 IP）
    const mk = () => { const c = new FakeConn('8.8.8.8'); core.accept(c); return c; };
    for (let i = 0; i < DEFAULT_LIMITS.joinBucket.burst; i++) {
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

  it('单 IP 未封闭房间配额：超过 maxOpenRoomsPerIp 拒新建（cr-64 占座阻断压缩）', () => {
    const core = new RelayCore({ ...DEFAULT_LIMITS, maxOpenRoomsPerIp: 2 });
    const mk = () => { const c = new FakeConn('7.7.7.7'); core.accept(c); return c; };
    // 同 IP 建 2 个未封闭（1 席）房间：配额内
    expect(joinOk(mk(), 'm'.repeat(32))).toBe(true);
    expect(joinOk(mk(), 'n'.repeat(32))).toBe(true);
    // 第 3 个：超配额拒绝（统一 room-unavailable）
    const g = mk();
    g.recv(JSON.stringify({ op: 'join', room: 'o'.repeat(32) }));
    expect(g.lastOp()).toEqual({ op: 'room-unavailable' });
    // 其他 IP 不受影响
    const other = new FakeConn('6.6.6.6');
    core.accept(other);
    expect(joinOk(other, 'p'.repeat(32))).toBe(true);
    // 加入既有房间不受配额限制（不惩罚会合方）：第二方加入第 1 个房间 → 封闭
    const meet = mk();
    expect(joinOk(meet, 'm'.repeat(32))).toBe(true);
  });

  it('sweep 清扫长期无 take 的频控 bucket（cr-64 泄漏修复）', () => {
    vi.useFakeTimers();
    // 速率 0（永不恢复）让「残留 bucket」与「清扫后重建」行为可区分：残留 = 永久拒绝
    const core = new RelayCore({ ...DEFAULT_LIMITS, joinBucket: { burst: 3, ratePerSec: 0 }, maxOpenRoomsPerIp: 8 });
    const a = new FakeConn('5.5.5.5');
    core.accept(a);
    a.recv(JSON.stringify({ op: 'join', room: 'q'.repeat(32) })); // join bucket 建条目并耗 1 token
    vi.advanceTimersByTime(601_000); // > 10 分钟无 take
    core.sweep(); // 清扫后 bucket 重建 = burst 满额
    const mk = () => { const c = new FakeConn('5.5.5.5'); core.accept(c); return c; };
    for (let i = 0; i < 3; i++) {
      const c = mk(); // 单连接只进一个房间 → 独立连接（同 IP）
      c.recv(JSON.stringify({ op: 'join', room: 's'.repeat(30) + i.toString().padStart(2, '0') }));
      expect(c.lastOp()?.op).toBe('joined'); // 残留 bucket（剩 2 token）第 3 次会被拒——此处 3 次全过即证明 bucket 已清重建
    }
    vi.useRealTimers();
  });

  it('非 JSON / 非法 op → 断连', () => {
    const core = new RelayCore();
    const a = new FakeConn('1.1.1.1');
    core.accept(a);
    a.recv('not-json');
    expect(a.closed).toBe(true);
  });

  it('per-IP 房间配额含 everClosed 房间（F-2：封闭后退席不再移出统计）', () => {
    const core = new RelayCore({ ...DEFAULT_LIMITS, maxOpenRoomsPerIp: 2 });
    const mk = () => { const c = new FakeConn('7.7.7.7'); core.accept(c); return c; };
    // 房1：两方封闭 → 一方退席（everClosed=true，剩 1 席靠 ping 保活）
    const r1a = mk(); joinOk(r1a, 'v'.repeat(32));
    const r1b = mk(); joinOk(r1b, 'v'.repeat(32));
    r1b.close();
    // 房2：正常占座。此时该 IP 名下 2 房（1 个 everClosed + 1 个未封闭）→ 配额满
    expect(joinOk(mk(), 'w'.repeat(32))).toBe(true);
    const g = mk();
    g.recv(JSON.stringify({ op: 'join', room: 'x'.repeat(32) }));
    expect(g.lastOp()).toEqual({ op: 'room-unavailable' }); // 旧实现此处放行（绕过）
  });

  it('IPv6 同 /64 前缀聚合为一个频控桶（F-2：轮换源地址不再各自计数）', () => {
    const core = new RelayCore({ ...DEFAULT_LIMITS, maxConnPerIp: 2 });
    // 同 /64 内两个不同 /128 源地址 → 共享 per-IP 并发配额
    expect(core.accept(new FakeConn('2001:db8:1:2:0:0:0:a'))).toBe(true);
    expect(core.accept(new FakeConn('2001:db8:1:2:0:0:0:b'))).toBe(true);
    expect(core.accept(new FakeConn('2001:db8:1:2:0:0:0:c'))).toBe(false); // 第 3 条：超 2 上限
    // 异 /64 不受影响
    expect(core.accept(new FakeConn('2001:db8:1:3:0:0:0:a'))).toBe(true);
    // IPv4 映射地址与点分 IPv4 归一到同一桶（::ffff: 剥离；per-IP 口 2）
    const m4 = new FakeConn('::ffff:9.9.9.9');
    expect(core.accept(m4)).toBe(true);
    expect(core.accept(new FakeConn('9.9.9.9'))).toBe(true);
    // 第三条仍是同地址的映射形态 → 同桶第 3 条，拒绝
    expect(core.accept(new FakeConn('::ffff:9.9.9.9'))).toBe(false);
    m4.close(); // 释放一席，验证桶计数随断开递减
    expect(core.accept(new FakeConn('::ffff:9.9.9.9'))).toBe(true);
  });

  it('全局总连接上限（F-2 兜底：maxTotalConns）', () => {
    const core = new RelayCore({ ...DEFAULT_LIMITS, maxConnPerIp: 100, maxTotalConns: 3 });
    for (let i = 0; i < 3; i++) {
      expect(core.accept(new FakeConn(`10.0.${i}.1`))).toBe(true);
    }
    expect(core.accept(new FakeConn('10.9.9.9'))).toBe(false); // 全局满（各 IP 均未超 per-IP 口）
  });

  it('ping 同样收帧速率桶费（F-3：无限速 ping 不再绕过限速）', async () => {
    vi.useFakeTimers();
    const core = new RelayCore({ ...DEFAULT_LIMITS, frameBucket: { burst: 3, ratePerSec: 0 } });
    const a = new FakeConn('1.1.1.1');
    core.accept(a);
    for (let i = 0; i < 3; i++) {
      a.recv(JSON.stringify({ op: 'ping' }));
      expect(a.lastOp()).toEqual({ op: 'pong' });
    }
    a.recv(JSON.stringify({ op: 'ping' })); // 第 4 条：桶空（rate 0 永不恢复）
    expect(a.closed).toBe(true);
    vi.useRealTimers();
  });
});
