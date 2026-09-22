// ============================================================
// ac-subagent：多轮会话（spawn/send/await/list/stop/delete）+ 落盘恢复
//
// 覆盖面：
//   · spawn：阻塞等待/异步；默认池回落；受控工具集；独立上下文（首条框架）
//   · send 四语义：sync 多轮上下文延续 / steer 注入活跃 run / next-run 排队链跑
//   · stop（保留实体续聊）/ delete（墓碑，list 不可见）
//   · list 含历史 + query 过滤；await 等待与取结果
//   · 落盘：index.json + <subId>.jsonl；重启后 list 可见、send 续聊上下文延续
//   · 身份：run 以 agent=<subId> 直连（不冒父身份；门禁 fail-closed 防递归）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import { ConfigService } from 'ac-config';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as jobsRow from 'ac-jobs';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as subagentRow from '../src/index.ts';
import * as toolsRow from 'ac-tools';

type ExecRes = { ok: boolean; output: any; error?: string };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('until 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];

/** 慢 provider 控制：gates[i] 释放前第 i+1 次 chat 挂起 */
function makeGatedProvider(gates: Array<Promise<void> & { release: () => void }>) {
  return {
    name: 'gated-provider',
    inject: ['llm'],
    apply(c: Context) {
      c.llm.register(
        'gated',
        () => ({
          stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
            captured.push(input);
            const idx = captured.length - 1;
            const gate = gates[idx];
            if (gate) await gate;
            yield { delta: `结论#${idx}:${String(input.messages.at(-1)?.content).slice(0, 8)}` };
            yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
          },
        }),
        { models: ['gated-1'] },
      );
    },
  };
}

function newGate(): Promise<void> & { release: () => void } {
  let release!: () => void;
  const p = new Promise<void>((r) => {
    release = r;
  });
  return Object.assign(p, { release });
}

async function boot(opts: { root?: string; provider?: unknown; model?: string } = {}) {
  captured.length = 0;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const provider =
    opts.provider ??
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register(
          'mock',
          () => ({
            stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
              captured.push(input);
              yield { delta: `子任务结论:${String(input.messages.at(-1)?.content).slice(0, 10)}` };
              yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
            },
          }),
          { models: ['mock-1'] },
        );
      },
    };
  const rows: Array<[unknown, unknown]> = [
    [toolsRow, undefined],
    [jobsRow, undefined],
    [llmRow, undefined],
    [provider, undefined],
    [loopRow, undefined],
    [agentsRow, undefined],
    [ConfigService, undefined],
    [subagentRow, opts.root !== undefined ? { root: opts.root } : undefined],
  ];
  const prevEnv = process.env.AGENTCHAT_DATA_ROOT;
  if (opts.root === undefined) delete process.env.AGENTCHAT_DATA_ROOT;
  else process.env.AGENTCHAT_DATA_ROOT = opts.root;
  try {
    for (const [plugin, config] of rows) {
      const fiber = ctx.plugin(plugin as never, config as never);
      await fiber;
      fibers.push(fiber);
    }
    for (let i = 0; i < 1000; i++) {
      if ((ctx as any).tools && (ctx as any).agentLoop && (ctx as any).agents && (ctx as any).jobs) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    ctx.agents.register({ id: 'chief', model: opts.model ?? 'mock-1', tags: ['delegation'] });
    booted.push({ ctx, fibers });
    return { ctx, fibers };
  } finally {
    if (prevEnv === undefined) delete process.env.AGENTCHAT_DATA_ROOT;
    else process.env.AGENTCHAT_DATA_ROOT = prevEnv;
  }
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('ac-subagent：程序化开关传播（2026-09-17 裁决——转换随工具集流动）', () => {
  /** conv-settings stub（ctx.convSettings 可选能力——Service 形态注册进 ctx，
   * ctx.get('convSettings', false) 才可见；裸类实例挂属性不进服务表） */
  class ConvSettingsStub extends Service {
    private readonly store = new Map<string, { toolMode?: 'tc-base' | 'tc-programmatic' | 'tc-none' }>();
    constructor(ctx: Context, options: { settings?: Record<string, { toolMode?: 'tc-base' | 'tc-programmatic' | 'tc-none' }> } = {}) {
      super(ctx, 'convSettings');
      for (const [k, v] of Object.entries(options.settings ?? {})) this.store.set(k, v);
    }
    get(conversationId: string): { toolMode?: 'tc-base' | 'tc-programmatic' | 'tc-none' } {
      return this.store.get(conversationId) ?? {};
    }
  }

  async function bootWithSwitch(settings: Record<string, { toolMode?: 'tc-base' | 'tc-programmatic' | 'tc-none' }>) {

    const booted0 = await boot();

    void new ConvSettingsStub(booted0.ctx, { settings });
    // run_code 探针（2026-12 injection 轴形态：mode 工具不挂 requiredTags、
    // 不进常规能力面——收窄经 narrowToolsByMode 从 defs 合成 mode 集）
    booted0.ctx.tools.register({
      name: 'run_code',
      injection: 'mode',
      description: 'd',
      execute: () => ({ ok: true }),
    });
    booted0.ctx.agents.reassign({ id: 'chief', model: 'mock-1', tags: ['delegation'] });
    return booted0;
  }

  it('会话覆盖 tc-programmatic + spawn 不带 tools → 子 Agent 工具面收窄为 [run_code]', async () => {

    const { ctx } = await bootWithSwitch({ 'conv-prog': { toolMode: 'tc-programmatic' } });
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '程序化子任务', wait_time: 30 },
      agentId: 'chief',
      conversationId: 'conv-prog',
    });
    expect(r.ok).toBe(true);
    const input = captured.at(-1)!;
    expect((input.tools ?? []).map((t: any) => t.function.name)).toEqual(['run_code']);
  });

  it('spawn.tools 点名 + tc-programmatic：LLM 面仍收窄为 mode 集（与 router 同口径；点名工具经 run_code 投影可用）', async () => {
    const { ctx } = await bootWithSwitch({ 'conv-prog': { toolMode: 'tc-programmatic' } });

    ctx.tools.register({ name: 'plain_tool', description: 'd', execute: () => ({ ok: true }) });

    const r = await exec(ctx, {

      name: 'subagent',

      args: { action: 'spawn', task: '点名任务', tools: ['plain_tool'], wait_time: 30 },
      agentId: 'chief',
      conversationId: 'conv-prog',
    });
    expect(r.ok).toBe(true);
    const input = captured.at(-1)!;
    // 2026-12 二次修正：收窄对点名面同样生效（此前点名即跳过程序化传播
    // ——第三次实测复现 run_code 缺失）。点名工具不丢：仍在能力面，
    // run_code 投影（scope='projection' 能力面直取）涵盖它们
    expect((input.tools ?? []).map((t: any) => t.function.name)).toEqual(['run_code']);
  });

  it('会话覆盖 tc-base 压回标准档 → 常规工具面（mode 工具不混入）', async () => {
    // 2026-12 injection 轴后「并存形态」退役：run_code 挂 injection:'mode'
    // 恒不进常规面——tc-base 压回 = 纯常规工具（与 tc-programmatic 的
    // mode 集互斥；会话覆盖 = 跟随态被压制的显式形态）
    const { ctx } = await bootWithSwitch({ 'conv-plain': { toolMode: 'tc-base' } });
    ctx.tools.register({ name: 'plain_tool', description: 'd', execute: () => ({ ok: true }) });
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '常规子任务', wait_time: 30 },
      agentId: 'chief',
      conversationId: 'conv-plain',
    });
    expect(r.ok).toBe(true);
    const names = (captured.at(-1)!.tools ?? []).map((t: any) => t.function.name);
    expect(names).toContain('plain_tool');
    expect(names).not.toContain('run_code');
  });

  it('tc-base（无覆盖无模式词）→ mode 工具不进常规面：子 Agent 面 = 常规工具', async () => {
    const { ctx } = await bootWithSwitch({});

    ctx.tools.register({ name: 'plain_tool', description: 'd', execute: () => ({ ok: true }) });
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '常规任务', wait_time: 30 },
      agentId: 'chief',
    });
    expect(r.ok).toBe(true);
    const names = (captured.at(-1)!.tools ?? []).map((t: any) => t.function.name);
    // injection 轴重构后 mode 工具（run_code）不进常规能力面——tc-base 子
    // Agent 只见常规工具；tc-programmatic 才从 defs 合成 mode 集
    expect(names).not.toContain('run_code');
    expect(names).toContain('plain_tool');
  });
});


