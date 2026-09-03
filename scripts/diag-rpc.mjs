// 诊断脚本：查询运行实例（3830）的 RPC 面，还原前端实际看到的数据
import WebSocket from 'ws';
import { buildFrame, parseFrame, RPC_CALL, RPC_RESULT, WS_READY } from 'ac-ws-protocol';

const url = process.argv[2] ?? 'ws://127.0.0.1:3830/ws';
// 方法参数：method=k1:v1,k2:v2 形态（可选）
const specs = (process.argv.slice(3).length > 0 ? process.argv.slice(3) : ['llm/providers', 'agents/list'])
  .map((spec) => {
    const [method, kv] = spec.split('=');
    const params = {};
    if (kv) for (const pair of kv.split(',')) { const [k, v] = pair.split(':'); params[k] = v; }
    return { method, params };
  });

const ws = new WebSocket(url);
const pending = new Map();
let ready = false;
ws.on('message', (raw) => {
  const frame = parseFrame(raw.toString());
  if (!frame) return;
  if (frame.type === WS_READY) { ready = true; return; }
  if (frame.type !== RPC_RESULT) return;
  const d = frame.data ;
  if (d?.requestId && pending.has(d.requestId)) {
    pending.get(d.requestId)(JSON.stringify(d).slice(0, 3000));
    pending.delete(d.requestId);
  }
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });

setTimeout(() => {
  if (!ready) { console.error('WS_READY 未收到（端点/握手不符）'); process.exit(1); }
  let i = 0;
  for (const { method, params } of specs) {
    const id = `diag-${++i}`;
    const p = new Promise((resolve) => pending.set(id, resolve));
    ws.send(buildFrame(RPC_CALL, { method, requestId: id, params }));
    Promise.race([p, new Promise((r) => setTimeout(() => r('(timeout)'), 5000))]).then((out) => {
      console.log(`\n=== ${method} ===\n${out}`);
    });
  }
  setTimeout(() => process.exit(0), 6000);
}, 500);
