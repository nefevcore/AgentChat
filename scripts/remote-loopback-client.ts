// ============================================================
// scripts/remote-loopback-client.ts —— M1 全链路验证客户端（冒充安卓端）
//
// remote-client-relay-plan §6 的「原型验证捷径」：M3 之前用 Node 写
// loopback 客户端在 PC 上对通 relay + Noise 壳 + RPC 全链路。
//
// 用法（relay 需可达；本地起 relay：cd src/ac-relay-server && pnpm start）:
//   npx tsx scripts/remote-loopback-client.ts --relay ws://127.0.0.1:8443 \
//       --rpc ws://127.0.0.1:3830 [--device-name pixel-8] [--reconnect]
//
// 流程：
//   1. 经本地 web-server 的 WS RPC 调 remote/pair-start 拿二维码 URI；
//   2. 解析 URI（relay/room/pk）→ 出站连 relay → join(room) → XK 握手
//      （发起方，载荷 = 设备名+设备公钥）→ 拿 SAS；
//   3. 控制台打印 SAS，等用户在 WebUI 上核对后调 remote/pair-confirm；
//   4. 配对完成 → 在线。跑一组 RPC 冒烟（agents/list 经 scopes 闸门）；
//   5. --reconnect：断开后再连（KK 模式——roomId 确定性派生）。
// ============================================================
import WebSocket from 'ws';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { NoiseHandshake, TransportCipher, b64u, unb64u, sasFromHandshakeHash, type StaticIdentity } from '../src/ac-noise-core/src/index.ts';

// ---- 参数 ----

const args = process.argv.slice(2);
function argOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const RELAY = argOf('--relay') ?? 'ws://127.0.0.1:8443';
const RPC_WS = argOf('--rpc') ?? 'ws://127.0.0.1:3830';
const DEVICE_NAME = argOf('--device-name') ?? 'loopback-node';
const DO_RECONNECT = args.includes('--reconnect');
const SKIP_PAIR = args.includes('--skip-pair');

// ---- 本地 WS RPC 客户端（web-server 面）----

let rpcSeq = 0;
const rpcWaiters = new Map<string, (r: any) => void>();
let rpcWs: WebSocket;

function rpcConnect(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    rpcWs = new WebSocket(url, { headers: { Origin: 'http://localhost:5173' } });
    rpcWs.on('open', () => resolve());
    rpcWs.on('error', reject);
    rpcWs.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'rpc/result' && frame.data?.requestId) {
        const d = frame.data as { requestId: string; ok: boolean; result?: unknown; error?: string };
        const waiter = rpcWaiters.get(d.requestId);
        if (waiter) {
          rpcWaiters.delete(d.requestId);
          waiter(d.ok ? { __ok: true, result: d.result } : { __ok: false, error: d.error });
        }
      }
    });
  });
}

function rpcCall(method: string, params?: unknown): Promise<any> {
  const requestId = 'lb-' + (++rpcSeq);
  return new Promise((resolve, reject) => {
    rpcWaiters.set(requestId, (r) => {
      if (r && (r as any).__ok) resolve((r as any).result);
      else reject(new Error(`rpc ${method}: ${(r as any)?.error ?? 'no response'}`));
    });
    rpcWs.send(JSON.stringify({ type: 'rpc/call', data: { method, requestId, params } }));
    setTimeout(() => {
      if (rpcWaiters.has(requestId)) {
        rpcWaiters.delete(requestId);
        reject(new Error(`rpc ${method} timeout`));
      }
    }, 10000);
  });
}

// ---- relay + Noise 客户端半边 ----

class LoopbackClient {
  identity: StaticIdentity;
  private ws: WebSocket | null = null;
  private transport: { send: TransportCipher; recv: TransportCipher } | null = null;
  onPayload: ((p: any) => void) | null = null;

  constructor() {
    // 设备身份：进程内生成（真机在 Android Keystore——此为原型）
    this.identity = genIdentity();
  }

  /** 出站连 relay + join + XK 发起握手。返回 SAS。 */
  async pairAndHandshake(relayUrl: string, roomId: string, corePub: Buffer): Promise<string> {
    const ws = await this.dial(relayUrl, roomId);
    const hs = new NoiseHandshake('XK', 'initiator', this.identity, corePub);
    // 协议约定（与核心端 relay-connection 对齐）：m1 载荷空，设备信息放 m3
    // （此时链路已加密——设备公钥/名称不以明文过 relay）
    const m1 = hs.writeMessage();
    ws.send(wire({ op: 'frame', data: { hs: b64u(m1) } }));
    const m2 = await this.nextHandshake(ws);
    hs.readMessage(m2);
    if (!hs.remoteStaticMatches(corePub)) throw new Error('XK: 对端静态公钥与二维码不符');
    const info = { name: DEVICE_NAME, pubkey: b64u(this.identity.publicKey) };
    const m3 = hs.writeMessage(Buffer.from(JSON.stringify(info)));
    ws.send(wire({ op: 'frame', data: { hs: b64u(m3) } }));
    const pair = hs.split();
    this.transport = { send: pair.send, recv: pair.recv };
    this.attachFramePump(ws);
    return sasFromHandshakeHash(pair.handshakeHash);
  }