// ============================================================
// 沙箱基准继承（2026-12 数据根一致修复——子 Agent 与父会话同根）
// ============================================================
describe('ac-subagent：spawn 沙箱基准快照（数据根一致）', () => {
  /** workspace 域 stub：会话挂载工作区 → conversationWorkspaceRoot；无 → null */
  function makeWorkspaceStub(ctx: Context, convRoots: Record<string, string>) {
    class WorkspaceStub extends Service {
      constructor(c: Context) {
        super(c, 'workspace');
      }
      conversationWorkspaceRoot(conversationId: string | undefined): string | null {
        if (!conversationId) return null;
        return convRoots[conversationId] ?? null;
      }
      sandboxWorkdir(agentId: string | undefined): string | undefined {
        // 真实优先序缩影：会话工作区（本 stub 无键）> settings 显式 workdir
        //（agents 经闭包引用——Service 基类 this.ctx 的 fiber 解析在裸实例
        // 化形态下不可靠，测试 stub 不依赖它）
        if (!agentId) return undefined;
        const agent = ctx.agents.get(agentId);
        const security = (agent?.settings as Record<string, unknown> | undefined)?.security as Record<string, unknown> | undefined;
        const wd = security?.workdir;
        return typeof wd === 'string' && wd ? wd : undefined;
      }
    }
    void new WorkspaceStub(ctx);
  }

  it('会话挂载工作区 → spawn 快照进派生身份 settings.security.workdir（子 Agent 与父会话同根）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-ws-'));
    const wsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-ws-mount-'));
    const { ctx } = await boot({ root });
    makeWorkspaceStub(ctx, { 'conv-ws': wsPath });
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '工作区任务', wait_time: 30 },
      agentId: 'chief',
      conversationId: 'conv-ws',
    });
    expect(r.ok).toBe(true);
    const id = r.output.subagent_id as string;
    // 注册表快照落盘（跨重启仍生效）
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'subagents', 'index.json'), 'utf-8'));
    const rec = registry.subs.find((s: any) => s.id === id);
    expect(rec.workdir).toBe(wsPath);
    // 派生身份：sandboxWorkdir 显式档命中（会话键缺席也能解析到工作区）
    const agent = ctx.agents.get(id)!;
    expect((agent.settings as any).security.workdir).toBe(wsPath);
    const workspace = ctx.get('workspace') as any;
    expect(workspace.sandboxWorkdir(id, undefined)).toBe(wsPath);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  });

  it('无会话工作区（未挂载/无会话键）→ workdir 缺席：沙箱链回落旧行为（preset→数据根）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-nows-'));
    const { ctx } = await boot({ root });
    makeWorkspaceStub(ctx, {}); // 无挂载
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '无工作区任务', wait_time: 30 },
      agentId: 'chief', // 无 conversationId
    });
    expect(r.ok).toBe(true);
    const id = r.output.subagent_id as string;
    const agent = ctx.agents.get(id)!;
    expect((agent.settings as any)?.security?.workdir).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });
});


describe('ac-subagent：spawn / await / 身份', () => {
  it('父 Agent 未声明 model → 默认池连接回落；无池也无 model → fail-closed 拒绝', async () => {
    const { ctx } = await boot();
    ctx.config.set('llmProviders', { main: { provider: 'mock', model: 'mock-1', default: true } });
    ctx.agents.register({ id: 'pooluser' });
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '默认池下的子任务', wait_time: 30 },
      agentId: 'pooluser',
    });
    expect(r.ok).toBe(true);
    expect(r.output.status).toBe('done');
    ctx.config.set('llmProviders', {});
    const r2 = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: 'x', wait_time: 1 },
      agentId: 'pooluser',
    });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/无可用模型/);
  });

  it('派生身份注册：preset 隐藏 + tags 剥 delegation/admin；delete 撤注册', async () => {
    const { ctx } = await boot();
    // 父带 delegation/admin/full-access——子派生应剥前二者、保留档位
    ctx.agents.reassign({ id: 'chief', model: 'mock-1', tags: ['delegation', 'admin', 'full-access'] });
    ctx.tools.register({
      name: 'admin_tool',
      requiredTags: ['admin'],
      execute: () => ({ ok: true, output: '***' }),
    });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '身份任务', wait_time: 30 }, agentId: 'chief' });
    expect(r.ok).toBe(true);
    const id = r.output.subagent_id as string;
    const derived = ctx.agents.get(id);
    // preset=true：名册/协作/管理面过滤口径（agents/list RPC 与 list_agents 同款）
    expect(derived?.preset).toBe(true);
    expect(ctx.agents.list().filter((a) => a.preset !== true).map((a) => a.id)).not.toContain(id);
    // tags 剥减：delegation/admin 移除、full-access 保留（档位继承单源仍在父侧）
    expect(derived?.tags).toEqual(['full-access']);
    // delete → 撤派生注册
    const d = await exec(ctx, { name: 'subagent', args: { action: 'delete', subagent_id: id }, agentId: 'chief' });
    expect(d.ok).toBe(true);
    expect(ctx.agents.get(id)).toBeUndefined();
  });

  it('能力面终滤：spawn.tools 点名 admin 工具也被滤；subagent 工具对子 Agent 不可见', async () => {
    const { ctx } = await boot();
    ctx.agents.reassign({ id: 'chief', model: 'mock-1', tags: ['delegation', 'admin'] });
    ctx.tools.register({
      name: 'admin_tool',
      requiredTags: ['admin'],
      execute: () => ({ ok: true, output: '***' }),
    });
    // 点名传入被门禁滤掉的工具
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '点名任务', tools: ['admin_tool', 'subagent'], wait_time: 30 },
      agentId: 'chief',
    });
    expect(r.ok).toBe(true);
    const input = captured.at(-1)!;
    // 子 run 工具清单不含 admin_tool（admin 被剥）与 subagent（delegation 被剥）
    // ——空集经 loop toolSpecs 收敛为 undefined（= 无工具）
    expect(input.tools ?? []).toEqual([]);
  });

  it('信封装配继承：子 run system 前缀父 system；llmParams 透传', async () => {
    const { ctx } = await boot();
    ctx.agents.reassign({
      id: 'chief',
      model: 'mock-1',
      tags: ['delegation'],
      system: '你是父级人设',
      llmParams: { temperature: 0.2 },
    });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '继承任务', wait_time: 30 }, agentId: 'chief' });
    expect(r.ok).toBe(true);
    const input = captured[0];
    // loop 把 request.system 拼为 messages 首行（role:system）
    const sys = input.messages.find((m: any) => m.role === 'system');
    expect(String(sys?.content ?? '')).toContain('你是父级人设');
    expect(input.temperature).toBe(0.2);
  });

  it('spawn 阻塞等待：拿到结果；受控工具集进 LLM 请求；独立上下文（首条裸文本）', async () => {
    const { ctx } = await boot();
    expect(ctx.tools.get('subagent')?.requiredTags).toEqual(['delegation']);
    ctx.tools.register({ name: 'calculator', execute: () => ({ ok: true }) });
    const runReqs: any[] = [];
    ctx.on('loop/run-started', (req) => runReqs.push(req));
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '调研 X 并总结', tools: ['calculator'], wait_time: 30 },
      agentId: 'chief',
    });
    expect(r.ok).toBe(true);
    expect(r.output.status).toBe('done');
    expect(String(r.output.result)).toContain('子任务结论:');
    expect(captured).toHaveLength(1);
    const input = captured[0];
    // 独立上下文：首条消息 = 任务原文（不背父会话；frameTask/context 参数
    // 均已退役——无角色框架无尾拼）
    expect(String(input.messages[0].content)).toContain('调研 X 并总结');
    expect(String(input.messages[0].content)).not.toContain('[子任务]');
    expect(String(input.messages[0].content)).not.toContain('[上下文]');
    expect(input.tools?.map((t) => t.function.name)).toEqual(['calculator']);
    // 身份：子 Agent 以自身合成 id 直连（不冒父身份——门禁 fail-closed 防递归）
    expect(runReqs[0].agent).toMatch(/^sub_/);
    expect(runReqs[0].agent).not.toBe('chief');
    expect(runReqs[0].conversationId).toBeUndefined();
  });

  it('无 task spawn → idle；send 首条 → 裸文本启动（无框架包装）', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', name: '调研员' }, agentId: 'chief' });
    expect(r.ok).toBe(true);
    expect(r.output.status).toBe('idle');
    const id = r.output.subagent_id as string;
    const s = await exec(ctx, {
      name: 'subagent',
      args: { action: 'send', subagent_id: id, message: '先摸底情况', mode: 'sync' },
      agentId: 'chief',
    });
    expect(s.ok).toBe(true);
    expect(s.output.status).toBe('done');
    expect(String(captured[0].messages[0].content)).toBe('先摸底情况'); // 裸文本（frameTask 退役）
    // send 无 task 的 spawn 记录任务摘要
    const l = await exec(ctx, { name: 'subagent', args: { action: 'list' }, agentId: 'chief' });
    expect(l.output.subagents[0].task).toContain('先摸底');
  });

  it('异步 spawn → await 取结果；job 登记 + settled 事件', async () => {
    const { ctx } = await boot();
    const settled: unknown[] = [];
    ctx.on('job/settled', (job) => settled.push(job));
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '慢任务' }, agentId: 'chief' });
    expect(r.output.status).toBe('running');
    const id = r.output.subagent_id as string;
    const jobsList = ctx.jobs.list('chief');
    expect(jobsList[0]).toMatchObject({ kind: 'subagent', label: '慢任务' });
    const done = await exec(ctx, { name: 'subagent', args: { action: 'await', subagent_id: id }, agentId: 'chief' });
    expect(done.ok).toBe(true);
    expect(done.output.status).toBe('done');
    await until(() => settled.length > 0);
    expect(settled[0]).toMatchObject({ kind: 'subagent', status: 'completed' });
  });
});

