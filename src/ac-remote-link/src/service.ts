// ============================================================
// ac-remote-link/src/service.ts —— 远程链路服务（ctx.remoteLink）
//
// 职责（remote-client-relay-plan §4.4 的 M1 形态）：
//   · 身份密钥生命周期（remote/identity）；
//   · 设备注册表（known_devices.json：配对写入 / 吊销删除）；
//   · 配对会话状态机（二维码 URI 生成 → XK 握手 → SAS 确认 → 注册）；
//   · 出站 relay 连接管理（断线重连指数退避；常驻心跳懒拉起）；
//   · 远程 RPC 转发（scopes 闸门 + deliver 强制 sender=remote:<id> 剥 elevation）；
//   · 事件下行（emit 面白名单订阅 → 加密单播在线设备）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type {} from './events.ts';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { b64u, sasFromHandshakeHash } from 'ac-noise-core';
import { loadOrCreateIdentity, type StoredIdentity } from './identity.ts';
import { DeviceRegistry, type RemoteDevice, type RemoteScope } from './device-registry.ts';
import { RelayConnection, type LinkPayload } from './relay-connection.ts';
import type { PairingSession, RemoteLinkStatus } from './contract.ts';

export interface RemoteLinkRowOptions {
  /** 数据根（缺省 AGENTCHAT_DATA_ROOT ?? ./data） */
  root?: string;
  /** relay 地址（wss://……；配对二维码写入；重连目标） */
  relayUrl?: string;
  /** relay TLS 证书 sha256 pin（hex；缺省跳过——测试） */
  tlsPin?: string;
  /** 新配对设备的缺省 scopes */
  defaultScopes?: RemoteScope[];
  /** 自动重连开关（缺省开） */
  autoReconnect?: boolean;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;
const PAIRING_TTL_MS = 5 * 60 * 1000;

/**
 * RPC 方法档位表（M1 收敛版：read 档 = 纯查询面；chat 档 = read + 投递面）。
 * files/admin 档位 M1 白名单为空（显式禁用，防误开——上游方案 §4.4）。
 */
const SCOPE_ALLOWED_METHODS: Record<RemoteScope, string[]> = {
  read: [
    'agents/list', 'agents/presets', 'agents/tool-defs', 'tools/list', 'tags/catalog',
    'conversation/stats', 'group/list', 'group/history', 'runs/snapshot', 'usage/tokens',
    'goal/get', 'todo/get', 'skills/list', 'timer/list', 'timer/entries',
    'session/history', 'session/tokens', 'singles/list', 'singles/update', 'singles/fork',
    'subagents/list', 'subagents/history', 'fileSnapshots/list', 'fileSnapshots/read-current',
    'system/version-check', 'interaction/list',
  ],
  chat: [
    'conversation/deliver', 'conversation/interrupt', 'conversation/queue',
    'conversation/queue-remove', 'conversation/queue-steer',
    'group/send', 'interaction/reply', 'runs/interrupt',
  ],
  files: [],
  admin: [],
};

/** deliver 类方法转发时的强制改写面（上游方案 §4.4：恒剥除提权通道） */
const DELIVER_METHODS = new Set(['conversation/deliver', 'group/send', 'interaction/reply']);

export class RemoteLinkService extends Service {
  static inject = ['webServer'];

  private identity: StoredIdentity;
  private registry: DeviceRegistry;
  private options: Required<Pick<RemoteLinkRowOptions, 'relayUrl' | 'tlsPin' | 'defaultScopes' | 'autoReconnect'>> &
    Pick<RemoteLinkRowOptions, 'root'>;
  private pairing: PairingSession | null = null;
  private pairingResolve: ((accept: boolean) => void) | null = null;
  /** 在线设备连接表（deviceId → 连接） */
  private connections = new Map<string, RelayConnection>();
  /** 设备 id ↔ 该连接的房间（重连 roomId 派生） */
  private deviceRooms = new Map<string, string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /** KK 握手期重试计数（成功能话清零；区别于断线后的指数退避重连） */
  private kkRetries = new Map<string, number>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;
  private pendingDeviceByConn = new Map<RelayConnection, { name: string; pubkey: string }>();

