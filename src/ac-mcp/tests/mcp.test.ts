// ============================================================
// ac-mcp/tests/mcp.test.ts —— MCP 注册中心
//
// · 懒建连：注册不建连；首个 run 才连接发现；连接跨 run 复用
// · 工具注册：裸名优先、撞名命名空间前缀、include 白名单暴露
// · 单服务器失败不炸行（回收半注册状态、下一 run 重试）
// · removeServer / 行卸载：连接关闭 + 工具回收（注册即归属）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as mcpRow from '../src/index';
import type { McpServerDef } from '../src/index';
import * as toolsRow from 'ac-tools';
import type { McpConnection, McpToolDef } from 'ac-mcp-core';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];

function scriptedProvider() {
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      yield { delta: 'ok' };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

interface FakeHandle {
  state: { connected: boolean; closed: number; connectCount: number; calls: Array<{ toolName: string; args: Record<string, unknown> }> };
  connection: McpConnection;
  def: McpServerDef;
}

/** 假服务器（clientFactory 注入——零网络零子进程） */
function fakeServer(name: string, tools: McpToolDef[], opts: { fail?: boolean } = {}): FakeHandle {
  const state = { connected: false, closed: 0, connectCount: 0, calls: [] as Array<{ toolName: string; args: Record<string, unknown> }> };
  const connection: McpConnection = {
    serverName: name,
    get connected() {
      return state.connected;
    },
    async connect() {
      state.connectCount += 1;
      if (opts.fail) throw new Error('连不上');
      state.connected = true;
    },
    async listTools() {
      if (!state.connected) throw new Error('未连接');
      return tools;
    },
    async callTool(toolName, args) {
      state.calls.push({ toolName, args });
      return { text: `${name}:${toolName}` };
    },
    close() {
      state.connected = false;
      state.closed += 1;
    },
  };
  return { state, connection, def: { name, clientFactory: () => connection } };
}

const ECHO: McpToolDef = {
  name: 'echo',
  description: '回声',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};

async function boot(ctx: Context, rows: unknown[]) {
  const fibers: Fiber[] = [];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return fibers;
}

function baseRows() {
  return [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] });
      },
    },
    loopRow,
  ];
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

const USER = [{ role: 'user' as const, content: 'hi' }];

describe('ac-mcp 懒建连与工具注册', () => {
  it('注册不建连；首个 run 连接发现并注册工具；连接跨 run 复用', async () => {
    const fake = fakeServer('srv', [ECHO]);
    const ctx = new Context();
    const fibers = await boot(ctx, baseRows());
    const mcpFiber = ctx.plugin(mcpRow, { servers: [fake.def] });
    await mcpFiber;
    fibers.push(mcpFiber);

    expect(fake.state.connectCount).toBe(0); // 懒建连
    expect(ctx.tools.has('echo')).toBe(false);

    await ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    expect(fake.state.connectCount).toBe(1);
    expect(ctx.tools.has('echo')).toBe(true);

    await ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    expect(fake.state.connectCount).toBe(1); // 复用
    expect(ctx.mcp.listServers()).toEqual([
      { name: 'srv', enabled: true, connected: true, toolCount: 1 },
    ]);

    // 工具经 ctx.tools 拦截链执行（协议级前缀描述）
    const tool = ctx.tools.get('echo');
    expect(tool?.description).toBe('[MCP:srv] 回声');
    const r = await ctx.tools.execute({ name: 'echo', args: { text: 'x' } });
    expect(r).toEqual({ ok: true, output: 'srv:echo' });
    expect(fake.state.calls).toEqual([{ toolName: 'echo', args: { text: 'x' } }]);
  });

  it('裸名被本地工具占用 → `${server}__${name}` 前缀；两 MCP 服务器同名工具亦前缀', async () => {
    const ctx = new Context();
    const fibers = await boot(ctx, baseRows());
    ctx.tools.register({
      name: 'echo',
      description: '本地已有',
      async execute() {
        return { ok: true, output: 'local' };
      },
    });
    const s1 = fakeServer('s1', [ECHO]);
    const s2 = fakeServer('s2', [ECHO]);
    const mcpFiber = ctx.plugin(mcpRow, { servers: [s1.def, s2.def] });
    await mcpFiber;
    fibers.push(mcpFiber);

    await ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    expect(ctx.tools.has('echo')).toBe(true); // 本地
    expect(ctx.tools.has('s1__echo')).toBe(true);
    expect(ctx.tools.has('s2__echo')).toBe(true);

    const r = await ctx.tools.execute({ name: 's2__echo', args: {} });
    expect(r).toEqual({ ok: true, output: 's2:echo' });
  });

  it('AgentConfig.tools 白名单决定 per-Agent 暴露（loop 侧过滤）', async () => {
    const fake = fakeServer('srv', [ECHO, { name: 'danger', description: '高危', inputSchema: { type: 'object' } }]);
    const ctx = new Context();
    await boot(ctx, baseRows());
    ctx.plugin(mcpRow, { servers: [fake.def] });
    await ctx.agentLoop.run({ model: 'mock-1', tools: ['echo'], messages: USER });
    // 传给 LLM 的工具清单只含白名单（MCP 工具与本地工具同权）
    const toolDefs = (captured[0] as unknown as { tools?: Array<{ function?: { name: string } }> }).tools ?? [];
    expect(toolDefs.map((t) => t.function?.name)).toEqual(['echo']);
  });
});