  /**
   * KK 重连（roomId = 核心端同款确定性派生）。
   *
   * relay 只转发实时帧——m1 若早于对端进房即丢失（双方进房时序不定）。
   * 解法：发起方带超时重试——3s 内无 m2 则整链重来（新 dial 新握手新 e），
   * 直到对端在房（房间封闭后 m2 即回）。上层（宿主 responder 侧）同款
   * 语义：expectHandshakeMessage 超时后 runDeviceConnection 重排。
   */
  async reconnect(relayUrl: string, roomId: string, corePub: Buffer, attempts = 20): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        const ws = await this.dial(relayUrl, roomId);
        const hs = new NoiseHandshake('KK', 'initiator', this.identity, corePub);
        const m1 = hs.writeMessage();
        ws.send(wire({ op: 'frame', data: { hs: b64u(m1) } }));
        const m2 = await this.withTimeout(this.nextHandshake(ws), 3000, 'KK m2');
        hs.readMessage(m2);
        const pair = hs.split();
        this.transport = { send: pair.send, recv: pair.recv };
        this.attachFramePump(ws);
        return;
      } catch {
        this.close();
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error(`KK reconnect: ${attempts} 次尝试均未完成握手`);
  }

  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
    ]);
  }

  send(payload: unknown): void {
    if (!this.transport) throw new Error('not connected');
    const { n, ct } = this.transport.send.write(Buffer.from(JSON.stringify(payload)));
    this.ws?.send(wire({ op: 'frame', data: { n, ct: b64u(ct) } }));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.transport = null;
  }

  private dial(relayUrl: string, roomId: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl, { rejectUnauthorized: false, handshakeTimeout: 10000 });
      const guard = setTimeout(() => { try { ws.terminate(); } catch { /* best effort */ } reject(new Error('relay: dial timeout')); }, 15000);
      ws.on('open', () => {
        ws.send(wire({ op: 'join', room: roomId }));
      });
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.op === 'joined') { clearTimeout(guard); this.ws = ws; resolve(ws); }
        else if (f.op === 'room-unavailable') { clearTimeout(guard); reject(new Error('relay: room-unavailable')); }
      });
      ws.on('error', (e) => { clearTimeout(guard); reject(e); });
    });
  }

  private nextHandshake(ws: WebSocket): Promise<Buffer> {
    return new Promise((resolve) => {
      const handler = (raw: { toString(): string }) => {
        const f = JSON.parse(raw.toString());
        if (f.op === 'frame' && f.data?.hs) {
          ws.off('message', handler as never);
          resolve(unb64u(f.data.hs));
        }
      };
      ws.on('message', handler as never);
    });
  }

  private attachFramePump(ws: WebSocket): void {
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.op === 'frame' && typeof f.data?.n === 'number' && typeof f.data?.ct === 'string') {
        if (!this.transport) return;
        try {
          const pt = this.transport.recv.read(f.data.n, unb64u(f.data.ct));
          this.onPayload?.(JSON.parse(pt.toString()));
        } catch (err) {
          console.error('[loopback] 解密失败:', err instanceof Error ? err.message : err);
          this.close();
        }
      }
    });
    ws.on('close', () => { console.log('[loopback] relay 连接断开'); });
  }
}

function wire(obj: unknown): string {
  return JSON.stringify(obj);
}

const IDENTITY_FILE = '.dsh/tmp/loopback-identity.json';

/** 设备身份持久化（模拟 Android Keystore：跨进程同身份 = 同设备——
 *  否则每次重启都是新设备，KK 重连房间永远对不上） */
