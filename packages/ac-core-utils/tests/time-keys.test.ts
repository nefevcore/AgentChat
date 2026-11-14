import { describe, it, expect } from 'vitest';
import { utcDayKey, utcMonthKey, DEFAULT_TZ, resolveTimezone } from '../src/time-keys.ts';

describe("utcDayKey / utcMonthKey（cr-1052 时间键单源：UTC 口径 + 补零）", () => {
  it('UTC 口径：只看 UTC 钟，与运行环境本地时区无关', () => {
    expect(utcDayKey(Date.UTC(2026, 10, 12, 20, 0, 0))).toBe('2026-11-12');
    expect(utcDayKey(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe('2026-01-01');
    expect(utcDayKey('2026-11-12T23:59:59.999Z')).toBe('2026-11-12');
    expect(utcDayKey('2026-11-13T00:00:00.000Z')).toBe('2026-11-13');
  });

  it('单数月/日补零（relay 旧 dayKeyOf 不补零的回归锚）', () => {
    expect(utcDayKey(Date.UTC(2026, 10, 5))).toBe('2026-11-05');
    expect(utcMonthKey(Date.UTC(2026, 0, 15))).toBe('202601');
    expect(utcMonthKey(Date.UTC(2027, 11, 31, 23, 59))).toBe('202712');
  });
});

describe('DEFAULT_TZ / resolveTimezone（cr-1053 缺省时区单源）', () => {
  it('常量锚：DEFAULT_TZ = Asia/Shanghai（产品主市场基线）', () => {
    expect(DEFAULT_TZ).toBe('Asia/Shanghai');
  });

  it('空/白串 → DEFAULT_TZ；合法原样；非法 → DEFAULT_TZ', () => {
    expect(resolveTimezone(undefined)).toBe('Asia/Shanghai');
    expect(resolveTimezone('  ')).toBe('Asia/Shanghai');
    expect(resolveTimezone('America/New_York')).toBe('America/New_York');
    expect(resolveTimezone('Mars/Olympus')).toBe('Asia/Shanghai');
  });
});
