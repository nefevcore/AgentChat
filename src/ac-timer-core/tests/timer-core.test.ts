// ============================================================
// ac-timer-core：间隔解析 / 目标时间 / 节假日（调休优先）/ 模板 / 恢复延迟
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  createHolidayResolver,
  describeEntry,
  formatWeekdayLabel,
  isFullDatetime,
  isWeekdayTime,
  localISO,
  msUntilTime,
  nextDelayOf,
  parseInterval,
  randomDelay,
  renderHint,
  type TimerEntry,
} from '../src/index.ts';

describe('ac-timer-core parseInterval', () => {
  it('组合单位累加；ms 单位（正则序）；非法/零 → null', () => {
    expect(parseInterval('300ms')).toBe(300);
    expect(parseInterval('30s')).toBe(30_000);
    expect(parseInterval('5m')).toBe(300_000);
    expect(parseInterval('2h30m')).toBe(2 * 3600_000 + 30 * 60_000);
    expect(parseInterval('1d')).toBe(24 * 3600_000);
    expect(parseInterval('0s')).toBeNull();
    expect(parseInterval('abc')).toBeNull();
    expect(parseInterval('')).toBeNull();
  });
});

describe('ac-timer-core msUntilTime', () => {
  const at = (iso: string) => new Date(iso);

  it('每日 HH:mm：未来时刻；已过顺延次日', () => {
    const now = at('2026-08-22T10:00:00');
    expect(msUntilTime('10:30', now)).toBe(30 * 60_000);
    expect(msUntilTime('09:30', now)).toBe(23.5 * 3600_000); // 次日
  });

  it('指定日期：未来有效；已过 → null', () => {
    const now = at('2026-08-22T10:00:00');
    expect(msUntilTime('2026-08-23T09:00', now)).toBe(23 * 3600_000);
    expect(msUntilTime('2026-08-22 09:00', now)).toBeNull();
    expect(msUntilTime('2026-08-22T10:00', now)).toBeNull(); // 恰好现在 = 已过
  });

  it('周几：本周未到按差值；已过顺延下周', () => {
    const now = at('2026-08-22T10:00:00'); // 周六
    expect(msUntilTime('Sun 11:00', now)).toBe(25 * 3600_000); // 次日周日
    expect(msUntilTime('周六 12:00', now)).toBe(2 * 3600_000); // 当天晚些
    expect(msUntilTime('周六 09:00', now)).toBe(7 * 24 * 3600_000 - 3600_000); // 已过 → 下周六 09:00
  });

  it('非法输入 → null', () => {
    expect(msUntilTime('25:00')).toBeNull();
    expect(msUntilTime('xx:00')).toBeNull();
    expect(msUntilTime('Foo 12:00')).toBeNull();
  });
});

describe('ac-timer-core 格式辅助', () => {
  it('isFullDatetime / isWeekdayTime / formatWeekdayLabel', () => {
    expect(isFullDatetime('2026-08-23T09:00')).toBe(true);
    expect(isFullDatetime('09:00')).toBe(false);
    expect(isWeekdayTime('Sun 12:00')).toBe(true);
    expect(isWeekdayTime('周日 12:00')).toBe(true);
    expect(isWeekdayTime('09:00')).toBe(false);
    expect(formatWeekdayLabel('Sun 12:00')).toBe('每周日 12:00');
    expect(formatWeekdayLabel('周一 09:00')).toBe('每周一 09:00');
  });

  it('describeEntry 五模式标签', () => {
    const e = (mode: TimerEntry['mode'], extra: Partial<TimerEntry> = {}): TimerEntry =>
      ({ id: 'x', enabled: true, mode, hint: 'h', ...extra }) as TimerEntry;
    expect(describeEntry(e('time', { time: '09:00' }))).toBe('每天 09:00');
    expect(describeEntry(e('time', { time: '2026-08-23T09:00' }))).toBe('2026-08-23T09:00');
    expect(describeEntry(e('workday', { time: '09:00' }))).toBe('工作日 09:00');
    expect(describeEntry(e('holiday', { time: '09:00' }))).toBe('节假日 09:00');
    expect(describeEntry(e('random', { delayMin: '1m', delayMax: '2m' }))).toBe('随机 1m~2m');
    expect(describeEntry(e('delay', { delay: '30m' }))).toBe('每隔 30m');
  });

  it('randomDelay：范围约束', () => {
    for (let i = 0; i < 20; i++) {
      const d = randomDelay('1m', '2m');
      expect(d).toBeGreaterThanOrEqual(60_000);
      expect(d).toBeLessThanOrEqual(120_000);
    }
    expect(randomDelay('5m', '1m')).toBe(60_000); // min>=max → max（src 语义）
  });
});

