// M3.1 跨端验证：Node(responder=pc) ⇄ Kotlin(initiator=phone)
// 用法：npx tsx scripts/m31-cross-verify.ts <kotlinClasspath>
// Kotlin 侧驱动器：mobile/transport/src/main/kotlin/agentchat/noise/CrossTest.kt
import { NoiseHandshake, sasFromHandshakeHash, b64u, unb64u, generateStaticIdentity, dh } from '../src/ac-noise-core/src/index.ts';
import { spawn } from 'node:child_process';

const classpath = process.argv[2];
if (!classpath) { console.error('用法: npx tsx scripts/m31-cross-verify.ts <kotlinClasspath>'); process.exit(2); }

const child = spawn('java', ['-cp', classpath, 'agentchat.noise.CrossTestKt'], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending: ((line: any) => void)[] = [];
const buf: string[] = [];
let carry = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  carry += d;
  const lines = carry.split('\n');
  carry = lines.pop() ?? '';
  for (const l of lines) if (l.trim()) {
    const waiter = pending.shift();
    if (waiter) waiter(JSON.parse(l));
    else buf.push(l);
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => process.stderr.write('[kotlin] ' + d));

function send(obj: unknown): void {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

function recv(op: string, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    // 先查缓冲
    const idx = buf.findIndex((l) => { try { return JSON.parse(l).op === op } catch { return false } });
    if (idx >= 0) { resolve(JSON.parse(buf.splice(idx, 1)[0])); return; }
    const timer = setTimeout(() => reject(new Error('timeout waiting ' + op)), timeoutMs);
    pending.push((line) => { clearTimeout(timer); resolve(line); });
  });
}

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label);
  if (!cond) failures++;
}

// ---- 主流程 ----
const pc = generateStaticIdentity();
send({ op: 'pair', pub: b64u(pc.publicKey) });
const pairOk = await recv('pair.ok');
const phonePubKotlin = pairOk.pub;

// XK 配对
send({ op: 'xk.start' });
const m1 = await recv('xk.m1');
const resp = new NoiseHandshake('XK', 'responder', pc);
resp.readMessage(unb64u(m1.hs));
const m2 = resp.writeMessage();
send({ op: 'xk.m2', hs: b64u(m2) });
const m3 = await recv('xk.m3');
const info = JSON.parse(resp.readMessage(unb64u(m3.hs)).toString());
check('XK: 设备信息可达 (name)', info.name === 'kotlin-device');
check('XK: responder 解出发起方公钥 = pair.ok 的 pub', b64u(resp.remoteStatic!) === phonePubKotlin);
const sasKotlin = (await recv('sas')).v;
const sasNode = sasFromHandshakeHash(resp.split().handshakeHash);
check('XK: SAS 双端一致 (' + sasNode + ')', sasKotlin === sasNode);
const pcPair = resp.split();

// 双向帧
send({ op: 'frame.send', v: 'hello-kotlin' });
const fout = await recv('frame.out');
check('frame: Node 解开 Kotlin 帧', pcPair.recv.read(Number(fout.n), unb64u(fout.ct)).toString() === 'hello-kotlin');
const f = pcPair.send.write(Buffer.from('hello-node'));
send({ op: 'frame.in', n: f.n, ct: b64u(f.ct) });
const ack = await recv('frame.ack');
check('frame: Kotlin 解开 Node 帧', ack.v === 'hello-node');

// KK 重连
send({ op: 'kk.start' });
const kk1 = await recv('kk.m1');
const r2 = new NoiseHandshake('KK', 'responder', pc, unb64u(phonePubKotlin));
r2.readMessage(unb64u(kk1.hs));
send({ op: 'kk.m2', hs: b64u(r2.writeMessage()) });
await recv('kk.done');
const kkPair = r2.split();
const kf = kkPair.send.write(Buffer.from('reconnected'));
send({ op: 'frame.in', n: kf.n, ct: b64u(kf.ct) });
const kack = await recv('frame.ack');
check('KK: 重连后帧互通', kack.v === 'reconnected');

send({ op: 'done' });
await recv('done');
child.stdin.end();
await new Promise((r) => child.on('exit', r));
console.log(failures === 0 ? 'M3.1 跨端验证全部通过 ✅' : '失败 ' + failures + ' 项 ❌');
process.exit(failures === 0 ? 0 : 1);
