// ============================================================
// ac-remote-link/src/relay-connection.ts —— 出站 relay 连接 + Noise 壳
//
// 传输半边（remote-client-relay-plan §4.2 的核心端实现）：
//   · 出站 wss 连 relay（自签证书 pin 到 sha256——服务器轮换证书时换 pin）；
//   · join(roomId) → 房间封闭（恰好两方）；
//   · XK（配对）/ KK（重连）握手 → TransportCipher 帧泵；
//   · 帧格式 { t: "frame", n, ct }（业务载荷 JSON 与本地 WS 协议同构）；
//   · ws 真死后指数退避重拨（1s 起，上限 60s，±20% 抖动）；对端离线走
//     常住待命（cr-70），不弃链。
//
// 与 relay 的控制帧词汇（ac-relay-server）：
//   入站 { op: "join", room } → joined | room-unavailable；
//   双向 { op: "frame", data } —— opaque 密文转发；
//   { op: "ping" } → { op: "pong" }（心跳兼保活）。
// ============================================================
import WebSocket from 'ws';
import * as crypto from 'node:crypto';
import {
  NoiseHandshake,
  TransportCipher,
  sasFromHandshakeHash,
  b64u,
  unb64u,
  type StaticIdentity,
} from 'ac-noise-core';
import type { RemoteDevice, RemoteScope } from './device-registry.ts';

/** 应用层保活间隔（relay 心跳超时 60s——留足余量） */
const KEEPALIVE_MS = 25_000;

/** relay 控制帧（本模块关心的六种） */
type RelayFrame =
  | { op: 'joined' }
  | { op: 'room-unavailable' }
  | { op: 'pong' }
  | { op: 'peer-left' }
  | { op: 'peer-arrived' }
  | { op: 'frame'; data: { t: string; n: number; ct: string } };

/** 加密业务帧的载荷形态（与本地 WS 帧 WsFrame 同构） */
export interface LinkPayload {
  type: string;
  data?: unknown;
}

export type LinkState =
  | 'idle'
  | 'connecting'
  | 'joined'
  | 'handshaking'
  | 'online'
  | 'pairing-sas'
  | 'waiting-peer'   // cr-70 常住方：对端离线，本连接原地待命（房间还在）
  | 'closed';

export interface RelayConnectOptions {
  url: string;
  roomId: string;
  /** relay TLS 证书 sha256 pin（hex；缺省 = 跳过校验——仅测试） */
  tlsPin?: string;
  /** 连接超时 ms */
  timeoutMs?: number;
  /** responder 等首条握手消息的窗口 ms（KK 路径应传覆盖发起方重试周期的长值） */
  waitFirstMsgMs?: number;
  /** KK 重连的目标设备静态公钥（base64url；pairing 房间不需要） */
  targetDevicePubkey?: string;
}

export interface HandshakeOutcome {
  kind: 'paired' | 'known';
  device: { name: string; pubkey: string };
  sas?: string;
  transport: { send: TransportCipher; recv: TransportCipher };
  handshakeHash: Buffer;
}

/**
 * 单个 relay 连接生命周期。cr-70 常住方模型后：PC 端 KK 连接常住房间——
 * 对端离线（peer-left）不弃链，原地待命（waiting-peer），对端回归的新 m1
 * 在同一条 ws 上重握手（kkRespond）。仅 ws 真死（relay 重启/网络断）才整体
 * 废弃重拨（新房间/新握手）。配对（XK）会话仍是一次性生命周期。
 */
export class RelayConnection {
  private ws: WebSocket | null = null;
  private transport: { send: TransportCipher; recv: TransportCipher } | null = null;
  state: LinkState = 'idle';
  roomId = '';
  /** 入站业务帧回调（解密后） */
  onPayload: ((payload: LinkPayload) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  /** 状态观察口（诊断用；不影响协议行为） */
  onState: ((note: string) => void) | null = null;
  /** 常住模式：对端离线（peer-left）——服务层更新设备下线状态用 */
  onPeerLeft: (() => void) | null = null;
  /** 常住模式：对端回归重握手成功——服务层恢复在线状态用 */
  onRehandshake: ((outcome: HandshakeOutcome) => void) | null = null;

  /** ws 通道活态（cr-43：connect 区分「健康在线跳过」与「死链清理重建」用） */
  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === this.ws.OPEN;
  }

