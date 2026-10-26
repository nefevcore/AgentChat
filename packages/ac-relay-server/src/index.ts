// ============================================================
// ac-relay-server —— 哑中继（remote-client-relay-plan §4.3）
//
// 设计铁律（“仅对接，不存储不探测”的结构化兑现）：
//   · 房间 = 恰好两方的内存管道；第三人 join 一律 room-unavailable
//     （统一错误码——不区分不存在/已满/已过期，扫描无存在性回声）；
//   · frame = opaque 密文转发：不解析、不落盘、不记内容日志；
//   · 房间寿命 = 常住方模型（cr-70/72）：成员离线只移除该成员并通知幸存者
//     （peer-left），房间随幸存者心跳存活；全员离场即销毁；从未封闭的
//     房间存活统一由成员心跳判活（60s 超时兜底）——哑中继的
//     “哑”（内容盲/身份盲/重启失忆）分毫未动，变的只是管道寿命策略；
//   · 防滥用四重限额（连接/房间/帧大小/速率）+ join 频控 + 单房间流量上限；
//   · 无数据库、无磁盘卷——重启即失忆是特性。
// ============================================================

/** 控制帧（relay 全部词汇） */
export type RelayClientMessage =
  | { op: 'join'; room: string }
  | { op: 'frame'; data: unknown }
  | { op: 'ping' }
  | { op: 'close' };

export type RelayServerMessage =
  | { op: 'joined' }
  | { op: 'room-unavailable' }        // 统一错误码（不存在/已满/已过期同码）
  | { op: 'peer-left' }               // cr-70 常住方模型：对端离线通知（房间保留）
  | { op: 'peer-arrived' }            // cr-70：对端加入通知（幸存者可重握手）
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
  /** 最近一次 take 时刻（sweep 清扫残留 bucket 用——cr-64：高频 IP 永久泄漏修复） */
  lastTake = Date.now();
  private readonly opts: RateLimiterOptions;
  constructor(opts: RateLimiterOptions) {
    this.opts = opts;
    this.tokens = opts.burst;
  }
  take(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.opts.burst, this.tokens + ((now - this.last) / 1000) * this.opts.ratePerSec);
    this.last = now;
    this.lastTake = now;
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
  /** 房间成员心跳超时（ms，任一方超时未 pong 即断开） */
  heartbeatTimeoutMs: number;
  /** 单 IP 名下房间数上限——cr-64：占座阻断的纵深压缩 */
  maxOpenRoomsPerIp: number;
  /** 全局并发连接上限（F-2 兜底：IPv6 /64 内轮换源地址时 per-IP 桶全部
   *  独立计，一台机器可刷满房间池——全局口是耗尽攻击的最后一道闸） */
  maxTotalConns: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  // 同 IP 并发连接上限（cr-43 ⑬ 真机实锤修正）：两端 NAT 同出口时手机 KK 重连（每轮
  // 新建连接，3s 超时窗口内连接未及释放）+ 核心端 KK 重试 + 管理探测 = 轻易 6+ 并发，
  // 原值 5 必触发 1013 try-again-later 互杀。12 = 双端各 5 活动连接 + 余量；防扫描
  // 语义由 join 频控承担。
  maxConnPerIp: 30,
  maxRooms: 10_000,
  // 单帧上限：初值 1MB 对远程链路的正当载荷过紧——webui 的会话历史/运行快照类
  // RPC 应答（+ Noise 封装开销）轻易破 1MB，超限即被 relay 关连接（M3.2 实测：
  // 桥的上游在一两分钟后静默失效）。防滥用主力是速率桶与房间日流量上限（均不变）；
  // 本项只防单帧 OOM，放宽到 8MB。真正解法（分片）见 M3.4 待办。
  maxFrameBytes: 8 * 1024 * 1024,
  // 帧速率桶（cr-248 调参）：30/s 在手机端 webui 启动/切页洪峰（懒加载 chunk 并发
  // rpc/call + vite import 失败重试 + 事件对账）下打空 → fail-loud 断链 → 在途 RPC
  // 全超时（真机实锤 #59 closed 1006 与手机「链路关闭」同刻）。60/s + burst 120
  // 覆盖合法峰值；防滥用语义不变（持续灌帧仍触顶，单帧 8MB 限制不动）。
  frameBucket: { burst: 120, ratePerSec: 60 },
  // join 频控（cr-43 ⑬ 真机实锤修正）：两端 NAT 同出口 IP 时，手机 KK 重连（7s ≈ 8.5/min）
  // + 核心端 KK 重试同速率 = 17/min 合法流量，原 10/min 上限必杀——burst 5 连 3s 超时
  // 重试的首轮都撑不过。防扫描语义保留（30/min 仍拦暴力枚举），合法双端重联不再互杀。
  joinBucket: { burst: 20, ratePerSec: 30 / 60 }, // 30/min
  roomDailyBytes: 1024 * 1024 * 1024,            // 1 GiB/天
  heartbeatTimeoutMs: 60 * 1000,
  // cr-64：单 IP 未封闭房间配额。正常拓扑每 IP 同时至多 2 条链（双端各一）×
  // 各 1 房；手机 4s/轮重试 + 核心端 70s 长驻的瞬态峰值也不超过 4-6 房。8 = 合法
  // 流量 2 倍余量，同时把「一 IP 占满全局房间池」的耗尽攻击面压到 8 房/IP。
  maxOpenRoomsPerIp: 8,
  // 正常拓扑 ≈ 每房间 2 连接 × 峰值若干 + 管理探测；30 并发/IP × 合法 IP 数
  // 远低于此。2000 = 合法流量百倍余量，单点轮换源攻击在此触顶。
  maxTotalConns: 2_000,
};

