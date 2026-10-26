// relay 公网 e2e 验证脚本：TLS WS（自签，rejectUnauthorized:false——生产由
// Noise 层认证，TLS 仅混淆）→ join/双向帧/第三者拒绝/离线销毁
import WebSocket from 'ws';

const URL = 'wss://47.110.63.135:8443';
const ROOM = 'e2e' + 'a'.repeat(28);
const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

function conn(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, { rejectUnauthorized: false, handshakeTimeout: 8000 });
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox, label }));
    ws.on('error', reject);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastOp = (c) => (c.inbox.length ? c.inbox[c.inbox.length - 1].op : '(none)');

// ① A join（创建房间）
const a = await conn('A');
a.ws.send(JSON.stringify({ op: 'join', room: ROOM }));
await wait(500);
ok('A join', lastOp(a) === 'joined');

// ② B join（封闭房间）
const b = await conn('B');
b.ws.send(JSON.stringify({ op: 'join', room: ROOM }));
await wait(500);
ok('B join（房间封闭）', lastOp(b) === 'joined');

// ③ C join → room-unavailable（第三者不可见）
const c = await conn('C');
c.ws.send(JSON.stringify({ op: 'join', room: ROOM }));
await wait(500);
ok('C 拒绝（统一 room-unavailable）', lastOp(c) === 'room-unavailable');

// ④ 双向帧转发（A→B、B→A）
a.ws.send(JSON.stringify({ op: 'frame', data: { from: 'A', n: 1 } }));
b.ws.send(JSON.stringify({ op: 'frame', data: { from: 'B', n: 2 } }));
await wait(800);
const aGot = a.inbox.filter((m) => m.op === 'frame');
const bGot = b.inbox.filter((m) => m.op === 'frame');
ok('A→B 帧转发', bGot.length === 1 && bGot[0].data.from === 'A');
ok('B→A 帧转发', aGot.length === 1 && aGot[0].data.from === 'B');

// ⑤ ping/pong
a.ws.send(JSON.stringify({ op: 'ping' }));
await wait(400);
ok('ping→pong', a.inbox.some((m) => m.op === 'pong'));

// ⑥ A 离线 → B 被断（房间销毁）
a.ws.close();
await wait(800);
ok('A 离线 → 房间销毁（B 断开）', b.ws.readyState === WebSocket.CLOSED);

// ⑦ 垃圾输入 → 断连
const g = await conn('G');
g.ws.send('not-json-at-all');
await wait(600);
ok('非 JSON 输入 → 断连', g.ws.readyState >= WebSocket.CLOSING);

for (const x of [b, c, g]) { try { x.ws.close(); } catch {} }
const failed = results.filter((r) => !r.pass);
console.log(failed.length === 0 ? '\n=== e2e 全部通过 ===' : `\n=== ${failed.length} 项失败 ===`);
process.exit(failed.length === 0 ? 0 : 1);