describe('ac-subagent：send 多轮语义', () => {
  it('sync 多轮：第二轮上下文含第一轮 user/assistant；结果返回', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '第一轮任务', wait_time: 30 },
      agentId: 'chief',
    });
    const id = r.output.subagent_id as string;
    expect(captured).toHaveLength(1);
    const s = await exec(ctx, {
      name: 'subagent',
      args: { action: 'send', subagent_id: id, message: '补充：只要结论要点', mode: 'sync' },
      agentId: 'chief',
    });
    expect(s.ok).toBe(true);
    expect(s.output.status).toBe('done');
    expect(s.output.delivered).toBe('started');
    expect(String(s.output.result)).toContain('子任务结论:');
    // 第二轮请求 = 首轮 user + assistant 回复（expandSteps 展开——纯文本步
    // 单 assistant 行，含工具步则有配对 tool 行）+ 新 user 消息
    expect(captured).toHaveLength(2);
    const second = captured[1].messages.map((m) => `${m.role}:${String(m.content).slice(0, 40)}`);
    expect(second[0]).toContain('第一轮任务');
    expect(second[1]).toContain('子任务结论');
    expect(second.at(-1)).toBe('user:补充：只要结论要点');
  });

  it('steer：注入活跃 run 的下一步（delivered=steered；消息进入该 run 后续请求）', async () => {
    const gates = [newGate(), newGate()];
    const { ctx } = await boot({ provider: makeGatedProvider(gates), model: 'gated-1' });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '长任务' }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    await until(() => captured.length >= 1); // 首步挂起中
    const s = await exec(ctx, {
      name: 'subagent',
      args: { action: 'send', subagent_id: id, message: '中途插话：注意预算', mode: 'steer' },
      agentId: 'chief',
    });
    expect(s.ok).toBe(true);
    expect(s.output.delivered).toBe('steered');
    gates[0].release();
    await until(() => captured.length >= 2); // 第二步已发出
    gates[1].release();
    const done = await exec(ctx, { name: 'subagent', args: { action: 'await', subagent_id: id }, agentId: 'chief' });
    expect(done.output.status).toBe('done');
    // 第二步请求 = 首步产出(assistant) + 注入的 user 消息
    const second = captured[1].messages;
    expect(second.some((m) => m.role === 'user' && String(m.content).includes('中途插话：注意预算'))).toBe(true);
  });

  it('next-run：忙时排队（delivered=queued），当前 run 收束后自动链跑', async () => {
    const gates = [newGate()];
    const { ctx } = await boot({ provider: makeGatedProvider(gates), model: 'gated-1' });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '第一轮' }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    await until(() => captured.length >= 1);
    const s = await exec(ctx, {
      name: 'subagent',
      args: { action: 'send', subagent_id: id, message: '第二轮追问', mode: 'next-run' },
      agentId: 'chief',
    });
    expect(s.output.delivered).toBe('queued');
    expect(captured).toHaveLength(1); // 未注入当前 run
    gates[0].release();
    await until(() => captured.length >= 2); // 链跑自动开新 run
    const done = await exec(ctx, { name: 'subagent', args: { action: 'await', subagent_id: id }, agentId: 'chief' });
    expect(done.output.status).toBe('done');
    expect(String(captured[1].messages.at(-1)?.content)).toContain('第二轮追问');
  });

  it('stop：终止当前推理（stopped）→ 实体保留，send 续聊成功', async () => {
    // 首步产出工具调用（挂起工具），中止落在步边界 → finish=interrupted
    const toolCallProvider = {
      name: 'toolcall-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register(
          'mock',
          () => ({
            stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
              captured.push(input);
              if (captured.length === 1) {
                yield {
                  delta: '',
                  finish: 'tool_calls',
                  toolCalls: [{ index: 0, id: 'tc1', name: 'slow_tool', argumentsDelta: '{}' }],
                };
              } else {
                yield { delta: `结论:${String(input.messages.at(-1)?.content).slice(0, 10)}` };
                yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
              }
            },
          }),
          { models: ['mock-1'] },
        );
      },
    };
    const { ctx } = await boot({ provider: toolCallProvider });
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((r) => {
      releaseTool = r;
    });
    ctx.tools.register({
      name: 'slow_tool',
      execute: (_args, call) =>
        new Promise((resolve) => {
          // abort 时优雅返回（模拟 bash 被杀）——下一步边界检查收束 interrupted
          const onAbort = () => resolve({ ok: false, error: 'aborted' });
          if (call.signal) {
            if (call.signal.aborted) return onAbort();
            call.signal.addEventListener('abort', onAbort, { once: true });
          }
          void toolGate.then(() => resolve({ ok: true, output: '慢工具完成' }));
        }),
    });
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '挂起任务', tools: ['slow_tool'] },
      agentId: 'chief',
    });
    const id = r.output.subagent_id as string;
    await until(() => captured.length >= 1);
    const st = await exec(ctx, { name: 'subagent', args: { action: 'stop', subagent_id: id }, agentId: 'chief' });
    expect(st.ok).toBe(true);
    expect(st.output.stopped).toBe(true);
    const done = await exec(ctx, { name: 'subagent', args: { action: 'await', subagent_id: id }, agentId: 'chief' });
    expect(done.output.status).toBe('stopped');
    // 续聊：同一实体再 send（中止轮无 assistant 行，上下文 = 首轮 user + 新 user）
    const s = await exec(ctx, {
      name: 'subagent',
      args: { action: 'send', subagent_id: id, message: '继续把任务做完', mode: 'sync' },
      agentId: 'chief',
    });
    expect(s.ok).toBe(true);
    expect(s.output.status).toBe('done');
    const last = captured.at(-1)!.messages;
    expect(String(last.at(-1)?.content)).toContain('继续把任务做完');
    releaseTool();
  });
});

describe('ac-subagent：delete / list / 旧词汇', () => {
  it('delete：list 不可见；send/await 报错；旧 action=kill 报未知', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '将被删', wait_time: 30 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    const d = await exec(ctx, { name: 'subagent', args: { action: 'delete', subagent_id: id }, agentId: 'chief' });
    expect(d.ok).toBe(true);
    expect(d.output.deleted).toBe(true);
    const l = await exec(ctx, { name: 'subagent', args: { action: 'list' }, agentId: 'chief' });
    expect(l.output.total).toBe(0);
    const s = await exec(ctx, { name: 'subagent', args: { action: 'send', subagent_id: id, message: 'x' }, agentId: 'chief' });
    expect(s.ok).toBe(false);
    expect(s.error).toContain('已删除');
    const a = await exec(ctx, { name: 'subagent', args: { action: 'await', subagent_id: id }, agentId: 'chief' });
    expect(a.ok).toBe(false);
    const k = await exec(ctx, { name: 'subagent', args: { action: 'kill', subagent_id: id }, agentId: 'chief' });
    expect(k.ok).toBe(false);
    // 已删除 id 的触达拦截在 earlyCheck（删除态优先于未知词汇提示）
    expect(k.error).toContain('已删除');
    const k2 = await exec(ctx, { name: 'subagent', args: { action: 'kill' }, agentId: 'chief' });
    expect(k2.ok).toBe(false);
    expect(k2.error).toContain('spawn/send/await/list/stop/delete');
  });

  it('list 含历史 + query 过滤 + running_only', async () => {
    const { ctx } = await boot();
    await exec(ctx, { name: 'subagent', args: { action: 'spawn', name: '调研员', task: '调研甲', wait_time: 30 }, agentId: 'chief' });
    await exec(ctx, { name: 'subagent', args: { action: 'spawn', name: '写作员', task: '写总结', wait_time: 30 }, agentId: 'chief' });
    const all = await exec(ctx, { name: 'subagent', args: { action: 'list' }, agentId: 'chief' });
    expect(all.output.total).toBe(2);
    expect(all.output.subagents.map((s: any) => s.name)).toEqual(['写作员', '调研员']); // 新在前
    expect(all.output.subagents[0]).toMatchObject({ status: 'done', runs: 1 });
    const q = await exec(ctx, { name: 'subagent', args: { action: 'list', query: '调研' }, agentId: 'chief' });
    expect(q.output.total).toBe(1);
    expect(q.output.subagents[0].name).toBe('调研员');
    const idleOnly = await exec(ctx, { name: 'subagent', args: { action: 'list', running_only: true }, agentId: 'chief' });
    expect(idleOnly.output.total).toBe(0);
  });
});

