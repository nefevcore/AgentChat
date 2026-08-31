// ============================================================
// ac-plugin-registry：M23 免审安装闭环
//   · installFromDir 三态结果 / 同 hash 幂等 / bump version 引导
//   · 保留字护栏（tools/llmProviders/agents 三面拒绝）
//   · 审计流水（install/uninstall/reject/load）
//   · 回执（session.append）+ sender:'event' 回触 owner 自会话（H1）
//   · 金闭环 e2e：脚本化 agent 走完 开发→安装→回执→回触→测试迭代
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import { pairKey } from 'ac-agent-loop';
import { makePluginDir } from './helpers.ts';
import * as agentsRow from 'ac-agents';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as sessionRow from 'ac-session';
import * as conversationRow from 'ac-conversation';
import * as toolsRow from 'ac-tools';
import * as registryRow from '../src/index.ts';
import * as gatesRow from 'ac-plugin-gates';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 脚本化 provider：按调用序号出动作。
 *   'install' → 调 install_plugin；'use' → 调插件工具；'text' → 收束文本
 */
function scriptedLlm(script: Array<'install' | 'use' | 'text'>, args: { dir?: string } = {}) {
  let counter = 0;
  const calls: LlmChatInput[] = [];
  return {
    calls,
    row() {
      return {
        name: 'mock-loop-llm',
        inject: ['llm'],
        apply(c: Context) {
          c.llm.register(
            'mock',
            () => ({
              stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
                const idx = counter++;
                calls.push(input);
                const action = script[idx] ?? 'text';
                if (action === 'install') {
                  yield { delta: '', toolCalls: [{ index: 0, id: 'ci', name: 'install_plugin' }] };
                  yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: JSON.stringify({ dir: args.dir }) }] };
                  yield { delta: '', finish: 'tool_calls' };
                } else if (action === 'use') {
                  yield { delta: '', toolCalls: [{ index: 0, id: 'cu', name: 'dev-tool-greet' }] };
                  yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: '{}' }] };
                  yield { delta: '', finish: 'tool_calls' };
                } else {
                  yield { delta: '闭环完成' };
                  yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
                }
              },
            }),
            { models: ['mock-1'] },
          );
        },
      };
    },
  };
}

/** 测试插件模块：注册一个工具（不带 name——避免与 manifest 名不一致拒绝） */
function testPluginModule() {
  return {
    apply(c: Context) {
      c.tools.register({
        name: 'dev-tool-greet',
        description: '测试工具（模板规约：输出用 tool-output 包裹）',
        requiredTags: ['agent:dev'],
        execute: () => ({ ok: true, output: '<tool-output plugin="dev">hello from plugin</tool-output>' }),
      });
    },
  };
}

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

interface BootOptions {
  modules?: Map<string, unknown>;
  gates?: boolean;
}

async function boot(root: string, options: BootOptions = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const modules = options.modules ?? new Map<string, unknown>();
  const rows: Array<[unknown, unknown]> = [
    [toolsRow, undefined],
    [llmRow, undefined],
    [loopRow, undefined],
    [agentsRow, undefined],
    [routerRow, undefined],
    [sessionRow, { root }],
    [conversationRow, undefined],
    [
      registryRow,
      {
        root,
        gatesTimeoutMs: 200,
        importModule: async (url: string) => {
          const key = new URL(url).pathname.split('/').slice(-2)[0];
          return modules.get(key);
        },
      },
    ],
    ...(options.gates === false ? [] : ([[gatesRow, undefined]] as Array<[unknown, unknown]>)),
  ];
  for (const [row, config] of rows) {
    const fiber = config === undefined ? ctx.plugin(row as any) : ctx.plugin(row as any, config);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

async function newRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'ac-install-'));
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

// ============================================================
// installFromDir 工程语义（三态 / 幂等 / 保留字 / 审计）
// ============================================================