  private readonly identity: StaticIdentity;

  /** KK 常住模式的目标设备公钥（b64url）——peer-left 后重握手用 */
  private kkTargetPubkey: string | null = null;

  constructor(identity: StaticIdentity) {
    this.identity = identity;
  }

  /**
   * 出站连接 + join + 响应方握手（核心端永远是 responder）。
   * knownDevices：按 pubkey 查注册表——命中走 KK，未命中走 XK（配对）。
   */
  async connectAndHandshake(
    opts: RelayConnectOptions,
    knownDevices: { getByPubkey(b64u: string): RemoteDevice | undefined },
    acceptPairing: (device: { name: string; pubkey: string }, sas: string) => Promise<boolean>,
  ): Promise<HandshakeOutcome> {
    this.state = 'connecting';
    this.roomId = opts.roomId;
    const ws = await this.dial(opts);
    this.ws = ws;
    ws.on('message', (raw) => this.handleWire(raw.toString()));
    ws.on('close', () => {
      this.stopKeepalive();
      this.state = 'closed';
      // 挂起中的握手等待立即唤醒（cr-69 真机+relay 日志双实锤：手机撞门轮
      // cancel 切 TCP → relay 销房 RST 掉本端 → 死 ws 上的 70s 等待若只靠
      // 定时器自然到期，盲等窗口内手机后续撞门全是空房——两端相位互屠，
      // 二次启动永远连不上。close 即 reject：失败路径立刻进 2s 快速重试，
      // 与手机 7.5s 撞门轮快速对齐相位。）
      this.failPendingHandshake('ws closed');
      this.onClose?.('ws closed');
    });
    ws.on('error', (err) => this.onError?.(err.message));
    // 握手期就要保活（半开连接 60s 会被 relay 判死——真机扫码耗时必超）
    this.startKeepalive();

    // join
    this.state = 'joined';
    ws.send(JSON.stringify({ op: 'join', room: opts.roomId }));
    const joined = await this.expectOp('joined', opts.timeoutMs ?? 15000);
    if (!joined) {
      ws.close();
      throw new Error('relay: join failed (room-unavailable)');
    }

    // 握手（核心端 = responder；消息由 handleWire 驱动）
    this.state = 'handshaking';
    // 诊断锚点：真机排障时这两行能区分「房间没进」「对端没发」「发了没收到」
    this.onState?.(`joined ${opts.roomId}，等待首条握手消息`);
    // KK 长等待（cr-43：responder 等 m1 的窗口必须覆盖发起方完整重试周期——
    // 原 15s 与手机 7s 轮同量级，双端对称重试相位锁定永不相遇（真机实锤：双方都在
    // 房间等对方却各自超时）。KK 路径传 70s；配对路径（XK）维持缺省短窗。
    const firstMsg = await this.expectHandshakeMessage(opts.waitFirstMsgMs ?? opts.timeoutMs ?? 15000);
    this.onState?.(`收到首条握手消息 ${firstMsg.length}B`);
    // 先以「未知对端」读第一条：XK m1 = [e]（无 s）——KK m1 = [e, es]，es 需要已知 rs。
    // 我们不知道对端是谁：先试 KK 注册表匹配（读出 rs 再定），实现上先按 XK 读——
    // 若 m1 长度 > 32 则可能是 KK？不可靠。正确做法：两条消息的第一条都以「盲读 e」开始，
    // es/se token 只在已知 rs 或读到 s 后才用。这里采用：先读 e（前 32B），然后查注册表
    // ——KK 的 es 用查到的 rs；XK 没有 es。故构造两个候选 responder，按 m1 长度分流：
    //   len == 32 + tag+payload：XK m1（payload 加密——但 m1 无 DH，载荷明文？）
    // 统一处理：用「先读 32B e + mixHash」的探测头，然后按注册表选择 KK/XK 路径。
    // 为保持实现可审计，直接规则：m1 恰好 32B + 密文载荷(>=16B tag)。我们先用盲读：
    //   XK m1: tokens=[e]，载荷加密（k 空 → 明文）。
    //   KK m1: tokens=[e, es]，载荷加密（k 非空）。
    // 无法从长度区分（载荷可变）。因此约定：**载荷首字节标记模式**（XK='P'，KK='R'，
    // 其余 = 协议错误）。m1 载荷在两种模式下都可读（XK 明文 / KK 加密——不，KK m1
    // 载荷用 es 后的密钥加密）。改用更简单的判定：注册表匹配。核心端把 m1 的 e 公钥
    // 与所有已知设备公钥比对？——e 是临时公钥，不是静态公钥，无法匹配。
    // 最终方案（与安卓端约定的信令）：**连接前 join 时把模式写进 roomId 命名空间**——
    // 配对房间以 'p:' 前缀、重连房间以 'r:' 前缀。roomId 由两端独立知晓（二维码/注册表），
    // 无歧义。
    const isPairing = opts.roomId.startsWith('p');
    let hs: NoiseHandshake;
    let outcome: HandshakeOutcome;
    if (isPairing) {
      hs = new NoiseHandshake('XK', 'responder', this.identity);
      const m1 = firstMsg;
      hs.readMessage(m1);
      this.onState?.('XK m1 已解析，发送 m2');
      const m2 = hs.writeMessage();
      this.sendHandshake(m2);
      const m3 = await this.expectHandshakeMessage(opts.timeoutMs ?? 15000);
      this.onState?.(`收到 XK m3 ${m3.length}B`);
      const deviceInfoRaw = hs.readMessage(m3);
      const info = JSON.parse(deviceInfoRaw.toString('utf8')) as { name: string; pubkey: string };
      const pair = hs.split();
      const sas = sasFromHandshakeHash(pair.handshakeHash);
      this.state = 'pairing-sas';
      const accepted = await acceptPairing(info, sas);
      if (!accepted) {
        ws.close();
        this.state = 'closed';
        throw new Error('pairing rejected (SAS mismatch)');
      }
      this.transport = pair;
      this.state = 'online';
      outcome = { kind: 'paired', device: info, sas, transport: pair, handshakeHash: pair.handshakeHash };
    } else {
      // KK 常住方（cr-70）：首条 m1 与后续重握手共用同一处理。
      const targetPub = (opts as RelayConnectOptions & { targetDevicePubkey?: string }).targetDevicePubkey;
      if (!targetPub) {
        ws.close();
        throw new Error('relay: reconnect requires targetDevicePubkey');
      }
      this.kkTargetPubkey = targetPub;
      outcome = this.kkRespond(firstMsg);
    }
    return outcome;
  }

