// ============================================================
// src/agents/config-diff 单元测试 —— 配置 diff/merge 纯函数
// ============================================================
import { describe, it, expect } from 'vitest';
import { deepMerge, computeDiff } from '../src/config-diff';

describe('deepMerge', () => {
  it('基本类型：source 覆盖 target（纯函数，不修改入参）', () => {
    const target = { a: 1, b: 2 };
    const result = deepMerge(target, { b: 3, c: 4 } as any);
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
    expect(target).toEqual({ a: 1, b: 2 }); // 入参不变
  });

  it('嵌套对象：递归合并子键', () => {
    const result = deepMerge(
      { llm: { provider: 'deepseek', temperature: 0.5 } },
      { llm: { temperature: 0.8 } } as any,
    );
    expect(result).toEqual({ llm: { provider: 'deepseek', temperature: 0.8 } });
  });

  it('undefined：source 为 undefined 时保留 target 值', () => {
    const result = deepMerge({ a: 1 }, { a: undefined } as any);
    expect(result).toEqual({ a: 1 });
  });

  it('数组：整体覆盖（不合并）', () => {
    const result = deepMerge({ tools: ['a'] }, { tools: ['b', 'c'] });
    expect(result.tools).toEqual(['b', 'c']);
  });

  it('null：视为覆盖值', () => {
    const result = deepMerge({ a: 1 }, { a: null } as any);
    expect(result).toEqual({ a: null });
  });
});

describe('computeDiff', () => {
  const base = {
    agent_id: 'a',
    name: 'A',
    llm: { provider: 'deepseek', temperature: 0.5, model: 'm1' },
    tools: ['bash'],
    tags: ['dev'],
  };

  it('与 base 相同的值不进 diff；agent_id/name 始终保留', () => {
    const diff = computeDiff({ ...base }, base);
    expect(diff).toEqual({ agent_id: 'a', name: 'A' });
  });

  it('不同的值纳入 diff；base 中没有的键纳入', () => {
    const agent = {
      ...base,
      llm: { ...base.llm, temperature: 0.8 },
      tags: ['dev', 'qa'],
      avatar: 'x.png',
    };
    const diff = computeDiff(agent, base);
    expect(diff.agent_id).toBe('a');
    expect(diff.name).toBe('A');
    expect((diff.llm as any).temperature).toBe(0.8);
    expect((diff.llm as any).provider).toBeUndefined(); // 与 base 相同 → 不进
    expect((diff.llm as any).model).toBeUndefined();
    expect(diff.tags).toEqual(['dev', 'qa']);
    expect(diff.avatar).toBe('x.png');
    expect(diff.tools).toBeUndefined(); // 相同 → 不进
  });

  it('deepMerge 与 computeDiff 互逆：diff 后可 merge 还原', () => {
    const agent = {
      agent_id: 'a',
      name: 'A',
      llm: { provider: 'deepseek', temperature: 0.9, model: 'm2' },
      tools: ['bash', 'read'],
      tags: ['dev'],
    };
    const diff = computeDiff(agent, base);
    const restored = deepMerge(base as any, diff as any);
    expect(restored).toEqual(agent);
  });
});
