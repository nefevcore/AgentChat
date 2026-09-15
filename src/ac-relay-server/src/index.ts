// ============================================================
// ac-relay-server —— 哑中继（remote-client-relay-plan §4.3）
//
// 设计铁律（“仅对接，不存储不探测”的结构化兑现）：
//   · 房间 = 恰好两方的内存管道；第三人 join 一律 room-unavailable
//     （统一错误码——不区分不存在/已满/已过期，扫描无存在性回声）；
//   · frame = opaque 密文转发：不解析、不落盘、不记内容日志；
//   · 任一离线 → 房间立即销毁；未封闭房间 TTL 5min；
//   · 防滥用四重限额（连接/房间/帧大小/速率）+ join 频控 + 单房间流量上限；
//   · 无数据库、无磁盘卷——重启即失忆是特性。
// ============================================================

/** 控制帧（relay 全部词汇——就这四种） */
export type RelayClientMessage =
  | { op: 'join'; room: string }
  | { op: 'frame'; data: unknown }
  | { op: 'ping' }
  | { op: 'close' };

export type RelayServerMessage =
  | { op: 'joined' }
  | { op: 'room-unavailable' }        // 统一错误码（不存在/已满/已过期同码）
  | { op: 'frame'; data: unknown }
  | { op: 'pong' }
  | { op: 'error'; code: string; message?: string };

export interface RateLimiterOptions {
  /** 突发容量 */
  burst: number;
  /** 每秒恢复速率 */
  ratePerSec: number;
}

/** 令牌桶（进程内存——防滥用不需要跨重启精度） */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly opts: RateLimiterOptions) {
    this.tokens = opts.burst;
  }
  take(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.opts.burst, this.tokens + ((now - this.last) / 1000) * this.opts.ratePerSec);
    this.last = now;
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}

export interface RelayLimits {
  /** 单 IP 并发连接上限 */
  maxConnPerIp: number;
  /** 全局房间数上限 */
  maxRooms: number;
  /** 单帧大小上限（字节，字符串长度计） */
  maxFrameBytes: number;
  /** 帧速率令牌桶 */
  frameBucket: RateLimiterOptions;
  /** join 频控令牌桶 */
  joinBucket: RateLimiterOptions;
  /** 单房间每日流量上限（字节——入向计） */
  roomDailyBytes: number;
  /** 未封闭房间 TTL（ms） */
  openRoomTtlMs: number;
  /** 房间成员心跳超时（ms，任一方超时未 pong 即断开销毁房间） */
  heartbeatTimeoutMs: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  maxConnPerIp: 5,
  maxRooms: 10_000,
  maxFrameBytes: 1024 * 1024,
  frameBucket: { burst: 60, ratePerSec: 30 },
  joinBucket: { burst: 5, ratePerSec: 10 / 60 }, // 10/min
  roomDailyBytes: 1024 * 1024 * 1024,            // 1 GiB/天
  openRoomTtlMs: 5 * 60 * 1000,
  heartbeatTimeoutMs: 60 * 1000,
};

/** room id 合法形状：22-43 字符 urlsafe base64（128-256 bit 熵） */
const ROOM_ID_RE = /^[A-Za-z0-9_-]{22,43}$/;

/** 房间：恰好两方 + 流量计数 */
interface Room {
  peers: { ws: { send: (s: string) => void; close: () => void; terminate: () => void }; ip: string }[];
  createdAt: number;
  /** 入向字节累计（按自然日重置——防免费中转滥用） */
  dayKey: string;
  bytesIn: number;
  /** 双方 join 后每个成员的心跳截止时刻（超时未见 ping 即断开） */
  lastSeen: number[];
}

/** 连接句柄抽象（可注入测试替身） */
export interface RelayConn {
  ip: string;
  send: (s: string) => void;
  close: () => void;
  terminate: () => void;
  onMessage: (h: (raw: string) => void) => void;
  onClose: (h: () => void) => void;
}

/**
 * 中继核心（纯逻辑，传输层无关——ws 适配器在 main.ts）。
 * 单实例内存态；所有计数与房间均不落盘。
 */
export class RelayCore {
  private readonly rooms = new Map<string, Room>();
  private readonly ipConns = new Map<string, number>();
  private readonly joinBuckets = new Map<string, TokenBucket>();
  private readonly frameBuckets = new Map<string, TokenBucket>();
  private closed = false;

  constructor(private readonly limits: RelayLimits = DEFAULT_LIMITS) {}

  /** 每分钟一次的全局清扫（未封闭 TTL 房间 + 心跳超时成员） */
  sweep(now = Date.now()): void {
    for (const [id, room] of this.rooms) {
      if (room.peers.length < 2 && now - room.createdAt > this.limits.openRoomTtlMs) {
        this.destroyRoom(id);
        continue;
      }
      // 心跳超时：断开呆死成员（正常成员每 <30s 一 ping）
      for (let i = 0; i < room.peers.length; i++) {
        if (now - room.lastSeen[i] > this.limits.heartbeatTimeoutMs) {
          this.destroyRoom(id);
          break;
        }
      }
    }
  }

