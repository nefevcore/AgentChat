// ============================================================
// ac-agent-loop/tests/sections.test.ts —— PromptSection 段注册制（cr-881）
//
// · SECTION_ORDER 具名分配单源（未知名抛错）
// · assembleSystemPrompt：(order, name) 双键排序、CALLER 前缀、空串不贡献
// · registerPromptSection：同名重复注册抛错、注销精确回收
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import { assembleSystemPrompt, sectionOrder, validateSectionName, validateSectionOrder, type RegisteredSection } from '../src/sections.ts';
import * as loopRow from '../src/index.ts';
import * as toolsRow from 'ac-tools';
import * as llmRow from 'ac-llm';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

const sec = (name: RegisteredSection['name'], order: number, text: string): RegisteredSection =>
  ({ name, order, text, owner: 'test' });

describe('SECTION_ORDER 核心惯例表（cr-944 动态化后为惯例单源，非注册白名单）', () => {
  it('已知名解析出数值（未知名抛错闸已随动态注册退役——见 validateSectionName）', () => {
    expect(sectionOrder('PERSONA')).toBe(10);
    expect(sectionOrder('DATETIME')).toBeGreaterThan(sectionOrder('CONVERSATION'));
  });

  it('段位语义分层（判据 v2）：身份(0-99) < 词汇聚簇(110-122) < 环境(200-299) < 指引(300-410) < 参考材料(450) < 会话动态(900+)', () => {
    expect(sectionOrder('PERSONA')).toBeLessThan(sectionOrder('REFERENCE_FS'));
    expect(sectionOrder('TERMINOLOGY')).toBeLessThan(sectionOrder('ENV_WORKDIR'));
    expect(sectionOrder('TERMINOLOGY')).toBeGreaterThan(sectionOrder('REFERENCE_SESSION'));
    expect(sectionOrder('PTC_SDK')).toBeGreaterThan(sectionOrder('CONDUCT'));
    expect(sectionOrder('PTC_SDK')).toBeLessThan(sectionOrder('CONVERSATION'));
    expect(sectionOrder('CONDUCT')).toBeLessThan(sectionOrder('CONVERSATION'));
    expect(sectionOrder('CONVERSATION')).toBeLessThan(sectionOrder('DATETIME'));
  });

  it('cr-944 动态校验：非法名/保留名生态注册/越界 order 抛错；动态段名+order 合法', () => {
    expect(() => validateSectionName('bad name', 'x')).not.toThrow(); // 空格在中间合法（仅首尾空白与空串非法）
    expect(() => validateSectionName('  x', 'x')).toThrow();
    expect(() => validateSectionName('DATETIME', 'x')).toThrow();
    expect(() => validateSectionName('DATETIME', 'ac-datetime')).not.toThrow();
    expect(() => validateSectionOrder(899)).not.toThrow();
    expect(() => validateSectionOrder(900)).toThrow();
    expect(() => validateSectionOrder(-1)).toThrow();
  });
});

describe('assembleSystemPrompt 纯函数', () => {
  const req = { model: 'm', messages: [] };

  it('(order, name) 双键排序：注册序无关，order 同值按名排序', () => {
    const out = assembleSystemPrompt(
      [sec('DATETIME', 910, 'D'), sec('PERSONA', 10, 'P'), sec('GUIDELINES_TODO', 391, 'T'), sec('GUIDELINES_GOAL', 390, 'G')],
      undefined,
      req as never,
    );
    expect(out).toBe('P\n\nG\n\nT\n\nD');
  });

  it('CALLER 前缀段在最前；空串段不贡献；全空 = undefined', () => {
    const out = assembleSystemPrompt(
      [sec('DATETIME', 910, 'D'), sec('PERSONA', 10, ''), sec('CONDUCT', 410, 'C')],
      'BASE',
      req as never,
    );
    expect(out).toBe('BASE\n\nC\n\nD');
    expect(assembleSystemPrompt([sec('PERSONA', 10, '')], undefined, req as never)).toBeUndefined();
  });

  it('provider 形式：per-run 求值（门控住 provider 内）', () => {
    const out = assembleSystemPrompt(
      [{ name: 'CONVERSATION', order: 900, owner: 't', text: (r) => (r.conversationId ? 'CONV' : '') }],
      undefined,
      { ...req, conversationId: 'c1' } as never,
    );
    expect(out).toBe('CONV');
    expect(assembleSystemPrompt(
      [{ name: 'CONVERSATION', order: 900, owner: 't', text: (r) => (r.conversationId ? 'CONV' : '') }],
      undefined,
      req as never,
    )).toBeUndefined();
  });
});

describe('registerPromptSection 注册面', () => {
  // loopRow inject ['llm','tools']——llm 行 + mock provider 缺席则本行 PENDING、
  // ctx.agentLoop 恒 undefined（boot 脚手架同 loop.test.ts）。
  const bootRows = (): Array<unknown> => [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', () => ({ stream: async function* () { yield { delta: 'ok', finish: 'stop' as const, usage: { prompt: 1, completion: 1 } }; } }), { models: ['mock-1'] });
      },
    },
    loopRow,
  ];

  it('段贡献经 run() 入口组装进 system（先于 before-run 拦截链）', async () => {
    const ctx = new Context();
    const fibers: Fiber[] = [];
    for (const row of bootRows()) {
      const f = ctx.plugin(row as never, {} as never);
      await f;
      fibers.push(f);
    }
    booted.push({ ctx, fibers });
    ctx.agentLoop.registerPromptSection({ name: 'PERSONA', text: 'P' }, 'test');
    ctx.agentLoop.registerPromptSection({ name: 'test-tail', order: 800, text: 'D' }, 'test');
    let seen: string | undefined;
    ctx.on('loop/before-run', (call, next) => {
      seen = call.request.system;
      return next();
    });
    await ctx.agentLoop.run({ model: 'mock-1', messages: [] });
    expect(seen).toBe('P\n\nD');
  });

  it('同名重复注册抛错；注销后可重注册；旧注销不误删新条目', async () => {
    const ctx = new Context();
    const fibers: Fiber[] = [];
    for (const row of bootRows()) {
      const f = ctx.plugin(row as never, {} as never);
      await f;
      fibers.push(f);
    }
    booted.push({ ctx, fibers });
    const dispose = ctx.agentLoop.registerPromptSection({ name: 'PERSONA', text: 'P1' }, 'a');
    expect(() => ctx.agentLoop.registerPromptSection({ name: 'PERSONA', text: 'P2' }, 'b')).toThrow();
    dispose();
    const dispose2 = ctx.agentLoop.registerPromptSection({ name: 'PERSONA', text: 'P2' }, 'b');
    dispose(); // 旧注销对新条目无害
    const out = ctx.agentLoop.assemblePreview({ model: 'm', messages: [] });
    expect(out).toBe('P2');
    dispose2();
    expect(ctx.agentLoop.assemblePreview({ model: 'm', messages: [] })).toBeUndefined();
  });
});