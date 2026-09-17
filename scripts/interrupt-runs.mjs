// 中断指定会话的在途 run：runs/snapshot 查看活跃 → runs/interrupt 中止。
// 用法：node scripts/interrupt-runs.mjs <convId> [convId2 ...]
import { WebSocket } from 'ws';

const URL = 'ws://127.0.0.1:3830';
const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('用法: node scripts/interrupt-runs.mjs <conversationId> [...]');
  process.exit(1);
}

const ws = new WebSocket(URL, { origin: 'http://127.0.0.1:3830' });
const pending = new Map();
let nextReq = 1;

function callRpc(method, params) {
  return new Promise((resolve, reject) => {
    const requestId = `req-${nextReq++}`;
    pending.set(requestId, { resolve, reject });
    ws.send(JSON.stringify({ type: 'rpc/call', data: { method, requestId, params } }));
  });
}

ws.on('open', async () => {
  try {
    // 1) 快照：确认哪些目标会话有活跃 run
    const snap = await callRpc('runs/snapshot', {});
    const runs = snap?.runs ?? [];
    console.log(`[interrupt] 活跃 run 数: ${runs.length}`);
    for (const r of runs) {
      const cid = r.conversationId ?? r.conv ?? r.conversation ?? '?';
      const row = JSON.stringify(r).slice(0, 200);
      console.log(`  - ${cid}: ${row}`);
    }
    // 2) 逐个中断目标
    for (const id of ids) {
      const res = await callRpc('runs/interrupt', { conversationId: id });
      console.log(`[interrupt] ${id} →`, JSON.stringify(res));
    }
    // 3) 等 1s 再快照一次确认
    await new Promise((r) => setTimeout(r, 1000));
    const snap2 = await callRpc('runs/snapshot', {});
    const runs2 = snap2?.runs ?? [];
    const remain = runs2.filter((r) => ids.includes(r.conversationId ?? r.conv ?? r.conversation));
    console.log(`[interrupt] 中断后剩余活跃 run: ${runs2.length}，目标会话剩余: ${remain.length}`);
    process.exit(remain.length > 0 ? 2 : 0);
  } catch (err) {
    console.error('[interrupt] 失败:', err);
    process.exit(1);
  }
});

ws.on('message', (raw) => {
  let frame;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (frame.type === 'rpc/result') {
    const { requestId, ok, result, error } = frame.data ?? {};
    const entry = pending.get(requestId);
    if (entry) {
      pending.delete(requestId);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error ?? 'rpc error'));
    }
  }
});

ws.on('error', (err) => {
  console.error('[interrupt] WS 错误:', err.message);
  process.exit(1);
});