describe('ac-mcp 失败与回收', () => {
  it('单服务器失败不炸行：其余照常；失败服务器下一 run 重试', async () => {
    const bad = fakeServer('bad', [ECHO], { fail: true });
    const good = fakeServer('good', [ECHO]);
    const ctx = new Context();
    await boot(ctx, baseRows());
    const mcpFiber = ctx.plugin(mcpRow, { servers: [bad.def, good.def] });
    await mcpFiber;

    await ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    expect(ctx.tools.has('echo')).toBe(true); // good 的
    expect(ctx.mcp.listServers().find((s) => s.name === 'bad')?.connected).toBe(false);
    expect(bad.state.connectCount).toBe(1);

    await ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    expect(bad.state.connectCount).toBe(2); // 重试
    expect(good.state.connectCount).toBe(1); // good 仍复用
  });

  it('removeServer：关闭连接 + 回收工具；enabled=false 跳过', async () => {
    const fake = fakeServer('srv', [ECHO]);
    const skipped = fakeServer('off', [{ name: 'never', description: 'x', inputSchema: { type: 'object' } }]);
    skipped.def.enabled = false;
    const ctx = new Context();
    await boot(ctx, baseRows());
    const mcpFiber = ctx.plugin(mcpRow, { servers: [fake.def, skipped.def] });
    await mcpFiber;

    await ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    expect(ctx.tools.has('never')).toBe(false);

    expect(ctx.mcp.removeServer('srv')).toBe(true);
    expect(ctx.tools.has('echo')).toBe(false);
    expect(fake.state.closed).toBe(1);
    expect(ctx.mcp.removeServer('srv')).toBe(false);
  });

  it('行卸载（fiber dispose）：全部连接关闭 + 工具回收（注册即归属）', async () => {
    const fake = fakeServer('srv', [ECHO]);
    const ctx = new Context();
    await boot(ctx, baseRows());
    const mcpFiber = ctx.plugin(mcpRow, { servers: [fake.def] });
    await mcpFiber;

    await ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    expect(ctx.tools.has('echo')).toBe(true);
    const serversBeforeUnload = ctx.mcp.listServers();

    await mcpFiber.dispose();
    expect(ctx.tools.has('echo')).toBe(false);
    expect(fake.state.closed).toBe(1);
    expect(serversBeforeUnload.map((s) => s.name)).toEqual(['srv']);
  });

  it('重名注册抛错（注册中心纪律）', async () => {
    const ctx = new Context();
    await boot(ctx, baseRows());
    const mcpFiber = ctx.plugin(mcpRow);
    await mcpFiber;
    const s = fakeServer('dup', []);
    ctx.mcp.registerServer(s.def);
    expect(() => ctx.mcp.registerServer(fakeServer('dup', []).def)).toThrow(/已注册/);
  });
});