/** room id 合法形状：22-43 字符 urlsafe base64（128-256 bit 熵） */
const ROOM_ID_RE = /^[A-Za-z0-9_-]{22,43}$/;

/** 频控/配额的 IP 归一（F-2：IPv6 聚合到 /64——同前缀轮换源地址共享一个桶，
 *  防单机刷独立 /128 桶绕过 per-IP 限额；IPv4 与非 IP 串原样）。 */
export function normalizeIp(ip: string): string {
  if (ip === 'unknown') return ip;
  const bare = ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip;
  if (!bare.includes(':')) return bare; // IPv4 / 主机名（传输层注入的替身 ip）
  let v6 = bare.toLowerCase().split('%')[0]; // 去掉 zone id
  // 展开 :: 压缩（fe80::1 → fe80:0:0:0:0:0:0:1），否则 split 段数不足
  if (v6.includes('::')) {
    const [head, tail = ''] = v6.split('::');
    const headGroups = head ? head.split(':') : [];
    const tailGroups = tail ? tail.split(':') : [];
    const pad = Math.max(0, 8 - headGroups.length - tailGroups.length);
    v6 = [...headGroups, ...Array<string>(pad).fill('0'), ...tailGroups].join(':');
  }
  const groups = v6.split(':');
  if (groups.length < 4) return v6; // 形状异常——原样
  return groups.slice(0, 4).join(':'); // 前 4 组 = /64 前缀
}

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
  private totalConns = 0;
  private closed = false;

  constructor(private readonly limits: RelayLimits = DEFAULT_LIMITS) {}

  /** 周期性全局清扫（心跳超时成员 + 残留频控 bucket） */
  sweep(now = Date.now()): void {
    // bucket 泄漏修复（cr-64）：joinBuckets/frameBuckets 原本只增不减——每个
    // 出现过的高频 IP 永久残留一条 entry。10 分钟无 take 的 bucket 即无主残骸。
    for (const [ip, b] of this.joinBuckets) {
      if (now - b.lastTake > 600_000) this.joinBuckets.delete(ip);
    }
    for (const [ip, b] of this.frameBuckets) {
      if (now - b.lastTake > 600_000) this.frameBuckets.delete(ip);
    }
    for (const [_id, room] of this.rooms) {
      // 房间存活统一判据（cr-246）：成员心跳。占座房（cr-246 PC 常驻等对端）与
      // 常住房同语义——有心跳即活，无人心跳即由下面的超时清理收房。防滥用不变：
      // 恶意占房须持续心跳（受 join 频控与 per-IP 房间配额约束），且清理窗
      // 60s 反而比旧 TTL 5min 更严。
      // 心跳超时：只清超时成员（cr-70——原语义销毁全房；现在幸存者无责）。
      // terminate 会触发该连接的 onClose → detach → removeMember（通知幸存者），
      // 此处不再手动移除（同步 close 的替身会双重 splice——索引错位实锤）。
      for (let i = room.peers.length - 1; i >= 0; i--) {
        if (now - room.lastSeen[i] > this.limits.heartbeatTimeoutMs) {
          try { room.peers[i].ws.terminate(); } catch { /* 已断 */ }
        }
      }
    }
  }

  /** 新连接接入（返回 false = 达连接上限，传输层应立即关闭） */
  accept(conn: RelayConn): boolean {
    if (this.closed) return false;
    // F-2 兜底：全局总连接上限——IPv6 /64 内轮换源地址时 per-IP 桶全部独立
    // 计，单点即可绕过 per-IP 配额；全局口与 per-IP 口双闸。
    if (this.totalConns >= this.limits.maxTotalConns) return false;
    const key = normalizeIp(conn.ip);
    const n = this.ipConns.get(key) ?? 0;
    if (n >= this.limits.maxConnPerIp) return false;
    this.ipConns.set(key, n + 1);
    this.totalConns += 1;

    let joinedRoom: string | null = null;
    // F-3：帧速率桶入即领取——原实现只在 frame 分支 take，ping 等其余 op 不计
    // 速率费，单连接可不限速灌 8MB 合法 JSON 消耗 CPU/带宽。桶随连接绑定
    // （而非按消息），对端换房重连自然换桶。
    const bucket = this.getFrameBucket(key);

    const detach = () => {
      const c = this.ipConns.get(key) ?? 1;
      if (c <= 1) this.ipConns.delete(key); else this.ipConns.set(key, c - 1);
      this.totalConns -= 1;
      // cr-70 常住方模型：成员离线不再销毁房间——只移除该成员并通知幸存者。
      // 原语义（任一离线即销房）逼得双端都做重试振荡器，相位耦合修不完
      // （cr-43⑭/48/50/63/65/69 全是这类补丁）。现在：房间随幸存者的心跳
      // 存活；新成员随时可 join 进来。房间仅当无成员时由 destroyRoom 收尾。
      if (joinedRoom) this.removeMember(joinedRoom, conn);
    };

    conn.onClose(detach);

    // 连接级空闲超时（cr-43 ⑬：超时重试的客户端可能遗留半开连接——15s 未 join
    // 即清退，防僵尸爬满 per-IP 桶。unref 不钉事件循环）
    const idleTimer = setTimeout(() => {
      if (!joinedRoom) { try { conn.close(); } catch { /* 已断 */ } }
    }, 15_000);
    idleTimer.unref();

    conn.onMessage((raw) => {
      const len = raw.length;
      if (len > this.limits.maxFrameBytes) { conn.close(); return; }
      // F-3：所有 op 统一收速率费（JSON.parse 与协议处理都吃 CPU）——帧桶
      // 耗尽 = 该连接已超速，断开（fail-loud，不静默丢帧）。
      if (!bucket.take()) { conn.close(); return; }
      let msg: RelayClientMessage;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || typeof (parsed as RelayClientMessage).op !== 'string') { conn.close(); return; }
        msg = parsed as RelayClientMessage;
      } catch { conn.close(); return; }

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
          // 单 IP 房间配额（cr-64 + F-2 修正）：新建房才计（加入既有房不限——
          // 不惩罚会合方）；计入口径含全部房间——原实现只数未封闭房，
          // 攻击者可两连接封闭再退一席，把房间移出统计后靠 ping 保活，per-IP
          // 配额形同虚设。心跳保活的房间同样占内存与端口，同计数。
          if (!this.rooms.has(msg.room)) {
            const byIp = [...this.rooms.values()]
              .filter((r) => r.peers.some((p) => p.ip === conn.ip)).length;
            if (byIp >= this.limits.maxOpenRoomsPerIp) {
              conn.send(JSON.stringify({ op: 'room-unavailable' } satisfies RelayServerMessage));
              return;
            }
          }
          let room = this.rooms.get(msg.room);
          if (!room) {
            room = { peers: [], createdAt: Date.now(), dayKey: dayKeyOf(), bytesIn: 0, lastSeen: [] };
            this.rooms.set(msg.room, room);
            // 心跳超时由全局 sweep()（main.ts 每 15s，已 unref）兜底——
            // 房间级定时器会钉住事件循环（进程不退出事故）
          }
          if (room.peers.length >= 2) {
            conn.send(JSON.stringify({ op: 'room-unavailable' } satisfies RelayServerMessage));
            return;
          }
          // 成员回归（房间已有 1 席 + 本连接加入）→ 通知幸存者对端已到
          if (room.peers.length === 1) {
            room.peers[0].ws.send(JSON.stringify({ op: 'peer-arrived' } satisfies RelayServerMessage));
          }
          room.peers.push({ ws: conn, ip: conn.ip });
          room.lastSeen.push(Date.now());
          joinedRoom = msg.room;
          clearTimeout(idleTimer);
          if (process.env.RELAY_DEBUG) console.log(`[relay:dbg] join ${msg.room} from #${conn.ip} (peers=${room.peers.length})`);
          this.touch(conn, joinedRoom);
          conn.send(JSON.stringify({ op: 'joined' } satisfies RelayServerMessage));
          return;
        }
        case 'frame': {
          const roomId = joinedRoom;
          if (!roomId) { conn.close(); return; }
          const room = this.rooms.get(roomId);
          if (!room) { conn.close(); return; }
          // 流量记账（入向；自然日翻转即重置）
          const dk = dayKeyOf();
          if (room.dayKey !== dk) { room.dayKey = dk; room.bytesIn = 0; }
          room.bytesIn += len;
          if (room.bytesIn > this.limits.roomDailyBytes) { this.destroyRoom(roomId); return; }
          const other = room.peers.find((p) => p.ws !== conn);
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

  /**
   * 移除房间成员（cr-70）：通知幸存者 peer-left；房间空了才销毁。
   * 与 destroyRoom（全员清场）分工——后者仅用于销毁性事件（流量超限/sweep 收尾）。
   */
  private removeMember(roomId: string, conn: RelayConn): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const idx = room.peers.findIndex((p) => p.ws === conn);
    if (idx < 0) return;
    room.peers.splice(idx, 1);
    room.lastSeen.splice(idx, 1);
    if (room.peers.length === 0) {
      this.destroyRoom(roomId);
      return;
    }
    // 幸存者通知——不 terminate（cr-70 核心语义：幸存连接继续活）
    for (const p of room.peers) {
      try { p.ws.send(JSON.stringify({ op: 'peer-left' } satisfies RelayServerMessage)); } catch { /* 已断 */ }
    }
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
    // terminate（RST）而非 close：销毁原因多为心跳超时 = 连接已死，优雅 close 的
    // FIN 对死端无意义，只会拖住端口等超时；RST 让对端立即感知（cr-48）
    for (const p of room.peers) { try { p.ws.terminate(); } catch { /* 已断 */ } }
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
