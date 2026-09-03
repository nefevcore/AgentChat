// ============================================================
// ac-agents（M15）：resolveToolNames / filterLlmParams / reassign
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from '../src/index.ts';
import { resolveToolNames, filterLlmParams } from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot() {
  const ctx = new Context();
  const fiber = ctx.plugin(agentsRow as any);
  await fiber;
  booted.push({ ctx, fibers: [fiber] });
  return ctx;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of fibers) if (fiber.uid !== null) await fiber.dispose();
  }
});

describe('resolveToolNames（tools 对象形态收编）', () => {
  const all = ['read', 'write', 'bash', 'web_search', 'math'];

  it('undefined → undefined（全部）；string[] → 白名单原样', () => {
    expect(resolveToolNames(undefined, all)).toBeUndefined();
    expect(resolveToolNames(['read', 'bash'], all)).toEqual(['read', 'bash']);
  });

  it('include / exclude / 组合', () => {
    expect(resolveToolNames({ include: ['read'] }, all)).toEqual(['read']);
    expect(resolveToolNames({ exclude: ['bash'] }, all)).toEqual(['read', 'write', 'web_search', 'math']);
    expect(resolveToolNames({ include: ['read', 'write', 'bash'], exclude: ['bash'] }, all)).toEqual([
      'read',
      'write',
    ]);
    // 空 include = 显式全停；{} = 全部
    expect(resolveToolNames({ include: [] }, all)).toEqual([]);
    expect(resolveToolNames({}, all)).toEqual(all);
  });
});

describe('filterLlmParams（采样白名单）', () => {
  it('白名单键保留、保留键与未知键剔除', () => {
    expect(
      filterLlmParams({
        temperature: 0.3,
        max_tokens: 1024,
        model: 'evil', // 保留键——不可覆盖
        messages: [], // 保留键
        tools: [], // 保留键
        custom_injection: 1, // 未知键
      }),
    ).toEqual({ temperature: 0.3, max_tokens: 1024 });
    expect(filterLlmParams(undefined)).toEqual({});
  });

  it("null/'' 值剔除（deepMerge 删除语义与旧自由文本空串不进协议体）", () => {
    expect(filterLlmParams({ reasoning_effort: null, thinking: null, stop: '', temperature: 0.3 }))
      .toEqual({ temperature: 0.3 });
    expect(filterLlmParams({ reasoning_effort: '' })).toEqual({});
  });

  it("reasoning_effort 'none' → thinking disabled（'none' 不是合法档位，翻译成开关形）", () => {
    expect(filterLlmParams({ reasoning_effort: 'none' }))
      .toEqual({ thinking: { type: 'disabled' } });
    // 与既有 thinking 对象并存时档位胜出（互斥键——UI 单选维护）
    expect(filterLlmParams({ reasoning_effort: 'none', thinking: { type: 'enabled' } }))
      .toEqual({ thinking: { type: 'disabled' } });
    // 合法档位原样透传
    expect(filterLlmParams({ reasoning_effort: 'low', thinking: null }))
      .toEqual({ reasoning_effort: 'low' });
  });

  it('legacy 布尔 thinking → 结构化开关（旧「思考输出」勾选存量归一）', () => {
    expect(filterLlmParams({ thinking: true })).toEqual({ thinking: { type: 'enabled' } });
    expect(filterLlmParams({ thinking: false })).toEqual({ thinking: { type: 'disabled' } });
    // 结构化对象原样透传
    expect(filterLlmParams({ thinking: { type: 'disabled' } })).toEqual({ thinking: { type: 'disabled' } });
  });
});

describe('AgentsService.reassign（数据驱动覆盖注册）', () => {
  it('覆盖后条目立即可见且不挂调用方 effect（卸载覆盖行不删除条目）', async () => {
    const ctx = await boot();
    ctx.agents.register({ id: 'x', model: 'm' }); // 原注册（归属测试行 fiber）

    // 模拟另一行（工具行）上的覆盖：在子 fiber 里 reassign
    const coverFiber = ctx.plugin({
      name: 'cover-row',
      apply(c: Context) {
        // 子 fiber 未 inject agents——经 ctx.get（root-traced 无限制解析）
        c.get('agents')!.reassign({ id: 'x', model: 'm2', system: '改过了' });
      },
    });
    await coverFiber;
    expect(ctx.agents.get('x')).toMatchObject({ model: 'm2', system: '改过了' });

    // 覆盖行卸载：条目存活（reassign 无 effect——数据驱动语义）
    await coverFiber.dispose();
    expect(ctx.agents.has('x')).toBe(true);
    expect(ctx.agents.get('x')?.model).toBe('m2');
  });
});
