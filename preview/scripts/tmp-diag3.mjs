// 只读探针：ac-agent-loop 的 dep-graph 闭包与 RPC 面状态
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:3830');
let seq = 0;
const pending = new Map();

function rpc(method, params) {
  const requestId = `diag3-${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, method });
    ws.send(JSON.stringify({ type: 'rpc/call', data: { method, requestId, params: params ?? {} } }));
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(new Error(`timeout: ${method}`));
      }
    }, 6000);
  });
}

ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString());
  if (frame.type !== 'rpc/result') return;
  const p = pending.get(frame.data.requestId);
  if (!p) return;
  pending.delete(frame.data.requestId);
  if (frame.data.ok) p.resolve(frame.data.result);
  else p.reject(new Error(`${p.method}: ${frame.data.error}`));
});

ws.on('open', async () => {
  try {
    const g = await rpc('plugin/dep-graph');
    const rows = g.rows ?? [];
    console.log(`dep-graph nodes=${rows.length}`);
    const loop = rows.find((r) => r.name === 'ac-agent-loop');
    console.log('ac-agent-loop rowDeps:', JSON.stringify(loop?.rowDeps));
    console.log('ac-agent-loop dependents(闭包):', JSON.stringify(loop?.dependents));
    console.log('闭包含 ac-web-api?', (loop?.dependents ?? []).includes('ac-web-api'));
    const cat = await rpc('plugin/catalog');
    console.log(`catalog: builtin=${(cat.builtin ?? []).length}`);
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message);
    ws.close();
    process.exit(1);
  }
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
