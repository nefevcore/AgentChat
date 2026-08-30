// 名册 Port B 真链路验证：对运行中的 preview:boot（3830）验证
// api/roster.ts + api/groups.ts 直连面——名册汇聚/群/群历史形状。
// 用法：node preview/scripts/verify-roster-portb.mjs
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:3830');
let seq = 0;
const pending = new Map();

function rpc(method, params) {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const requestId = `v-${nonce}-${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, method });
    ws.send(JSON.stringify({ type: 'rpc/call', data: { method, requestId, params: params ?? {} } }));
    setTimeout(() => {
      if (pending.has(requestId)) { pending.delete(requestId); reject(new Error(`timeout: ${method}`)); }
    }, 8000);
  });
}

ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString());
  if (frame.type !== 'rpc/result') return;
  const p = pending.get(frame.data.requestId);
  if (!p) return;
  pending.delete(frame.data.requestId);
  if (frame.data.ok) p.resolve(frame.data.result); else p.reject(new Error(`${p.method}: ${frame.data.error}`));
});

ws.on('open', async () => {
  try {
    // fetchAgents 汇聚：agents/list + conversation/stats
    const [agentsR, statsR] = await Promise.all([rpc('agents/list'), rpc('conversation/stats')]);
    const roster = (agentsR.agents ?? []).map((a) => ({ id: a.id, name: a.description ?? a.id, hasActiveSession: (statsR.running ?? []).some((r) => r.agentId === a.id) }));
    console.log(`roster: ${roster.length} 个 Agent（hasActiveSession=${roster.filter((r) => r.hasActiveSession).length}）`);
    for (const r of roster.slice(0, 4)) console.log(`  - ${r.id} → "${r.name}"`);

    // fetchPools：config/get
    const cfg = await rpc('config/get');
    console.log(`pools: llmProviders=${Object.keys(cfg.config?.llmProviders ?? cfg.config?.llm ?? {}).length} searchProviders=${Object.keys(cfg.config?.searchProviders ?? {}).length}`);

    // fetchAgentModels：llm/providers
    const prov = await rpc('llm/providers');
    console.log(`models: providers=${(prov.providers ?? []).length} models=${[...new Set((prov.stats ?? []).flatMap((s) => s.models ?? []))].length}`);

    // fetchSessionTokens
    const target = roster.find((r) => !r.id.includes('user'));
    if (target) {
      const t = await rpc('session/tokens', { conversationId: target.id });
      console.log(`sessionTokens(${target.id}): msgs=${t.messageCount} lastContextPrompt=${t.lastContextPrompt} status=${t.status}`);
    }

    // groups：list + history
    const groups = await rpc('group/list');
    for (const g of groups.groups ?? []) {
      console.log(`group: ${g.id} "${g.name}" members=[${g.members.join(',')}] createdAt=${g.createdAt}`);
      const h = await rpc('group/history', { groupId: g.id, limit: 3 });
      console.log(`  history: ${(h.messages ?? []).length} 条（首条 from=${h.messages?.[0]?.from}）`);
    }

    console.log('OK: 名册 Port B 后端面全部就绪');
    ws.close(); process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message);
    ws.close(); process.exit(1);
  }
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