describe('ac-timer-core 节假日', () => {
  it('周末为假；调休优先；配置节假日生效', () => {
    const resolve = createHolidayResolver({
      holidays: ['2026-08-24'], // 周一
      makeupWorkdays: ['2026-08-22'], // 周六调休上班
    });
    expect(resolve.isHoliday(new Date('2026-08-22T12:00:00'))).toBe(false); // 周六但调休
    expect(resolve.isWorkday(new Date('2026-08-22T12:00:00'))).toBe(true);
    expect(resolve.isHoliday(new Date('2026-08-23T12:00:00'))).toBe(true); // 周日
    expect(resolve.isHoliday(new Date('2026-08-24T12:00:00'))).toBe(true); // 周一配置节假日
    expect(resolve.isWorkday(new Date('2026-08-25T12:00:00'))).toBe(true); // 普通周二
  });

  it('阳历固定节日（元旦/清明/劳动/国庆）', () => {
    const { isHoliday } = createHolidayResolver();
    expect(isHoliday(new Date('2026-01-01T12:00:00'))).toBe(true);
    expect(isHoliday(new Date('2026-10-02T12:00:00'))).toBe(true);
    expect(isHoliday(new Date('2026-05-02T12:00:00'))).toBe(true);
    // 普通工作日不是节假日
    expect(isHoliday(new Date('2026-08-25T12:00:00'))).toBe(false);
  });
});

describe('ac-timer-core localISO / renderHint', () => {
  it('localISO：偏移推导（东八区整点）', () => {
    const s = localISO(new Date('2026-08-22T02:00:00Z'));
    expect(s).toBe('2026-08-22T10:00:00+08:00');
  });

  it('renderHint：模板变量', () => {
    const entry: TimerEntry = { id: 'x', enabled: true, mode: 'time', time: '09:30', hint: '' };
    const out = renderHint('现在 {{time}}，定时 {time}，日期 {{date}}', entry, new Date('2026-08-22T15:04:00'));
    expect(out).toContain('现在 15:04');
    expect(out).toContain('定时 09:30');
    expect(out).toContain('2026');
  });
});

describe('ac-timer-core nextDelayOf（恢复态）', () => {
  it('delay：持久化状态抵扣已流逝时间', () => {
    const entry: TimerEntry = { id: 'x', enabled: true, mode: 'delay', delay: '10m', hint: 'h' };
    const now = Date.now();
    expect(nextDelayOf(entry, { startedAt: new Date(now - 4 * 60_000).toISOString(), totalDelayMs: 600_000 }, now)).toBe(6 * 60_000);
    // 超时恢复 → 0（立即触发）
    expect(nextDelayOf(entry, { startedAt: new Date(now - 11 * 60_000).toISOString(), totalDelayMs: 600_000 }, now)).toBe(0);
    // 无状态 → 全量延迟
    expect(nextDelayOf(entry, undefined, now)).toBe(600_000);
  });

  it('time：msUntilTime 语义', () => {
    const entry: TimerEntry = { id: 'x', enabled: true, mode: 'time', time: '23:59', hint: 'h' };
    const d = nextDelayOf(entry, undefined, new Date('2026-08-22T10:00:00').getTime());
    expect(d).toBe((23 * 60 + 59 - 10 * 60) * 60_000);
  });
});
