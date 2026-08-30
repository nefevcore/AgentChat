// ============================================================
// ac-plugin-registry/tests/patch-rpc.test.ts —— 行偏好急救通道 RPC
//   · plugin/patch-list / plugin/patch-set 注册归本行（2026-08-30 迁移：
//     原住 ac-web-api——其静态 inject 在行停用级联中阵亡，急救 RPC 跟着
//     消失，UI 无法自救；本行仅依赖 tools/webServer，住在级联闭包外）
//   · 形状回归：空基线 / 写入三态（harness 无 include 行 → no-include-row）/
//     upsert / id 缺失拒绝
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Context } from '@agentchat/cordis';
import { WebServerService } from 'ac-web-server';
import { ToolsService } from 'ac-tools';
import { buildFrame, parseFrame, RPC_CALL, RPC_RESULT, WS_READY } from 'ac-ws-protocol';
import * as registryRow from '../src/index.ts';
import * as patchRpcRow from '../src/patch-rpc.ts';

const harnesses: Array<{ web: WebServerService; ctx: Context; root: string }> = [];
const sockets: WebSocket[] = [];

async function boot() {
  const ctx = new Context();
  const root = join(await mkdtemp(join(tmpdir(), 'ac-patchrpc-')), 'data');
  mkdirSync(root, { recursive: true });
  const web = new WebServerService(ctx, { port: 0, heartbeatMs: 0 });
  new ToolsService(ctx);
  await ctx.plugin(registryRow, { root });
  await ctx.plugin(patchRpcRow);
  const port = await web.ready();
  harnesses.push({ web, ctx, root });
  return { ctx, root, port };
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      if (parseFrame(raw.toString())?.type === WS_READY) resolve(ws);
    });
  });
}

function rpc(ws: WebSocket, method: string, requestId: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: { toString(): string }) => {
      const frame = parseFrame(raw.toString());
      if (frame?.type !== RPC_RESULT) return;
      if ((frame.data as { requestId?: string }).requestId !== requestId) return;
      ws.off('message', onMessage);
      resolve(frame.data);
    };
    ws.on('message', onMessage);
    ws.on('error', reject);
    ws.send(buildFrame(RPC_CALL, { method, requestId, params }));
  });
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const h of harnesses.splice(0)) {
    await h.web.stop();
    await h.ctx.fiber.dispose();
  }
});

describe('ac-plugin-registry 行偏好急救 RPC', () => {
  it('patch-list 基线 + patch-set 三态/upsert/参数校验（harness 无 include 行 → no-include-row）', async () => {
    const h = await boot();
    const ws = await connect(h.port);

    // 基线：无 patch 文件 → 空列表
    const base = await rpc(ws, 'plugin/patch-list', 'r1');
    expect(base.ok).toBe(true);
    expect(base.result.patches).toEqual([]);
    expect(base.result.file).toBe(join(h.root, 'cordis.patch.yml'));

    // setPatch：写了文件 + 三态（harness 无 include 行 → no-include-row）
    const set = await rpc(ws, 'plugin/patch-set', 'r2', { id: 'mcp', disabled: true });
    expect(set.ok).toBe(true);
    expect(set.result.state).toBe('no-include-row');
    expect(set.result.patches).toEqual([{ id: 'mcp', disabled: true }]);

    const list = await rpc(ws, 'plugin/patch-list', 'r3');
    expect(list.result.patches).toEqual([{ id: 'mcp', disabled: true }]);

    // upsert：同 id 覆盖
    const set2 = await rpc(ws, 'plugin/patch-set', 'r4', { id: 'mcp', disabled: false });
    expect(set2.result.patches).toEqual([{ id: 'mcp', disabled: false }]);

    // 参数校验：id 缺失拒绝
    const bad = await rpc(ws, 'plugin/patch-set', 'r5', { disabled: true });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain('id');

    // 既有 patch 文件带警告透出（fail-soft）
    writeFileSync(join(h.root, 'cordis.patch.yml'), '- { id: x', 'utf8');
    const warnList = await rpc(ws, 'plugin/patch-list', 'r6');
    expect(warnList.result.warnings.length).toBeGreaterThan(0);
  });
});
