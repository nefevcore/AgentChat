// ============================================================
// ac-agents（M15）：resolveToolNames / filterLlmParams / reassign
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from '../src/index.ts';
import { resolveToolNames, filterLlmParams, effectiveToolMode, discoverTools, narrowToolsByMode, isModeToolFace, widenToolsForGating, humanPresentOf } from '../src/index.ts';

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

describe('工具调用模式单源（effectiveToolMode / narrowToolsByMode——router 与估算面共用）', () => {
  const convSettings = {
    get: (conversationId: string) =>
      conversationId === 'user~coder' ? { toolMode: 'tc-base' as const } : {},
  };

  it('effectiveToolMode：会话覆盖 ?? toolModeOf(agent)', () => {
    const coder = { id: 'coder', model: 'm', toolMode: 'tc-programmatic' as const };
    // 覆盖压回（tc-programmatic → tc-base）
    expect(effectiveToolMode(coder, 'user~coder', { convSettings })).toBe('tc-base');
    // 无键会话 = 跟随 config
    expect(effectiveToolMode(coder, 'other~coder', { convSettings })).toBe('tc-programmatic');
    // 无 conversationId / 无 convSettings = 跟随 config
    expect(effectiveToolMode(coder, undefined, { convSettings })).toBe('tc-programmatic');
    expect(effectiveToolMode(coder, 'user~coder')).toBe('tc-programmatic');
    // 无 toolMode = tc-base（toolModeOf 语义）
    expect(effectiveToolMode({ id: 'x', model: 'm' }, undefined)).toBe('tc-base');
    expect(effectiveToolMode({ id: 'x', model: 'm', toolMode: 'tc-none' }, undefined)).toBe('tc-none');
  });

  it('两步投影（cr-1049）：扩展档 → discovered 中 discover 在场者；入口集空 = 回退 baseFace（cr-1021）；tc-none → 空；tc-base → baseFace', () => {
    const defs = [
      { name: 'read' },
      { name: 'bash' },
      { name: 'run_code', discover: () => true },
    ];
    // 扩展档：入口集 = discovered（含谓词声明者）；baseFace 被替换
    expect(narrowToolsByMode(['read', 'bash'], ['read', 'bash', 'run_code'], defs, 'tc-programmatic')).toEqual(['run_code']);
    // 入口集空（发现步已滤掉入口 = 行未装/谓词 false）= 回退 baseFace
    //（cr-1021：news~news 空面植物人事故——静默零工具执行危害大于
    //「悄悄变常规档」，可用性优先 + 调用方 warn 留痕）
    expect(narrowToolsByMode(['read', 'bash'], ['read', 'bash'], [{ name: 'run_code', discover: () => false }], 'tc-programmatic')).toEqual(['read', 'bash']);
    expect(narrowToolsByMode(['read', 'bash'], ['read', 'bash'], [], 'tc-programmatic')).toEqual(['read', 'bash']);
    expect(narrowToolsByMode(['read', 'run_code'], ['read', 'run_code'], defs, 'tc-none')).toEqual([]);
    expect(narrowToolsByMode(['read', 'bash'], ['read', 'bash', 'run_code'], defs, 'tc-base')).toEqual(['read', 'bash']);
  });

  it('discoverTools（发现步）：缺省 true；谓词按投影上下文求值；throw 按 false（fail-closed）', () => {
    const defs = [
      { name: 'read' },
      { name: 'run_code', discover: (face: { toolMode: string }) => face.toolMode === 'tc-programmatic' },
      { name: 'boom', discover: () => { throw new Error('x'); } },
    ];
    expect(discoverTools(defs, { toolMode: 'tc-base' })).toEqual(['read']);
    expect(discoverTools(defs, { toolMode: 'tc-programmatic' })).toEqual(['read', 'run_code']);
  });
});

