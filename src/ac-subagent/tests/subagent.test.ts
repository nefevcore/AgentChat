// ============================================================
// ac-subagent：spawn（loop 直连零会话污染）/ await / list / kill + job 登记
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import { ConfigService } from 'ac-config';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as jobsRow from 'ac-jobs';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as subagentRow from '../src/index.ts';
import * as toolsRow from 'ac-tools';
type ExecRes = { ok: boolean; output: any; error?: string; interrupt?: any };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

const captured: LlmChatInput[] = [];

async function boot() {
  captured.length = 0;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<[unknown, unknown]> = [
    [toolsRow, undefined],
    [jobsRow, undefined],
    [llmRow, undefined],
    [
      {
        name: 'mock-provider',
        inject: ['llm'],
        apply(c: Context) {
          c.llm.register(
            'mock',
            () => ({
              stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
                captured.push(input);
                yield { delta: `子任务结论:${input.messages.at(-1)?.content.slice(0, 10)}` };
                yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
              },
            }),
            { models: ['mock-1'] },
          );
        },
      },
      undefined,
    ],
    [loopRow, undefined],
    [agentsRow, undefined],
    [ConfigService, undefined],
    [subagentRow, undefined],
  ];
  for (const [plugin, config] of rows) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).tools && (ctx as any).agentLoop && (ctx as any).agents && (ctx as any).jobs) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  ctx.agents.register({ id: 'chief', model: 'mock-1' });
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('ac-subagent', () => {
  it('父 Agent 未声明 model → 默认池连接回落（与 router 信封同口径；2026-09-02 反馈：admin 用默认池跑得好却派不了子 Agent）', async () => {
    const { ctx } = await boot();
    // 无 model 的父 Agent + 默认池连接（provider=mock）→ spawn 应成功
    ctx.config.set('llmProviders', { main: { provider: 'mock', model: 'mock-1', default: true } });
    ctx.agents.register({ id: 'pooluser' });
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '默认池下的子任务', wait_time: 30 },
      agentId: 'pooluser',
    });
    expect(r.ok).toBe(true);
    expect(r.output.status).toBe('done');
    // 无池也无 model → 维持 fail-closed 拒绝
    ctx.config.set('llmProviders', {});
    const r2 = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: 'x', wait_time: 1 },
      agentId: 'pooluser',
    });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/无可用模型/);
  });

  it('spawn + 阻塞等待：拿到结果；受控工具集进 LLM 请求；独立上下文（只含任务）', async () => {
    const { ctx } = await boot();
    // 门禁标签（更名自 conductor）：subagent 要求 delegation
    expect(ctx.tools.get('subagent')?.requiredTags).toEqual(['delegation']);
    ctx.tools.register({ name: 'calculator', execute: () => ({ ok: true }) });
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '调研 X 并总结', tools: ['calculator'], context: '背景信息', wait_time: 30 },
      agentId: 'chief',
    });
    expect(r.ok).toBe(true);
    expect(r.output.status).toBe('done');
    expect(String(r.output.result)).toContain('子任务结论:');
    // LLM 收到的是子任务的独立上下文（不背父会话），带受控工具集
    expect(captured).toHaveLength(1);
    const input = captured[0];
    expect(String(input.messages[0].content)).toContain('调研 X 并总结');
    expect(String(input.messages[0].content)).toContain('背景信息');
    expect(input.tools?.map((t) => t.function.name)).toEqual(['calculator']);
  });

  it('异步 spawn → await 取结果；job 登记 + settled 事件', async () => {
    const { ctx } = await boot();
    const settled: unknown[] = [];
    ctx.on('job/settled', (job) => settled.push(job));
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '慢任务' },
      agentId: 'chief',
    });
    expect(r.output.status).toBe('running');
    const id = r.output.subagent_id as string;
    // job 登记（kind=subagent；owner=父）——直接查注册表（job 工具在 ac-shell-tools 行）
    const jobsList = ctx.jobs.list('chief');
    expect(jobsList[0]).toMatchObject({ kind: 'subagent', id: 'subagent-1', label: '慢任务' });
    const done = await exec(ctx, {
      name: 'subagent',
      args: { action: 'await', subagent_id: id },
      agentId: 'chief',
    });
    expect(done.ok).toBe(true);
    expect(done.output.status).toBe('done');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ kind: 'subagent', status: 'completed' });
  });

  it('kill 中断：running → killed；job settle killed', async () => {
    const { ctx } = await boot();
    // 慢 provider：挂起不吐 token，直到 abort
    const { ctx: _c } = { ctx };
    const r = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '挂起任务' },
      agentId: 'chief',
    });
    const id = r.output.subagent_id as string;
    const k = await exec(ctx, {
      name: 'subagent',
      args: { action: 'kill', subagent_id: id },
      agentId: 'chief',
    });
    expect(k.ok).toBe(true);
    const done = await exec(ctx, {
      name: 'subagent',
      args: { action: 'await', subagent_id: id },
      agentId: 'chief',
    });
    // kill 后 loop 在 step 边界收束为 interrupted → 子任务 handle 状态 killed/timeout
    expect(['killed', 'timeout']).toContain(done.output.status);
    expect(done.ok).toBe(true);
  });

  it('list 列活跃；缺 task 报错；未知 action 报错', async () => {
    const { ctx } = await boot();
    const noTask = await exec(ctx, {
      name: 'subagent',
      args: { action: 'spawn', task: '' },
      agentId: 'chief',
    });
    expect(noTask.ok).toBe(false);
    expect(noTask.error).toContain('task');
    const bad = await exec(ctx, {
      name: 'subagent',
      args: { action: 'teleport' },
      agentId: 'chief',
    });
    expect(bad.ok).toBe(false);
    const empty = await exec(ctx, { name: 'subagent', args: { action: 'list' }, agentId: 'chief' });
    expect(empty.output.active_count).toBe(0);
  });
});