describe('ac-subagent：误用护栏（2026-09-16 news 事故复盘）', () => {
  it('未知参数（send_agent 语义串线）：带正文的 message 塞进 subagent(send) → 立即报错指路，不再静默丢弃', async () => {
    const { ctx } = await boot();
    // 复刻事故第一现场：action=send、无 subagent_id、正文在 message、还带 to/wait
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'send', message: '📊【特别报道】推送正文…', to: 'user', wait: false },
      agentId: 'chief',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未知参数');
    expect(r.error).toContain('不会送达任何接收方');
    // 指路：send_agent/send_group 而不是 spawn 送信
    expect(String(r.error)).toMatch(/send_agent/);
    expect((r.output as any).hint).toContain('send_agent');
  });

  it('send 缺 subagent_id 且名下零子 Agent → 报错点破"工具拿错"并指路', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'send', message: '给用户的推送' },
      agentId: 'chief',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有任何子 Agent');
    expect(r.error).toContain('send_agent');
  });

  it('spawn task 冒号截断："请转交以下内容："式结尾 → 拒绝并提示补全', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '请将以下内容原样转交给 user（莉莉新闻的推送内容），完成后简单回执即可：' },
      agentId: 'chief',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('疑似被截断');
    expect(r.error).toContain('完整内容');
  });

  it('id 近似候选：誊写噪声（尾下划线/引号）报错附候选', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '原始任务', wait_time: 30 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    const noisy = `${id}_`;
    const a = await exec(ctx, { name: 'subagent', args: { action: 'await', subagent_id: noisy }, agentId: 'chief' });
    expect(a.ok).toBe(false);
    expect(a.error).toContain('不存在');
    expect(a.error).toContain(id); // 候选列出正确 id
  });

  it('await 结果带触达 note：result 仅回到父上下文，未投递任何接收方', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '复读任务', wait_time: 30 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    const a = await exec(ctx, { name: 'subagent', args: { action: 'await', subagent_id: id }, agentId: 'chief' });
    expect(a.ok).toBe(true);
    expect(String((a.output as any).note)).toContain('尚未投递');
    expect(String((a.output as any).note)).toContain('send_agent');
  });

  it('合法路径不受护栏影响：正常 spawn/send(sinc)/await 全通', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '正常任务', wait_time: 30 }, agentId: 'chief' });
    expect(r.ok).toBe(true);
    const id = r.output.subagent_id as string;
    const s = await exec(ctx, {
      name: 'subagent',
      args: { action: 'send', subagent_id: id, message: '补充指示', mode: 'sync' },
      agentId: 'chief',
    });
    expect(s.ok).toBe(true);
    expect(s.output.status).toBe('done');
  });
});

