// ============================================================
// M8.6 tools 授权门验收（cr-527——A14 落地）
//
// 验收面：门真装配（行集含 tools 即得）；MCP 服务器资产硬闸——
//   · fail-closed：投影空（无 auth）→ MCP 工具执行被拒，非 MCP 照常；
//   · 放行线：per-agent grants [{mcp}] → 该服务器工具可执行；
//   · 每 run 前重读：吊销后经 loop/before-run 边界生效（最终一致）；
//   · denials 优先：grants 与 denials 并存 → 拒绝；
//   · children 物化快照（subagent spawnOp → child auth.json ⊆ 父投影）
//     归 subagent 测试域，此处只验门语义。
// 全链真身：主线 ac-mcp 行 + 假连接（clientFactory 注入——零网络），
// tools.execute 走完整 waterfall（门在链上真拦截）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bootShell } from '../boot.ts';
import type { Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import type { McpConnection, McpToolDef } from 'ac-mcp-core';

const ROOT = path.join('sandbox', 'test-gate-' + process.pid);
const CATALOG = path.join(process.env.AGENTCHAT_REPO_ROOT ?? process.cwd(), 'apps', 'catalog', 'row-catalog.json');
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 假 MCP 服务器连接（主线 mcp.test.ts 同款——零网络零子进程） */
function fakeConnection(name: string, tools: McpToolDef[]): McpConnection {
  const state = { connected: false };
  const conn: McpConnection = {
    serverName: name,
    get connected() { return state.connected; },
    async connect() { state.connected = true; },
    async listTools() { return tools; },
    async callTool(toolName: string) { return { text: name + ':' + toolName }; },
    close() { state.connected = false; },
  };
  return conn;
}

const ECHO: McpToolDef = {
  name: 'gate_echo',
  description: '门测试回声',
  inputSchema: { type: 'object', properties: {} },
};

/** 装配带 mcp 行 + 假服务器 alpha 的壳，注册假 MCP 工具 */
async function bootWithMcp(agentId: string, writeAuth?: (root: string) => void) {
  fs.mkdirSync(path.join(ROOT, 'agents', agentId), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'agents', agentId, 'config.json'),
    JSON.stringify({ id: agentId, model: 'mock' }), 'utf-8');
  writeAuth?.(ROOT);
  const boot = await bootShell({ dataRoot: ROOT, agentId, catalogFile: CATALOG }, { emit: () => {} });
  const mcp = boot.ctx.get('mcp', false) as {
    registerServer(def: { name: string; clientFactory: () => McpConnection }): void;
    sync(): Promise<void>;
    serverOfTool(n: string): string | undefined;
  } | undefined;
  if (mcp === undefined) throw new Error('mcp 服务缺席——基础行集应含 mcp 行');
  mcp.registerServer({ name: 'alpha', clientFactory: () => fakeConnection('alpha', [ECHO]) });
  await mcp.sync();
  const tools = boot.ctx.get('tools') as {
    list(): Array<{ name: string }>;
    execute(call: { name: string; args?: Record<string, unknown>; agentId?: string }): Promise<ToolResult>;
  };
  if (!tools.list().some((t) => t.name === 'gate_echo')) throw new Error('MCP 工具未注册（sync 失败）');
  return { boot, mcp, tools };
}

/** 触发 run 边界（门在 loop/before-run 清投影缓存——吊销生效时点） */
async function runBoundary(ctx: Context): Promise<void> {
  await ctx.waterfall('loop/before-run', { request: { agent: 'x', model: 'mock', messages: [] } } as never,
    async () => ({ finish: 'stop' }) as never);
}

describe('M8.6 tools 授权门（A14：投影 per-run 现算 + 工具 waterfall 硬闸）', () => {
  it('fail-closed：无授权 → MCP 工具被拒，非 MCP 工具照常（装了即可见）', async () => {
    const { boot, mcp, tools } = await bootWithMcp('anon');
    try {
      expect(mcp.serverOfTool('gate_echo')).toBe('alpha');
      const denied = await tools.execute({ name: 'gate_echo', args: {} });
      expect(denied.ok).toBe(false);
      expect(String(denied.error)).toContain('fail-closed');
      // 非 MCP 工具：第一方行工具无第二闸（math 行基础集内）
      const math = await tools.execute({ name: 'math', args: { expression: '1+1' } });
      expect(math.ok).toBe(true);
    } finally {
      await boot.close();
    }
  }, 20_000);

  it('放行线：per-agent grants [{mcp:alpha}] → alpha 工具可执行', async () => {
    const { boot, tools } = await bootWithMcp('granted', (root) => {
      fs.writeFileSync(path.join(root, 'agents', 'granted', 'auth.json'),
        JSON.stringify({ version: 1, agentId: 'granted', grants: [{ mcp: 'alpha' }], denials: [] }), 'utf-8');
    });
    try {
      const ok = await tools.execute({ name: 'gate_echo', args: {} });
      expect(ok.ok).toBe(true);
      expect(JSON.stringify(ok.output)).toContain('alpha:gate_echo');
    } finally {
      await boot.close();
    }
  }, 20_000);

  it('每 run 前重读：放行 → 吊销（denials）→ run 边界后生效（最终一致）', async () => {
    const { boot, tools } = await bootWithMcp('flux', (root) => {
      fs.writeFileSync(path.join(root, 'agents', 'flux', 'auth.json'),
        JSON.stringify({ version: 1, agentId: 'flux', grants: [{ mcp: 'alpha' }], denials: [] }), 'utf-8');
    });
    try {
      // 初始放行（缓存此刻建立）
      expect((await tools.execute({ name: 'gate_echo', args: {} })).ok).toBe(true);
      // 宿主写者面吊销（denials 优先于一切）
      fs.writeFileSync(path.join(ROOT, 'agents', 'flux', 'auth.json'),
        JSON.stringify({ version: 1, agentId: 'flux', grants: [{ mcp: 'alpha' }], denials: [{ mcp: 'alpha' }] }), 'utf-8');
      // 同 run 内（缓存未失效）仍放行——生效时点 = run 收束 + 下次重读
      expect((await tools.execute({ name: 'gate_echo', args: {} })).ok).toBe(true);
      // run 边界 → 缓存失效 → 下一调用现算 → 拒绝
      await runBoundary(boot.ctx);
      const denied = await tools.execute({ name: 'gate_echo', args: {} });
      expect(denied.ok).toBe(false);
      expect(String(denied.error)).toContain('fail-closed');
    } finally {
      await boot.close();
    }
  }, 20_000);

  it('全局层 mcp-server 授权（全局有效条目 → 行集含 mcp 行的 agent 均放行）', async () => {
    const { boot, tools } = await bootWithMcp('globalgranted', (root) => {
      fs.writeFileSync(path.join(root, 'auth.json'),
        JSON.stringify({ version: 1, entries: [{ id: 'g1', asset: { kind: 'mcp-server', name: 'alpha' }, grantedAt: '2026-10-18T00:00:00Z', grantSource: 'user-webui' }] }), 'utf-8');
    });
    try {
      expect((await tools.execute({ name: 'gate_echo', args: {} })).ok).toBe(true);
    } finally {
      await boot.close();
    }
  }, 20_000);
});