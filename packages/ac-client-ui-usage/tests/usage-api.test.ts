// ============================================================
// ac-client-ui-usage/tests/usage-api.test.ts —— usageApi 纯函数面
//
// 主路径（形状映射/范围过滤/fetchUsageTokens 聚合）已由 webui/tests/
// port-b.test.ts 契约锁覆盖（住 webui 包）；本文件补包内可独立回归的
// 回退路径与边界：aggRow 缺省口径、range 推导、缺省 rpc 拒绝桩——
// 包内测试进 typecheck 覆盖面（webui tests 不进），防漂移。
// ============================================================
import { describe, it, expect } from 'vitest';
import { toUsageSummary, filterUsageRange, fetchUsageTokens, type PUsageResult } from '../client/usageApi.ts';

const DAY_A = '2026-01-01';
const DAY_B = '2026-01-05';

describe('usageApi · toUsageSummary 回退口径', () => {
  it('aggRow 全缺省字段：total 缺失时 prompt+completion 兜底、elapsed/计数归零', () => {
    const u: PUsageResult = {
      byAgent: { a: { prompt: 3, completion: 2 } },
      byModel: {},
      byDay: [{ date: DAY_A, prompt: 3, completion: 2 }],
      byConversation: {},
      totals: { prompt: 3, completion: 2 },
    };
    const s = toUsageSummary(u);
    expect(s.overall).toMatchObject({
      total_prompt_tokens: 3,
      total_completion_tokens: 2,
      total_tokens: 5, // total 缺失 → prompt+completion
      total_records: 0,
      total_cache_hit: 0,
      total_elapsed_ms: 0,
    });
    expect(s.by_agent[0]).toMatchObject({ agent: 'a', total_tokens: 5, record_count: 0, last_used: '' });
    expect(s.range).toEqual({ from: DAY_A, to: DAY_A });
    // 空日期集 → range 两端 null
    const empty = toUsageSummary({ ...u, byDay: [] });
    expect(empty.range).toEqual({ from: null, to: null });
  });

  it('byPair 行 total 缺失兜底 prompt+completion；by_day_pair 缺失维保持 undefined（旧后端信号）', () => {
    const u: PUsageResult = {
      byAgent: {},
      byModel: {},
      byDay: [],
      byConversation: {},
      byPair: [{ a: 'user', b: 'x', prompt: 4, completion: 1, runs: 2 }],
      totals: { prompt: 0, completion: 0 },
    };
    const s = toUsageSummary(u);
    expect(s.by_pair).toEqual([{ a: 'user', b: 'x', total_tokens: 5, record_count: 2 }]);
    expect(s.by_day_pair).toBeUndefined();
    expect(s.by_day_llm).toEqual([]);
  });
});

describe('usageApi · filterUsageRange 边界', () => {
  const base = toUsageSummary({
    byAgent: { a: { prompt: 4, completion: 2, total: 6, runs: 1 } },
    byModel: {},
    byDay: [
      { date: DAY_A, prompt: 4, completion: 2, total: 6, runs: 1 },
      { date: DAY_B, prompt: 8, completion: 4, total: 12, runs: 2, elapsedMs: 1000 },
    ],
    byConversation: {},
    byDayPair: [
      { date: DAY_A, a: 'user', b: 'a', prompt: 4, completion: 2, total: 6, runs: 1 },
      { date: DAY_B, a: 'user', b: 'a', prompt: 8, completion: 4, total: 12, runs: 2 },
      { date: DAY_B, a: 'a', b: 'b', prompt: 1, completion: 1, total: 2, runs: 1 },
    ],
    byPair: [{ a: 'user', b: 'a', prompt: 12, completion: 6, total: 18, runs: 3 }],
    totals: { prompt: 12, completion: 6, total: 18, runs: 3 },
  });

  it('空参数原样返回（引用同一）', () => {
    expect(filterUsageRange(base, {})).toBe(base);
  });

  it('from/to 边界含端点（闭区间）；窗口外 by_day_pair 行剔除后按端点对求和重建（total 降序）', () => {
    const f = filterUsageRange(base, { from: DAY_B, to: DAY_B });
    expect(f.by_day.map((d) => d.date)).toEqual([DAY_B]);
    expect(f.by_pair).toEqual([
      { a: 'user', b: 'a', total_tokens: 12, record_count: 2 },
      { a: 'a', b: 'b', total_tokens: 2, record_count: 1 },
    ]);
    expect(f.overall).toMatchObject({ total_tokens: 12, total_records: 2, total_elapsed_ms: 1000 });
  });

  it('窗口内无行：overall 归零、by_pair 空数组（by_day_pair 维存在时空集语义）', () => {
    const f = filterUsageRange(base, { from: '2027-01-01', to: '2027-12-31' });
    expect(f.by_day).toEqual([]);
    expect(f.by_pair).toEqual([]);
    expect(f.overall.total_tokens).toBe(0);
    expect(f.overall.total_records).toBe(0);
  });

  it('days 窗口：cutoff 边界当日行保留（>= 语义）', () => {
    const today = new Date().toISOString().slice(0, 10);
    const withToday = toUsageSummary({
      byAgent: {},
      byModel: {},
      byDay: [{ date: today, prompt: 1, completion: 1, total: 2, runs: 1 }],
      byConversation: {},
      totals: { prompt: 1, completion: 1, total: 2, runs: 1 },
    });
    const f = filterUsageRange(withToday, { days: 1 });
    expect(f.by_day.map((d) => d.date)).toEqual([today]);
  });
});

describe('usageApi · fetchUsageTokens rpc 注入', () => {
  it('缺省 rpc（clientRuntime 未装配）→ 拒绝桩 reject（调用方 catch 归一空态）', async () => {
    await expect(fetchUsageTokens({})).rejects.toThrow(/client runtime 未装配/);
  });
});