describe('installFromDir 三态结果与幂等（E6/F6、G8）', () => {
  it('installed+loaded：安装 + 立即装载 + 安装态可查', async () => {
    const root = await newRoot();
    const modules = new Map<string, unknown>();
    const { ctx } = await boot(root, { modules });
    const dir = await makePluginDir(root, 'alpha', '1.0.0', { permissions: ['fs'] });
    modules.set('alpha', testPluginModule());

    const result = await ctx.pluginRegistry.installFromDir(dir, 'dev');
    expect(result.status).toBe('installed');
    if (result.status === 'installed') {
      expect(result.load.status).toBe('loaded');
      expect(result.installedDir).toBe(join(root, 'plugins', 'alpha'));
    }
    expect(ctx.pluginRegistry.has('alpha')).toBe(true);
    expect(ctx.pluginRegistry.listInstalled().map((r) => r.manifest.name)).toContain('alpha');
    // 免审快照 = manifest permissions 全集 + 默认授予
    const rec = ctx.pluginRegistry.listInstalled().find((r) => r.manifest.name === 'alpha')!;
    expect(rec.permissions).toEqual(['fs', 'network']);
    expect(rec.owner).toBe('dev');
  });

  it('installed+failed：装载失败不影响安装；失败立即计入熔断（F4/F6）', async () => {
    const root = await newRoot();
    const modules = new Map<string, unknown>();
    const { ctx } = await boot(root, { modules });
    const dir = await makePluginDir(root, 'broken');
    modules.set('broken', {}); // 缺 apply → 装载 rejected

    const result = await ctx.pluginRegistry.installFromDir(dir, 'dev');
    expect(result.status).toBe('installed');
    if (result.status === 'installed' && result.load.status === 'rejected') {
      expect(result.load.error).toMatch(/apply/);
    } else {
      throw new Error('期望 installed+failed');
    }
    expect(ctx.pluginRegistry.has('broken')).toBe(false);
    expect(ctx.pluginRegistry.listInstalled().map((r) => r.manifest.name)).toContain('broken');
    // install 期失败同源立即计数（与 loadInstalled 同源）
    const { readLoadHealth } = await import('ac-plugin-core');
    expect(readLoadHealth(root).failures.broken.count).toBe(1);
    expect(ctx.pluginRegistry.listFailed()).toEqual([
      { name: 'broken', error: expect.stringContaining('apply') },
    ]);
  });

  it('rejected：manifest 缺失 → 安装未成、无暂存残留', async () => {
    const root = await newRoot();
    const { ctx } = await boot(root);
    const result = await ctx.pluginRegistry.installFromDir(join(root, 'nonexistent'), 'dev');
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.error).toMatch(/manifest/);
    expect(ctx.pluginRegistry.listStaging()).toHaveLength(0);
    expect(ctx.pluginRegistry.listInstalled()).toHaveLength(0);
  });

  it('同 name+version 同 hash → 幂等返回已装状态与上次装载结果，不触发装载重试（G8）', async () => {
    const root = await newRoot();
    const modules = new Map<string, unknown>();
    const { ctx } = await boot(root, { modules });
    const dir = await makePluginDir(root, 'alpha', '1.0.0');
    modules.set('alpha', testPluginModule());
    await ctx.pluginRegistry.installFromDir(dir, 'dev');

    // 幂等重装：目录未动
    const again = await ctx.pluginRegistry.installFromDir(dir, 'dev');
    expect(again.status).toBe('installed');
    if (again.status === 'installed') {
      expect(again.idempotent).toBe(true);
      expect(again.load.status).toBe('loaded'); // 上次装载结果
    }
    // 幂等路径不重复装载：audit 只有一次 install/load 序列断言在下面测试；
    // 这里断言装载未重试（无第二条 load:loaded 流水）
    const { readAudit } = await import('ac-plugin-core');
    const loads = readAudit(root).filter((e) => e.event === 'load' && e.name === 'alpha');
    expect(loads).toHaveLength(1);
  });

  it('同 name+version 但 hash 不一致 → 拒绝并教 bump version（F14/L4）', async () => {
    const root = await newRoot();
    const modules = new Map<string, unknown>();
    const { ctx } = await boot(root, { modules });
    const dir = await makePluginDir(root, 'alpha', '1.0.0');
    modules.set('alpha', testPluginModule());
    await ctx.pluginRegistry.installFromDir(dir, 'dev');

    await writeFile(join(dir, 'index.ts'), 'export function apply() { /* 改动 */ }\n');
    const bumped = await ctx.pluginRegistry.installFromDir(dir, 'dev');
    expect(bumped.status).toBe('rejected');
    if (bumped.status === 'rejected') expect(bumped.error).toMatch(/bump version/);

    // bump version 后重装成功（正路）
    const dir2 = await makePluginDir(root, 'alpha', '1.1.0');
    modules.set('alpha', testPluginModule());
    const ok = await ctx.pluginRegistry.installFromDir(dir2, 'dev');
    expect(ok.status).toBe('installed');
  });

  it('数据根外来源 → 回执附可见警告 + 审计记原始 sourceDir（F14/L10）', async () => {
    const root = await newRoot();
    const outside = await mkdtemp(join(tmpdir(), 'ac-outside-'));
    const modules = new Map<string, unknown>();
    const { ctx } = await boot(root, { modules });
    const dir = await makePluginDir(outside, 'foreign', '1.0.0');
    modules.set('foreign', testPluginModule());

    const result = await ctx.pluginRegistry.installFromDir(dir, 'dev');
    expect(result.status).toBe('installed');
    if (result.status === 'installed') expect(result.warning).toMatch(/数据根（.*）之外/);
    const { readAudit } = await import('ac-plugin-core');
    const entry = readAudit(root).find((e) => e.event === 'install' && e.name === 'foreign');
    expect(entry?.sourceDir).toBe(dir);
  });

  it('F7 免审 UI 缺省 isolated：未声明 → 安装态规范化为 isolated:true；显式 false 保留并透出 uiNonIsolated', async () => {
    const root = await newRoot();
    const modules = new Map<string, unknown>();
    const { ctx } = await boot(root, { modules });
    const { loadManifestFromDir } = await import('ac-plugin-core');

    // 未声明 isolated → 规范化为 true（安装副本落盘；hash 一致）
    const dirA = await makePluginDir(root, 'ui-default', '1.0.0', { permissions: ['fs', 'ui'], ui: { entry: 'ui.js' } });
    await writeFile(join(dirA, 'ui.js'), 'export default {};\n');
    modules.set('ui-default', testPluginModule());
    const a = await ctx.pluginRegistry.installFromDir(dirA, 'dev');
    expect(a.status).toBe('installed');
    const installedManifest = loadManifestFromDir(join(root, 'plugins', 'ui-default'));
    expect(installedManifest.ui?.isolated).toBe(true);
    if (a.status === 'installed') expect(a.uiNonIsolated).toBeUndefined();

    // 显式 isolated:false → 保留 + 透出标记（徽章/回执明示面）
    const dirB = await makePluginDir(root, 'ui-explicit', '1.0.0', { permissions: ['fs', 'ui'], ui: { entry: 'ui.js', isolated: false } });
    await writeFile(join(dirB, 'ui.js'), 'export default {};\n');
    modules.set('ui-explicit', testPluginModule());
    const b = await ctx.pluginRegistry.installFromDir(dirB, 'dev');
    expect(b.status).toBe('installed');
    if (b.status === 'installed') expect(b.uiNonIsolated).toBe(true);
    expect(loadManifestFromDir(join(root, 'plugins', 'ui-explicit')).ui?.isolated).toBe(false);
  });

  it('§3.2/3.3 provides 装载后对账：声明与注册面不符 → warn 不阻断（装载照常成功）', async () => {
    const root = await newRoot();
    const modules = new Map<string, unknown>();
    const { ctx } = await boot(root, { modules });
    const warnCalls: string[] = [];
    const logger = (ctx as unknown as { logger: { warn(...args: unknown[]): void } }).logger;
    const origWarn = logger.warn.bind(logger);
    logger.warn = (...args: unknown[]) => {
      warnCalls.push(args.map(String).join(' '));
      origWarn(...args);
    };
    // 声明 provides.tools 与实际注册不符（声明了未注册的 + 注册了未声明的）
    const dir = await makePluginDir(root, 'liar', '1.0.0', { provides: { tools: ['liar-declared-tool'] } });
    modules.set('liar', testPluginModule()); // 实际注册 dev-tool-greet
    const result = await ctx.pluginRegistry.installFromDir(dir, 'dev');
    expect(result.status === 'installed' && result.load.status).toBe('loaded'); // 不阻断
    const reconcile = warnCalls.find((w) => w.includes('provides 对账不符') && w.includes('liar'));
    expect(reconcile).toMatch(/声明未注册的工具 \[liar-declared-tool\]/);
    expect(reconcile).toMatch(/未声明的工具注册 \[dev-tool-greet\]/);
  });
});

