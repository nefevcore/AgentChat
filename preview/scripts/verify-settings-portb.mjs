// 设置面板 Port B 真链路验证：对运行中的 preview:boot（3830）验证
// settings/api.ts 直连面——config/装配/插件目录/timer 的形状与数据量。
// 用法：node preview/scripts/verify-settings-portb.mjs
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
    const cfg = await rpc('config/get');
    const keys = Object.keys(cfg.config ?? {});
    console.log(`config/get: ${keys.length} 键 [${keys.slice(0, 8).join(', ')}${keys.length > 8 ? '…' : ''}]`);

    const agents = await rpc('agents/list');
    const target = (agents.agents ?? [])[0];
    if (target) {
      const asm = await rpc('agents/assembly', { agentId: target.id });
      const t = asm.assembly?.tools ?? {};
      console.log(`assembly(${target.id}): tools.enabled=${(t.enabled ?? []).length} catalog=${(t.catalog ?? []).length}`);
      const cfgR = await rpc('agents/get-config', { agentId: target.id });
      console.log(`get-config(${target.id}): model=${cfgR.config?.model ?? '(无)'} description=${JSON.stringify(cfgR.config?.description ?? '')}`);
      const doc = await rpc('agents/read-doc', { agentId: target.id, name: 'AGENT.md' });
      console.log(`read-doc(AGENT.md): ${doc.content !== undefined ? `${String(doc.content).length} chars` : '(无文档)'}`);
    }

    const loaded = await rpc('plugin/loaded');
    console.log(`plugin/loaded: ${(loaded.loaded ?? []).length} 个`);
    const tools = await rpc('tools/list');
    console.log(`tools/list: ${(tools.tools ?? []).length} 个工具目录`);

    const timers = await rpc('timer/list');
    console.log(`timer/list: ${(timers.entries ?? []).length} 个 owner`);
    const globalTimers = await rpc('timer/entries', {});
    console.log(`timer/entries(全局 __global__): ${(globalTimers.entries ?? []).length} 条（P1 config timer.tasks 迁移）`);
    const perm = await rpc('plugin/permissions');
    console.log(`plugin/permissions: vocabulary=${(perm.permissions ?? []).length} 词汇`);

    // P1：config 域迁移落位（池/默认指针/全局定时任务）
    const pools = Object.keys(cfg.config?.llmProviders ?? {});
    const searchPools = Object.keys(cfg.config?.searchProviders ?? {});
    console.log(`config 池: llmProviders=${pools.length} searchProviders=${searchPools.length}（P1 迁移）`);
    if (keys.length === 0) throw new Error('config/get 0 键：config 域未迁移（跑 scripts/migrate-workspace.ts）');

    // P5：system-prompt 干跑（真组装器链装配 framework 块）
    const spTarget = (agents.agents ?? []).find((a) => a.id !== 'user' && !a.virtual) ?? target;
    if (spTarget) {
      const sp = await rpc('agents/system-prompt', { agentId: spTarget.id });
      const ok = (sp.systemPrompt ?? '').includes('<framework>');
      console.log(`system-prompt(${spTarget.id}): ${ok ? '含 <framework> 块' : '为空（异常）'}（P5）`);
      if (!ok) throw new Error('system-prompt 预览为空：干跑未过组装器链');
    }

    console.log('OK: settings Port B 后端面全部就绪');
    ws.close(); process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message);
    ws.close(); process.exit(1);
  }
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
