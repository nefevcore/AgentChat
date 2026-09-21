// ============================================================
// ac-agents（M15）：resolveToolNames / filterLlmParams / reassign
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from '../src/index.ts';
import { resolveToolNames, filterLlmParams, effectiveToolMode, narrowToolsByMode, isModeToolFace, widenToolsForGating } from '../src/index.ts';

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
    const coder = { id: 'coder', model: 'm', tags: ['tc-programmatic'] };
    // 覆盖压回（tc-programmatic → tc-base）
    expect(effectiveToolMode(coder, 'user~coder', { convSettings })).toBe('tc-base');
    // 无键会话 = 跟随 tags
    expect(effectiveToolMode(coder, 'other~coder', { convSettings })).toBe('tc-programmatic');
    // 无 conversationId / 无 convSettings = 跟随 tags
    expect(effectiveToolMode(coder, undefined, { convSettings })).toBe('tc-programmatic');
    expect(effectiveToolMode(coder, 'user~coder')).toBe('tc-programmatic');
    // 无 tags = tc-base；tc-none 优先（toolModeOf 语义）
    expect(effectiveToolMode({ id: 'x', model: 'm' }, undefined)).toBe('tc-base');
    expect(effectiveToolMode({ id: 'x', model: 'm', tags: ['tc-none', 'tc-programmatic'] }, undefined)).toBe('tc-none');
  });

  it('narrowToolsByMode：tc-programmatic → mode 工具集（从 defs 合成，与 tags/常规面无关）；无 mode 工具 = 空面（不回落）；tc-none → 空；tc-base → 原面', () => {
    const defs = [
      { name: 'read' },
      { name: 'bash' },
      { name: 'run_code', injection: 'mode' as const },
    ];
    // mode 工具从 defs 合成——tools 面里有没有它无关（它不进常规面）
    expect(narrowToolsByMode(['read', 'bash'], defs, 'tc-programmatic')).toEqual(['run_code']);
    // 无 mode 工具（行未装）= 空面（形同 tc-none，不回落常规面——语义突变防护）
    expect(narrowToolsByMode(['read', 'bash'], [{ name: 'read' }], 'tc-programmatic')).toEqual([]);
    expect(narrowToolsByMode(['read', 'run_code'], defs, 'tc-none')).toEqual([]);
    expect(narrowToolsByMode(['read', 'bash'], defs, 'tc-base')).toEqual(['read', 'bash']);
  });
});

describe('PTC 门控面单源（isModeToolFace / widenToolsForGating——2026-12 基线段丢失修复）', () => {
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

  it('widenToolsForGating：PTC run 按能力面展开（含 tags 门禁与 requiresInteraction 终滤）；常规面原样', async () => {
    const ctx = await boot();
    ctx.agents.register({ id: 'prog', model: 'm', tags: ['fs', 'infra'] });
    // 最小桩：ac-agents 不硬依赖 tools 服务，手造 list 面 + agents 转发
    const fakeTools = {
      list: () => [
        { name: 'read', requiredTags: ['fs'] },
        { name: 'write', requiredTags: ['fs'] },
        { name: 'ask_questions', requiredTags: ['infra'], requiresInteraction: true },
        { name: 'run_code', injection: 'mode' as const },
      ],
    };
    const faceOf = (conversationId: string) => ({ get: (key: string) => (key === 'tools' ? fakeTools : key === 'agents' ? { get: (id: string) => ctx.agents.get(id) } : undefined) } as never);
    // PTC run：能力面展开（fs 标签解锁 read/write；mode 工具与交互终滤各就位）
    const widened = widenToolsForGating(faceOf('user~prog'), 'prog', 'user~prog', ['run_code']);
    expect(widened).toContain('read');
    expect(widened).toContain('write');
    expect(widened).not.toContain('run_code'); // mode 工具自身不进门控面
    expect(widened).toContain('ask_questions'); // 非自会话不裁剪
    // 未注册 Agent → 能力面只剩 base 解锁（fakeTools 里无 base 工具 → 空）
    const anon = widenToolsForGating(faceOf('user~anon'), 'anon', 'user~anon', ['run_code']);
    expect(anon).toEqual([]);
    // requiresInteraction 终滤：self 会话（机制 run）裁剪
    const selfFace = widenToolsForGating(faceOf('prog~prog'), 'prog', 'prog~prog', ['run_code']);
    expect(selfFace).not.toContain('ask_questions');
    // 常规面：request.tools 原样返回（含 run_code 混排的并存形态）
    const normal = widenToolsForGating(faceOf('user~prog'), 'prog', 'user~prog', ['read', 'run_code']);
    expect(normal).toEqual(['read', 'run_code']);
  });
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

  it('tag 引用（universe 传 defs 时按 requiredTags 展开；纯名字数组 = 落空）', () => {
    const defs = [
      { name: 'read' },
      { name: 'bash', requiredTags: ['shell'] },
      { name: 'adt_search', requiredTags: ['sap-adt'] },
      { name: 'adt_read', requiredTags: ['sap-adt'] },
      { name: 'hello' },
    ];
    // 对象形态 include：tag 引用与精确名混排
    expect(resolveToolNames({ include: ['tag:sap-adt', 'read'] }, defs)).toEqual([
      'adt_search',
      'adt_read',
      'read',
    ]);
    // 数组白名单同语义
    expect(resolveToolNames(['tag:shell', 'hello'], defs)).toEqual(['bash', 'hello']);
    // exclude 侧同样展开（tag 批量停用）
    const excluded = resolveToolNames({ exclude: ['tag:sap-adt'] }, defs)!;
    expect(excluded).toEqual(defs.map((d) => d.name).filter((n) => !n.startsWith('adt_')));
    // 无匹配 tag → 空展开（tag: 非字面名，不落进结果）
    expect(resolveToolNames({ include: ['tag:none', 'hello'] }, defs)).toEqual(['hello']);
    // 纯名字 universe（无 tag 信息）：引用条目静默落空
    expect(resolveToolNames({ include: ['tag:sap-adt', 'hello'] }, all)).toEqual(['hello']);
  });

  it('落空告警回调（前置修复 #2）：字面名不在 universe 与 tag 空展开都回调；字面名仍透传', () => {
    const defs = [
      { name: 'read', requiredTags: ['fs'] },
      { name: 'pwsh', requiredTags: ['shell'] },
    ];
    const unknownLiterals: string[] = [];
    const emptyTags: string[] = [];
    // 'bash' 不在 universe（平台拆分后 Windows 的存量形态）——回调但透传
    const resolved = resolveToolNames(
      ['read', 'bash'],
      defs,
      (t) => emptyTags.push(t),
      (n) => unknownLiterals.push(n),
    );
    expect(resolved).toEqual(['read', 'bash']); // 透传不变（执行面报未知工具）
    expect(unknownLiterals).toEqual(['bash']);
    expect(emptyTags).toEqual([]); // 无 tag: 引用
    // tag 空展开照旧回调
    resolveToolNames(['tag:none'], defs, (t) => emptyTags.push(t));
    expect(emptyTags).toEqual(['none']);
    // exclude 侧字面名落空同样回调（点名停用不存在工具——配置噪音）
    const exclUnknown: string[] = [];
    resolveToolNames({ exclude: ['ghost'] }, defs, undefined, (n) => exclUnknown.push(n));
    expect(exclUnknown).toEqual(['ghost']);
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