describe('保留字护栏（F13/G1——三面各一例）', () => {
  it('tools 面：provides.tools 撞内置工具名 → 可诊断拒绝', async () => {
    const root = await newRoot();
    const { ctx } = await boot(root);
    const dir = await makePluginDir(root, 'evil-tools', '1.0.0', { provides: { tools: ['read'] } });
    const result = await ctx.pluginRegistry.installFromDir(dir, 'dev');
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.error).toMatch(/内置名冲突/);
    expect(ctx.pluginRegistry.listInstalled()).toHaveLength(0);
    // 拒绝同入审计流水（G7：reject 事件带 owner 与原始 sourceDir）
    const { readAudit } = await import('ac-plugin-core');
    const entry = readAudit(root).find((e) => e.event === 'reject' && e.name === 'evil-tools');
    expect(entry?.owner).toBe('dev');
    expect(entry?.sourceDir).toBe(dir);
  });

  it('llmProviders 面：provides.llmProviders 撞 openai → 拒绝', async () => {
    const root = await newRoot();
    const { ctx } = await boot(root);
    const dir = await makePluginDir(root, 'evil-prov', '1.0.0', { provides: { llmProviders: ['openai'] } });
    const result = await ctx.pluginRegistry.installFromDir(dir, 'dev');
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.error).toMatch(/openai/);
  });

  it('agents 面：provides.agents 撞 user → 拒绝', async () => {
    const root = await newRoot();
    const { ctx } = await boot(root);
    const dir = await makePluginDir(root, 'evil-agent', '1.0.0', { provides: { agents: ['user'] } });
    const result = await ctx.pluginRegistry.installFromDir(dir, 'dev');
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.error).toMatch(/user/);
  });
});