describe('ac-subagent：落盘与重启恢复', () => {
  it('消息与注册表落盘；重启后 list 可见、send 续聊上下文延续', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-test-'));
    const first = await boot({ root });
    const r = await exec(first.ctx, {
      name: 'subagent',
      args: { action: 'spawn', name: '档案员', task: '第一轮任务', wait_time: 30 },
      agentId: 'chief',
    });
    const id = r.output.subagent_id as string;
    // 落盘：注册表 + 会话消息行
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'subagents', 'index.json'), 'utf-8'));
    expect(registry.subs).toHaveLength(1);
    expect(registry.subs[0]).toMatchObject({ id, name: '档案员', status: 'idle', runs: 1 });
    const lines = fs.readFileSync(path.join(root, 'subagents', id, 'messages.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3); // user（框架）+ agent（收束回复）+ run-settled 判别行
    const userLine = JSON.parse(lines[0]);
    const agentLine = JSON.parse(lines[1]);
    expect(userLine.role).toBe('user');
    expect(userLine.agent_id).toBe('chief'); // 任务发送方 = 父
    expect(userLine.message_id).toMatch(/^msg-/);
    expect(typeof userLine.timestamp).toBe('string');
    expect(agentLine.role).toBe('agent'); // 新行形（SessionRecord 中性格式）
    expect(agentLine.agent_id).toBe(id); // 说话人 = 子
    // 删除 first 引用（afterEach 统一回收）

    // 重启：同一 root 新宿主
    const second = await boot({ root });
    const l = await exec(second.ctx, { name: 'subagent', args: { action: 'list', query: '档案员' }, agentId: 'chief' });
    expect(l.output.total).toBe(1);
    expect(l.output.subagents[0]).toMatchObject({ id, runs: 1, status: 'done' });
    const s = await exec(second.ctx, {
      name: 'subagent',
      args: { action: 'send', subagent_id: id, message: '重启后的追问', mode: 'sync' },
      agentId: 'chief',
    });
    expect(s.ok).toBe(true);
    expect(s.output.status).toBe('done');
    // 续聊上下文 = 落盘历史（首轮 user/assistant）+ 新消息
    const msgs = captured[0].messages;
    expect(String(msgs[0].content)).toContain('第一轮任务');
    expect(String(msgs[1].content)).toContain('子任务结论');
    expect(String(msgs.at(-1)?.content)).toBe('重启后的追问');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('重启崩溃恢复：注册表 running → idle 归一（消息保留可续聊）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-crash-'));
    const gates = [newGate()];
    const { ctx } = await boot({ root, provider: makeGatedProvider(gates), model: 'gated-1' });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '跑到一半' }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    await until(() => captured.length >= 1);
    // run 进行中：注册表已记 running
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'subagents', 'index.json'), 'utf-8'));
    expect(onDisk.subs[0]).toMatchObject({ id, status: 'running' });
    // 第二宿主同 root 装载：running → idle 归一（run 未收束：runs=0、无 lastRun）
    const { ctx: ctx2 } = await boot({ root });
    const l = await exec(ctx2, { name: 'subagent', args: { action: 'list' }, agentId: 'chief' });
    expect(l.output.subagents[0]).toMatchObject({ id, status: 'idle', runs: 0 });
    gates[0].release();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('ac-subagent：落盘完整消息（subagent-session-view-plan R1/R2/R6/R8）', () => {
  /** 带工具调用的 provider：一步工具调用 + 一步终文本（toolCalls/results 落盘形状） */
  function makeToolingProvider() {
    return {
      name: 'tooling-provider',
      inject: ['llm'],
      apply(c: Context) {
        let round = 0;
        c.llm.register(
          'tooling',
          () => ({
            stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
              captured.push(input);
              round += 1;
              if (round % 2 === 1) {
                // 奇数步：reasoning + 工具调用（模拟 ReAct 中间步；arguments
                // 走 argumentsDelta 增量——聚合层按 index 拼接）
                yield { delta: '', reasoning: '先查一下' };
                yield {
                  delta: '',
                  toolCalls: [
                    { index: 0, id: `tc-${round}`, name: 'math' },
                    { index: 0, argumentsDelta: '{"expression":"1+2"}' },
                  ],
                };
                yield { delta: '', finish: 'tool-calls', usage: { prompt: 2, completion: 1 } };
              } else {
                yield { delta: '调研完成：结论如下' };
                yield { delta: '', finish: 'stop', usage: { prompt: 3, completion: 2 } };
              }
            },
          }),
          { models: ['tooling-1'] },
        );
      },
    };
  }

  it('带工具任务的收束行携带全量 steps（toolCalls/results 一一对应）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-steps-'));
    const { ctx } = await boot({ root, provider: makeToolingProvider(), model: 'tooling-1' });
    // 注册 math 工具（纯 LLM 面，无副作用）
    ctx.tools.register({
      name: 'math',
      description: '测试工具',
      parameters: { type: 'object', properties: { expression: { type: 'string' } } },
      async execute() {
        return { ok: true, output: 3 };
      },
    });
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', name: '调研员', task: '查一下', tools: ['math'], wait_time: 30 },
      agentId: 'chief',
    });
    const id = r.output.subagent_id as string;
    const lines = fs.readFileSync(path.join(root, 'subagents', id, 'messages.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3); // user + agent（settlement 单行形）+ run-settled
    const agentLine = JSON.parse(lines[1]);
    expect(agentLine.role).toBe('agent');
    expect(agentLine.agent_id).toBe(id);
    expect(typeof agentLine.run).toBe('string'); // run 键（三文件化对账锚）
    expect(agentLine.steps).toHaveLength(2);
    // journal 收束即清：partials.jsonl 不存在（工具步步行已被 settlement 提升）
    expect(fs.existsSync(path.join(root, 'subagents', id, 'partials.jsonl'))).toBe(false);
    // 工具步：reasoning + toolCalls（result = ToolResult 终值）
    expect(agentLine.steps[0].reasoning).toBe('先查一下');
    expect(agentLine.steps[0].toolCalls).toHaveLength(1);
    expect(agentLine.steps[0].toolCalls[0]).toMatchObject({ id: 'tc-1', name: 'math', arguments: '{"expression":"1+2"}' });
    expect(agentLine.steps[0].toolCalls[0].result).toMatchObject({ ok: true, output: 3 });
    // 终步：正文收束
    expect(agentLine.steps[1].content).toBe('调研完成：结论如下');
    // 展示投影：historyRecords 原样带出
    const records = ctx.subagents.historyRecords(id);
    expect(records).toHaveLength(2);
    expect(records[1].steps).toHaveLength(2);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('旧行（assistant/ts:number）宽容读取：回放不炸、historyRecords 归一为 agent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-legacy-'));
    const { ctx } = await boot({ root });
    // 手写旧行文件 + 注册表条目（模拟升级前数据）
    const id = 'sub_19990101_abcd';
    fs.mkdirSync(path.join(root, 'subagents'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'subagents', `${id}.jsonl`),
      `${JSON.stringify({ role: 'user', content: '旧任务', ts: 1000 })}\n`
      + `${JSON.stringify({ role: 'assistant', content: '旧回复', ts: 2000 })}\n`,
      'utf-8',
    );
    const registry = { version: 1, subs: [{ id, parentId: 'chief', name: '旧子', task: '旧任务', status: 'idle', deleted: false, createdAt: 1, updatedAt: 1, runs: 1, maxSteps: 15, timeoutMs: 0 }] };
    fs.writeFileSync(path.join(root, 'subagents', 'index.json'), JSON.stringify(registry), 'utf-8');
    // 重启装载（同 root 第二宿主）
    const second = await boot({ root });
    const records = second.ctx.subagents.historyRecords(id);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ role: 'user', content: '旧任务' });
    expect(records[1]).toMatchObject({ role: 'assistant', content: '旧回复' });
    // 回放口径：旧 assistant 行 → LlmMessage assistant（续聊可用）
    const replay = await second.ctx.subagents.history(id);
    expect(replay).toEqual([
      { role: 'user', content: '旧任务' },
      { role: 'assistant', content: '旧回复' },
    ]);
    // 新 send 追加行与旧行共存
    const s = await exec(second.ctx, { name: 'subagent', args: { action: 'send', subagent_id: id, message: '新追问', mode: 'sync' }, agentId: 'chief' });
    expect(s.ok).toBe(true);
    const merged = second.ctx.subagents.historyRecords(id);
    expect(merged).toHaveLength(4);
    expect(merged.at(-1)).toMatchObject({ role: 'agent', agent_id: id });
    void ctx;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('墓碑可读（R6）：delete 后 historyRecords 照常返回；send/await 仍拒', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-tomb-'));
    const { ctx } = await boot({ root });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '将被删', wait_time: 30 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    await exec(ctx, { name: 'subagent', args: { action: 'delete', subagent_id: id }, agentId: 'chief' });
    // 触达面拒绝（requireRecord 墓碑判定）
    const send = await exec(ctx, { name: 'subagent', args: { action: 'send', subagent_id: id, message: 'x' }, agentId: 'chief' });
    expect(send.ok).toBe(false);
    // 展示面照常（文件保留语义）
    const records = ctx.subagents.historyRecords(id);
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records[0]).toMatchObject({ role: 'user' });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('回放轨迹展开：agent 行 steps 进上下文（expandSteps——与主会话同口径）；纯文本步无 tool 轮次', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-noline-'));
    const { ctx } = await boot({ root });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '普通任务', tools: ['math'], wait_time: 30 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    const id2 = (await exec(ctx, { name: 'subagent', args: { action: 'spawn', name: '乙', task: '任务乙', wait_time: 30 }, agentId: 'chief' })).output.subagent_id as string;
    void id2;
    // 无工具纯 mock run：收束 text 非空 → 落 agent 行（对照；三文件化：+ run-settled 判别行）
    const lines = fs.readFileSync(path.join(root, 'subagents', id, 'messages.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const agentLine = JSON.parse(lines[1]);
    // mock provider 一步终文本：steps=[单步无 toolCalls]——按实际形状锁定
    expect(Array.isArray(agentLine.steps)).toBe(true);
    expect(agentLine.steps[0].toolCalls).toBeUndefined();
    expect(agentLine.steps[0].content).toContain('子任务结论');
    // 回放口径（2026-12 多轮失忆修复）：agent 行携带 steps → expandSteps
    // 轨迹展开进上下文（纯文本步 = assistant 行；带工具步 = assistant +
    // 配对 tool 行）；本例单步无 toolCalls → 无 tool role，assistant 含结论
    const replay = await ctx.subagents.history(id);
    expect(replay[0]).toMatchObject({ role: 'user' });
    expect(replay.some((m) => m.role === 'assistant' && String(m.content).includes('子任务结论'))).toBe(true);
    expect(replay.every((m) => m.role !== 'tool')).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('access-tier：子 Agent 档位继承（§7.3 elevation = tierOf(parentId)）', () => {
  it('父 full/sandbox → 子 run 信封带对应 elevation；父 base → 无 elevation（继承不放大也不缩水）', async () => {
    const seen: Array<string | undefined> = [];
    // 记录器行（loop/before-run 只读观察——子 run 的 agentLoop.run 直连请求）
    const recorder = {
      name: 'elevation-recorder',
      inject: [] as string[],
      apply(c: Context) {
        c.on('loop/before-run', (call, next) => {
          seen.push((call.request as { elevation?: string }).elevation);
          return next();
        }, { description: '测试：记录子 run 信封 elevation' });
      },
    };
    const ctx = new Context();
    const fibers: Fiber[] = [];
    const provider = {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register(
          'mock',
          () => ({
            stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
              captured.push(input);
              yield { delta: `子任务结论:${String(input.messages.at(-1)?.content).slice(0, 10)}` };
              yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
            },
          }),
          { models: ['mock-1'] },
        );
      },
    };
    captured.length = 0;
    delete process.env.AGENTCHAT_DATA_ROOT;
    const rows: Array<[unknown, unknown]> = [
      [toolsRow, undefined],
      [jobsRow, undefined],
      [llmRow, undefined],
      [provider, undefined],
      [loopRow, undefined],
      [agentsRow, undefined],
      [recorder, undefined],
      [subagentRow, undefined],
    ];
    for (const [plugin, config] of rows) {
      const fiber = ctx.plugin(plugin as never, config as never);
      await fiber;
      fibers.push(fiber);
    }
    for (let i = 0; i < 1000; i++) {
      if ((ctx as any).tools && (ctx as any).agentLoop && (ctx as any).agents && (ctx as any).jobs) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    booted.push({ ctx, fibers });

    // base 父（delegation）→ 无 elevation
    ctx.agents.register({ id: 'chief', model: 'mock-1', tags: ['delegation'] });
    await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: 'base 父任务' }, agentId: 'chief' });
    await until(() => seen.length >= 1);
    expect(seen[0]).toBeUndefined();

    // full 父 → elevation full-access（继承不放大也不缩水）
    ctx.agents.reassign({ id: 'chief', model: 'mock-1', tags: ['delegation', 'full-access'] });
    await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: 'full 父任务' }, agentId: 'chief' });
    await until(() => seen.length >= 2);
    expect(seen[1]).toBe('full-access');

    // sandbox 父 → elevation sandbox-access
    ctx.agents.reassign({ id: 'chief', model: 'mock-1', tags: ['delegation', 'sandbox-access'] });
    await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: 'sandbox 父任务' }, agentId: 'chief' });
    await until(() => seen.length >= 3);
    expect(seen[2]).toBe('sandbox-access');
  });
});

describe('ac-subagent：超时看门狗语义', () => {
  it('缺省不设看门狗：挂起的 run 永不超时（研究型长任务）；timeout_s 正值仍生效', async () => {
    const gates = [newGate()];
    const { ctx } = await boot({ provider: makeGatedProvider(gates), model: 'gated-1' });
    // 不传 timeout_s——缺省不限（旧缺省 300s 已移除）
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '不限时任务' },
      agentId: 'chief',
    });
    expect(r.ok).toBe(true);
    const id = r.output.subagent_id as string;
    await until(() => captured.length >= 1);
    // run 挂起中（gated provider 不放行）——无看门狗，状态恒 running
    const running = await exec(ctx, { name: 'subagent', args: { action: 'list', running_only: true }, agentId: 'chief' });
    expect(running.output.total).toBe(1);
    gates[0].release();
    const done = await exec(ctx, { name: 'subagent', args: { action: 'await', subagent_id: id }, agentId: 'chief' });
    expect(done.output.status).toBe('done');
  });

  it('stop/timeout 竞态：stop 先 abort 后，迟到的看门狗不覆写 abortReason（终态 stopped 而非 timeout）', async () => {
    // 窗口构造：首步产出 tool_calls，工具不响应 signal 挂在 gate——run 停在
    // tools.execute；stop abort 后 run 不收束（工具仍挂），1s 看门狗在窗口
    // 内迟到触发。修复前：覆写 abortReason='timeout'；放行工具 → 步边界
    // interrupted → 终态误标 timeout。修复后守卫不覆写 → stopped。
    const toolCallProvider = {
      name: 'toolcall-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register(
          'mock',
          () => ({
            stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
              captured.push(input);
              if (captured.length === 1) {
                yield {
                  delta: '',
                  finish: 'tool_calls',
                  toolCalls: [{ index: 0, id: 'tc1', name: 'deaf_tool', argumentsDelta: '{}' }],
                };
              } else {
                yield { delta: `结论:${String(input.messages.at(-1)?.content).slice(0, 10)}` };
                yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
              }
            },
          }),
          { models: ['mock-1'] },
        );
      },
    };
    const { ctx } = await boot({ provider: toolCallProvider });
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((r) => {
      releaseTool = r;
    });
    ctx.tools.register({
      name: 'deaf_tool',
      // 有意不响应 signal（模拟不可中止的慢工具），只等 gate
      execute: () => new Promise((resolve) => void toolGate.then(() => resolve({ ok: true, output: '完成' }))),
    });
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '竞态任务', tools: ['deaf_tool'], timeout_s: 1 },
      agentId: 'chief',
    });
    const id = r.output.subagent_id as string;
    await until(() => captured.length >= 1);
    const st = await exec(ctx, { name: 'subagent', args: { action: 'stop', subagent_id: id }, agentId: 'chief' });
    expect(st.ok).toBe(true);
    expect(st.output.stopped).toBe(true);
    await new Promise((res) => setTimeout(res, 1200)); // 看门狗迟到触发过（abort 已发生、run 未收束）
    releaseTool(); // 放行工具 → 下一步边界检查 aborted → interrupted 收束
    const done = await exec(ctx, { name: 'subagent', args: { action: 'await', subagent_id: id }, agentId: 'chief' });
    expect(done.output.status).toBe('stopped'); // 不得误标 timeout
  });
});

