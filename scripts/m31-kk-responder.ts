// M3.1 KK 专项：Node responder 在 relay 房间等 Kotlin initiator 的 m1 → 回 m2 → 验证帧互通
import WebSocket from 'ws';
import { NoiseHandshake, b64u, unb64u } from '../src/ac-noise-core/src/index.ts';

const relay = process.argv[2] ?? 'ws://127.0.0.1:18443';
const roomId = process.argv[3];
if (!roomId) { console.error('用法: npx tsx scripts/m31-kk-responder.ts <relay> <room>'); process.exit(2); }

// 身份：从宿主 data root 拿真核心端身份（与 Kotlin 端 corePub 一致）
import * as fs from 'node:fs';
const raw = JSON.parse(fs.readFileSync('.dsh/tmp/loopback-data/remote/identity', 'utf8'));
const corePub = Buffer.from(raw.publicKey, 'base64url');
const corePriv = Buffer.from(raw.privateKey, 'base64url');
console.log('[kk-resp] core pub=' + b64u(corePub));

// 设备公钥：从 known_devices 拿
const reg = JSON.parse(fs.readFileSync('.dsh/tmp/loopback-data/remote/known_devices.json', 'utf8'));
const dev = reg.devices.find((d: any) => d.name === 'kotlin-phone') ?? reg.devices[0];
console.log('[kk-resp] device=' + dev.id + ' pub=' + dev.pubkey);

const ws = new WebSocket(relay, { rejectUnauthorized: false });
ws.on('open', () => ws.send(JSON.stringify({ op: 'join', room: roomId })));
ws.on('message', (raw2: { toString(): string }) => {
  const f = JSON.parse(raw2.toString());
  if (f.op === 'joined') { console.log('[kk-resp] joined'); return; }
  if (f.op === 'frame' && f.data?.hs) {
    const hs = new NoiseHandshake('KK', 'responder', { publicKey: corePub, privateKey: corePriv }, unb64u(dev.pubkey));
    hs.readMessage(unb64u(f.data.hs));
    ws.send(JSON.stringify({ op: 'frame', data: { hs: b64u(hs.writeMessage()) } }));
    const pair = hs.split();
    console.log('[kk-resp] KK 握手完成');
    const t1 = pair.send.write(Buffer.from('kk-pong'));
    ws.send(JSON.stringify({ op: 'frame', data: { n: t1.n, ct: b64u(t1.ct) } }));
    return;
  }
  if (f.op === 'frame' && typeof f.data?.n === 'number') {
    // 收 Kotlin 帧（recv.read 需要握手态——此处简单回显）
    console.log('[kk-resp] 收到帧 n=' + f.data.n);
  }
});
setTimeout(() => { console.log('[kk-resp] 超时退出'); process.exit(1); }, 30000);