describe('审计流水（G7：install/uninstall/reject/load 同入账）', () => {
  it('四类事件全落 audit.jsonl；uninstall 带备份目录与消费方', async () => {
    const root = await newRoot();
    const modules = new Map<string, unknown>();
    const { ctx } = await boot(root, { modules });
    const dir = await makePluginDir(root, 'audited', '1.0.0');
    modules.set('audited', testPluginModule());
    await ctx.pluginRegistry.installFromDir(dir, 'dev');

    // 共享：另一 Agent capabilities 含 agent:dev → uninstall 回执列消费方
    ctx.agents.register({ id: 'consumer', model: 'm', settings: { security: { capabilities: ['base', 'agent:dev'] } } });
    const un = await ctx.pluginRegistry.uninstall('audited');
    expect(un.consumers).toEqual(['consumer']);

    const { readAudit } = await import('ac-plugin-core');
    const events = readAudit(root).map((e) => `${e.event}:${e.name}`);
    expect(events).toContain('install:audited');
    expect(events).toContain('load:audited');
    expect(events).toContain('uninstall:audited');
    const unEntry = readAudit(root).find((e) => e.event === 'uninstall');
    expect(unEntry?.backupDir).toBeDefined();
    expect(unEntry?.outcome).toMatch(/consumer/);
  });
});

// ============================================================
// 回执 + 回触（H1 金闭环）—— 脚本化 agent 走完五步
// ============================================================

