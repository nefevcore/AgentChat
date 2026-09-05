// ============================================================
// ac-mcp/tests/mcp.test.ts —— MCP 注册中心
//
// · 懒建连：注册不建连；首个 run 才连接发现；连接跨 run 复用
// · 工具注册：裸名优先、撞名命名空间前缀、include 白名单暴露
// · 单服务器失败不炸行（回收半注册状态、下一 run 重试）
// · removeServer / 行卸载：连接关闭 + 工具回收（注册即归属）
// · Config schema：servers 缺省 []、非法条目拒绝、clientFactory 透传
// · settings.mcp 清单文件（缺省数据根 mcp.json）：投放即替换基线 / 文件
//   是事实源（变更下一 sync 生效）/ enabled 软停用 / 非法 fail-soft /
//   程序化注册不动
// · per-Agent 覆盖（settingsOf 合成）：差异层 file 指向自己的清单即覆盖
//   （可含池外，run 时懒注册）；enabled 差异层覆盖全局；暴露面按生效清单收敛
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import { ConfigService } from 'ac-config';
import * as agentsRow from 'ac-agents';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as mcpRow from '../src/index';
import type { McpRowOptions, McpServerDef } from '../src/index';
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

describe('ac-mcp Config schema（可配置面）', () => {
  /** 校验契约测试：故意喂运行期非法数据——经 unknown 绕开输入类型面 */
  const attempt = (input: unknown) => mcpRow.Config(input as McpRowOptions);

  it('servers 缺省填 []（loader 契约：校验 + 填默认值）', () => {
    expect(mcpRow.Config(undefined)).toEqual({ servers: [] });
    expect(mcpRow.Config({})).toEqual({ servers: [] });
  });

  it('缺 name / 类型错 = 校验拒绝（非法配置 boot 期失败）', () => {
    expect(() => attempt({ servers: [{ url: 'https://x' }] })).toThrow(/missing required value/);
    expect(() => attempt({ servers: [{ name: 'x', connectTimeoutMs: 'soon' }] })).toThrow(/expected number/);
    expect(() => attempt({ servers: [{ name: 'x', transport: 'grpc' }] })).toThrow(/expected/);
  });

  it('clientFactory（测试注入面）不在 schema 声明——非严格合并原样透传', () => {
    const fake = fakeServer('s', []);
    const validated = mcpRow.Config({ servers: [fake.def] });
    expect(validated.servers?.[0]?.name).toBe('s');
    expect(validated.servers?.[0]?.clientFactory).toBe(fake.def.clientFactory);
  });
});

/** workspace 锚桩（只提供 root——readServersFile 的相对路径基准同产线） */
class FakeWorkspaceRoot extends Service {
  readonly root: string;
  constructor(ctx: Context, root: string) {
    super(ctx, 'workspace');
    this.root = root;
  }
}