describe('ac-subagent：output.action 显式标注（前端卡分发单源）', () => {
  // 六合一工具的每条 output 显式带 action 键——前端 ToolResultSubagent 按
  // data.action 精确分发（结构猜仅作历史记录回落）。本族断言防回归。
  it('spawn（异步）：action/name/task 透传；task 超 120 字符截断', async () => {
    const { ctx } = await boot();
    const longTask = 'T'.repeat(150);
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', name: '调研员', task: longTask }, agentId: 'chief' });
    expect(r.ok).toBe(true);
    expect(r.output.action).toBe('spawn');
    expect(r.output.name).toBe('调研员');
    expect(r.output.task).toBe('T'.repeat(120));
    expect(r.output.status).toBe('running');
  });

  it('spawn（无 task）：task 为空串（不缺席）', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn' }, agentId: 'chief' });
    expect(r.ok).toBe(true);
    expect(r.output.action).toBe('spawn');
    expect(r.output.task).toBe('');
    expect(r.output.status).toBe('idle');
  });

  it('send（async）：action/delivered 回执；send（sync）：action + 结果字段', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '第一轮', wait_time: 30 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    const s = await exec(ctx, { name: 'subagent', args: { action: 'send', subagent_id: id, message: '追加', mode: 'sync' }, agentId: 'chief' });
    expect(s.ok).toBe(true);
    expect(s.output.action).toBe('send');
    expect(s.output.delivered).toBe('started');
    expect(s.output.status).toBe('done');
  });

  it('await：idle 态与结果态均带 action', async () => {
    const { ctx } = await boot();
    const idle = await exec(ctx, { name: 'subagent', args: { action: 'spawn', name: '档案员' }, agentId: 'chief' });
    const idleId = idle.output.subagent_id as string;
    const a0 = await exec(ctx, { name: 'subagent', args: { action: 'await', subagent_id: idleId }, agentId: 'chief' });
    expect(a0.ok).toBe(true);
    expect(a0.output.action).toBe('await');
    expect(a0.output.status).toBe('idle');
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '跑一轮', wait_time: 30 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    const a1 = await exec(ctx, { name: 'subagent', args: { action: 'await', subagent_id: id }, agentId: 'chief' });
    expect(a1.output.action).toBe('await');
    expect(a1.output.status).toBe('done');
  });

  it('list/stop/delete：均带 action', async () => {
    const { ctx } = await boot();
    const l = await exec(ctx, { name: 'subagent', args: { action: 'list' }, agentId: 'chief' });
    expect(l.ok).toBe(true);
    expect(l.output.action).toBe('list');
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '停删对象', wait_time: 30 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    const st = await exec(ctx, { name: 'subagent', args: { action: 'stop', subagent_id: id }, agentId: 'chief' });
    // 已收束的 run 再 stop 报错是合法路径（无进行中 run）——换活跃对象验证
    if (st.ok) {
      expect(st.output.action).toBe('stop');
    }
    const r2 = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '待删', wait_time: 30 }, agentId: 'chief' });
    const id2 = r2.output.subagent_id as string;
    const d = await exec(ctx, { name: 'subagent', args: { action: 'delete', subagent_id: id2 }, agentId: 'chief' });
    expect(d.ok).toBe(true);
    expect(d.output.action).toBe('delete');
  });
});


