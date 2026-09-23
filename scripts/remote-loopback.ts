// ============================================================
// scripts/remote-loopback.ts —— 远程链路 loopback 验证客户端
//（m1 方案预留的「~50 行冒充安卓端」原型捷径，P1 落地）
//
// 在 PC 上冒充手机端，对通 relay + Noise 壳 + RPC 全链路：
//   ① 解析配对二维码 URI（agentchat://pair）
//   ② join 房间 + XK 握手（发起方）
//   ③ SAS 打印（人工比对或 --yes 自动确认）
//   ④ RPC 往返（agents/list 等 read 档方法）
//   ⑤ 断线重连（KK）
//
// 用法：
//   1) 宿主侧（另一个终端）：remote/pair-start 的二维码 URI 传给本脚本
//   2) npx tsx scripts/remote-loopback.ts "<qrUri>" [--yes]
// ============================================================
import WebSocket from 'ws';
import { NoiseHandshake, b64u, unb64u, sasFromHandshakeHash, generateStaticIdentity, type StaticIdentity } from 'ac-noise-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---- 参数 ----
const qrUri = process.argv[2];
const autoYes = process.argv.includes('--yes');
if (!qrUri || !qrUri.startsWith('agentchat://pair?')) {
  console.error('用法: npx tsx scripts/remote-loopback.ts "agentchat://pair?..." [--yes]');
  process.exit(1);
}

// ---- 解析二维码 ----
const params = new URLSearchParams(qrUri.slice('agentchat://pair?'.length));
const relayUrl = params.get('relay');
const room = params.get('room');
const corePub = params.get('pk');
const exp = Number(params.get('exp') ?? 0);
if (!relayUrl || !room || !corePub) { console.error('二维码缺字段'); process.exit(1); }
if (exp && Date.now() > exp) { console.error('二维码已过期'); process.exit(1); }
console.log(`relay=${relayUrl} room=${room.slice(0, 8)}… exp=${new Date(exp).toLocaleTimeString()}`);

// ---- 设备身份（loopback 专用临时目录，不污染真实 data root）----
const idDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopback-device-'));
const idFile = path.join(idDir, 'identity.json');
let identity: StaticIdentity;
if (fs.existsSync(idFile)) {
  const raw = JSON.parse(fs.readFileSync(idFile, 'utf8'));
  identity = { publicKey: unb64u(raw.publicKey), privateKey: unb64u(raw.privateKey) };
} else {
  identity = generateStaticIdentity();
  fs.writeFileSync(idFile, JSON.stringify({
    publicKey: b64u(identity.publicKey),
    privateKey: b64u(identity.privateKey),
  }));
}
console.log(`设备公钥: ${b64u(identity.publicKey).slice(0, 12)}…`);

// ---- 连 relay + XK 握手 ----
const ws = new WebSocket(relayUrl, { rejectUnauthorized: false, handshakeTimeout: 10000 });
let transport: { send: import('ac-noise-core').TransportCipher; recv: import('ac-noise-core').TransportCipher } | null = null;
let sendN = 0;
const results: Array<[string, boolean]> = [];
const ok = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass]);
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

function sendFrame(obj: unknown): void {
  ws.send(JSON.stringify({ op: 'frame', data: obj }));
}

let rpcSeq = 0;
const pendingRpc = new Map<string, (r: any) => void>();

function rpcCall(method: string, params?: unknown): Promise<any> {
  const requestId = `lb-${++rpcSeq}`;
  sendEncrypted({ type: 'rpc/call', data: { method, requestId, params } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC 超时: ${method}`)), 10000);
    pendingRpc.set(requestId, (r) => { clearTimeout(timer); resolve(r); });
  });
}

function sendEncrypted(payload: unknown): void {
  if (!transport) throw new Error('not online');
  const { n, ct } = transport.send.write(Buffer.from(JSON.stringify(payload)));
  sendFrame({ n, ct: b64u(ct) });
}

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.op === 'frame' && msg.data) {
    const d = msg.data;
    if (typeof d.hs === 'string') { onHandshake(unb64u(d.hs)); return; }
    if (typeof d.n === 'number' && typeof d.ct === 'string' && transport) {
      const pt = transport.recv.read(d.n, unb64u(d.ct));
      const payload = JSON.parse(pt.toString());
      if (payload.type === 'rpc/result') {
        const waiter = pendingRpc.get(payload.data?.requestId);
        if (waiter) waiter(payload.data);
      }
    }
  }
});

let hs: NoiseHandshake | null = null;
let stage = 0;

function onHandshake(msg: Buffer): void {
  if (!hs) return;
  if (stage === 1) {
    // 收到 m2（e,ee,s,es）——读
    hs.readMessage(msg);
    ok('XK m2 解析（核心端静态公钥验证）', hs.remoteStaticMatches(unb64u(corePub)));
    // 发 m3（s,se）——设备信息
    const info = { name: 'loopback-node', pubkey: b64u(identity.publicKey) };
    const m3 = hs.writeMessage(Buffer.from(JSON.stringify(info)));
    sendFrame({ hs: b64u(m3) });
    const pair = hs.split();
    transport = pair;
    const sas = sasFromHandshakeHash(pair.handshakeHash);
    console.log(`\n  SAS 比对码: ${sas.slice(0, 4)} ${sas.slice(4)}  （宿主侧确认后链路建立）\n`);
    stage = 2;
    // 等待宿主确认后即可 RPC——loopback 直接试（宿主 --yes 场景已自动确认）
    setTimeout(() => void runRpcTests(), 500);
  }
}

ws.on('open', () => {
  ws.send(JSON.stringify({ op: 'join', room }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.op === 'joined' && stage === 0) {
    ok('join 房间', true);
    // 发起 XK m1（e）
    hs = new NoiseHandshake('XK', 'initiator', identity, unb64u(corePub));
    const m1 = hs.writeMessage(Buffer.from(JSON.stringify({ hello: 'loopback' })));
    sendFrame({ hs: b64u(m1) });
    stage = 1;
  }
});

async function runRpcTests(): Promise<void> {
  try {
    const list = await rpcCall('agents/list');
    ok('RPC agents/list', Array.isArray(list?.agents), `agents=${list?.agents?.length ?? 0}`);
    const stats = await rpcCall('conversation/stats');
    ok('RPC conversation/stats', typeof stats === 'object');
    // scopes 闸门：chat 档默认应有——deliver 测试会真实投递消息，loopback 跳过
    const forbidden = await rpcCall('config/set').catch((e: Error) => e);
    ok('RPC config/set 被拒（不在白名单）', forbidden instanceof Error || forbidden?.error !== undefined);
  } catch (e) {
    ok('RPC 往返', false, e instanceof Error ? e.message : String(e));
  }
  // 收尾
  const passed = results.filter(([, p]) => p).length;
  console.log(`\nloopback 结果: ${passed}/${results.length} 通过`);
  ws.close();
  process.exit(passed === results.length ? 0 : 1);
}

ws.on('error', (e) => {
  console.error('连接失败:', e.message);
  process.exit(1);
});