  constructor(ctx: Context, options: RemoteLinkRowOptions = {}) {
    super(ctx, 'remoteLink');
    this.options = {
      relayUrl: options.relayUrl ?? '',
      tlsPin: options.tlsPin ?? '',
      defaultScopes: options.defaultScopes ?? ['read', 'chat'],
      autoReconnect: options.autoReconnect ?? true,
      root: options.root,
    };
    const root = this.options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data';
    const remoteDir = path.resolve(root, 'remote');
    this.identity = loadOrCreateIdentity(remoteDir);
    this.registry = new DeviceRegistry(remoteDir);
    // 全局设置层（settings.remoteLink.relayUrl）热更：config/set 落 settings →
    // config/changed → 重解析（boot 期已构造时吸收更早写入）。改 URL = 换 relay：
    // 断开现有连接（设备注册表/身份不动——换 relay 不换身份，老设备重连即恢复）
    this.ctx.on('config/changed', () => this.applySettings(), {
      description: 'remote-link relayUrl 热更（settings.remoteLink 全局层）',
    });
    this.applySettings();
  }

  /**
   * 全局设置层对账：settings.remoteLink.relayUrl 覆盖行配置。
   * 形状非法/缺失 = 保持现状。改 URL 即断开全部在线连接（新旧 relay 房间
   * 互不相通）；设备不需要重新配对（身份与注册表跟 relay 无关）。
   */
  private applySettings(): void {
    const config = this.ctx.get('config', false) as
      | { get<T>(key: string): T | undefined }
      | undefined;
    if (!config) return;
    const layer = config.get<Record<string, unknown>>('settings.remoteLink');
    if (layer === undefined) return;
    if (typeof layer !== 'object' || Array.isArray(layer)) {
      this.ctx.logger.warn('[remote-link] settings.remoteLink 形状非法（保持现状）');
      return;
    }
    const v = layer.relayUrl;
    if (v === undefined) return;
    if (typeof v !== 'string' || (v !== '' && !/^wss?:\/\//.test(v))) {
      this.ctx.logger.warn('[remote-link] settings.remoteLink.relayUrl 非法（须 ws:// 或 wss:// 开头；空串 = 清除），保持现状');
      return;
    }
    if (v === this.options.relayUrl) return;
    this.options.relayUrl = v;
    // 换 relay：断现有连接（重连由 connect/手机端触发——房间号是身份派生，
    // 新 relay 上直接重建）
    if (this.connections.size > 0) {
      this.ctx.logger.info('[remote-link] relayUrl 变更——断开 %s 个在线连接（设备无需重新配对）', this.connections.size);
      this.disconnect();
    }
  }

  // ============ 管理面（RPC 转发目标） ============

  listDevices(): RemoteDevice[] {
    return this.registry.list();
  }

  revokeDevice(deviceId: string): RemoteDevice | undefined {
    const conn = this.connections.get(deviceId);
    if (conn) {
      conn.close('revoked');
      this.connections.delete(deviceId);
    }
    const removed = this.registry.revoke(deviceId);
    this.ctx.emit('remote/device-revoked', deviceId, removed);
    return removed;
  }

  status(): RemoteLinkStatus {
    const online = [...this.connections.keys()];
    let state: RemoteLinkStatus['state'] = 'idle';
    if (this.pairing) state = 'pairing';
    else if (online.length > 0) state = 'online';
    else if (this.reconnectTimer) state = 'connecting';
    else if (this.lastError) state = 'error';
    return {
      identityPubkey: b64u(this.identity.publicKey),
      relayUrl: this.options.relayUrl || null,
      state,
      onlineDeviceIds: online,
      lastError: this.lastError,
    };
  }

  /** 取消配对会话（用户关闭二维码对话框等）——会话立即释放（可再 start） */
  cancelPairing(sessionId: string): PairingSession {
    const s = this.pairing;
    if (!s || s.sessionId !== sessionId) throw new Error('no such pairing session');
    this.pairingResolve?.(false);
    this.pairingResolve = null;
    s.state = 'expired';
    this.pairing = null; // 释放——同轮询窗口内的下一次 startPairing 不再被挡
    return { ...s };
  }

  /** 断开全部在线连接（手动下线；自动重连暂停到下次 connect） */
  disconnect(): void {
    for (const [id, conn] of this.connections) {
      conn.close('manual-disconnect');
      this.connections.delete(id);
      this.ctx.emit('remote/device-offline', id, 'manual-disconnect');
    }
    this.disposeHeartbeat();
  }

  // ============ 配对 ============

  /**
   * 开启配对会话：生成 roomId + 二维码 URI，等手机进房（XK 握手）。
   * 返回的会话含 qrUri——webui/CLI 展示二维码。
   */
  async startPairing(deviceName?: string): Promise<PairingSession> {
    if (this.pairing && (this.pairing.state === 'wait-join' || this.pairing.state === 'sas-confirm')) {
      throw new Error('pairing already in progress');
    }
    if (!this.options.relayUrl) throw new Error('relayUrl not configured');
    // roomId 满足 relay 校验 [A-Za-z0-9_-]{22,43}：首字符 p = 配对模式信令
    const roomId = 'p' + crypto.randomBytes(18).toString('base64url');
    const sessionId = 'pair-' + crypto.randomBytes(8).toString('base64url');
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    const qrUri = [
      'agentchat://pair?v=1',
      'relay=' + encodeURIComponent(this.options.relayUrl),
      'room=' + encodeURIComponent(roomId),
      'pk=' + encodeURIComponent(b64u(this.identity.publicKey)),
      'exp=' + expiresAt,
    ].join('&');
    this.pairing = { sessionId, roomId, qrUri, expiresAt, state: 'wait-join' };
    // 后台起连接（等待手机 join → XK 握手 → SAS）
    void this.runPairingConnection(roomId);
    void deviceName;
    return { ...this.pairing };
  }

  /** SAS 确认（用户比对两端数字后调用；false = 拒绝配对） */
  confirmPairing(sessionId: string, accept: boolean): PairingSession {
    const s = this.pairing;
    if (!s || s.sessionId !== sessionId) throw new Error('no such pairing session');
    if (s.state !== 'sas-confirm') throw new Error(`pairing state is ${s.state}, not sas-confirm`);
    this.pairingResolve?.(accept);
    this.pairingResolve = null;
    return { ...s };
  }

  private async runPairingConnection(roomId: string): Promise<void> {
    const conn = new RelayConnection(this.identity);
    try {
      const outcome = await conn.connectAndHandshake(
        { url: this.options.relayUrl, roomId, tlsPin: this.options.tlsPin || undefined },
        this.registry,
        async (device, sas) => {
          // 进入 SAS 确认态——等 RPC confirmPairing
          if (this.pairing) {
            this.pairing.state = 'sas-confirm';
            this.pairing.sas = sas;
            this.pairing.deviceName = device.name;
          }
          const accept = await new Promise<boolean>((resolve) => {
            this.pairingResolve = resolve;
            // TTL 兜底：超时视为拒绝
            const s = this.pairing;
            if (s) {
              setTimeout(() => resolve(false), Math.max(0, s.expiresAt - Date.now()));
            }
          });
          return accept;
        },
      );
      // 配对成功：注册设备 + 转入在线
      const deviceId = 'dev-' + crypto.randomBytes(6).toString('base64url');
      const device: RemoteDevice = {
        id: deviceId,
        name: outcome.device.name,
        pubkey: outcome.device.pubkey,
        scopes: [...this.options.defaultScopes],
        pairedAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      this.registry.add(device);
      this.ctx.emit('remote/device-paired', device);
      this.adoptConnection(deviceId, conn, outcome.transport);
      if (this.pairing) this.pairing.state = 'done';
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      conn.close('pairing-failed');
      if (this.pairing && this.pairing.state !== 'done') this.pairing.state = 'expired';
      this.pairing = null; // 失败即释放——下次 startPairing 不被残留会话挡
    }
  }

  // ============ 在线设备连接管理 ============

  /**
   * 主动连 relay（重连模式：r:<deviceId>:<nonce> 房间——等手机进房 KK 握手）。
   * 手机侧同理主动连。两端谁先进房谁等。
   */
  async connect(opts?: { deviceId: string }): Promise<void> {
    if (!this.options.relayUrl) throw new Error('relayUrl not configured');
    const targets = opts ? [opts.deviceId] : this.registry.list().map((d) => d.id);
    for (const deviceId of targets) {
      if (this.connections.has(deviceId)) continue;
      void this.runDeviceConnection(deviceId);
    }
  }

  private async runDeviceConnection(deviceId: string): Promise<void> {
    const device = this.registry.get(deviceId);
    if (!device) return;
    // 死链清理：重连前先 dispose 同设备旧连接（对端已换新会话——旧链的 KK 帧序号
    // 必然错位，且它占着 connections 槽位会让 connect 短路跳过）
    const stale = this.connections.get(deviceId);
    if (stale) {
      this.connections.delete(deviceId);
      stale.close('stale-before-reconnect');
    }
    // 重连 roomId 确定性派生：'r' + SHA256(core_pub || device_pub) 前 22 字符的 base64url——
    // 双方各自可算（互相知道对方公钥），无需通信协商；被吊销设备预计算抢房只造成
    // join 失败（KK 握手必然失败），无害。
    const dev = this.registry.get(deviceId);
    const derived = crypto.createHash('sha256')
      .update(this.identity.publicKey)
      .update(Buffer.from(deviceId, 'utf8'))
      .update(Buffer.from(dev?.pubkey ?? '', 'utf8'))
      .digest();
    const roomId = 'r' + derived.subarray(0, 17).toString('base64url');
    const conn = new RelayConnection(this.identity);
    conn.onPayload = (payload) => this.handleDevicePayload(deviceId, payload);
    conn.onClose = (reason) => {
      this.connections.delete(deviceId);
      this.deviceRooms.delete(deviceId);
      this.ctx.emit('remote/device-offline', deviceId, reason);
      this.scheduleReconnect(deviceId);
    };
    try {
      const outcome = await conn.connectAndHandshake(
        { url: this.options.relayUrl, roomId, tlsPin: this.options.tlsPin || undefined, targetDevicePubkey: device.pubkey },
        this.registry,
        async () => false, // KK 路径不进 SAS
      );
      this.registry.touch(deviceId);
      this.adoptConnection(deviceId, conn, outcome.transport);
      this.ctx.emit('remote/device-online', deviceId);
      this.reconnectAttempt = 0;
      this.kkRetries.delete(deviceId);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      conn.close('connect-failed');
      // KK 握手期失败重试不受 autoReconnect 门控（进房时序竞态是常态：发起方
      // m1 早于本端入房即丢——短窗内自动重排对齐客户端的重试节奏）
      if ((this.kkRetries.get(deviceId) ?? 0) < 10) {
        this.kkRetries.set(deviceId, (this.kkRetries.get(deviceId) ?? 0) + 1);
        setTimeout(() => { void this.runDeviceConnection(deviceId); }, 1000);
      } else {
        this.kkRetries.delete(deviceId);
        this.scheduleReconnect(deviceId);
      }
    }
  }

  private adoptConnection(
    deviceId: string,
    conn: RelayConnection,
    transport: { send: import('ac-noise-core').TransportCipher; recv: import('ac-noise-core').TransportCipher },
  ): void {
    // RelayConnection 内部已持有 transport；这里只挂回调与登记
    conn.onPayload = conn.onPayload ?? ((payload) => this.handleDevicePayload(deviceId, payload));
    const prev = this.connections.get(deviceId);
    if (prev && prev !== conn) prev.close('superseded');
    this.connections.set(deviceId, conn);
    this.ensureHeartbeat();
  }

  private scheduleReconnect(deviceId: string): void {
    if (!this.options.autoReconnect) return;
    if (!this.registry.get(deviceId)) return; // 已吊销
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    const jitter = delay * (0.8 + Math.random() * 0.4);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.runDeviceConnection(deviceId);
    }, jitter);
  }