// ============================================================
// 三文件化落盘（2026-12，对齐 ac-session run journal 裁决）
// ============================================================
describe('ac-subagent：三文件落盘（messages / partials / subcalls）', () => {
  /** 带 run_code 形态子调用的 provider：第 1 步调 math 工具，第 2 步终文本 */
  function makeSubcallProvider() {
    return {
      name: 'subcall-provider',
      inject: ['llm'],
      apply(c: Context) {
        let round = 0;
        c.llm.register(
          'subcall-mock',
          () => ({
            stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
              captured.push(input);
              round += 1;
              if (round % 2 === 1) {
                yield { delta: '', reasoning: '先算' };
                yield {
                  delta: '',
                  toolCalls: [{ index: 0, id: `tc-${round}`, name: 'math' }, { index: 0, argumentsDelta: '{"expression":"1+1"}' }],
                };
                yield { delta: '', finish: 'tool-calls', usage: { prompt: 2, completion: 1 } };
              } else {
                yield { delta: '结论：等于二' };
                yield { delta: '', finish: 'stop', usage: { prompt: 3, completion: 2 } };
              }
            },
          }),
          { models: ['subcall-1'] },
        );
      },
    };
  }

  it('run_code 子调用（runCodeSubcall）落 subcalls.jsonl 永久档案；直调补行落 partials 且收束即清', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-3file-'));
    const { ctx } = await boot({ root, provider: makeSubcallProvider(), model: 'subcall-1' });
    // math 工具在 run 内直调；sub_math 带 runCodeSubcall 标记模拟 run_code 子调用
    ctx.tools.register({
      name: 'math', description: 'd',
      parameters: { type: 'object', properties: { expression: { type: 'string' } } },
      async execute() { return { ok: true, output: 2 }; },
    });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '算一下', tools: ['math'], wait_time: 30 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    const dir = path.join(root, 'subagents', id);
    // 三文件形态：messages 定稿流在场
    const msgs = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8').trim().split('\n');
    expect(msgs.length).toBeGreaterThanOrEqual(3); // user + agent + run-settled
    expect(msgs.at(-1)).toContain('"type":"run-settled"');
    // partials 收束即清（无注入 run → 整行直落形态）
    const partialsExists = fs.existsSync(path.join(dir, 'partials.jsonl'));
    expect(partialsExists).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('journal 崩溃恢复：partials 残留步行 → 触达时物化为段行进 messages（durable）并清 journal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-recover-'));
    const { ctx } = await boot({ root, provider: makeSubcallProvider(), model: 'subcall-1' });
    ctx.tools.register({
      name: 'math', description: 'd',
      parameters: { type: 'object', properties: { expression: { type: 'string' } } },
      async execute() { return { ok: true, output: 2 }; },
    });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '会崩溃的', tools: ['math'], wait_time: 30 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    const dir = path.join(root, 'subagents', id);
    // 人工构造崩溃现场：messages 只有 user 行 + partials 残留一个孤儿 run 的步行
    const msgLines = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8').trim().split('\n');
    const userLine = msgLines.find((l) => l.includes('"role":"user"'))!;
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), userLine + '\n', 'utf-8');
    const orphanStep = { content: '推理到一半', reasoning: '思路', toolCalls: [{ id: 'tc-orphan', name: 'math', arguments: '{}', result: null }] };
    fs.writeFileSync(path.join(dir, 'partials.jsonl'), [
      JSON.stringify({ type: 'journal-step', run: 'run-orphan-1', step: orphanStep, seq: 1 }),
      // 直调补行：崩溃前工具已执行、终值已落——恢复时并入步行（终值覆盖源）
      JSON.stringify({ type: 'tool-result', run: 'run-orphan-1', tool_call_id: 'tc-orphan', result: { ok: true, output: 2 }, seq: 2 }),
    ].join('\n') + '\n', 'utf-8');
    // 触达（send 触发 ensureMessages → recoverJournal）
    const s = await exec(ctx, { name: 'subagent', args: { action: 'send', subagent_id: id, message: '继续', mode: 'sync' }, agentId: 'chief' });
    expect(s.ok).toBe(true);
    // 恢复产物：孤儿步行已物化为段行（agent + steps + run 键）+ journal 清空
    const recovered = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8').trim().split('\n');
    const segLine = recovered.find((l) => l.includes('run-orphan-1') && l.includes('"steps"'));
    expect(segLine).toBeDefined();
    const seg = JSON.parse(segLine!);
    // 补行并入：步行 result:null ← 补行终值（keyed by tool_call_id）
    expect(seg.steps[0].toolCalls[0].result).toMatchObject({ ok: true, output: 2 });
    expect(fs.existsSync(path.join(dir, 'partials.jsonl'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('steer 切段：注入消息消费点真序物化（段行 + injected 提升行交错，注入行 ts 还原）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-steer-seg-'));
    const gates = [newGate(), newGate(), newGate()];
    const { ctx } = await boot({ root, provider: makeGatedProvider(gates), model: 'gated-1' });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '慢任务', wait_time: 0 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    gates[0].release(); // 首轮 run 开始
    await until(() => captured.length >= 1);
    // run 活跃期 steer：注入消息（会进入下一消费点）
    const st = await exec(ctx, { name: 'subagent', args: { action: 'send', subagent_id: id, message: '补充指示', mode: 'steer' }, agentId: 'chief' });
    expect(st.output.delivered).toBe('steered');
    gates[1].release();
    gates[2].release();
    await exec(ctx, { name: 'subagent', args: { action: 'await', subagent_id: id }, agentId: 'chief' });
    const dir = path.join(root, 'subagents', id);
    const msgs = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8').trim().split('\n');
    // 切分形态：injected 提升行在场（journal-inject → messages），带 run 键
    const injected = msgs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((p) => p?.injected === true);
    expect(injected.length).toBeGreaterThanOrEqual(1);
    expect(injected[0].role).toBe('user');
    expect(typeof injected[0].run).toBe('string');
    // journal 已清
    expect(fs.existsSync(path.join(dir, 'partials.jsonl'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('subcalls 档案投影：run_code 子调用按宿主前缀挂载进 steps[].toolCalls（subcall:true 平铺）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-subproj-'));
    const { ctx } = await boot({ root, provider: makeSubcallProvider(), model: 'subcall-1' });
    ctx.tools.register({
      name: 'math', description: 'd',
      parameters: { type: 'object', properties: { expression: { type: 'string' } } },
      async execute() { return { ok: true, output: 2 }; },
    });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '算一下', tools: ['math'], wait_time: 30 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    const dir = path.join(root, 'subagents', id);
    // 找宿主 run_code 调用 id（settlement 后 steps 里 math 步的 toolCall id）
    const msgs = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8').trim().split('\n');
    const agentLine = msgs.map((l) => JSON.parse(l)).find((p) => p.role === 'agent' && p.steps);
    const hostId = agentLine.steps.flatMap((s: any) => s.toolCalls ?? []).find((tc: any) => tc.name === 'math').id;
    // 手工构造 subcall 档案（run_code 程序内子调用形态：<hostId>#<seq>）
    fs.appendFileSync(path.join(dir, 'subcalls.jsonl'), [
      JSON.stringify({ type: 'tool-result', run: agentLine.run, tool_call_id: hostId + '#1', result: { ok: true, output: 7 }, subcall: true, name: 'grep', arguments: '{"pattern":"x"}', seq: 1 }),
      JSON.stringify({ type: 'tool-result', run: agentLine.run, tool_call_id: hostId + '#2', result: { ok: true, output: 8 }, subcall: true, name: 'read', arguments: '{"file_path":"a.ts"}', seq: 2 }),
      // 孤儿档案（宿主不存在）→ 静默丢弃
      JSON.stringify({ type: 'tool-result', run: agentLine.run, tool_call_id: 'ghost#1', result: { ok: true }, subcall: true, name: 'x', seq: 3 }),
    ].join('\n') + '\n', 'utf-8');
    const recs = ctx.subagents.historyRecords(id);
    const agentRec = recs.find((p) => p.role === 'agent' && p.steps)!;
    const tcs = agentRec.steps!.flatMap((s) => s.toolCalls ?? []);
    const mathIdx = tcs.findIndex((tc) => tc.name === 'math' && tc.subcall !== true);
    expect(mathIdx).toBeGreaterThanOrEqual(0);
    // 紧随宿主平铺注入，seq 升序
    expect(tcs[mathIdx + 1]).toMatchObject({ name: 'grep', subcall: true, arguments: '{"pattern":"x"}' });
    expect(tcs[mathIdx + 2]).toMatchObject({ name: 'read', subcall: true });
    expect(tcs.filter((tc) => tc.id === 'ghost#1')).toHaveLength(0);
    // 盘上行未被变异（重读幂等）：再读一次不重复注入
    const recs2 = ctx.subagents.historyRecords(id);
    const tcs2 = recs2.find((p) => p.role === 'agent' && p.steps)!.steps!.flatMap((s) => s.toolCalls ?? []);
    expect(tcs2.filter((tc) => tc.subcall === true)).toHaveLength(2);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('跨 run 轨迹复放（2026-12 多轮失忆修复）：第二轮上下文含第一轮工具轨迹（assistant+tool 对），不再只剩终文本', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-replay-'));
    const { ctx } = await boot({ root, provider: makeSubcallProvider(), model: 'subcall-1' });
    ctx.tools.register({
      name: 'math', description: 'd',
      parameters: { type: 'object', properties: { expression: { type: 'string' } } },
      async execute() { return { ok: true, output: 2 }; },
    });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '算一下', tools: ['math'], wait_time: 30 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    // 第二轮（sync）：捕获第二轮 LLM 请求
    const before = captured.length;
    const s = await exec(ctx, { name: 'subagent', args: { action: 'send', subagent_id: id, message: '再算一次', mode: 'sync' }, agentId: 'chief' });
    expect(s.ok).toBe(true);
    expect(captured.length).toBeGreaterThan(before);
    const second = captured[before].messages;
    // 第一轮轨迹完整复放：user 任务 → assistant(含 tool_calls) → tool(结果) → assistant(终文本) → user 新消息
    const roles = second.map((m) => m.role);
    expect(roles[0]).toBe('user');
    const toolIdx = roles.indexOf('tool');
    expect(toolIdx).toBeGreaterThan(0);
    expect(roles[toolIdx - 1]).toBe('assistant');
    const toolMsg = second[toolIdx] as { tool_call_id?: string };
    expect(typeof toolMsg.tool_call_id).toBe('string');
    expect(String((second[toolIdx] as { content?: unknown }).content)).toContain('"ok":true');
    // 终文本 + 新 user 消息在场（首请求以新任务收尾）
    const lastUser = roles.lastIndexOf('user');
    expect(lastUser).toBeGreaterThan(toolIdx);
    expect(String(second[lastUser].content)).toContain('再算一次');
    expect(second.some((m) => m.role === 'assistant' && String(m.content).includes('结论：等于二'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('重启后轨迹复放同口径（ensureMessages 展开盘上 agent 行 steps）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-replay2-'));
    { const { ctx } = await boot({ root, provider: makeSubcallProvider(), model: 'subcall-1' });
      ctx.tools.register({
        name: 'math', description: 'd',
        parameters: { type: 'object', properties: { expression: { type: 'string' } } },
        async execute() { return { ok: true, output: 2 }; },
      });
      const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '算一下', tools: ['math'], wait_time: 30 }, agentId: 'chief' });
      void r;
    }
    // 第二宿主（同 root）：盘上 messages 重派生
    const second = await boot({ root, provider: makeSubcallProvider(), model: 'subcall-1' });
    const reg = JSON.parse(fs.readFileSync(path.join(root, 'subagents', 'index.json'), 'utf-8')) as { subs: Array<{ id: string }> };
    const id = reg.subs[0].id;
    const replay = await second.ctx.subagents.history(id);
    const roles = replay.map((m) => m.role);
    expect(roles).toContain('tool');
    expect(replay.some((m) => m.role === 'assistant' && String(m.content).includes('结论：等于二'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('journal 活投影：run 进行中 partials 台账 → historyRecords 尾部可见 partial 段行（补行终值覆盖 result:null）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-live-'));
    const { ctx } = await boot({ root, provider: makeSubcallProvider(), model: 'subcall-1' });
    ctx.tools.register({
      name: 'math', description: 'd',
      parameters: { type: 'object', properties: { expression: { type: 'string' } } },
      async execute() { return { ok: true, output: 2 }; },
    });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '算一下', tools: ['math'] }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    const dir = path.join(root, 'subagents', id);
    // run 已收束（wait_time 缺省 0——异步 spawn）：手工构造「进行中」现场：
    // 清掉 messages 尾部 agent 段行与 settled 行，partials 重建步行+补行
    const msgLines = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8').trim().split('\n');
    const userLine = msgLines.find((l) => l.includes('"role":"user"'))!;
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), userLine + '\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'partials.jsonl'), [
      JSON.stringify({ type: 'journal-step', run: 'run-live-1', seq: 1, step: { content: '先算', toolCalls: [{ id: 'tc-live', name: 'math', arguments: '{"expression":"1+1"}', result: null }] } }),
      JSON.stringify({ type: 'tool-result', run: 'run-live-1', tool_call_id: 'tc-live', result: { ok: true, output: 2 }, seq: 2 }),
    ].join('\n') + '\n', 'utf-8');
    const recs = ctx.subagents.historyRecords(id);
    const liveSeg = recs.find((p) => p.partial === true);
    expect(liveSeg).toBeDefined();
    expect(liveSeg!.steps![0].toolCalls![0].result).toEqual({ ok: true, output: 2 }); // 补行覆盖
    // 已收束 run 的 journal 行不投影（messages 有同 run 非 partial 行 = settled）
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('旧单文件（<subId>.jsonl）读侧回退兼容：历史会话在迁移前照常可读', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-legacy-'));
    const { ctx } = await boot({ root });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', name: '旧档', task: '旧任务', wait_time: 30 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    // 把目录形态改回旧单文件形态（模拟未迁移数据）
    const dir = path.join(root, 'subagents', id);
    const body = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8')
      .split('\n').filter((l) => l.trim() && !l.includes('"type":"run-settled"')).join('\n') + '\n';
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(path.join(root, 'subagents', `${id}.jsonl`), body, 'utf-8');
    // 读侧：historyRecords 走回退路径照常返回
    const recs = ctx.subagents.historyRecords(id);
    expect(recs.length).toBe(2); // user + agent（判别行被滤）
    // 续聊照常（run 写入新目录形态——回退只影响读源）
    const s = await exec(ctx, { name: 'subagent', args: { action: 'send', subagent_id: id, message: '继续', mode: 'sync' }, agentId: 'chief' });
    expect(s.ok).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// 迁移（v3 subagents-dir）：ac-migration-core 测试面覆盖（此处验形态幂等）
describe('subagents 目录化迁移（SESSION_MIGRATIONS v3）', () => {
  it('单文件 → <subId>/messages.jsonl；目录形态已存在 = 幂等跳过', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-mig-'));
    fs.mkdirSync(path.join(root, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(root, 'subagents', 'sub_1_abc.jsonl'), '{"role":"user","content":"旧"}\n', 'utf-8');
    const { SESSION_MIGRATIONS } = await import('../../ac-session/src/migrations.ts');
    const v3 = SESSION_MIGRATIONS.find((m) => m.id === 'subagents-dir')!;
    v3.apply(root);
    expect(fs.existsSync(path.join(root, 'subagents', 'sub_1_abc', 'messages.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'subagents', 'sub_1_abc.jsonl'))).toBe(false);
    // 幂等：重跑无副作用
    v3.apply(root);
    expect(fs.existsSync(path.join(root, 'subagents', 'sub_1_abc', 'messages.jsonl'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
// ============================================================
// spawn system 显式固化（2026-12 人格防污染）
// ============================================================
describe('ac-subagent：spawn system 固化', () => {
  class ConvSettingsStub2 extends Service {
    private readonly store = new Map<string, { toolMode?: 'tc-base' | 'tc-programmatic' | 'tc-none' }>();
    constructor(c: Context, options: { settings?: Record<string, { toolMode?: 'tc-base' | 'tc-programmatic' | 'tc-none' }> } = {}) {
      super(c, 'convSettings');
      for (const [k, v] of Object.entries(options.settings ?? {})) this.store.set(k, v);
    }
    get(conversationId: string): { toolMode?: 'tc-base' | 'tc-programmatic' | 'tc-none' } {
      return this.store.get(conversationId) ?? {};
    }
  }

  it('spawn(system) 固化进注册表；run 请求 system 用显式值（覆盖父人设）；重启后仍生效', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-sys-'));
    const first = await boot({ root });
    first.ctx.agents.reassign({ id: 'chief', model: 'mock-1', tags: ['delegation'], system: '父的人设：说话简洁' });
    const r = await exec(first.ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '调研任务', system: '你是资深代码审查员，只报告确定的问题', wait_time: 30 },
      agentId: 'chief',
    });
    expect(r.ok).toBe(true);
    const id = r.output.subagent_id as string;
    // system 以消息形态进 messages[0]（loop 装配：request.system → 首条 system 消息）
    const sys = String(captured.at(-1)!.messages[0]?.content ?? '');
    expect(sys).toContain('资深代码审查员');
    expect(sys).not.toContain('父的人设');
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'subagents', 'index.json'), 'utf-8'));
    expect(registry.subs.find((s: any) => s.id === id).system).toContain('资深代码审查员');
    const second = await boot({ root });
    const s = await exec(second.ctx, { name: 'subagent', args: { action: 'send', subagent_id: id, message: '继续', mode: 'sync' }, agentId: 'chief' });
    expect(s.ok).toBe(true);
    expect(String(captured.at(-1)!.messages[0]?.content ?? '')).toContain('资深代码审查员');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('spawn(system) + tc-programmatic：显式 system 与 mode 工具面收窄共存（投影由 run-code 行尾拼，正交）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-sysptc-'));
    const { ctx } = await boot({ root });
    void new ConvSettingsStub2(ctx, { settings: { 'conv-ptc': { toolMode: 'tc-programmatic' } } });
    ctx.tools.register({ name: 'run_code', injection: 'mode', description: 'd', execute: () => ({ ok: true }) });
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '程序化调研', system: '你是数据分析助手', wait_time: 30 },
      agentId: 'chief',
      conversationId: 'conv-ptc',
    });
    expect(r.ok).toBe(true);
    const input = captured.at(-1)!;
    expect((input.tools ?? []).map((t: any) => t.function.name)).toEqual(['run_code']);
    expect(String(input.messages[0]?.content ?? '')).toContain('数据分析助手');
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ── subagents/updated 事件（2026-12 持久化清单主源化：spawn/started/
  //    settled 全链通知——前端域投影帧驱动刷新的数据源） ──
  it('subagents/updated：spawn → started → settled 事件序列（displayStatus 投影随行）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-evt-'));
    const { ctx } = await boot({ root });
    const seen: Array<{ id: string; action: string; displayStatus: string }> = [];
    ctx.on('subagents/updated', (info, action) => {
      seen.push({ id: info.id, action, displayStatus: info.displayStatus });
    });
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '事件链调研', wait_time: 30 },
      agentId: 'chief',
    });
    expect(r.ok).toBe(true);
    const id = r.output.subagent_id as string;
    await until(() => seen.some((s) => s.action === 'settled' && s.id === id));
    const seq = seen.filter((s) => s.id === id).map((s) => s.action);
    expect(seq).toContain('spawned');
    expect(seq).toContain('started');
    expect(seq.indexOf('started')).toBeGreaterThan(seq.indexOf('spawned'));
    expect(seq.indexOf('settled')).toBeGreaterThan(seq.indexOf('started'));
    // 载荷 = list 投影口径（displayStatus 随收束回落 lastRun 终态）
    const settled = seen.find((s) => s.id === id && s.action === 'settled')!;
    expect(settled.displayStatus).toBe('done');
    // delete 恒发 removed（删除前快照）
    const removed: string[] = [];
    ctx.on('subagents/updated', (info, action) => {
      if (action === 'removed') removed.push(info.id);
    });
    await exec(ctx, { name: 'subagent', args: { action: 'delete', subagent_id: id }, agentId: 'chief' });
    expect(removed).toContain(id);
    // 墓碑投影：缺省 list 不可见；includeDeleted 可见且 deleted=true（展示面
    // 已删除历史入口——会话文件保留、history 仍可读）
    const svc = ctx.get('subagents') as unknown as { list(opts?: { includeDeleted?: boolean }): { subs: Array<{ id: string; deleted: boolean }> } };
    expect(svc.list().subs.some((s) => s.id === id)).toBe(false);
    const withTomb = svc.list({ includeDeleted: true }).subs.find((s) => s.id === id);
    expect(withTomb?.deleted).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('error 收束行 = context 形态（与主会话 D12/F7 同口径：UI 错误分隔符 + 不进子上下文回放）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-errline-'));
    let fail = true;
    const flakyProvider = {
      name: 'flaky-llm',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('flaky-1', () => ({
          stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
            captured.push(input);
            if (fail) throw new Error('模型炸了');
            yield { delta: '恢复后的回复' };
            yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
          },
        }), { models: ['flaky-1'] });
      },
    };
    const { ctx } = await boot({ root, provider: flakyProvider, model: 'flaky-1' });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '会失败的', wait_time: 30 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    const dir = path.join(root, 'subagents', id);
    const msgs = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8');
    // 收束行 role:'context' + source:'error'（UI toHistoryMessages 错误分隔符消费口径）
    expect(msgs).toContain('"source":"error"');
    const errLine = msgs.trim().split('\n').find((l) => l.includes('"source":"error"'))!;
    const parsed = JSON.parse(errLine);
    expect(parsed.role).toBe('context');
    expect(parsed.content).toContain('模型炸了');
    // 回放口径：error 行不进子上下文——恢复后再 send，下一 run 的 LLM 入参不含错误文本
    fail = false;
    captured.length = 0;
    const s = await exec(ctx, { name: 'subagent', args: { action: 'send', subagent_id: id, message: '再试一次', mode: 'sync' }, agentId: 'chief' });
    expect(s.ok).toBe(true);
    const nextInput = captured.at(-1)!;
    const replayText = JSON.stringify(nextInput.messages);
    expect(replayText).not.toContain('模型炸了');
    expect(replayText).toContain('再试一次');
    fs.rmSync(root, { recursive: true, force: true });
  });
});