describe('金闭环 e2e：install_plugin → 回执 → 回触 → 自会话测试（H1）', () => {
  it('回执落账请求会话 + sender:event 回触 owner 自会话 + 插件工具可调', async () => {
    const root = await newRoot();
    const modules = new Map<string, unknown>();
    const { ctx, fibers } = await boot(root, { modules });

    // 开发目录（调用方沙箱约定 files/<agentId>/）——先建目录再装填脚本
    const devDir = join(root, 'files', 'dev', 'dev-tool');
    await mkdir(devDir, { recursive: true });
    await writeFile(
      join(devDir, 'manifest.json'),
      JSON.stringify({ name: 'dev-tool', version: '1.0.0', entry: 'index.ts', permissions: ['fs'], provides: { tools: ['dev-tool-greet'] } }),
    );
    await writeFile(join(devDir, 'index.ts'), 'export function apply() {}\n');
    modules.set('dev-tool', testPluginModule());

    const mock = scriptedLlm(['install', 'use', 'text'], { dir: devDir });
    const scripted = ctx.plugin(mock.row() as any);
    await scripted;
    fibers.push(scripted);

    ctx.agents.register({ id: 'dev', model: 'mock-1' });

    // ① 用户驱动 run：agent 调 install_plugin → run interrupted 收束
    const conversation = ctx.get('conversation') as {
      deliver(
        agentId: string,
        inbound: { role: 'user'; content: string },
        options: { conversationId: string; sender: string },
      ): Promise<{ kind: string }>;
    };
    const userConv = pairKey('user', 'dev');
    const outcome = await conversation.deliver('dev', { role: 'user', content: '请安装并测试你的插件' }, {
      conversationId: userConv,
      sender: 'user',
    });
    expect(outcome.kind).toBe('run');

    // ② 回执落账 + 回触自会话 + 下一轮 run（LLM 第 2 调 = use）→ 第 3 调收束
    //    轮询等待：插件安装、回执行、回触 run、工具执行全部完成
    const session = ctx.get('session') as {
      records(conversationId: string): Promise<Array<{ role: string; content: string | null; agent_id?: string }>>;
    };
    let receiptLine: { role: string; content: string | null; agent_id?: string } | undefined;
    let selfRecords: Array<{ role: string; content: string | null; agent_id?: string }> = [];
    for (let i = 0; i < 400; i++) {
      receiptLine = (await session.records(userConv)).find((r) => (r.content ?? '').includes('[plugin] install_plugin'));
      if (receiptLine) break;
      await sleep(10);
    }
    expect(receiptLine).toBeDefined();
    expect(receiptLine!.agent_id).toBe('dev'); // M21 中性格式：role:'agent' + agent_id
    expect(receiptLine!.content).toMatch(/已安装并装载成功/);
    expect(receiptLine!.content).toMatch(/bump version/); // 错误/回执文案可独立驱动下一步

    for (let i = 0; i < 400; i++) {
      selfRecords = await session.records(pairKey('dev', 'dev'));
      const done = selfRecords.some((r) => (r.content ?? '').includes('闭环完成'));
      if (done && ctx.tools.has('dev-tool-greet')) break;
      await sleep(10);
    }
    // 回触进 owner 自会话（dev~dev），插件工具已被第二轮 run 调用过
    expect(selfRecords.some((r) => (r.content ?? '').includes('[plugin] 你安装的'))).toBe(true);
    expect(mock.calls.length).toBeGreaterThanOrEqual(3); // install → use → text
    expect(ctx.pluginRegistry.has('dev-tool')).toBe(true);
    await scripted.dispose();
  }, 30000);

  it('失败路径回执可自纠：装载失败文案引导 bump version 重装', async () => {
    const root = await newRoot();
    const modules = new Map<string, unknown>();
    const { ctx, fibers } = await boot(root, { modules });

    const devDir = join(root, 'files', 'dev', 'broken-tool');
    await mkdir(devDir, { recursive: true });
    await writeFile(
      join(devDir, 'manifest.json'),
      JSON.stringify({ name: 'broken-tool', version: '1.0.0', entry: 'index.ts', permissions: ['fs'] }),
    );
    await writeFile(join(devDir, 'index.ts'), 'export function apply() {}\n');
    modules.set('broken-tool', {}); // 缺 apply → installed+failed

    const mock = scriptedLlm(['install', 'text'], { dir: devDir });
    const scripted = ctx.plugin(mock.row() as any);
    await scripted;
    fibers.push(scripted);

    ctx.agents.register({ id: 'dev', model: 'mock-1' });
    const conversation = ctx.get('conversation') as {
      deliver(
        agentId: string,
        inbound: { role: 'user'; content: string },
        options: { conversationId: string; sender: string },
      ): Promise<{ kind: string }>;
    };
    const userConv = pairKey('user', 'dev');
    await conversation.deliver('dev', { role: 'user', content: '装一下' }, { conversationId: userConv, sender: 'user' });

    const session = ctx.get('session') as {
      records(conversationId: string): Promise<Array<{ role: string; content: string | null }>>;
    };
    let receipt = '';
    for (let i = 0; i < 400; i++) {
      const line = (await session.records(userConv)).find((r) => (r.content ?? '').includes('装载失败'));
      if (line) {
        receipt = line.content ?? '';
        break;
      }
      await sleep(10);
    }
    expect(receipt).toMatch(/已安装 broken-tool@1\.0\.0，但装载失败/);
    expect(receipt).toMatch(/bump version/); // 下一步动作可独立驱动
    await scripted.dispose();
  }, 30000);
});