  /**
   * KK 响应握手一轮：读 m1 → 回 m2 → 换 transport → online。
   * 幂等安全：旧 transport 直接被替换（对端已换会话，旧序号帧自然解不开）。
   */
  private kkRespond(m1: Buffer): HandshakeOutcome {
    const targetPub = this.kkTargetPubkey!;
    const hs = new NoiseHandshake('KK', 'responder', this.identity, unb64u(targetPub));
    // 真 KK（cr-64）：m1 含发起方加密 s 段 + ss DH——静态私钥不持有者无法算出
    // 正确密钥链，readMessage 必抛错（解 s 段失败或身份比对不符）。
    hs.readMessage(m1);
    const m2 = hs.writeMessage();
    this.sendHandshake(m2);
    const pair = hs.split();
    this.transport = pair;
    this.state = 'online';
    this.onState?.('KK 重握手完成（对端回归）');
    return { kind: 'known', device: { name: '', pubkey: b64u(hs.remoteStatic ?? unb64u(targetPub)) }, transport: pair, handshakeHash: pair.handshakeHash };
  }

  /** 发送业务帧（加密） */
  sendPayload(payload: LinkPayload): void {
    if (!this.transport || this.state !== 'online') throw new Error('link: not online');
    const { n, ct } = this.transport.send.write(Buffer.from(JSON.stringify(payload), 'utf8'));
    this.ws?.send(JSON.stringify({ op: 'frame', data: { n, ct: b64u(ct) } }));
  }

