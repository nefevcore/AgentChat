// ============================================================
// ac-bench/tests/bfcl.test.ts —— 评测域测试
//
// 覆盖面：
//   · eval 纯函数：调用串解析 / 宽松相等 / 多重集对拍（回溯匹配）；
//   · BFCL 适配器：v1/v3 双数据形态解析 + 答案 join；
//   · 服务注册中心：套件注册/回收/重名；
//   · 端到端（脚本化 mock provider）：注册中心 → agentLoop →
//     llm 路由 → toolCalls 聚合 → 工具执行 → 对拍 → 报告 → 事件。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as llmRow from 'ac-llm';
import * as toolsRow from 'ac-tools';
import * as agentLoopRow from 'ac-agent-loop';
import * as benchRow from '../src/index.ts';
import {
  MOCK_MODEL,
  MOCK_PROVIDER,
  normalizeToolSchema,
  sanitizeToolName,
  scriptedBenchRow,
} from '../src/index.ts';
import { compareCalls, parseCallString } from '../src/eval.ts';
import type { BenchActualCall, BenchCase, BenchSuite } from '../src/contract.ts';

// ---- 脚手架：最小树 boot + 逐 fiber 回收 ----

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot(extra: unknown[] = []) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [llmRow, toolsRow, agentLoopRow, benchRow, ...extra]) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of fibers) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

// ---- eval：parseCallString ----

describe('parseCallString（v1 调用串解析）', () => {
  it('单引号字符串 + 数字参数', () => {
    const spec = parseCallString("convert_currency(base_currency='USD', target_currency='CNY', value=100)");
    expect(spec).toEqual({
      name: 'convert_currency',
      argsSpec: { base_currency: ['USD'], target_currency: ['CNY'], value: [100] },
    });
  });

  it('双引号 / 布尔 / None / 列表 / 裸函数名 / 空参', () => {
    expect(parseCallString('get_stock_price(symbol="AAPL")')).toEqual({
      name: 'get_stock_price',
      argsSpec: { symbol: ['AAPL'] },
    });
    expect(parseCallString('f(flag=True, off=False, nothing=None)')).toEqual({
      name: 'f',
      argsSpec: { flag: [true], off: [false], nothing: [null] },
    });
    expect(parseCallString('f(items=[1, 2, 3])')).toEqual({
      name: 'f',
      argsSpec: { items: [[1, 2, 3]] },
    });
    expect(parseCallString('bare_func')).toEqual({ name: 'bare_func' });
    expect(parseCallString('no_args()')).toEqual({ name: 'no_args', argsSpec: {} });
    expect(parseCallString('')).toBeNull();
  });
});

// ---- eval：compareCalls ----

