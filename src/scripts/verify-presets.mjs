// 验证：真实数据根 boot（boot-yml 同款 loader 路径）→ 预设物化 + 名册过滤 + 目录 RPC
// （web-server 端口 patch 到 0——避开用户在跑的 3830 实例）
import { bootFromConfig } from '../ac-app/src/ecosystem.ts';
import WebSocket from 'ws';
import { buildFrame, parseFrame, RPC_CALL, RPC_RESULT, WS_READY } from 'ac-ws-protocol';

function rpc(ws, method, requestId, params) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      const frame = parseFrame(raw.toString());
      if (frame?.type !== RPC_RESULT) return;
      if (frame.data.requestId !== requestId) return;
      ws.off('message', onMessage);
      resolve(frame.data);
    };
    ws.on('message', onMessage);
    ws.on('error', reject);
    ws.send(buildFrame(RPC_CALL, { method, requestId, params }));
  });
}

const booted = await bootFromConfig({
  file: './cordis.yml',
  patches: [{ id: 'web-server', config: { port: 0 } }],
});
const { ctx } = booted;

// 1) 预设物化 + 模型解析（真实 config：deepseek-v4-flash default:true）
const std = ctx.agents.get('__standard__');
console.log('__standard__:', JSON.stringify({ preset: std?.preset, model: std?.model, desc: std?.description }));
const minimal = ctx.agents.get('__dsh_minimal__');
console.log('__dsh_minimal__:', JSON.stringify({ preset: minimal?.preset, model: minimal?.model, tools: minimal?.tools }));

// 2) 名册过滤（agents/list RPC 不含预设）
const port = await ctx.webServer.ready();
console.log('port ready:', port);
const ws = await new Promise((resolve, reject) => {
  const w = new WebSocket(`ws://127.0.0.1:${port}`);
  w.on('error', reject);
  w.on('message', (raw) => { if (parseFrame(raw.toString())?.type === WS_READY) resolve(w); });
});
console.log('ws ready');
const list = await rpc(ws, 'agents/list', 'q1');
const ids = (list.result?.agents ?? []).map((a) => a.id);
console.log('名册含预设？', ids.includes('__standard__') || ids.includes('__dsh_minimal__'), '（应 false）');

// 3) 预设目录 RPC
const cat = await rpc(ws, 'agents/presets', 'q2');
console.log('目录 ok=' + cat.ok, cat.error ?? JSON.stringify(cat.result?.presets));

// 4) 悬空引用修复验证：06112ee5 会话引用 __dsh_minimal__（src 迁移）→ 现在可路由
const probe = await rpc(ws, 'singles/list', 'q3');
const migrated = (probe.result?.singles ?? []).find((s) => s.agentId === '__dsh_minimal__');
console.log('迁移会话（__dsh_minimal__）:', migrated ? `${migrated.id.slice(0, 8)} ${migrated.title ?? ''}` : '（无）');

ws.close();
await booted.includeEntry.subtree.ctx.fiber.dispose();
process.exit(0);