function genIdentity(): StaticIdentity {
  try {
    const raw = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8')) as { pub: string; priv: string };
    return { publicKey: Buffer.from(raw.pub, 'base64url'), privateKey: Buffer.from(raw.priv, 'base64url') };
  } catch { /* 首次——生成并落盘 */ }
  const pair = crypto.generateKeyPairSync('x25519');
  const pub = Buffer.from((pair.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64');
  const priv = Buffer.from((pair.privateKey.export({ format: 'jwk' }) as { d: string }).d, 'base64');
  try { fs.mkdirSync('.dsh/tmp', { recursive: true }); } catch { /* exists */ }
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify({ pub: pub.toString('base64url'), priv: priv.toString('base64url') }));
  return { publicKey: pub, privateKey: priv };
}

// ---- 主流程 ----

async function main() {
  console.log('[loopback] 连接本地 RPC:', RPC_WS);
  await rpcConnect(RPC_WS);

  const client = new LoopbackClient();
  let relayUrl = RELAY;
  let pk: Buffer;

  if (!SKIP_PAIR) {
    // 清残留会话（前次异常退出可能留下 wait-join 态——pair-cancel 容错）
    try { const st = await rpcCall('remote/status', {}); if (st.state === 'pairing') { await rpcCall('remote/pair-cancel', { sessionId: 'any' }); } } catch { /* 无会话则跳过 */ }
    console.log('[loopback] remote/pair-start ...');
    const session = await rpcCall('remote/pair-start', {});
    console.log('[loopback] 会话:', session.sessionId, '房间:', session.roomId);
    console.log('[loopback] 二维码 URI:', session.qrUri);

    const u = new URL(session.qrUri.replace('agentchat://pair?', 'http://pair/?'));
    relayUrl = u.searchParams.get('relay') ?? RELAY;
    const roomId = u.searchParams.get('room')!;
    pk = unb64u(u.searchParams.get('pk')!);
    console.log('[loopback] relay:', relayUrl);

    const sas = await client.pairAndHandshake(relayUrl, roomId, pk);
    console.log('[loopback] SAS（请在 WebUI 核对一致后确认）:', sas.slice(0, 4), '-', sas.slice(4));

    console.log('[loopback] 等待 WebUI 侧 SAS 确认（remote/pair-confirm）...');
    const deadline = Date.now() + 120000;
    let online = false;
    while (Date.now() < deadline) {
      const st = await rpcCall('remote/status', {});
      if (st.state === 'online' || (st.onlineDeviceIds ?? []).length > 0) { online = true; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!online) {
      console.error('[loopback] 120s 内未见设备上线——SAS 未确认或握手失败');
      process.exit(1);
    }
    console.log('[loopback] 已上线！');
  } else {
    // 老设备直连：从宿主拿身份公钥，走 KK
    const st = await rpcCall('remote/status', {});
    pk = unb64u(st.identityPubkey);
    const devices = await rpcCall('remote/devices', {});
    const dev = devices.devices?.find((d: any) => d.pubkey === b64u(client.identity.publicKey));
    if (!dev) throw new Error('本机身份未注册（先跑一次完整配对）');
    const derived = crypto.createHash('sha256').update(pk).update(Buffer.from(dev.id, 'utf8')).update(Buffer.from(dev.pubkey, 'utf8')).digest();
    const rr = 'r' + derived.subarray(0, 17).toString('base64url');
    console.log('[loopback] KK 直连房间:', rr);
    await rpcCall('remote/connect', { deviceId: dev.id });
    await new Promise((r) => setTimeout(r, 2000));
    await client.reconnect(RELAY, rr, pk);
    console.log('[loopback] KK 直连成功');
  }

  if (!SKIP_PAIR) await smoke(client);

  if (DO_RECONNECT) {
    console.log('[loopback] 断开并重连（KK）...');
    client.close();
    await new Promise((r) => setTimeout(r, 1500));
    const devices = await rpcCall('remote/devices', {});
    const dev = devices.devices?.[0];
    if (!dev) throw new Error('no device');
    const derived = crypto.createHash('sha256').update(pk).update(Buffer.from(dev.id, 'utf8')).update(Buffer.from(dev.pubkey, 'utf8')).digest();
    const rr = 'r' + derived.subarray(0, 17).toString('base64url');
    console.log('[loopback] 重连房间:', rr);
    await rpcCall('remote/connect', { deviceId: dev.id });
    // 等宿主进房（runDeviceConnection 拨号+join 需要时间；轮询 status 到 online
    // 或 connecting 消失——KK 双方谁先进房都行，但 dial 早于宿主 join 也无妨，
    // 房间未封闭 TTL 5min 足够。真正的约束：宿主必须已发起 runDeviceConnection。
    await new Promise((r) => setTimeout(r, 2000));
    await client.reconnect(relayUrl, rr, pk);
    console.log('[loopback] KK 重连成功（双向认证通过）');
    await smoke(client);
  }

  console.log('[loopback] 全链路验证完成');
  process.exit(0);
}

async function smoke(client: LoopbackClient): Promise<void> {
  const result = await new Promise<any>((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 8000);
    client.onPayload = (p) => {
      if (p.type === 'rpc/result') { clearTimeout(timer); resolve(p.data); }
    };
    client.send({ type: 'rpc/call', data: { method: 'agents/list', requestId: 'smoke-' + Date.now(), params: {} } });
  });
  console.log('[loopback] agents/list →', JSON.stringify(result).slice(0, 200));
  if (!result || result.ok !== true) {
    console.error('[loopback] RPC 冒烟失败');
    process.exit(1);
  }
}

main().catch((err) => { console.error('[loopback] 失败:', err); process.exit(1); });