describe('compareCalls（多重集对拍）', () => {
  const call = (name: string, args: Record<string, unknown> = {}): BenchActualCall => ({ name, args });

  it('单调用精确匹配 / 数字串宽松互认 / 可接受值列表', () => {
    expect(compareCalls([{ name: 'f', argsSpec: { a: [1] } }], [call('f', { a: 1 })]).pass).toBe(true);
    expect(compareCalls([{ name: 'f', argsSpec: { a: [1] } }], [call('f', { a: '1' })]).pass).toBe(true);
    expect(compareCalls([{ name: 'f', argsSpec: { a: ['x', 'y'] } }], [call('f', { a: 'y' })]).pass).toBe(true);
    expect(compareCalls([{ name: 'f', argsSpec: { a: [1] } }], [call('f', { a: 2 })]).pass).toBe(false);
  });

  it('同名多调用回溯匹配（parallel 次序不敏感）', () => {
    const expected = [
      { name: 'convert', argsSpec: { to: ['EUR'], v: [50] } },
      { name: 'convert', argsSpec: { to: ['JPY'], v: [100] } },
    ];
    const actual = [call('convert', { to: 'JPY', v: 100 }), call('convert', { to: 'EUR', v: 50 })];
    expect(compareCalls(expected, actual).pass).toBe(true);
    // 同名两调用参数交叉错配 → 失败
    const bad = [call('convert', { to: 'JPY', v: 50 }), call('convert', { to: 'EUR', v: 100 })];
    expect(compareCalls(expected, bad).pass).toBe(false);
  });

  it('数量不符 / 名不符 / 多余参数 / 缺参 / 反例用例', () => {
    const spec = [{ name: 'f', argsSpec: { a: [1] } }];
    expect(compareCalls(spec, []).pass).toBe(false);
    expect(compareCalls(spec, [call('g', { a: 1 })]).pass).toBe(false);
    expect(compareCalls(spec, [call('f', { a: 1, b: 2 })]).pass).toBe(false);
    expect(compareCalls(spec, [call('f', {})]).pass).toBe(false);
    // 反例：期望零调用
    expect(compareCalls([], []).pass).toBe(true);
    expect(compareCalls([], [call('f')]).pass).toBe(false);
    // 无参规格：实际带参即败
    expect(compareCalls([{ name: 'bare' }], [call('bare')]).pass).toBe(true);
    expect(compareCalls([{ name: 'bare' }], [call('bare', { x: 1 })]).pass).toBe(false);
  });

  it('可选参省略语义：可接受列表含默认形状值（""/0/false/null）时缺省放行', () => {
    // 2026-09-11 真实跑批误判根因：math_hypot.z 期望 ["",0]、units 期望 ["meters",""]
    // ——模型省略可选参 = 取默认，应判过
    expect(compareCalls([{ name: 'f', argsSpec: { x: [3], z: ['', 0] } }], [call('f', { x: 3 })]).pass).toBe(true);
    expect(compareCalls([{ name: 'f', argsSpec: { units: ['meters', ''] } }], [call('f', {})]).pass).toBe(true);
    expect(compareCalls([{ name: 'f', argsSpec: { flag: [false] } }], [call('f', {})]).pass).toBe(true);
    // 列表无默认形状值：缺省仍是失配（必填参不能丢）
    expect(compareCalls([{ name: 'f', argsSpec: { root_type: ['all'] } }], [call('f', {})]).pass).toBe(false);
    // 在场取错值仍失配
    expect(compareCalls([{ name: 'f', argsSpec: { units: ['meters', ''] } }], [call('f', { units: 'imperial' })]).pass).toBe(false);
  });

  it('失败诊断携带失配明细', () => {
    const verdict = compareCalls([{ name: 'f', argsSpec: { a: [1] } }], [call('f', { a: 2 })]);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('f.a');
  });

  it('诊断与判定同口径：多值列表命中次值的键不误报（simple_370 回归）', () => {
    // location 命中可接受列表第 2 个值（通过）；quantity 真失配——
    // 诊断必须指名 quantity，不得把已通过的 location 报成失配
    const spec = [{ name: 'safeway_order', argsSpec: { location: ['Palo Alto', 'Palo Alto, CA'], quantity: [[3, 1]] } }];
    const verdict = compareCalls(spec, [call('safeway_order', { location: 'Palo Alto, CA', quantity: [1, 3] })]);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('quantity');
    expect(verdict.reason).not.toContain('location');
    // 多余参数也有明确诊断
    const extra = compareCalls([{ name: 'f', argsSpec: { a: [1] } }], [call('f', { a: 1, ghost: 'x' })]);
    expect(extra.pass).toBe(false);
    expect(extra.reason).toContain('ghost');
  });
});

// ---- suites/bfcl：schema 归一化（BFCL Python 类型词 → JSON Schema） ----