  /** 新连接接入（返回 false = 达单 IP 连接上限，传输层应立即关闭） */
  accept(conn: RelayConn): boolean {
    if (this.closed) return false;
    const n = this.ipConns.get(conn.ip) ?? 0;
    if (n >= this.limits.maxConnPerIp) return false;
    this.ipConns.set(conn.ip, n + 1);

    let joinedRoom: string | null = null;
    let bucket = this.getFrameBucket(conn.ip);

    const detach = () => {
      const c = this.ipConns.get(conn.ip) ?? 1;
      if (c <= 1) this.ipConns.delete(conn.ip); else this.ipConns.set(conn.ip, c - 1);
      if (joinedRoom) this.destroyRoom(joinedRoom);
    };

    conn.onClose(detach);

    conn.onMessage((raw) => {
      const len = raw.length;
      if (len > this.limits.maxFrameBytes) { conn.close(); return; }
      let msg: RelayClientMessage;
      try { msg = JSON.parse(raw) as RelayClientMessage; } catch { conn.close(); return; }
      if (msg == null || typeof msg !== 'object' || typeof msg.op !== 'string') { conn.close(); return; }

      switch (msg.op) {
        case 'ping':
          this.touch(conn, joinedRoom);
          conn.send(JSON.stringify({ op: 'pong' } satisfies RelayServerMessage));
          return;
        case 'join': {
          if (joinedRoom) { conn.send(JSON.stringify({ op: 'room-unavailable' } satisfies RelayServerMessage)); return; }
          if (typeof msg.room !== 'string' || !ROOM_ID_RE.test(msg.room)) {
            conn.send(JSON.stringify({ op: 'room-unavailable' } satisfies RelayServerMessage));
            return;
          }
          if (!this.getJoinBucket(conn.ip).take()) {
            conn.send(JSON.stringify({ op: 'room-unavailable' } satisfies RelayServerMessage));
            return;
          }
          if (this.rooms.size >= this.limits.maxRooms && !this.rooms.has(msg.room)) {
            conn.send(JSON.stringify({ op: 'room-unavailable' } satisfies RelayServerMessage));
            return;
          }
          let room = this.rooms.get(msg.room);
          if (!room) {
            room = { peers: [], createdAt: Date.now(), dayKey: dayKeyOf(), bytesIn: 0, lastSeen: [] };
            this.rooms.set(msg.room, room);
            // 未封闭 TTL / 心跳超时统一由全局 sweep()（main.ts 每 60s，已
            // unref）兜底——房间级定时器会钉住事件循环（进程不退出事故）
          }
          if (room.peers.length >= 2) {
            conn.send(JSON.stringify({ op: 'room-unavailable' } satisfies RelayServerMessage));
            return;
          }
          room.peers.push({ ws: conn, ip: conn.ip });
          room.lastSeen.push(Date.now());
          joinedRoom = msg.room;
          this.touch(conn, joinedRoom);
          conn.send(JSON.stringify({ op: 'joined' } satisfies RelayServerMessage));
          return;
        }
        case 'frame': {
          const roomId = joinedRoom;
          if (!roomId) { conn.close(); return; }
          if (!bucket.take()) { conn.close(); return; }
          const room = this.rooms.get(roomId);
          if (!room) { conn.close(); return; }
          // 流量记账（入向；自然日翻转即重置）
          const dk = dayKeyOf();
          if (room.dayKey !== dk) { room.dayKey = dk; room.bytesIn = 0; }
          room.bytesIn += len;
          if (room.bytesIn > this.limits.roomDailyBytes) { this.destroyRoom(roomId); return; }
          const other = room.peers.find((p) => p.ws !== (conn as unknown)) ?? room.peers.find((p) => p.ws !== conn);
          if (!other) return;
          this.touch(conn, roomId);
          // opaque 原样转发（不解析 data——relay 对载荷零理解）
          other.ws.send(raw);
          return;
        }
        default:
          conn.close();
      }
    });
    return true;
  }

  /** 心跳刷新（ping/join/frame 均算活跃） */
  private touch(conn: RelayConn, roomId: string | null): void {
    if (!roomId) return;
    const room = this.rooms.get(roomId);
    if (!room) return;
    const idx = room.peers.findIndex((p) => p.ws === conn);
    if (idx >= 0) room.lastSeen[idx] = Date.now();
  }

  private destroyRoom(id: string): void {
    const room = this.rooms.get(id);
    if (!room) return;
    for (const p of room.peers) { try { p.ws.close(); } catch { /* 已断 */ } }
    this.rooms.delete(id);
  }

  private getJoinBucket(ip: string): TokenBucket {
    let b = this.joinBuckets.get(ip);
    if (!b) { b = new TokenBucket(this.limits.joinBucket); this.joinBuckets.set(ip, b); }
    return b;
  }

  private getFrameBucket(ip: string): TokenBucket {
    let b = this.frameBuckets.get(ip);
    if (!b) { b = new TokenBucket(this.limits.frameBucket); this.frameBuckets.set(ip, b); }
    return b;
  }

  /** 房间数（监控/测试用） */
  get roomCount(): number { return this.rooms.size; }

  /** 优雅关闭：销毁全部房间 */
  shutdown(): void {
    this.closed = true;
    for (const id of [...this.rooms.keys()]) this.destroyRoom(id);
  }
}

function dayKeyOf(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
