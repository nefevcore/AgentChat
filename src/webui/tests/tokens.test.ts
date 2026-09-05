// ============================================================
// tokens.test.ts —— 前端 token 估算（展示口径）
// 与后端 ac-text-budget estimateTokens 同款启发式（CJK 0.6/其他 0.3，
// 逐串向上取整）——Token 详情弹层的固定开销拆分以此计数。
// ============================================================
import { describe, it, expect } from 'vitest';
import { estimateTokens, fmtTokenCount } from '../src/utils/tokens';

describe('estimateTokens（展示口径，对齐 ac-text-budget）', () => {
  it('CJK 0.6/字，其他 0.3/字符，逐串向上取整', () => {
    expect(estimateTokens('话'.repeat(10))).toBe(6);       // 10 × 0.6 = 6
    expect(estimateTokens('x'.repeat(10))).toBe(3);        // 10 × 0.3 = 3
    expect(estimateTokens('bash{}')).toBe(2);              // 6 × 0.3 = 1.8 → 2
    expect(estimateTokens('话'.repeat(5) + 'bash{}')).toBe(5); // 3 + 2
  });

  it('空值计 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });
});

describe('fmtTokenCount（K/M 级约化）', () => {
  it('<1K 原样（小值不失真）', () => {
    expect(fmtTokenCount(0)).toBe('0');
    expect(fmtTokenCount(313)).toBe('313');
    expect(fmtTokenCount(999)).toBe('999');
  });

  it('K 档：≥100K 取整、1K~100K 一位小数', () => {
    expect(fmtTokenCount(1_000)).toBe('1K');
    expect(fmtTokenCount(8_901)).toBe('8.9K');
    expect(fmtTokenCount(12_345)).toBe('12.3K');
    expect(fmtTokenCount(98_762)).toBe('98.8K');
    expect(fmtTokenCount(118_762)).toBe('119K');
    expect(fmtTokenCount(196_025)).toBe('196K');
    expect(fmtTokenCount(999_499)).toBe('999K');
  });

  it('M 档：≥999.5K 进位（K 舍入到 1000K 的边界）、一位小数、≥100M 取整', () => {
    expect(fmtTokenCount(999_500)).toBe('1M');
    expect(fmtTokenCount(1_000_000)).toBe('1M');
    expect(fmtTokenCount(1_048_576)).toBe('1M');
    expect(fmtTokenCount(1_500_000)).toBe('1.5M');
    expect(fmtTokenCount(12_300_000)).toBe('12.3M');
    expect(fmtTokenCount(123_000_000)).toBe('123M');
  });
});