describe('normalizeToolSchema（BFCL Python 类型词归一化）', () => {
  it('dict/tuple/any 等 Python 词映射或删除；合法词透传', () => {
    // 2026-09-11 真实跑批 400 全灭根因："type": "dict" 被端点严格校验打回
    expect(normalizeToolSchema({ type: 'dict', properties: {} })).toEqual({ type: 'object', properties: {} });
    expect(normalizeToolSchema({ type: 'tuple' })).toEqual({ type: 'array' });
    expect(normalizeToolSchema({ type: 'any', description: '任意' })).toEqual({ description: '任意' });
    expect(normalizeToolSchema({ type: 'string' })).toEqual({ type: 'string' });
    expect(normalizeToolSchema({ type: 'float' })).toEqual({ type: 'number' });
    expect(normalizeToolSchema({ type: 'str' })).toEqual({ type: 'string' });
    expect(normalizeToolSchema({ type: 'int' })).toEqual({ type: 'integer' });
    expect(normalizeToolSchema({ type: 'bool' })).toEqual({ type: 'boolean' });
  });

  it('递归：properties 值 / items / 组合词全走归一化', () => {
    expect(
      normalizeToolSchema({
        type: 'object',
        properties: {
          filters: { type: 'dict', properties: { rating: { type: 'float' } } },
          tags: { type: 'list', items: { type: 'str' } },
          note: { description: '无类型' },
          alias: 'str', // 裸类型词简写
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        filters: { type: 'object', properties: { rating: { type: 'number' } } },
        tags: { type: 'array', items: { type: 'string' } },
        note: { description: '无类型' },
        alias: { type: 'string' },
      },
    });
  });
});

// ---- suites/bfcl：工具名清洗（OpenAI 兼容端点合法集） ----

describe('sanitizeToolName（BFCL 点名清洗）', () => {
  it('带点/非法字符名替换 _；合法名原样', () => {
    // 2026-09-11 真实跑批根因：math.factorial 类点名被端点 400 打回（249/400 全灭）
    expect(sanitizeToolName('math.factorial')).toBe('math_factorial');
    expect(sanitizeToolName('hospital.locate')).toBe('hospital_locate');
    expect(sanitizeToolName('get_stock_price')).toBe('get_stock_price');
    expect(sanitizeToolName('a b/c')).toBe('a_b_c');
  });

  it('适配器双侧同源清洗：工具定义与期望规格名字一致（端到端可对拍）', async () => {
    const { createBfclSuite } = await import('../src/suites/bfcl.ts');
    const file = 'bfcl-dotted-name-test.json';
    const fs = await import('node:fs');
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          id: 'dotted_0',
          question: [[{ role: 'user', content: 'Compute 5 factorial.' }]],
          function: [
            {
              name: 'math.factorial',
              description: 'Compute n!',
              parameters: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] },
            },
          ],
          ground_truth: [{ 'math.factorial': { number: [5] } }],
        },
      ]),
    );
    try {
      const suite = createBfclSuite({ files: [file] });
      const suiteObj = suite as ReturnType<typeof createBfclSuite>;
      const cases = await suiteObj.load();
      expect(cases).toHaveLength(1);
      expect(cases[0]?.tools[0]?.name).toBe('math_factorial');
      // 期望规格同名清洗 → 模型按清洗名调用即可对拍命中
      expect(cases[0]?.expected[0]?.name).toBe('math_factorial');
      expect(compareCalls(cases[0]!.expected, [{ name: 'math_factorial', args: { number: 5 } }]).pass).toBe(true);
      expect(compareCalls(cases[0]!.expected, [{ name: 'math.factorial', args: { number: 5 } }]).pass).toBe(false);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

// ---- 端到端（脚本化 mock） ----

describe('ac-bench 端到端（脚本化冒烟）', () => {
  it('内置样例全量跑批：accuracy 100% + 工具用后即焚 + 事件流', async () => {
    const { ctx } = await boot([scriptedBenchRow()]);
    const events: string[] = [];
    ctx.on('bench/run-started', (info) => events.push(`start:${info.total}`));
    ctx.on('bench/case-settled', (result) => events.push(`case:${result.id}:${result.pass ? 'pass' : 'fail'}`));
    ctx.on('bench/run-completed', (report) => events.push(`done:${report.passed}/${report.total}`));

    const report = await ctx.bench.run('bfcl', {
      provider: MOCK_PROVIDER,
      model: MOCK_MODEL,
      scripted: true,
    });

    expect(report.total).toBe(7);
    expect(report.passed).toBe(7);
    expect(report.accuracy).toBe(1);
    expect(report.promptTokens).toBeGreaterThan(0);
    expect(report.completionTokens).toBeGreaterThan(0);
    // 反例用例（#6 讲笑话）：期望零调用，mock 无指令直接终文本
    const joke = report.cases.find((c) => c.id.includes('#6'));
    expect(joke?.pass).toBe(true);
    expect(joke?.actual).toEqual([]);
    // 平行用例（#3 双转换）：两调用、次序无关
    const parallel = report.cases.find((c) => c.id.includes('#3'));
    expect(parallel?.actual.map((a) => a.name).sort()).toEqual(['convert_currency', 'convert_currency']);
    // 临时工具回收
    expect(ctx.tools.has('convert_currency')).toBe(false);
    expect(ctx.tools.has('get_stock_price')).toBe(false);
    // 事件流：start → 逐例 settled → completed
    expect(events[0]).toBe('start:7');
    expect(events.at(-1)).toBe('done:7/7');
    expect(events.filter((e) => e.startsWith('case:')).length).toBe(7);
  });

  it('limit/filter 切片 + 未知套件抛错', async () => {
    const { ctx } = await boot([scriptedBenchRow()]);
    const limited = await ctx.bench.run('bfcl', {
      provider: MOCK_PROVIDER,
      model: MOCK_MODEL,
      scripted: true,
      limit: 2,
    });
    expect(limited.total).toBe(2);
    const filtered = await ctx.bench.run('bfcl', {
      provider: MOCK_PROVIDER,
      model: MOCK_MODEL,
      scripted: true,
      filter: '#4',
    });
    expect(filtered.total).toBe(1);
    expect(filtered.cases[0]?.actual.map((a) => a.name).sort()).toEqual(['get_company_name', 'get_stock_price']);
    await expect(
      ctx.bench.run('nope', { provider: MOCK_PROVIDER, model: MOCK_MODEL }),
    ).rejects.toThrow('不存在');
  });

  it('对拍失败路径：mock 发错参数 → accuracy 0 + 失配诊断', async () => {
    // 定制 provider：首轮发错误参数调用，工具结果回填后终文本收束
    const wrongRow = {
      name: 'mock-wrong',
      inject: ['llm'],
      apply(ctx: Context) {
        ctx.llm.register(
          'wrong',
          () => ({
            stream: async function* (input: { messages: Array<{ role: string }> }) {
              if (input.messages.at(-1)?.role === 'tool') {
                yield { delta: 'done' };
                yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
                return;
              }
              yield { delta: '', toolCalls: [{ index: 0, id: 'c1', name: 'get_stock_price', argumentsDelta: '{"symbol":"TSLA"}' }] };
              yield { delta: '', finish: 'tool_calls', usage: { prompt: 1, completion: 1 } };
            },
          }),
          { models: ['wrong-model'] },
        );
      },
    };
    const { ctx } = await boot([wrongRow]);
    const suite: BenchSuite = {
      name: 'wrong-suite',
      load: async () => [
        {
          id: 'case-wrong-1',
          prompt: "What's the price of AAPL?",
          tools: [
            {
              name: 'get_stock_price',
              parameters: {
                type: 'object',
                properties: { symbol: { type: 'string' } },
                required: ['symbol'],
              },
            },
          ],
          expected: [{ name: 'get_stock_price', argsSpec: { symbol: ['AAPL'] } }],
        } satisfies BenchCase,
      ],
    };
    ctx.bench.registerSuite(suite);
    const report = await ctx.bench.run('wrong-suite', { provider: 'wrong', model: 'wrong-model' });
    expect(report.passed).toBe(0);
    expect(report.cases[0]?.reason).toContain('symbol');
    expect(report.cases[0]?.actual).toEqual([{ name: 'get_stock_price', args: { symbol: 'TSLA' } }]);
  });
});

// ---- 注册中心生命周期 ----

describe('套件注册中心', () => {
  it('注册/清单/重名/回收（随 fiber）', async () => {
    const { ctx, fibers } = await boot([scriptedBenchRow()]);
    expect(ctx.bench.listSuites().map((s) => s.name)).toContain('bfcl');
    const holderRow = {
      name: 'mock-suite-holder',
      inject: ['bench'],
      apply(c: Context) {
        c.bench.registerSuite({ name: 'custom-x', load: async () => [] });
      },
    };
    const fiber = ctx.plugin(holderRow as any);
    await fiber;
    expect(ctx.bench.listSuites().map((s) => s.name)).toContain('custom-x');
    expect(() => ctx.bench.registerSuite({ name: 'bfcl', load: async () => [] })).toThrow('已注册');
    await fiber.dispose();
    expect(ctx.bench.listSuites().map((s) => s.name)).not.toContain('custom-x');
    // 行卸载（bench fiber）后服务随之消失
    const benchFiber = fibers.find((f) => f.name === 'ac-bench');
    if (benchFiber && benchFiber.uid !== null) {
      await benchFiber.dispose();
      expect((ctx as Partial<Context>).bench).toBeUndefined();
    }
  });
});
