// ============================================================
// chain.test.ts —— 迁移链核心单测（cr-1036 批1 / migration-chain-completeness.md §五）
//
// 锁定四断言 + 执行语义：
//   1. 严格相邻：to === from + 1（跳版/负数/非整数 = 红）；
//   2. from 无重复：同一起点两条边 = 注册错误；
//   3. 链完整：v0..current 每环都在，缺环 fail-loud 列名；
//   4. 未来拒绝：stored > current 显式抛错，绝不静默降级读；
//   5. 执行：plan 现算剩余边 + 逐边应用可审计 + migrate 抛错透传。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  validateChain, assertChainIntegrity, planChain, runChain, chainCurrent,
  type MigrationEdge,
} from '../src/chain.ts';

const edge = (from: number, migrate?: (v: number) => number): MigrationEdge<number> => ({
  from,
  to: from + 1,
  migrate: migrate !== undefined ? migrate : (v) => v + 1,
});

describe('断言 1：严格相邻', () => {
  it('跳版边（to ≠ from + 1）= adjacent 红，列名 from→to', () => {
    const bad: MigrationEdge<number>[] = [{ from: 0, to: 2, migrate: (v) => v }];
    const errs = validateChain(bad);
    expect(errs).toHaveLength(1);
    expect(errs[0].assertion).toBe('adjacent');
    expect(errs[0].message).toContain('0→2');
  });

  it('负数/非整数 from 同判 adjacent', () => {
    const bad: MigrationEdge<number>[] = [
      { from: -1, to: 0, migrate: (v) => v },
      { from: 1.5, to: 2.5, migrate: (v) => v },
    ];
    const errs = validateChain(bad);
    expect(errs).toHaveLength(2);
    expect(errs.every((e) => e.assertion === 'adjacent')).toBe(true);
  });
});

describe('断言 2：from 无重复', () => {
  it('同一起点两条边 = duplicate 红，两条边都列名', () => {
    const bad: MigrationEdge<number>[] = [edge(0), edge(0)];
    const errs = validateChain(bad);
    expect(errs).toHaveLength(1);
    expect(errs[0].assertion).toBe('duplicate');
    expect(errs[0].message).toContain('v0→v1 与 v0→v1');
  });

  it('链内无重复 from（v0→v1、v1→v2）= 零违规', () => {
    expect(validateChain([edge(0), edge(1)])).toEqual([]);
  });
});

describe('断言 3：链完整（缺环 fail-loud）', () => {
  it('v0→v1 与 v2→v3 在场、v1→v2 缺失 = complete 红，缺环列名', () => {
    const bad: MigrationEdge<number>[] = [edge(0), edge(2)];
    const errs = validateChain(bad);
    expect(errs).toHaveLength(1);
    expect(errs[0].assertion).toBe('complete');
    expect(errs[0].message).toContain('v1→v2 边未注册');
  });

  it('孤立高位边（只有 v5→v6）= 逐起点列名 v0..v4 五处缺环', () => {
    const bad: MigrationEdge<number>[] = [edge(5)];
    const errs = validateChain(bad);
    expect(errs.every((e) => e.assertion === 'complete')).toBe(true);
    expect(errs).toHaveLength(5);
  });
});

describe('断言 4：未来拒绝（stored > current 显式抛错）', () => {
  it('stored 超前 = 抛错并明示新数据旧代码', () => {
    expect(() => planChain([edge(0)], 2)).toThrow(/未来版本拒绝降级读.*current v1/);
  });

  it('stored = current = 空计划（已是最新，零迁移）', () => {
    expect(planChain([edge(0)], 1)).toEqual([]);
  });

  it('stored 非法（负数/非整数）= 抛错', () => {
    expect(() => planChain([edge(0)], -1)).toThrow('存量版本非法');
    expect(() => planChain([edge(0)], 0.5)).toThrow('存量版本非法');
  });
});

describe('执行语义：plan 现算 + 逐边应用可审计', () => {
  it('runChain 逐边接力：v0 值经三边到 v3，reports 逐边记录', () => {
    const chain = [
      edge(0, (v) => v + 1),
      edge(1, (v) => v * 10),
      edge(2, (v) => v + 5),
    ];
    const out = runChain(chain, { version: 0, value: 0 });
    // 0 →(+1) 1 →(*10) 10 →(+5) 15
    expect(out.value).toBe(15);
    expect(out.version).toBe(3);
    expect(out.reports).toEqual([
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ]);
  });

  it('plan 只取剩余边：stored v2 → 只应用 v2→v3', () => {
    const chain = [edge(0), edge(1), edge(2)];
    const out = runChain(chain, { version: 2, value: 7 });
    expect(out.value).toBe(8);
    expect(out.reports).toEqual([{ from: 2, to: 3 }]);
  });

  it('migrate 抛错透传（不可迁显式报告，纯库不猜降级）', () => {
    const chain = [edge(0, () => { throw new Error('不可迁：字段已删'); })];
    expect(() => runChain(chain, { version: 0, value: 1 })).toThrow('不可迁：字段已删');
  });

  it('migrate 收到的值 = 前边产物（接力顺序由 plan 排序保证）', () => {
    const seen: number[] = [];
    const chain = [
      edge(1, (v) => { seen.push(v); return v; }),
      edge(0, (v) => { seen.push(v); return v + 1; }),
    ];
    runChain(chain, { version: 0, value: 0 });
    expect(seen).toEqual([0, 1]);
  });

  it('migrate 的 this 与外部捕获：纯函数约定（无 this 依赖）', () => {
    const chain = [edge(0, function (v) { return v + 1; })];
    expect(runChain(chain, { version: 0, value: 41 }).value).toBe(42);
  });
});

describe('注册面：assertChainIntegrity（注册时即红）', () => {
  it('完备链静默通过；缺环链抛错列名形态名', () => {
    expect(() => assertChainIntegrity('agent.patch', [edge(0), edge(1)])).not.toThrow();
    expect(() => assertChainIntegrity('agent.patch', [edge(0), edge(2)]))
      .toThrow('迁移链不完备（agent.patch）');
  });
});

describe('chainCurrent：空链 = v0 起点形态', () => {
  it('空链 current = 0，stored v0 = 空计划合法', () => {
    expect(chainCurrent([])).toBe(0);
    expect(planChain([], 0)).toEqual([]);
  });
});
