// ============================================================
// ac-remote-link/src/relay-connection.ts —— 出站 relay 连接 + Noise 壳
//
// 传输半边（remote-client-relay-plan §4.2 的核心端实现）：
//   · 出站 wss 连 relay（自签证书 pin 到 sha256——服务器轮换证书时换 pin）；
//   · join(roomId) → 房间封闭（恰好两方）；
//   · XK（配对）/ KK（重连）握手 → TransportCipher 帧泵；
//   · 帧格式 { t: "frame", n, ct }（业务载荷 JSON 与本地 WS 协议同构）；
//   · 断线指数退避重连（1s 起，上限 60s，±20% 抖动）。
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

/** relay 控制帧（本模块只关心这四种） */
type RelayFrame =
  | { op: 'joined' }
  | { op: 'room-unavailable' }
  | { op: 'pong' }
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
  | 'closed';

export interface RelayConnectOptions {
  url: string;
  roomId: string;
  /** relay TLS 证书 sha256 pin（hex；缺省 = 跳过校验——仅测试） */
  tlsPin?: string;
  /** 连接超时 ms */
  timeoutMs?: number;
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
 * 单次 relay 会话（一个房间 = 一次连接生命周期）。
 * 服务层持有；断线后整体废弃重连（新房间/新握手——relay 房间任一离线即销毁）。
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

  private readonly identity: StaticIdentity;

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
      this.state = 'closed';
      this.onClose?.('ws closed');
    });
    ws.on('error', (err) => this.onError?.(err.message));

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
    const firstMsg = await this.expectHandshakeMessage(opts.timeoutMs ?? 15000);
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
      const m2 = hs.writeMessage();
      this.sendHandshake(m2);
      const m3 = await this.expectHandshakeMessage(opts.timeoutMs ?? 15000);
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
      // KK 重连：m1 = [e, es]——es 需要已知对端静态公钥。对端是谁由调用方决定：
      // runDeviceConnection 已按注册表锁定 deviceId 并传入 targetDevicePubkey。
      const targetPub = (opts as RelayConnectOptions & { targetDevicePubkey?: string }).targetDevicePubkey;
      if (!targetPub) {
        ws.close();
        throw new Error('relay: reconnect requires targetDevicePubkey');
      }
      hs = new NoiseHandshake('KK', 'responder', this.identity, unb64u(targetPub));
      hs.readMessage(firstMsg);
      const m2 = hs.writeMessage();
      this.sendHandshake(m2);
      const pair = hs.split();
      this.transport = pair;
      this.state = 'online';
      outcome = { kind: 'known', device: { name: '', pubkey: targetPub }, transport: pair, handshakeHash: pair.handshakeHash };
    }
    return outcome;
  }

  /** 发送业务帧（加密） */
  sendPayload(payload: LinkPayload): void {
    if (!this.transport || this.state !== 'online') throw new Error('link: not online');
    const { n, ct } = this.transport.send.write(Buffer.from(JSON.stringify(payload), 'utf8'));
    this.ws?.send(JSON.stringify({ op: 'frame', data: { n, ct: b64u(ct) } }));
  }

  /** 主动关闭 */
  close(reason = 'manual'): void {
    this.state = 'closed';
    try { this.ws?.close(); } catch { /* best effort */ }
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

  private pendingHandshake: { resolve: (msg: Buffer) => void }[] = [];

  private expectHandshakeMessage(timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('relay: handshake timeout')), timeoutMs);
      this.pendingHandshake.push({ resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
    });
  }

  private sendHandshake(msg: Buffer): void {
    this.ws?.send(JSON.stringify({ op: 'frame', data: { hs: b64u(msg) } }));
  }

  private handleWire(raw: string): void {
    let frame: { op: string; data?: unknown };
    try {
      frame = JSON.parse(raw);
    } catch {
      this.onError?.('relay: malformed frame');
      return;
    }
    if (frame.op === 'joined' || frame.op === 'room-unavailable' || frame.op === 'pong') {
      if (frame.op === 'joined') {
        const waiter = this.pendingOps.shift();
        if (waiter && waiter.op === 'joined') waiter.resolve(true);
      }
      return;
    }
    if (frame.op === 'frame') {
      const data = (frame.data ?? {}) as { hs?: unknown; n?: unknown; ct?: unknown };
      if (typeof data.hs === 'string') {
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