describe('ac-mcp 清单文件（缺省 mcp.json）全局层对账', () => {
  const writeJson = (root: string, name: string, data: unknown): void => {
    fs.writeFileSync(path.join(root, name), JSON.stringify(data, null, 2), 'utf-8');
  };

  /** 真 ConfigService + workspace 锚（临时数据根）——文件读取/config 热通路同产线 */
  function bootWithFiles(): { ctx: Context; config: ConfigService; root: string } {
    const ctx = new Context();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-mcp-file-'));
    const config = new ConfigService(ctx, { root });
    new FakeWorkspaceRoot(ctx, root);
    return { ctx, config, root };
  }
  const names = (ctx: Context): string[] => ctx.mcp.listServers().map((s) => s.name).sort();

  it('数据根投放 mcp.json 即整体替换基线（boot 吸收：构造时对账；懒建连不连接）', async () => {
    const { ctx, root } = bootWithFiles();
    writeJson(root, 'mcp.json', { servers: [{ name: 'file-srv', url: 'https://x.example/mcp' }] });
    await boot(ctx, baseRows()); // inject 'tools' 依赖（缺则 apply 不运行）
    const mcpFiber = ctx.plugin(mcpRow);
    await mcpFiber;
    expect(names(ctx)).toEqual(['file-srv']);
    expect(ctx.mcp.listServers()[0]).toMatchObject({ connected: false, toolCount: 0 });
  });

  it('文件是事实源：内容变更/换文件/删文件在下一 sync 生效；显式 file 键切换', async () => {
    const { ctx, config, root } = bootWithFiles();
    await boot(ctx, baseRows());
    const ymlFake = fakeServer('yml-srv', [ECHO]);
    const mcpFiber = ctx.plugin(mcpRow, { servers: [ymlFake.def] });
    await mcpFiber;
    expect(names(ctx)).toEqual(['yml-srv']); // 缺省文件缺失 → 基线

    writeJson(root, 'mcp.json', { servers: [{ name: 'ui-srv', url: 'https://a.example/mcp' }] });
    ctx.mcp.reload();
    expect(names(ctx)).toEqual(['ui-srv']); // 文件存在即替换基线

    // 裸数组形态 + 同名换定义 → 热替换（撤+重挂，仍懒建连）
    writeJson(root, 'mcp.json', [{ name: 'ui-srv', command: 'npx', args: ['-y', 'srv'] }]);
    ctx.mcp.reload();
    expect(ctx.mcp.listServers()).toEqual([{ name: 'ui-srv', enabled: true, connected: false, toolCount: 0 }]);

    writeJson(root, 'other.json', { servers: [{ name: 'x', url: 'https://x' }] });
    config.set('settings.mcp', { file: 'other.json' }); // 显式切换（config/changed → 对账）
    expect(names(ctx)).toEqual(['x']);

    fs.rmSync(path.join(root, 'mcp.json')); // 缺省文件回归缺失 → 基线
    config.set('settings.mcp', { enabled: true });
    ctx.mcp.reload();
    expect(names(ctx)).toEqual(['yml-srv']);
  });

  it('enabled:false 软停用 → 回收全部配置面服务器与工具；恢复重挂懒建连', async () => {
    const { ctx, config } = bootWithFiles();
    await boot(ctx, baseRows());
    const fake = fakeServer('srv', [ECHO]);
    const mcpFiber = ctx.plugin(mcpRow, { servers: [fake.def] });
    await mcpFiber;
    await ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    expect(ctx.tools.has('echo')).toBe(true);

    config.set('settings.mcp', { enabled: false });
    expect(ctx.tools.has('echo')).toBe(false); // 工具随服务器回收
    expect(fake.state.closed).toBe(1);
    expect(names(ctx)).toEqual([]);

    config.set('settings.mcp', { enabled: true });
    expect(names(ctx)).toEqual(['srv']); // 重挂（未 run 不重连）
    await ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    expect(fake.state.connectCount).toBe(2); // 下一 run 懒建连恢复
  });

  it('清单文件非法（坏 JSON / 缺 name / 非数组形状）→ warn 保持现状', async () => {
    const { ctx, root } = bootWithFiles();
    await boot(ctx, baseRows());
    const mcpFiber = ctx.plugin(mcpRow);
    await mcpFiber;
    writeJson(root, 'mcp.json', { servers: [{ name: 'ok', url: 'https://x' }] });
    ctx.mcp.reload();
    expect(names(ctx)).toEqual(['ok']);

    fs.writeFileSync(path.join(root, 'mcp.json'), '{ broken', 'utf-8'); // 坏 JSON
    ctx.mcp.reload();
    expect(names(ctx)).toEqual(['ok']);

    writeJson(root, 'mcp.json', { servers: [{ url: 'https://x' }] }); // 缺 name
    ctx.mcp.reload();
    expect(names(ctx)).toEqual(['ok']);

    writeJson(root, 'mcp.json', { servers: 'nope' }); // 非数组
    ctx.mcp.reload();
    expect(names(ctx)).toEqual(['ok']);
  });

  it('程序化 registerServer 不被清单对账回收（managed 之外不动）', async () => {
    const { ctx, root } = bootWithFiles();
    await boot(ctx, baseRows());
    const mcpFiber = ctx.plugin(mcpRow);
    await mcpFiber;
    const prog = fakeServer('prog', []);
    ctx.mcp.registerServer(prog.def);
    writeJson(root, 'mcp.json', { servers: [{ name: 'ui', url: 'https://x' }] });
    ctx.mcp.reload();
    expect(names(ctx)).toEqual(['prog', 'ui']);
    writeJson(root, 'mcp.json', { servers: [] }); // 清单清空 → ui 撤；prog 非管辖
    ctx.mcp.reload();
    expect(names(ctx)).toEqual(['prog']);
  });
});

