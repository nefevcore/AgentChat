// M3.1 自动 SAS 确认（模拟 WebUI 用户点「一致」）。
// sessionId 经 .dsh/tmp/pair-session.txt 传递（Kotlin RelayMain pair-start 后落盘）。
import WebSocket from 'ws';
import * as fs from 'node:fs';

const rpc = process.argv[2] ?? 'ws://127.0.0.1:4183';
let seq = 0;
const ws = new WebSocket(rpc, { headers: { Origin: 'http://localhost:5173' } });
const call = (method: string, params: unknown) => {
  const requestId = 'ac-' + (++seq);
  return new Promise<any>((resolve) => {
    const on = (raw: { toString(): string }) => {
      const f = JSON.parse(raw.toString());
      if (f?.data?.requestId === requestId) { ws.off('message', on as never); resolve(f.data); }
    };
    ws.on('message', on as never);
    ws.send(JSON.stringify({ type: 'rpc/call', data: { method, requestId, params } }));
  });
};
ws.on('open', async () => {
  try { fs.rmSync('.dsh/tmp/pair-session.txt'); } catch { /* 首次无 */ }
  for (let i = 0; i < 90; i++) {
    let sessionId = '';
    try { sessionId = fs.readFileSync('.dsh/tmp/pair-session.txt', 'utf8').trim(); } catch { /* 未写 */ }
    if (sessionId) {
      const r = await call('remote/pair-confirm', { sessionId, accept: true });
      console.log('[confirm] pair-confirm →', JSON.stringify(r).slice(0, 160));
      process.exit(r?.ok === true ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('[confirm] 45s 内未拿到 sessionId');
  process.exit(1);
});