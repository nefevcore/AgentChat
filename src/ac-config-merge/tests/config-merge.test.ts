// ============================================================
// ac-config-merge：deepMerge / computeDiff 纯函数语义
// ============================================================
import { describe, it, expect } from 'vitest';
import { computeDiff, deepMerge } from '../src/index.ts';

describe('deepMerge', () => {
  it('基本类型/数组：source 覆盖 target', () => {
    expect(
      deepMerge({ a: 1, b: 'x', c: [1, 2] } as Record<string, unknown>, { a: 2, c: [3] }),
    ).toEqual({ a: 2, b: 'x', c: [3] });
  });

  it('普通对象递归合并子键；undefined 不覆盖', () => {
    const base: Record<string, unknown> = { llm: { model: 'a', temperature: 0.5 }, top: 1 };
    const merged = deepMerge(base, { llm: { model: 'b' }, top: undefined });
    expect(merged).toEqual({ llm: { model: 'b', temperature: 0.5 }, top: 1 });
  });

  it('纯函数：不变异入参', () => {
    const base: Record<string, unknown> = { o: { x: 1 } };
    deepMerge(base, { o: { y: 2 } });
    expect(base).toEqual({ o: { x: 1 } });
  });

  it('类型不匹配（对象 vs 标量）→ source 整体覆盖', () => {
    expect(deepMerge({ o: { x: 1 } } as Record<string, unknown>, { o: 'flat' })).toEqual({ o: 'flat' });
    expect(deepMerge({ o: 'flat' } as Record<string, unknown>, { o: { x: 1 } })).toEqual({ o: { x: 1 } });
  });

  it('null 视为值覆盖（非递归点）', () => {
    expect(deepMerge({ o: { x: 1 } } as Record<string, unknown>, { o: null })).toEqual({ o: null });
  });
});

describe('computeDiff', () => {
  it('只检出与基准不同的键；base 缺失的键纳入', () => {
    const diff = computeDiff(
      { id: 'a1', model: 'glm-5.3', system: '自定义', extra: true },
      { model: 'glm-5.3', system: '默认' },
    );
    expect(diff).toEqual({ id: 'a1', system: '自定义', extra: true });
  });

  it('身份键（id/agent_id/name）始终保留', () => {
    expect(computeDiff({ id: 'x', name: 'n' }, { id: 'x', name: 'n' })).toEqual({ id: 'x', name: 'n' });
  });

  it('嵌套对象递归 diff：仅差异子键；子级无差异则整体省略', () => {
    const diff = computeDiff(
      { llm: { model: 'a', temp: 0.5 }, settings: { persona: { text: 'p' } } },
      { llm: { model: 'a', temp: 0.7 }, settings: { persona: { text: 'p' } } },
    );
    expect(diff).toEqual({ llm: { temp: 0.5 } });
  });

  it('数组按值比较（JSON 语义）：相同不检出，不同整体纳入', () => {
    expect(computeDiff({ tools: ['a', 'b'] }, { tools: ['a', 'b'] })).toEqual({});
    expect(computeDiff({ tools: ['a'] }, { tools: ['a', 'b'] })).toEqual({ tools: ['a'] });
  });

  it('round-trip：diff 保存后 deepMerge(base, diff) 还原有效配置', () => {
    const base = { model: 'glm-5.3', system: '默认', maxSteps: 10 };
    const effective = { id: 'a1', model: 'deepseek-v4-flash', system: '默认', maxSteps: 10 };
    const diff = computeDiff(effective, base);
    expect(deepMerge({ ...base }, diff as Partial<typeof base>)).toEqual(effective);
  });
});
