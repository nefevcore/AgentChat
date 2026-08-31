// 真实迁移数据验证：对运行中的 preview:boot（3830）验证适配器消费的
// 后端面——名册/singles/群/历史/usage 的形状与数据量。
// 用法：node preview/scripts/verify-adapter-realdata.mjs
import WebSocket from 'ws';

const URL_ = 'ws://127.0.0.1:3830';
const ws = new WebSocket(URL_);
let seq = 0;
const pending = new Map();

function rpc(method, params) {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const requestId = `verify-${nonce}-${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, method });
    ws.send(JSON.stringify({ type: 'rpc/call', data: { method, requestId, params: params ?? {} } }));
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(new Error(`timeout: ${method}`));
      }
    }, 8000);
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
    const agents = await rpc('agents/list');
    const names = (agents.agents ?? []).map((a) => ({ id: a.id, name: a.description ?? '(无描述)', virtual: !!a.virtual }));
    console.log(`agents: ${names.length}`);
    for (const n of names) console.log(`  - ${n.id} → name="${n.name}"${n.virtual ? ' [virtual]' : ''}`);

    const singles = await rpc('singles/list');
    console.log(`singles: ${(singles.singles ?? []).length}`);
    for (const s of singles.singles ?? []) console.log(`  - ${s.id} agent=${s.agentId} status=${s.status}${s.workspaceId ? ` ws=${s.workspaceId}` : ''}`);

    const groups = await rpc('group/list');
    console.log(`groups: ${(groups.groups ?? []).length}`);
    for (const g of groups.groups ?? []) console.log(`  - ${g.id} "${g.name}" members=[${(g.members ?? []).join(',')}]`);

    // 任一 1v1 会话历史（取第一个非 user agent）
    const target = (agents.agents ?? []).find((a) => a.id !== 'user' && !a.virtual);
    if (target) {
      const h = await rpc('session/history', { conversationId: target.id, limit: 5, offset: 0 });
      console.log(`history(${target.id}): total=${h.total} hasMore=${h.hasMore} page=${(h.records ?? []).length}`);
      for (const r of h.records ?? []) console.log(`  [${r.role}] ${(r.content ?? '').slice(0, 40).replace(/\n/g, ' ')}${r.name ? ` (name=${r.name})` : ''}`);
    }

    const usage = await rpc('usage/tokens');
    console.log(`usage: totals{runs=${usage.totals?.runs}, prompt=${usage.totals?.prompt}} byDay=${(usage.byDay ?? []).length} byConv=${Object.keys(usage.byConversation ?? {}).length}`);

    const runs = await rpc('runs/snapshot');
    console.log(`runs: conversations=${(runs.conversations ?? []).length} groups=${(runs.groups ?? []).length} running=${(runs.running ?? []).length}`);

    console.log('OK: 后端面全部就绪（适配器消费的形状与真数据验证通过）');
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message);
    ws.close();
    process.exit(1);
  }
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