describe('PTC 门控面单源（isModeToolFace / widenToolsForGating——2026-09-21 基线段丢失修复）', () => {
  it('isModeToolFace：请求面恰等于 mode 工具集（互为子集且非空、无重复）才成立', () => {
    expect(isModeToolFace(['run_code'], ['run_code'])).toBe(true);
    // 请求面含常规工具（并存形态）→ 非程序化 run
    expect(isModeToolFace(['run_code', 'read'], ['run_code'])).toBe(false);
    // 注册面有多个 mode 工具时须全对齐
    expect(isModeToolFace(['run_code'], ['run_code', 'other_mode'])).toBe(false);
    expect(isModeToolFace(['run_code', 'other_mode'], ['run_code', 'other_mode'])).toBe(true);
    // 空/缺省/重复 → 不成立
    expect(isModeToolFace(undefined, ['run_code'])).toBe(false);
    expect(isModeToolFace([], ['run_code'])).toBe(false);
    expect(isModeToolFace(['run_code', 'run_code'], ['run_code'])).toBe(false);
    expect(isModeToolFace(['run_code'], [])).toBe(false);
  });

  it('widenToolsForGating：PTC run 按注册面展开（行装载单闸 + requiresInteraction 终滤）；常规面原样', async () => {
    const ctx = await boot();
    ctx.agents.register({ id: 'prog', model: 'm' });
    // 最小桩：ac-agents 不硬依赖 tools 服务，手造 list 面 + agents 转发
    const fakeTools = {
      list: () => [
        { name: 'read' },
        { name: 'write' },
        { name: 'ask_questions', requiresInteraction: true },
        { name: 'run_code', discover: () => true },
      ],
    };
    const faceOf = (conversationId: string) => ({ get: (key: string) => (key === 'tools' ? fakeTools : key === 'agents' ? { get: (id: string) => ctx.agents.get(id) } : undefined) } as never);
    // PTC run：注册面展开（行装载单闸——cr-953 后无标签门禁）；mode 工具与交互终滤各就位
    const widened = widenToolsForGating(faceOf('user~prog'), 'prog', 'user~prog', ['run_code']);
    expect(widened).toContain('read');
    expect(widened).toContain('write');
    expect(widened).not.toContain('run_code'); // mode 工具自身不进门控面
    expect(widened).toContain('ask_questions'); // 非自会话不裁剪
    // 未注册 Agent → 能力面同样直取（注册面与身份无关——行装载单闸）
    const anon = widenToolsForGating(faceOf('user~anon'), 'anon', 'user~anon', ['run_code']);
    expect(anon).toEqual(['read', 'write', 'ask_questions']);
    // requiresInteraction 终滤：self 会话（机制 run）裁剪
    const selfFace = widenToolsForGating(faceOf('prog~prog'), 'prog', 'prog~prog', ['run_code']);
    expect(selfFace).not.toContain('ask_questions');
    // cr-1079 无人语义：agent~agent 与群会话同样无人——交互性工具同样裁剪
    const p2pFace = widenToolsForGating(faceOf('prog~peer'), 'prog', 'prog~peer', ['run_code']);
    expect(p2pFace).not.toContain('ask_questions');
    const grpFace = widenToolsForGating(faceOf('g-abc~prog'), 'prog', 'g-abc~prog', ['run_code']);
    expect(grpFace).not.toContain('ask_questions');
    // 常规面：request.tools 原样返回（含 run_code 混排的并存形态）
    const normal = widenToolsForGating(faceOf('user~prog'), 'prog', 'user~prog', ['read', 'run_code']);
    expect(normal).toEqual(['read', 'run_code']);
  });
});

describe('humanPresentOf（cr-1079 无人语义单源——纯词法，零 ctx 状态）', () => {
  it('有人：a~user 对桶（两向）与 singles sid', () => {
    expect(humanPresentOf('news~user')).toBe(true);
    expect(humanPresentOf('user~news')).toBe(true);
    expect(humanPresentOf('018f-uuid-sid')).toBe(true); // singles：无 ~ 即用户独立会话
  });
  it('无人：self / agent~agent / 群成员桶 / undefined', () => {
    expect(humanPresentOf('news~news')).toBe(false);
    expect(humanPresentOf('designer~news')).toBe(false);
    expect(humanPresentOf('g-mthfaf3e~news')).toBe(false);
    expect(humanPresentOf(undefined)).toBe(false);
  });
});

describe('resolveToolNames（rows 词形归一——cr-953 单参语义，行集展开在垫片/行集层）', () => {
  it('undefined → undefined（全部）；string[] → 清单原样', () => {
    expect(resolveToolNames(undefined)).toBeUndefined();
    expect(resolveToolNames(['read', 'bash'])).toEqual(['read', 'bash']);
  });

  it('include / exclude / 组合', () => {
    expect(resolveToolNames({ include: ['read'] })).toEqual(['read']);
    expect(resolveToolNames({ exclude: ['bash'] })).toBeUndefined(); // 全集减法由调用方持全集
    expect(resolveToolNames({ include: ['read', 'write', 'bash'], exclude: ['bash'] })).toEqual([
      'read',
      'write',
    ]);
    // 空 include = 显式全停
    expect(resolveToolNames({ include: [] })).toEqual([]);
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
