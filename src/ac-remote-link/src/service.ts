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
/** 远程应答单帧字节上限（cr-52：移动网络对大帧敏感——超限截断 records 由前端分页续拉） */
const MAX_REMOTE_RESULT_BYTES = 300 * 1024;

/**
 * RPC 方法档位表（read 档 = 纯查询面；chat 档 = 投递面）。
 * files 档 = HTTP 写面（M3.4 起，仍须显式开启）；admin 档白名单为空
 * （显式禁用，防误开——上游方案 §4.4）。
 */
const SCOPE_ALLOWED_METHODS: Record<RemoteScope, string[]> = {
  read: [
    'agents/list', 'agents/presets', 'agents/tool-defs', 'tools/list', 'tags/catalog',
    'conversation/stats', 'group/list', 'group/history', 'runs/snapshot', 'usage/tokens',
    'goal/get', 'todo/get', 'skills/list', 'timer/list', 'timer/entries',
    'session/history', 'session/tokens', 'singles/list',
    'subagents/list', 'subagents/history', 'fileSnapshots/list', 'fileSnapshots/read-current',
    'system/version-check', 'interaction/list',
    // 远程 WebView 启动必需：行 client 半边装载图（低敏感——仅行名与平台；
    // 无它则手机端 webui 装配第④步拿不到清单 → 白屏，M3.2 实测）
    'ui/boot-graph',
    // 宿主 HTTP 面（仅 GET：webui 的 /api/ui/*、/api/workspace/*、/api/workspaces
    // 读面）——写面另属 files 档（见下）
    'http/read',
  ],
  chat: [
    'conversation/deliver', 'conversation/interrupt', 'conversation/queue',
    'conversation/queue-remove', 'conversation/queue-steer',
    'group/send', 'interaction/reply', 'runs/interrupt',
  ],
  // 显式开启才有：HTTP 写面（上传、工作区增删改）+ 未来的文件工具
  files: ['http/write'],
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
  /** 在途连接尝试去重（cr-43 ⑭ 并发守卫，见 runDeviceConnection） */
  private connectingDevices = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 启动即连已触发（cr-53：applySettings 的 URL 到位补触发只跑一次） */
  private bootConnected = false;
  private lastError: string | null = null;
  private pendingDeviceByConn = new Map<RelayConnection, { name: string; pubkey: string }>();

  constructor(ctx: Context, options: RemoteLinkRowOptions = {}) {
    super(ctx, 'remoteLink');
    this.options = {
      relayUrl: options.relayUrl ?? '',
      tlsPin: options.tlsPin ?? '',
      // 空数组回落缺省档（cr-66）：loader 路径行无 config 时经 Config schema
      // 归一化得到 defaultScopes: []（schemastery 对 array 字段的缺省输出），
      // ?? 不认空数组——真机配对落库 scopes 为空、全部 RPC 被闸门拒（手机端
      // webui 装配黑屏）。显式配 scopes: [] 才是真「零权限」意图，loader 缺省
      // 归一化产物不是。
      defaultScopes: options.defaultScopes?.length ? options.defaultScopes : ['read', 'chat'],
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
    // 启动即连（config 已就位时此处直接生效；缺席时由 applySettings 的
    // 「URL 首次到位即连」补触发——cr-53 时序修复）。KK 的发起方在手机端，
    // 其 m1 只在「本端已在房」时才可达（relay 只转发实时帧）——核心端不先进房，
    // 手机重试再多也握不上手（M3 真机实录：设备 10 轮重试全部落空）。
    if (this.options.relayUrl && this.registry.list().length > 0) {
      this.bootConnected = true;
      void this.connect().catch(() => { /* 启动期 relay 不可达：scheduleReconnect 接管 */ });
    }
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
    // TLS pin（cr-65）：hex sha256（64 hex）或空串清除；随二维码下发供手机端校验
    const pin = layer.tlsPin;
    if (pin !== undefined) {
      if (typeof pin !== 'string' || (pin !== '' && !/^[0-9a-fA-F]{64}$/.test(pin))) {
        this.ctx.logger.warn('[remote-link] settings.remoteLink.tlsPin 非法（须 64 位 hex sha256；空串 = 清除），保持现状');
      } else {
        this.options.tlsPin = pin;
      }
    }
    if (v === this.options.relayUrl) return;
    this.options.relayUrl = v;
    // 换 relay：断现有连接（重连由 connect/手机端触发——房间号是身份派生，
    // 新 relay 上直接重建）
    if (this.connections.size > 0) {
      this.ctx.logger.info('[remote-link] relayUrl 变更——断开 %s 个在线连接（设备无需重新配对）', this.connections.size);
      this.disconnect();
    }
    // URL 首次到位即连（cr-53：构造器时序里 config 服务可能尚未就位——applySettings
    // 拿不到 relayUrl，启动即连被静默跳过，重启后手机端空撞门等 PC「待机」。
    // config 的 changed 只在写入时广播，boot 期静态加载无事件可依赖——把启动
    // 即连的触发点搬到「URL 首次就位」时刻，晚到比缺席好。）
    if (!this.bootConnected && this.registry.list().length > 0) {
      this.bootConnected = true;
      void this.connect().catch(() => { /* relay 不可达：scheduleReconnect 接管 */ });
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
    // online 判定（cr-70）：只数真正在传数据的连接——waiting-peer（常住待命）
    // 的连接虽然活着，但对端不在线，设备应显示离线。
    const online = [...this.connections.entries()]
      .filter(([, c]) => c.state === 'online')
      .map(([id]) => id);
    let state: RemoteLinkStatus['state'] = 'idle';
    // done 会话是配对成功的残留快照（供前端对账），不是进行中配对——
    // 它不得压过 online（cr-66 真机实锤：配对成功后 PC 恒显「配对中」）。
    if (this.pairing && this.pairing.state !== 'done') state = 'pairing';
    else if (online.length > 0) state = 'online';
    else if (this.reconnectTimer) state = 'connecting';
    // KK 快速重试期（cr-68：kkRetries 2s 间隔重排不经 reconnectTimer，状态面板
    // 误显「异常」——用户以为链路死了不再唤起，实际一直在撞门重试）
    else if (this.connectingDevices.size > 0) state = 'connecting';
    else if (this.lastError) state = 'error';
    return {
      identityPubkey: b64u(this.identity.publicKey),
      relayUrl: this.options.relayUrl || null,
      tlsPinConfigured: !!this.options.tlsPin,
      state,
      onlineDeviceIds: online,
      lastError: this.lastError,
      // 配对会话快照：活动会话随 status 下发（UI 对账恢复用，见 contract 注释）
      pairing: this.pairing ? { ...this.pairing } : null,
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
    // 幂等（cr-43）：活动会话存在时返回它而非报错——多窗口/重开页重入
    // 拿同一会话（SAS 确认界面随之恢复），不再出现「被占用」死锁。
    // TTL 过期的 wait-join 会话直接废弃重建（cr-65：原样返回过期房间 =
    // 抢先入房者的占座窗口无限续期；过期即换房，旧房作废）。
    if (this.pairing && this.pairing.state === 'wait-join' && this.pairing.expiresAt <= Date.now()) {
      this.pairing = null;
    }
    if (this.pairing && (this.pairing.state === 'wait-join' || this.pairing.state === 'sas-confirm')) {
      return { ...this.pairing };
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
      // TLS pin（cr-65）：随码带出——手机端 dial 校验证书 sha256，堵 KCI 场景
      // 下「relay 真伪无从验证」的缺口（无 pin 字段 = 部署方未配置，行为同旧）
      ...(this.options.tlsPin ? ['pin=' + encodeURIComponent(this.options.tlsPin)] : []),
    ].join('&');
    this.pairing = { sessionId, roomId, qrUri, expiresAt, state: 'wait-join' };
    // 后台起连接（等待手机 join → XK 握手 → SAS）
    void this.runPairingConnection(roomId);
    void deviceName;
    return { ...this.pairing };
  }

  /** SAS 确认（用户比对两端数字后调用；false = 拒绝配对）。
   * 接受时必须回传会话 SAS（R-2：堵盲确认——恶意 relay 抢先握手时 SAS
   * 必与手机屏显不一致，回传值与服务端持有的 sasFromHandshakeHash 产
   * 物核对，用户「不看数字直接点确认」无法通过校验；拒绝路径不受限）。 */
  confirmPairing(sessionId: string, accept: boolean, sasInput?: string): PairingSession {
    const s = this.pairing;
    if (!s || s.sessionId !== sessionId) throw new Error('no such pairing session');
    if (s.state !== 'sas-confirm') throw new Error(`pairing state is ${s.state}, not sas-confirm`);
    if (accept && s.sas !== undefined && sasInput !== s.sas) {
      throw new Error('SAS 数字不一致——请核对手机屏显数字后重新输入');
    }
    this.pairingResolve?.(accept);
    this.pairingResolve = null;
    return { ...s };
  }

  private async runPairingConnection(roomId: string): Promise<void> {
    const conn = new RelayConnection(this.identity);
    conn.onState = (note) => this.ctx.logger.info(`[remote-link] pairing ${roomId}: ${note}`);
    conn.onError = (msg) => this.ctx.logger.warn(`[remote-link] pairing ${roomId} 链路错误: ${msg}`);
    conn.onClose = () => {
      // 配对轮连接断开：若已被收编（在线态），由 adoptConnection 挂的 onClose 接管——
      // 这里只处理收编前的失败路径（runPairingConnection 的 catch 已置 expired）。
    };
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
            this.pairing.devicePubkey = device.pubkey;
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
      // 配对成功：注册设备（同公钥 upsert——重复配对必须替换，见 upsertByPubkey 注释）+ 转入在线
      const device = this.registry.upsertByPubkey(
        {
          name: outcome.device.name,
          pubkey: outcome.device.pubkey,
          scopes: [...this.options.defaultScopes],
          pairedAt: Date.now(),
          lastSeenAt: Date.now(),
        },
        () => 'dev-' + crypto.randomBytes(6).toString('base64url'),
      );
      const deviceId = device.id;
      this.ctx.emit('remote/device-paired', device);
      this.adoptConnection(deviceId, conn, outcome.transport);
      // cr-73：配对连接不转常住。它住在一次性配对房（p 前缀 rendezvous），
      // 手机 KK 重连撞的是派生房（r 前缀）——若在此待命则房间错位永不相遇
      // （真机实锤：重新配对后强杀手机，PC 在配对房 waiting、手机在派生房
      // 撞门 10 分钟不合）。对端离线即弃链，立即去派生房 dial 常住连接。
      conn.onPeerLeft = () => {
        this.ctx.emit('remote/device-offline', deviceId, 'pairing-room-left');
        if (this.connections.get(deviceId) === conn) {
          this.connections.delete(deviceId);
          conn.sever('move-to-derived-room');
        }
        void this.runDeviceConnection(deviceId);
      };
      // 告知手机自身 deviceId 与权限档。
      // 为什么必须下发：KK 重连房间号 = SHA256(core_pub‖deviceId‖device_pub)，
      // 而 deviceId 是**本端分配**的（dev-<rand>）——手机侧无从自行得知。
      // 缺这条信令时，手机在断线后算不出房间号，重连永久失败（M3.3 真机前的
      // 协议缺口；M3.1 的 loopback 客户端靠直连本地 RPC 查注册表绕过了它，
      // 真机没有这个通道）。scopes 一并下发供 UI 展示与权限提示。
      try {
        conn.sendPayload({ type: 'remote/paired', data: { deviceId, scopes: device.scopes } });
        this.ctx.logger.info(`[remote-link] 已向 ${deviceId} 下发 deviceId 信令`);
      } catch (err) {
        this.ctx.logger.warn(`[remote-link] deviceId 信令下发失败: ${err instanceof Error ? err.message : err}`);
      }
      this.finalizePairingDone();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      conn.close('pairing-failed');
      if (this.pairing && this.pairing.state !== 'done') this.pairing.state = 'expired';
      this.pairing = null; // 失败即释放——下次 startPairing 不被残留会话挡
    }
  }

  /**
   * 配对成功收尾：置 done + 短驻后释放。
   *
   * done 会话原样保留是 cr-43 对账语义（多窗口/刷新恢复「配对完成」面板），
   * 但永不清理会在真机上把面板变成常驻卡（cr-67）——短驻 10s 保留对账窗口，
   * 到期释放，此后 status().pairing 为 null，前端按既有对账语义收起面板。
   */
  private finalizePairingDone(): void {
    if (!this.pairing) return;
    this.pairing.state = 'done';
    const s = this.pairing;
    setTimeout(() => {
      if (this.pairing === s && s.state === 'done') this.pairing = null;
    }, 10_000).unref();
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
      // 健康连接跳过；死链（断链但 onClose 未触发——relay 单侧 failure 帧/半开连接，
      // cr-43 真机实锤 connections 槽位残留致 connect 短路、设备永不重连）交
      // runDeviceConnection 的 stale 清理处置。
      const existing = this.connections.get(deviceId);
      if (existing?.isOpen) continue;
      void this.runDeviceConnection(deviceId);
    }
  }

  private async runDeviceConnection(deviceId: string): Promise<void> {
    const device = this.registry.get(deviceId);
    if (!device) return;
    // 并发去重（cr-43 ⑭：connect 手动触发与 scheduleReconnect 退避并发时，多条 KK 链
    // 同时 join 同一房间把自己占满（2/2），手机 join 全被拒——真机实锤 relay 房间
    // 满员但手机不在其中）。同设备同时只允许一条在途连接尝试。
    if (this.connectingDevices.has(deviceId)) return;
    this.connectingDevices.add(deviceId);
    try {
      await this.runDeviceConnectionInner(deviceId);
    } finally {
      this.connectingDevices.delete(deviceId);
    }
  }

  private async runDeviceConnectionInner(deviceId: string): Promise<void> {
    const device = this.registry.get(deviceId);
    if (!device) return;
    // 死链清理：重连前先 dispose 同设备旧连接（对端已换新会话——旧链的 KK 帧序号
    // 必然错位，且它占着 connections 槽位会让 connect 短路跳过）
    const stale = this.connections.get(deviceId);
    if (stale) {
      this.connections.delete(deviceId);
      stale.sever('stale-before-reconnect'); // 失败路径 RST 立断（cr-50），不占房
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
    // cr-70 常住方：对端离线/回归由连接自身处理（peer-left → waiting 待命，
    // 新 m1 → 原地重握手）——服务层只观察状态迁移。
    conn.onPeerLeft = () => {
      this.ctx.emit('remote/device-offline', deviceId, 'peer-left');
      this.ensureHeartbeat(); // 心跳维持房间（无连接时它会自停）
    };
    conn.onRehandshake = (outcome) => {
      this.registry.touch(deviceId);
      this.ctx.emit('remote/device-online', deviceId);
      this.reconnectAttempt = 0;
      void outcome; // transport 已在连接内换新；adoptConnection 只做登记
    };
    // onClose 不在此挂——统一由 adoptConnection 收编时挂（cr-67 收敛，见彼处注释）
    try {
      const outcome = await conn.connectAndHandshake(
        { url: this.options.relayUrl, roomId, tlsPin: this.options.tlsPin || undefined, targetDevicePubkey: device.pubkey,
          // 首握手等待窗（cr-70 后无相位压力——手机撞门即达；窗口只兜底网络
          // 抖动与 dial 失败的判定）。原 70s 长驻语义已被常住模型取代。
          waitFirstMsgMs: 15_000 },
        this.registry,
        async () => false, // KK 路径不进 SAS
      );
      this.registry.touch(deviceId);
      this.adoptConnection(deviceId, conn, outcome.transport);
      this.ctx.emit('remote/device-online', deviceId);
      this.reconnectAttempt = 0;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      // sever 而非 close（cr-50）：失败路径 RST 立断，不占房。
      conn.sever('connect-failed');
      // cr-70：重试只剩这一处——dial/join 失败（relay 不可达/频控）时常规退避。
      // 相位耦合已由常住模型根除，不再需要快重试循环。
      this.scheduleReconnect(deviceId);
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
    if (prev && prev !== conn) {
      prev.onClose = null; // 替换前摘钩——旧链的 superseded 关闭不得误触发下线的清理
      prev.close('superseded');
    }
    // onClose 统一在此挂（cr-67：配对收编路径原先漏挂——手机离线后 relay 销房 RST，
    // 连接内态已 closed 但服务层无人通知 → connections 残留死链、status 恒报在线、
    // 重连永不触发，手机在派生房空撞门卡「正在连接」）。KK 路径的挂载点移除，
    // 与配对路径收敛到同一漏斗——两份 onClose 迟早走散。
    conn.onClose = (reason) => {
      // 新链已替换本链（superseded 摘钩在前，理论上到不了这里——防御性保留）
      if (this.connections.get(deviceId) !== conn) return;
      this.connections.delete(deviceId);
      this.deviceRooms.delete(deviceId);
      // 退避计数随断链归零（cr-48 真机实锤：断链=新周期，退避应从 1s 重新爬）
      this.reconnectAttempt = 0;
      this.ctx.emit('remote/device-offline', deviceId, reason);
      this.scheduleReconnect(deviceId);
    };
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
      result = this.truncateRemoteResult(result);
      const frame: LinkPayload = error
        ? { type: 'rpc/result', data: { requestId: call.requestId, ok: false, error } }
        : { type: 'rpc/result', data: { requestId: call.requestId, ok: true, result } };
      try {
        conn.sendPayload(frame);
      } catch { /* 连接已断——忽略 */ }
    })();
  }

  /**
   * 远程应答尺寸兜底（cr-52）：记录条数分页挡不住单轮超大（subcalls 投影后单条
   * 可达数百 KB）。超阈值的 records 从尾部截断保最近 2 条，hasMore 标记让前端
   * 自然上翻续拉——小步分页，不影响正确性。非 records 形态原样放行。
   */
  truncateRemoteResult(result: unknown): unknown {
    if (!result || typeof result !== 'object' || !Array.isArray((result as { records?: unknown[] }).records)) return result;
    const serialized = JSON.stringify(result);
    if (serialized.length <= MAX_REMOTE_RESULT_BYTES) return result;
    const r = result as { records: unknown[]; hasMore?: boolean; truncated?: boolean };
    r.records = r.records.slice(-2); // 保底最近 2 条（至少有反馈，不留空屏）
    r.hasMore = true;
    r.truncated = true;
    return r;
  }

  /** scopes 闸门 + deliver 改写 + webServer.callRpc */
  private async forwardRpc(device: RemoteDevice, method: string, params: unknown): Promise<unknown> {
    const allowed = this.scopeAllows(device.scopes, method);
    if (!allowed) {
      throw new Error(`remote: method "${method}" not allowed for device scopes [${device.scopes.join(',')}]`);
    }
    let forwardParams = params;
    // 远程大应答止血（cr-52 真机实锤）：session/history 按记录条数分页挡不住
    // 「单轮超大」的会话（subcalls 投影展开后 50 条仍 1.28MB，移动网络必炸）。
    // 远程路径强制 limit=8（对齐前端首屏 5 轮量级），已有 limit 一律钳到 ≤8。
    // 桌面 webui 不经此路径不受影响。
    if (method === 'session/history' && params && typeof params === 'object') {
      const p = params as Record<string, unknown>;
      const asked = typeof p.limit === 'number' ? p.limit : undefined;
      const capped = asked === undefined ? 8 : Math.min(asked, 8);
      // lite 视图（cr-54）：steps 工具调用截断为摘要——重会话 98.7% 体积在
      // run_code 轨迹，移动端打开必须瘦身；前端传 view 时不覆盖。
      if (p.view !== undefined) {
        if (asked !== capped) forwardParams = { ...p, limit: capped };
      } else {
        forwardParams = { ...p, limit: capped, view: 'lite' };
      }
    }
    if (DELIVER_METHODS.has(method) && forwardParams && typeof forwardParams === 'object') {
      const p = { ...(forwardParams as Record<string, unknown>) };
      // sender=user（cr-78）：M19 起 sender 是直答桶键的唯一输入（pairKey(sender,
      // agentId)）——remote: 前缀会让移动端 1v1 消息落桶 remote:xxx~agent，与
      // 桌面 user~agent 分裂（流式门控拦帧、历史读不回、conv-settings 错桶）。
      // 手机 = viewer 的另一块表面，端点身份不变；设备溯源留在链路层（deviceId
      // 在手），不进信封。强制改写保留——防配对设备伪造 sender 注入 agent⇄agent
      // 桶（裁决：src/docs/remote-deliver-sender-ruling.md）。
      p.sender = 'user';
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
    if (!REMOTE_DOWNLINK_EVENTS.includes(type)) return;
    const frame: LinkPayload = { type, data: { args } };
    // scopes 过滤（cr-64 审计）：下行事件全是会话内容流（llm/delta、tool 轨迹等），
    // chat-only（无 read 档）设备不应实时收明文——「能发不能看」的权限设计。
    for (const [deviceId, conn] of this.connections) {
      const device = this.registry.get(deviceId);
      if (!device || !device.scopes.includes('read')) continue;
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

/**
 * 下行事件白名单（照 ws-bridge 桥接面收敛——不新增词汇）。
 *
 * 单一事实源：订阅侧（index.ts 的 apply 订阅这些事件）与闸门侧
 * （broadcastEvent 再判一次）都读它——两处各写一份必然走散。
 *
 * 纪律：只收 emit 面。waterfall 事件（loop/transform-* 等）禁入——
 * 本表的订阅姿势是纯观察（不调 next），挂在 waterfall 上等于静默
 * veto 下游默认行为（transform-step/run 返 undefined → run 首步即
 * 炸、收束日志读 final.usage 抛错——2026-09-26 事故）。远程端需要
 * 的终值已由 after-step / after-run 携带。
 */
export const REMOTE_DOWNLINK_EVENTS: readonly string[] = [
  'router/message-received',
  'router/reply-completed',
  'loop/run-started',
  'loop/step-started',
  'loop/after-step',
  'loop/after-run',
  'llm/delta-start',
  'llm/delta',
  'llm/delta-end',
  'tool/started',
  'tool/progress',
  'tool/after-execute',
];