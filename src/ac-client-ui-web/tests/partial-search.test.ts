// ============================================================
// ac-client-ui-web/tests/partial-search.test.ts —— 截断恢复纯库单测
//（node 环境直跑——纯函数，零 pinia/vue 依赖；cr-466 抽库补覆盖）
// ============================================================
import { describe, it, expect } from 'vitest';
import { partialSearchOf } from '../client/partialSearch.ts';

/** 构造 subcall 补行截断载荷（完整 JSON 的前 headLen 字节） */
function truncatedHeadOf(output: unknown, headLen: number): Record<string, unknown> {
  return { __truncated: true, head: JSON.stringify({ output }).slice(0, headLen), bytes: 9999 };
}

describe('partialSearchOf —— 历史截断形部分恢复（cr-466 抽库）', () => {
  it('非截断形直接 null（零解析开销）', () => {
    expect(partialSearchOf({ query: 'q', results: [] })).toBeNull();
    expect(partialSearchOf({ __truncated: true })).toBeNull(); // head 非 string
    expect(partialSearchOf({})).toBeNull();
  });

  it('截断点落在元素内 → 丢弃残元素，恢复之前的完整元素 + preamble', () => {
    const out = {
      provider: 'tavily', query: 'agentchat 插件', answer: 'A',
      results: [
        { title: 't1', url: 'https://a/1', content: 'c1', score: 0.9 },
        { title: 't2', url: 'https://a/2', content: 'c2', score: 0.8 },
      ],
    };
    const full = JSON.stringify({ output: out });
    const cut = full.indexOf('t2') + 1; // 第二个元素 title 中间
    const r = partialSearchOf(truncatedHeadOf(out, cut))!;
    expect(r.provider).toBe('tavily');
    expect(r.query).toBe('agentchat 插件');
    expect(r.answer).toBe('A');
    expect(r.results).toEqual([out.results[0]]);
  });

  it('元素内容含转义引号/嵌套大括号 → 转义感知扫描正确恢复', () => {
    const out = {
      query: 'q',
      results: [
        { title: 'he said "hi"', url: 'https://a/?x={y}', content: 'a\\b', score: 1 },
        { title: 'next', url: 'u2', content: 'c2', score: 2 },
      ],
    };
    const full = JSON.stringify({ output: out });
    const cut = full.indexOf('next') + 2; // 第二元素 title 中间截断
    const r = partialSearchOf(truncatedHeadOf(out, cut))!;
    expect(r.results.length).toBe(1); // 残元素丢弃
    expect(r.results[0]).toEqual(out.results[0]); // 转义/嵌套完整恢复
  });

  it('截断在 results 数组之前 → null（无从恢复）', () => {
    const out = { query: 'q', results: [{ title: 't', url: 'u', content: 'c', score: 1 }] };
    const full = JSON.stringify({ output: out });
    expect(partialSearchOf(truncatedHeadOf(out, full.indexOf('"results"')))).toBeNull();
  });

  it('截断恢复几条算几条：3 元素截断在第 3 元素 → 前 2 条', () => {
    const out = { results: [1, 2, 3].map((i) => ({ title: 't' + i, url: 'https://a/' + i, content: 'c' + i, score: i / 10 })) };
    const full = JSON.stringify({ output: out });
    const r = partialSearchOf(truncatedHeadOf(out, full.indexOf('t3')))!;
    expect(r.results.length).toBe(2);
  });
});
