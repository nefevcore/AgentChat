import { describe, it, expect, afterEach } from 'vitest';
import { Context } from '@agentchat/cordis';
import { bootTree, type BootedTree } from '../src/index';
import { LlmError } from 'ac-llm';
import type { LlmMessage } from 'ac-llm';

// ---- 脚本化 provider 薄行（第 1 次出工具调用，第 2 次出最终文本；零网络） ----

function scriptedRow() {
  let counter = 0;
  return {
    name: 'mock-scripted-llm',
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.register(
        'scripted',
        () => ({
          stream: async function* (input: any) {
            const idx = counter++;
            if (idx === 0) {
              yield { delta: '', toolCalls: [{ index: 0, id: 'c1', name: 'hello' }] };
              yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: '{"message":"preview"}' }] };
              yield { delta: '', finish: 'tool_calls' };
            } else {
              yield { delta: '工具结果已处理' };
              yield { delta: '', finish: 'stop', usage: { prompt: 2, completion: 3 } };
            }
          },
        }),
        { models: ['mock-1'] },
      );
    },
  };
}

const booted: BootedTree[] = [];

async function boot() {
  const tree = await bootTree();
  // 在组合树外追加脚本 provider 薄行（不发起网络）
  const fiber = tree.ctx.plugin(scriptedRow() as any);
  await fiber;
  tree.fibers.set('mock-llm', fiber);
  booted.push(tree);
  return tree;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers.values()].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('ac-app 端到端（router → loop → tools → llm）', () => {
  it('完整链路：send → 工具轮 → 回复 → 事件订阅方收到全部通知', async () => {
    const { ctx } = await boot();
    ctx.agents.register({
      id: 'helper',
      model: 'mock-1',
      system: '你是链路验证助手',
      tools: ['hello'],
      maxSteps: 4,
    });
    const received: string[] = [];
    const replies: string[] = [];
    const inboundRoles: string[] = [];
    ctx.on('router/message-received', (agentId, message) => {
      received.push(agentId);
      inboundRoles.push(message.role);
    });
    ctx.on('router/reply-completed', (_a, text) => replies.push(text));

    const run = await ctx.router.send('helper', '请用工具打个招呼');
    expect(run.finish).toBe('stop');
    expect(run.steps).toHaveLength(2);
    expect(run.steps[0].toolResults[0]).toEqual({ ok: true, output: 'hello: preview' });
    expect(run.text).toBe('工具结果已处理');
    expect(received).toEqual(['helper']);
    expect(inboundRoles).toEqual(['user']);
    expect(replies).toEqual(['工具结果已处理']);
  });

  it('第二轮携带完整历史：事件积累 + history 回放（ac-session 前身形态）', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1', system: 'SYS' });
    const log: LlmMessage[] = [];
    ctx.on('router/message-received', (_id, m) => log.push(m));
    ctx.on('router/reply-completed', (_id, text) => log.push({ role: 'assistant', content: text }));
    await ctx.router.send('a', '第一轮');
    await ctx.router.send('a', '第二轮', { history: [...log] });
    expect(log.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('安全拦截跨域生效：tool veto → 工具被拒，循环照常收束', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1', tools: ['hello'] });
    ctx.on('tool/before-execute', (execution, next) =>
      execution.call.name === 'hello' ? { ok: false, error: 'blocked by security' } : next(),
    );
    const run = await ctx.router.send('a', 'q');
    expect(run.steps[0].toolResults[0]).toEqual({ ok: false, error: 'blocked by security' });
    expect(run.text).toBe('工具结果已处理');
  });

  it('budget veto：before-run 拦截器直接短路，LLM 零调用', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.on('loop/before-run', (call, next) => {
      if (call.request.agent === 'a') {
        return Promise.resolve({ steps: [], text: '[额度用尽]', finish: 'veto' as const, usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 } });
      }
      return next();
    });
    const run = await ctx.router.send('a', 'q');
    expect(run.finish).toBe('veto');
    expect(ctx.llm.stats().every((s) => !s.instantiated)).toBe(true);
  });

  it('热插拔级联：摘 agent-loop 行 → router 回滚消失，agents/llm 存活', async () => {
    const tree = await boot();
    const { ctx, fibers } = tree;
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const run = await ctx.router.send('a', '留档一句');
    expect(run.finish).toBe('stop');

    await fibers.get('agent-loop')!.dispose();
    expect((ctx as any).router).toBeUndefined();
    expect((ctx as any).agentLoop).toBeUndefined();
    expect((ctx as any).agents).toBeDefined(); // 无依赖行不受影响
    expect(ctx.llm.providers()).toContain('glm');
  });

  it('llm 路由红线：未注册 model → run finish=error 且错误可读', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'no-such-model' });
    const run = await ctx.router.send('a', 'q');
    expect(run.finish).toBe('error');
    expect(run.error).toMatch(/no-such-model/);
    expect(() => ctx.llm.resolveProvider({ model: 'no-such-model' })).toThrow(LlmError);
  });
});