  /** 主动关闭 */
  close(reason = 'manual'): void {
    this.stopKeepalive();
    this.state = 'closed';
    try { this.ws?.close(); } catch { /* best effort */ }
    this.ws = null;
    this.transport = null;
  }

  /**
   * 应用层保活（连接自身负责，配对/在线一视同仁）。
   *
   * 为什么必须在这里而不是服务层：relay 的活跃判定**只认应用层帧**
   * （ac-relay-server 的 touch 只被 ping/join/frame 触发），60s 未见即
   * destroyRoom。而配对期双方都在等对方，谁都不发业务帧——房间会被判死。
   * 服务层的 ensureHeartbeat 只在 connections.size > 0 时启动，配对期的连接
   * 尚未入表，恰好是盲区。真机表现：用户从「点添加设备」到「扫码完成」
   * 超过 60 秒（打开 App、授权相机、对准二维码）即 room-unavailable——
   * 必现，且 M3.1 的 loopback 客户端（拿码后毫秒级 join）测不出来。
   */
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  /** 最近一次入站帧时刻（pong 之外的业务帧也算活——真有流量本就没死） */
  private lastInboundAt = 0;

  private startKeepalive(): void {
    this.stopKeepalive();
    this.lastInboundAt = Date.now();
    this.keepaliveTimer = setInterval(() => {
      // pong watchdog（cr-48）：ws 库不发协议层 ping，盲发应用层 ping 对半开连接
      // 零感知——ping 进死 TCP 缓冲区毫无回声，此前只能等 relay sweep 销毁。
      // 62s 无任何入站即自行断开进入重连（正常时 pong 每 25s 一回）。
      if (Date.now() - this.lastInboundAt > 62_000) {
        this.onState?.('pong watchdog 超时——判定死链，主动断开');
        this.sever();
        return;
      }
      try { this.ping(); } catch { /* 断链由 close 事件收束 */ }
    }, KEEPALIVE_MS);
    // Node 定时器不应阻止进程退出（pnpm dev 自退纪律）
    this.keepaliveTimer.unref();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /**
   * 死链强断（watchdog/失败路径用）：优雅 close 的关闭握手对死端等不来 ACK（ws 库
   * 30s closeTimeout 兜底白拖），且残骸占房堵对端重试；terminate 发 RST 立即触发
   * close 事件 → onClose → service 重连。正常下线仍走 close()。
   */
  sever(reason = 'sever'): void {
    this.stopKeepalive();
    this.state = 'closed';
    try { this.ws?.terminate(); } catch { /* 已断 */ }
    this.ws = null;
    this.transport = null;
  }

  // ---- 内部 ----

  private dial(opts: RelayConnectOptions): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(opts.url, {
        handshakeTimeout: opts.timeoutMs ?? 15000,
        rejectUnauthorized: false, // 自签——认证在 Noise 层（上游方案 §4.3）；M1 加 pin 时在 tls 对象上校验
      });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('relay: connect timeout'));
      }, opts.timeoutMs ?? 15000);
      ws.once('open', () => {
        clearTimeout(timer);
        if (opts.tlsPin) {
          const cert = (ws as unknown as { socket?: { getPeerCertificate?: () => { raw?: Buffer } } }).socket?.getPeerCertificate?.();
          const der = cert?.raw;
          if (der && crypto.createHash('sha256').update(der).digest('hex') !== opts.tlsPin) {
            ws.terminate();
            reject(new Error('relay: TLS pin mismatch'));
            return;
          }
        }
        resolve(ws);
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private pendingOps: { op: string; resolve: (ok: boolean) => void }[] = [];

  private expectOp(op: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.pendingOps.push({ op, resolve: (ok) => { clearTimeout(timer); resolve(ok); } });
    });
  }

  private pendingHandshake: { resolve: (msg: Buffer) => void; reject: (err: Error) => void }[] = [];

  private expectHandshakeMessage(timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dropPendingWaiter(waiter);
        reject(new Error('relay: handshake timeout'));
      }, timeoutMs);
      const waiter = {
        resolve: (msg: Buffer) => { clearTimeout(timer); resolve(msg); },
        reject: (err: Error) => { clearTimeout(timer); reject(err); },
      };
      this.pendingHandshake.push(waiter);
    });
  }

  /** ws 已死——唤醒全部挂起握手等待（超时定时器由各 waiter 自清） */
  private failPendingHandshake(reason: string): void {
    const waiters = this.pendingHandshake.splice(0);
    for (const w of waiters) w.reject(new Error('relay: ' + reason));
  }

  private dropPendingWaiter(waiter: { resolve: (msg: Buffer) => void; reject: (err: Error) => void }): void {
    const i = this.pendingHandshake.indexOf(waiter);
    if (i >= 0) this.pendingHandshake.splice(i, 1);
  }

  private sendHandshake(msg: Buffer): void {
    this.ws?.send(JSON.stringify({ op: 'frame', data: { hs: b64u(msg) } }));
  }

  private handleWire(raw: string): void {
    this.lastInboundAt = Date.now();
    let frame: { op: string; data?: unknown };
    try {
      frame = JSON.parse(raw);
    } catch {
      this.onError?.('relay: malformed frame');
      return;
    }
    if (frame.op === 'joined' || frame.op === 'room-unavailable' || frame.op === 'pong') {
      // room-unavailable 同样解除 join 等待（cr-81：真机实锤——房满被拒时
      // expectOp 只等定时器自然到期，白等满 15s 才进重试，撞门相遇窗被拉长
      // 3~5 倍；拒帧即 resolve(false)，走既有 join failed 错误路径快速重试）。
      // pong 不碰等待者——上轮 ping 的回包迟到落在 join 窗内时，不得误判失败。
      if (frame.op !== 'pong') {
        const waiter = this.pendingOps.shift();
        if (waiter && waiter.op === 'joined') waiter.resolve(frame.op === 'joined');
      }
      return;
    }
    // cr-70 常住方：对端离线——房间保留，丢弃 transport 原地待命。
    // 不再触发 onClose（连接本身健康）；服务层经 onPeerLeft 观察下线。
    if (frame.op === 'peer-left') {
      if (this.state === 'online') {
        this.transport = null;
        this.state = 'waiting-peer';
        this.onState?.('对端离线——常住待命（房间保留）');
        this.onPeerLeft?.();
      }
      return;
    }
    if (frame.op === 'peer-arrived') {
      // 对端进房信令——握手帧随踵而至（handleWire 的 hs 分支处理），此处仅诊断
      if (this.state === 'waiting-peer') this.onState?.('对端进房——等待其 m1');
      return;
    }
    if (frame.op === 'frame') {
      const data = (frame.data ?? {}) as { hs?: unknown; n?: unknown; ct?: unknown };
      if (typeof data.hs === 'string') {
        // 常住重握手（cr-70）：waiting 态收到 m1 = 对端回归，直接重做 KK 响应。
        // 失败（伪冒/坏帧）只 sever 这条连接交上层重拨——不影响其他设备。
        if (this.state === 'waiting-peer' && this.kkTargetPubkey) {
          try {
            const outcome = this.kkRespond(unb64u(data.hs));
            this.onRehandshake?.(outcome);
          } catch (err) {
            this.onError?.('KK 重握手失败: ' + (err instanceof Error ? err.message : String(err)));
            this.sever('kk-rehandshake-failed');
          }
          return;
        }
        const waiter = this.pendingHandshake.shift();
        waiter?.resolve(unb64u(data.hs));
        return;
      }
      // 业务帧（传输 phase）
      if (typeof data.n === 'number' && typeof data.ct === 'string') {
        if (!this.transport) {
          this.onError?.('link: frame before handshake complete');
          return;
        }
        try {
          const pt = this.transport.recv.read(data.n, unb64u(data.ct as string));
          const payload = JSON.parse(pt.toString('utf8')) as LinkPayload;
          this.onPayload?.(payload);
        } catch (err) {
          this.onError?.(`link: decrypt failed: ${err instanceof Error ? err.message : err}`);
          this.close('decrypt-failed');
        }
        return;
      }
    }
  }

  /** 心跳（宿主定时器驱动） */
  ping(): void {
    this.ws?.send(JSON.stringify({ op: 'ping' }));
  }
}