  /** 常驻心跳懒拉起（有连接才有定时器——pnpm dev 自退纪律） */
  private ensureHeartbeat(): void {
    if (this.heartbeatTimer || this.connections.size === 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.connections.size === 0) {
        this.disposeHeartbeat();
        return;
      }
      for (const conn of this.connections.values()) conn.ping();
    }, 30000);
  }

  private disposeHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ============ RPC 转发（scopes 闸门 + elevation 剥除） ============

  /**
   * 远程设备发来的 rpc/call 帧的处理入口（relay-connection 解密后回调）。
   * 闸门判定 → webServer.callRpc → 加密回帧。
   */
  private handleDevicePayload(deviceId: string, payload: LinkPayload): void {
    if (payload.type !== 'rpc/call') {
      // 出站语义的帧不应入站——忽略（与 web-server 同款纪律）
      return;
    }
    const device = this.registry.get(deviceId);
    if (!device) return;
    const call = payload.data as { method?: string; requestId?: string; params?: unknown } | undefined;
    if (!call || typeof call.method !== 'string' || typeof call.requestId !== 'string') return;
    const { method, requestId, params } = call;
    void (async () => {
      let result: unknown;
      let error: string | undefined;
      try {
        result = await this.forwardRpc(device, method, params);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      const conn = this.connections.get(deviceId);
      if (!conn) return;
      const frame: LinkPayload = error
        ? { type: 'rpc/result', data: { requestId: call.requestId, ok: false, error } }
        : { type: 'rpc/result', data: { requestId: call.requestId, ok: true, result } };
      try {
        conn.sendPayload(frame);
      } catch { /* 连接已断——忽略 */ }
    })();
  }

  /** scopes 闸门 + deliver 改写 + webServer.callRpc */
  private async forwardRpc(device: RemoteDevice, method: string, params: unknown): Promise<unknown> {
    const allowed = this.scopeAllows(device.scopes, method);
    if (!allowed) {
      throw new Error(`remote: method "${method}" not allowed for device scopes [${device.scopes.join(',')}]`);
    }
    let forwardParams = params;
    if (DELIVER_METHODS.has(method) && params && typeof params === 'object') {
      const p = { ...(params as Record<string, unknown>) };
      p.sender = 'remote:' + device.id;
      p.source = 'user';
      delete p.elevation;
      forwardParams = p;
    }
    // 经注册中心转发（webServer.callRpc——M1 对 ac-web-server 的唯一新增公共面）。
    // inject 声明保证 webServer 在场；此处经 ctx.get 解析（跨服务深链纪律）。
    const webServer = this.ctx.get('webServer') as { callRpc?: (method: string, params?: unknown) => Promise<unknown> } | undefined;
    if (!webServer || typeof webServer.callRpc !== 'function') throw new Error('remote: webServer.callRpc unavailable');
    return webServer.callRpc(method, forwardParams);
  }

  /** 档位判定单源（M1：read/chat 两档有白名单；files/admin 空 = 显式禁用） */
  scopeAllows(scopes: RemoteScope[], method: string): boolean {
    return scopes.some((scope) => (SCOPE_ALLOWED_METHODS[scope] as string[] | undefined)?.includes(method) === true);
  }

  // ============ 下行事件单播 ============

  /**
   * 事件下行入口（ws-bridge 同款订阅姿势的远程版：只单播在线设备）。
   * M1 白名单：会话流核心事件（llm/delta-*、loop/*、router/*、tool/*）。
   */
  broadcastEvent(type: string, args: unknown[]): void {
    if (!EVENT_ALLOWLIST.has(type)) return;
    const frame: LinkPayload = { type, data: { args } };
    for (const conn of this.connections.values()) {
      try {
        conn.sendPayload(frame);
      } catch { /* 单个失败不影响其余 */ }
    }
  }

  /** 连接测试口（测试直接注入 FakeConn 用） */
  testInjectConnection(deviceId: string, conn: RelayConnection): void {
    this.connections.set(deviceId, conn);
    this.ensureHeartbeat();
  }

  testGetConnection(deviceId: string): RelayConnection | undefined {
    return this.connections.get(deviceId);
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 远程链路服务（ac-remote-link 提供）：设备/配对/连接管理 + RPC 转发闸门 */
    remoteLink: RemoteLinkService;
  }
}

/** M1 下行事件白名单（照 ws-bridge 桥接面收敛——不新增词汇） */
const EVENT_ALLOWLIST = new Set([
  'router/message-received',
  'router/reply-completed',
  'loop/run-started',
  'loop/step-started',
  'loop/after-step',
  'loop/transform-step',
  'loop/transform-run',
  'loop/after-run',
  'llm/delta-start',
  'llm/delta',
  'llm/delta-end',
  'tool/started',
  'tool/progress',
  'tool/after-execute',
]);