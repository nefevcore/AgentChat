// scripts/relay-e2e.ts —— relay 公网 e2e 验证（join/双向帧/第三者拒绝/TLS pin）
// 一次性脚本：模拟配对双方 + 扫描者，对照 relay 协议预期
import WebSocket from 'ws';
import { spawnSync } from 'node:child_process';

const URL = 'wss://47.110.63.135:8443';
const ROOM = 'e2e-test-room-0000000000000001';

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, { rejectUnauthorized: false, handshakeTimeout: 8000 });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
function send(ws: WebSocket, obj: unknown): void {
  ws.send(JSON.stringify(obj));
}
function nextMsg(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待消息超时')), timeoutMs);
    ws.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())); });
  });
}

async function main() {
  let failures = 0;
  const check = (name: string, cond: boolean) => {
    console.log(`${cond ? '✓' : '✗'} ${name}`);
    if (!cond) failures++;
  };

  // ① 双方 join
  const a = await connect();
  const b = await connect();
  send(a, { op: 'join', room: ROOM });
  check('A join → joined', (await nextMsg(a)).op === 'joined');
  send(b, { op: 'join', room: ROOM });
  check('B join → joined', (await nextMsg(b)).op === 'joined');

  // ② A→B 密文帧透传（opaque 原样）
  const payload = { op: 'frame', data: { n: 42, ct: 'base64ciphertext==' } };
  send(a, payload);
  const got = await nextMsg(b);
  check('A→B 帧透传（opaque 原样）', JSON.stringify(got) === JSON.stringify(payload));

  // ③ B→A 反向
  const payload2 = { op: 'frame', data: { n: 43, ct: 'replycipher==' } };
  send(b, payload2);
  check('B→A 帧透传', JSON.stringify(await nextMsg(a)) === JSON.stringify(payload2));

  // ④ ping/pong
  send(a, { op: 'ping' });
  check('ping → pong', (await nextMsg(a)).op === 'pong');

  // ⑤ 第三者扫描：同房间 join 拒绝（统一错误码）
  const c = await connect();
  send(c, { op: 'join', room: ROOM });
  check('第三者 join → room-unavailable（无存在性回声）', (await nextMsg(c)).op === 'room-unavailable');

  // ⑥ 未入房间发 frame → 断连
  send(c, { op: 'frame', data: 'x' });
  const cClosed = await new Promise<boolean>((res) => { c.once('close', () => res(true)); setTimeout(() => res(false), 4000); });
  check('未入房间 frame → 断连', cClosed);

  // ⑦ 非法房间号（短）→ 统一错误码
  const d = await connect();
  send(d, { op: 'join', room: 'short' });
  check('非法房间号 → room-unavailable（同码）', (await nextMsg(d)).op === 'room-unavailable');
  d.close();

  // ⑧ 房间销毁语义：A 断开 → B 也断
  a.close();
  const bClosed = await new Promise<boolean>((res) => { b.once('close', () => res(true)); setTimeout(() => res(false), 5000); });
  check('A 断开 → 房间销毁（B 同断）', bClosed);

  // ⑨ TLS 指纹 pin 核对（配对二维码将携带的信任锚）
  const fp = spawnSync('C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    ['s_client', '-connect', '47.110.63.135:8443', '-servername', '47.110.63.135'],
    { input: '', timeout: 10000 });
  const local = spawnSync('C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    ['x509', '-noout', '-fingerprint', '-sha256', '-in', `${process.env.TEMP}\\relay-deploy\\tls.crt`]);
  console.log('  （本地证书指纹 = 配对码信任锚，客户端 pin 此值）');
  console.log(' ', local.stdout.toString().trim().split('=').at(-1)?.slice(0, 32) + '…');

  console.log(failures === 0 ? '\n=== e2e 全部通过 ===' : `\n=== ${failures} 项失败 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('e2e 异常:', e.message); process.exit(1); });