describe('ac-mcp per-Agent 覆盖（settingsOf 合成：差异层 file 指向自己的清单）', () => {
  const QUERY: McpToolDef = { name: 'query', description: '自有工具', inputSchema: { type: 'object' } };
  const writeJson = (root: string, name: string, data: unknown): void => {
    fs.writeFileSync(path.join(root, name), JSON.stringify(data, null, 2), 'utf-8');
  };

  /** 分层脚手架：config + workspace 锚 + agents + baseRows + 本地工具 + mcp 行 */
  async function bootLayered(mcpOptions?: McpRowOptions): Promise<{ ctx: Context; config: ConfigService; root: string }> {
    const ctx = new Context();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-mcp-pa-'));
    const config = new ConfigService(ctx, { root });
    new FakeWorkspaceRoot(ctx, root);
    await boot(ctx, [...baseRows(), agentsRow]);
    ctx.tools.register({
      name: 'local',
      description: '本地工具（非 MCP——收敛不动）',
      async execute() {
        return { ok: true, output: 'local' };
      },
    });
    const mcpFiber = ctx.plugin(mcpRow, mcpOptions);
    await mcpFiber;
    return { ctx, config, root };
  }
  /** 最近一次 run 传给 LLM 的工具名清单 */
  const visibleTools = (): string[] =>
    ((captured.at(-1) as unknown as { tools?: Array<{ function?: { name: string } }> }).tools ?? [])
      .map((t) => t.function?.name ?? '')
      .filter((n) => n !== '')
      .sort();

  it('差异层 file = 覆盖：本 Agent 只见自己清单；他人见池、无身份不收敛；池外条目懒注册', async () => {
    const pool = fakeServer('pool', [ECHO]);
    const own = fakeServer('own', [QUERY]); // 文件不能带工厂——按名引用预注册的假连接
    const { ctx, root } = await bootLayered({ servers: [pool.def] });
    ctx.mcp.registerServer(own.def);
    writeJson(root, 'own.json', { servers: [{ name: 'own', url: 'https://x.example/mcp' }] });
    ctx.agents.register({ id: 'a1', model: 'mock-1', settings: { mcp: { file: 'own.json' } } });
    ctx.agents.register({ id: 'a2', model: 'mock-1' });
    // 池外条目（stdio 命令不存在——spawn 快速失败，不依赖网络）
    writeJson(root, 'extra.json', { servers: [{ name: 'extra', command: 'no-such-mcp-binary' }] });
    ctx.agents.register({ id: 'a3', model: 'mock-1', settings: { mcp: { file: 'extra.json' } } });

    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', messages: USER });
    expect(visibleTools()).toEqual(['local', 'query']); // own 清单覆盖池：echo 对 a1 不可见

    await ctx.agentLoop.run({ agent: 'a2', model: 'mock-1', messages: USER });
    expect(visibleTools()).toEqual(['echo', 'local']); // a2 无差异层 → 池；query 对 a2 不可见

    await ctx.agentLoop.run({ model: 'mock-1', messages: USER }); // 无身份 run：不收敛
    expect(visibleTools()).toEqual(['echo', 'local', 'query']);

    await ctx.agentLoop.run({ agent: 'a3', model: 'mock-1', messages: USER }); // 池外懒注册
    expect(ctx.mcp.listServers().map((s) => s.name).sort()).toEqual(['extra', 'own', 'pool']);
  });

  it('enabled 合成：差异层 false 停用本 Agent；全局 false 可被差异层 true 复活（池定义保留）', async () => {
    const pool = fakeServer('pool', [ECHO]);
    const { ctx, config } = await bootLayered({ servers: [pool.def] });
    ctx.agents.register({ id: 'off', model: 'mock-1', settings: { mcp: { enabled: false } } });
    ctx.agents.register({ id: 'reviver', model: 'mock-1', settings: { mcp: { enabled: true } } });

    await ctx.agentLoop.run({ agent: 'off', model: 'mock-1', messages: USER });
    expect(visibleTools()).toEqual(['local']); // MCP 暴露收敛为空（非 MCP 不动）

    config.set('settings.mcp', { enabled: false }); // 全局软停用：池撤挂
    expect(ctx.mcp.listServers()).toEqual([]);

    await ctx.agentLoop.run({ agent: 'off', model: 'mock-1', messages: USER });
    expect(visibleTools()).toEqual(['local']); // 合成后仍停用

    await ctx.agentLoop.run({ agent: 'reviver', model: 'mock-1', messages: USER });
    expect(visibleTools()).toEqual(['echo', 'local']); // 差异层 true：池复活重挂 + 建连
  });

  it('差异层清单文件缺失/非法 → warn 回落全局池', async () => {
    const pool = fakeServer('pool', [ECHO]);
    const { ctx, root } = await bootLayered({ servers: [pool.def] });
    ctx.agents.register({ id: 'gone', model: 'mock-1', settings: { mcp: { file: 'missing.json' } } });
    await ctx.agentLoop.run({ agent: 'gone', model: 'mock-1', messages: USER });
    expect(visibleTools()).toEqual(['echo', 'local']);

    fs.writeFileSync(path.join(root, 'bad.json'), '{ broken', 'utf-8');
    ctx.agents.register({ id: 'bad', model: 'mock-1', settings: { mcp: { file: 'bad.json' } } });
    await ctx.agentLoop.run({ agent: 'bad', model: 'mock-1', messages: USER });
    expect(visibleTools()).toEqual(['echo', 'local']);
  });
});
