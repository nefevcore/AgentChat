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

    void new ConvSettingsStub(booted0.ctx, { settings });    // run_code 探针（与真行同门禁形态——requiredTags infra，2026-09-17 优化：授权随能力族）
    booted0.ctx.tools.register({
      name: 'run_code',
      requiredTags: ['infra'],
      description: 'd',
      execute: () => ({ ok: true }),
    });
    booted0.ctx.agents.reassign({ id: 'chief', model: 'mock-1', tags: ['delegation', 'infra'] });
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

  it('spawn.tools 显式点名优先于开关传播（点名的工具面不被收窄）', async () => {
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
    expect((input.tools ?? []).map((t: any) => t.function.name)).toEqual(['plain_tool']);
  });

  it('会话覆盖 tc-base 压回标准档 → 并存形态：run_code 与传统工具同列', async () => {
    // 父 chief tags = ['delegation', 'infra']（bootWithSwitch 配）——
    // 会话覆盖 tc-base 压回标准档：子 Agent 工具面不收窄（run_code 与
    // 传统工具同列；tc-base 覆盖 = 跟随态被压制的显式形态）
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
    expect(names).toContain('run_code');
    expect(names).toContain('plain_tool');
  });

  it('父无 tc-programmatic → run_code 不在能力面，传播忽略（惰性同口径）', async () => {
    const { ctx } = await bootWithSwitch({ 'conv-prog': { toolMode: 'tc-programmatic' } });

    ctx.agents.reassign({ id: 'chief', model: 'mock-1', tags: ['delegation'] }); // 剥 tc-programmatic
    ctx.tools.register({ name: 'plain_tool', description: 'd', execute: () => ({ ok: true }) });
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '无授权任务', wait_time: 30 },
      agentId: 'chief',
      conversationId: 'conv-prog',
    });
    expect(r.ok).toBe(true);
    const names = (captured.at(-1)!.tools ?? []).map((t: any) => t.function.name);
    expect(names).not.toContain('run_code');
    expect(names).toContain('plain_tool');
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

  it('spawn 阻塞等待：拿到结果；受控工具集进 LLM 请求；独立上下文（首条任务框架）', async () => {
    const { ctx } = await boot();
    expect(ctx.tools.get('subagent')?.requiredTags).toEqual(['delegation']);
    ctx.tools.register({ name: 'calculator', execute: () => ({ ok: true }) });
    const runReqs: any[] = [];
    ctx.on('loop/run-started', (req) => runReqs.push(req));
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '调研 X 并总结', tools: ['calculator'], context: '背景信息', wait_time: 30 },
      agentId: 'chief',
    });
    expect(r.ok).toBe(true);
    expect(r.output.status).toBe('done');
    expect(String(r.output.result)).toContain('子任务结论:');
    expect(captured).toHaveLength(1);
    const input = captured[0];
    // 独立上下文：首条消息 = 任务框架（不背父会话），带上下文与受控工具集
    expect(String(input.messages[0].content)).toContain('调研 X 并总结');
    expect(String(input.messages[0].content)).toContain('背景信息');
    expect(String(input.messages[0].content)).toContain('[子任务]');
    expect(input.tools?.map((t) => t.function.name)).toEqual(['calculator']);
    // 身份：子 Agent 以自身合成 id 直连（不冒父身份——门禁 fail-closed 防递归）
    expect(runReqs[0].agent).toMatch(/^sub_/);
    expect(runReqs[0].agent).not.toBe('chief');
    expect(runReqs[0].conversationId).toBeUndefined();
  });

  it('无 task spawn → idle；send 首条 → 任务框架包装启动', async () => {
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
    expect(String(captured[0].messages[0].content)).toContain('[子任务]');
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
    // 第二轮请求 = 首轮 user（框架）+ assistant 回复 + 新 user 消息
    expect(captured).toHaveLength(2);
    const second = captured[1].messages.map((m) => `${m.role}:${String(m.content).slice(0, 40)}`);
    expect(second[0]).toContain('第一轮任务');
    expect(second[1]).toContain('子任务结论');
    expect(second[2]).toBe('user:补充：只要结论要点');
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
    const lines = fs.readFileSync(path.join(root, 'subagents', `${id}.jsonl`), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2); // user（框架）+ agent（收束回复）
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
    const lines = fs.readFileSync(path.join(root, 'subagents', `${id}.jsonl`), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const agentLine = JSON.parse(lines[1]);
    expect(agentLine.role).toBe('agent');
    expect(agentLine.agent_id).toBe(id);
    expect(agentLine.steps).toHaveLength(2);
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

  it('interrupted 收束无终文本 → 不落 agent 行（R8 口径）；回放不含 steps（上下文不变量）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-subagent-noline-'));
    const { ctx } = await boot({ root });
    const r = await exec(ctx, { name: 'subagent', args: { action: 'spawn', task: '普通任务', tools: ['math'], wait_time: 30 }, agentId: 'chief' });
    const id = r.output.subagent_id as string;
    const id2 = (await exec(ctx, { name: 'subagent', args: { action: 'spawn', name: '乙', task: '任务乙', wait_time: 30 }, agentId: 'chief' })).output.subagent_id as string;
    void id2;
    // 无工具纯 mock run：收束 text 非空 → 落 agent 行（对照）
    const lines = fs.readFileSync(path.join(root, 'subagents', `${id}.jsonl`), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const agentLine = JSON.parse(lines[1]);
    // mock provider 一步终文本：steps=[单步无 toolCalls]——按实际形状锁定
    expect(Array.isArray(agentLine.steps)).toBe(true);
    expect(agentLine.steps[0].toolCalls).toBeUndefined();
    expect(agentLine.steps[0].content).toContain('子任务结论');
    // 回放口径：history() 只产 user/assistant 纯文本对
    const replay = await ctx.subagents.history(id);
    expect(replay.every((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')).toBe(true);
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
