// M3.2 验收验证：模拟 WebView 侧经回环桥走通 HTTP 静态 + WS + rpc/call（加密链路）
import WebSocket from 'ws';

const port = Number(process.argv[2] ?? 4043);
const base = 'http://127.0.0.1:' + port;
let failures = 0;
const check = (label: string, cond: boolean, extra = '') => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
};

// 1) 静态资源（WebView 加载面）
const html = await (await fetch(base + '/')).text();
check('HTTP: index.html 可达', html.includes('<div id="app">'), html.length + ' bytes');
const fallback = await (await fetch(base + '/some/spa/route')).text();
check('HTTP: SPA fallback 回落 index.html', fallback === html);
const asset = await fetch(base + '/logo.svg');
check('HTTP: 静态资源（logo.svg）可达', asset.ok, String(asset.status));

// 2) WS 业务面（webui 的 wire.ts 契约）
const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
const inbox: any[] = [];
const waitFor = (pred: (f: any) => boolean, ms: number) => new Promise<any>((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    const hit = inbox.find(pred);
    if (hit) return resolve(hit);
    if (Date.now() - t0 > ms) return reject(new Error('timeout waiting frame'));
    setTimeout(tick, 100);
  };
  tick();
});
await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
ws.on('message', (m) => { try { inbox.push(JSON.parse(m.toString())); } catch { /* 忽略非 JSON */ } });

const ready = await waitFor((f) => f.type === 'ws/ready', 8000);
check('WS: 连接即下发 ws/ready', ready?.data?.protocol === 1, 'connId=' + ready?.data?.connId);

// 3) rpc/call 经回环桥 → 加密 relay → 核心端 → 加密回程 → WebView
// requestId 带时间戳：避开 web-server 的 method+requestId 30s 幂等去重窗（跨次运行同一 id 会被 dedup 吞掉）
const rid = 'm32-verify-' + Date.now();
ws.send(JSON.stringify({ type: 'rpc/call', data: { method: 'agents/list', requestId: rid } }));
try {
  const res = await waitFor((f) => f.type === 'rpc/result' && f.data?.requestId === rid, 20000);
  const n = res.data.result?.agents?.length ?? 0;
  check('RPC: agents/list 经桥+加密链路往返', res.data.ok === true && n > 0, n + ' 个 agent');
} catch (e) {
  check('RPC: agents/list 经桥+加密链路往返', false, String(e));
}

ws.close();
console.log(failures === 0 ? '\nM3.2 回环桥验收全部通过 ✅' : '\n失败 ' + failures + ' 项 ❌');
process.exit(failures === 0 ? 0 : 1);