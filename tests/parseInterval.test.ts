import { describe, it, expect } from 'vitest';
import { parseInterval } from '@plugins/builtin/src/timer';

describe('parseInterval', () => {
  it('支持秒/分钟/小时', () => {
    expect(parseInterval('30s')).toBe(30_000);
    expect(parseInterval('15m')).toBe(900_000);
    expect(parseInterval('2h')).toBe(7_200_000);
    expect(parseInterval('1h30m')).toBe(5_400_000);
  });

  it('支持天（d/day/days）', () => {
    expect(parseInterval('7d')).toBe(604_800_000);
    expect(parseInterval('1d')).toBe(86_400_000);
    expect(parseInterval('3 days')).toBe(259_200_000);
    expect(parseInterval('2d 12h')).toBe(216_000_000);
  });

  it('支持复合间隔', () => {
    expect(parseInterval('1d 2h 30m')).toBe(95_400_000);
  });

  it('无效输入返回 null', () => {
    expect(parseInterval('')).toBe(null);
    expect(parseInterval('abc')).toBe(null);
    expect(parseInterval('0')).toBe(null);
    expect(parseInterval('7x')).toBe(null);
  });

  it('大小写与空格容忍', () => {
    expect(parseInterval(' 2D ')).toBe(172_800_000);
    expect(parseInterval('1 DAY')).toBe(86_400_000);
  });
});
