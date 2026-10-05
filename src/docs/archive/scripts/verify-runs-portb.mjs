// 运行跟踪 Port B 真链路验证：对运行中的 preview:boot（3830）验证
// api/runs.ts 直连面——runs/snapshot 聚合 + pair 历史 + interrupt 换算源。
// 用法：node preview/scripts/verify-runs-portb.mjs
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
    // fetchRuns 聚合源：runs/snapshot + agents/list
    const [snapshot, agentsR] = await Promise.all([rpc('runs/snapshot'), rpc('agents/list')]);
    const agentIds = new Set((agentsR.agents ?? []).map((a) => a.id));
    const pairs = (snapshot.conversations ?? []).filter((c) => !c.conversationId.includes('~') && agentIds.has(c.conversationId));
    console.log(`runs/snapshot: conversations=${(snapshot.conversations ?? []).length} → pairs(1v1)=${pairs.length} groups=${(snapshot.groups ?? []).length} running=${(snapshot.running ?? []).length}`);
    for (const p of pairs.slice(0, 3)) console.log(`  pair: user↔${p.conversationId} msgs=${p.messageCount}`);
    // P4：尾部摘要（名册 lastActivity/lastMessage 合成源）
    const withLast = (snapshot.conversations ?? []).filter((c) => c.last);
    console.log(`tail 摘要: ${withLast.length}/${(snapshot.conversations ?? []).length} 会话携带 last（P4 名册合成）`);
    // 热力窗口（矩阵范围按钮数据源；后端按记录时间戳统计）
    const withWindows = (snapshot.conversations ?? []).filter((c) => c.windows);
    console.log(`热力窗口: ${withWindows.length}/${(snapshot.conversations ?? []).length} 会话携带 windows`);
    // user 成员去重（名册含 user → 矩阵单行；显示名如实）
    const rosterUsers = (agentsR.agents ?? []).filter((a) => a.id === 'user');
    console.log(`user 去重: 名册含 user ${rosterUsers.length} 个（${rosterUsers.length === 1 ? '矩阵单行 ✓' : '异常'}）`);
    // P6：tags 透传
    const withTags = (agentsR.agents ?? []).filter((a) => Array.isArray(a.tags));
    console.log(`agents/list tags: ${withTags.length}/${(agentsR.agents ?? []).length} 携带（P6）`);
    // byPair 端点对（弦图 agent 间关系数据源）
    const usage = await rpc('usage/tokens', {});
    const byPair = usage.byPair ?? [];
    const agentPairs = byPair.filter((p) => p.a !== 'user' && p.b !== 'user');
    console.log(`usage byPair: ${byPair.length} 对（agent⇄agent ${agentPairs.length}——委托产生）`);

    // pair 历史源（fetchPairHistory → session/history）
    const target = pairs[0]?.conversationId ?? (agentsR.agents ?? []).find((a) => a.id !== 'user')?.id;
    if (target) {
      const h = await rpc('session/history', { conversationId: target, limit: 5 });
      const first = h.records?.[0];
      console.log(`pairHistory(${target}): total=${h.total} page=${(h.records ?? []).length} 首行 role=${first?.role} user身份判定=${first?.role === 'user' ? "'user'" : 'assistant'}`);
    }

    // interrupt 换算源（convKey → conversationId；无运行 run 时 aborted=0）
    const intr = await rpc('runs/interrupt', { conversationId: target ?? 'user' });
    console.log(`interrupt(${target}): ${JSON.stringify(intr)}`);

    console.log('OK: 运行跟踪 Port B 后端面全部就绪（适配器 REST 面已退役）');
    ws.terminate();
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message);
    ws.terminate();
    process.exit(1);
  }
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
