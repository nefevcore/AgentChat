// ============================================================
// ac-timer-core 单测（cr-1147 v2 探测循环）：utils 纯函数包 /
// validateScriptEntries / nextWaitMs / inspectVerdict（cr-1149 verdict 校验）/
// compileEntry 全模式（不炸不丢）。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  CHECK_FLOOR_MS,
  compileEntry,
  createHolidayResolver,
  inspectVerdict,
  isLegacyEntryShape,
  localISO,
  makeTimerUtils,
  msUntilTime,
  nextWaitMs,
  parseInterval,
  validateScriptEntries,
  type LegacyTimerEntry,
  type TimerCheckArgs,
  type TimerUtils,
} from '../src/index.ts';

const u: TimerUtils = makeTimerUtils({ tz: 'Asia/Shanghai' });

const e = (over: Partial<LegacyTimerEntry>): LegacyTimerEntry => ({
  id: 'x', enabled: true, mode: 'delay', hint: 'h', ...over,
});

/** 固定「现在」的测试 args（2026-11-17 周二 09:05 上海） */
const args = (over: Partial<TimerCheckArgs> = {}): TimerCheckArgs => ({
  now: '2026-11-17T09:05:00+08:00',
  count: 0,
  ...over,
});

/** 求值编译产物（注入 utils；Date 序列化为 ISO 便于断言） */
function runCompiled(code: string, a: TimerCheckArgs): Record<string, unknown> {
  const fn = eval('(' + code + ')') as (x: TimerCheckArgs, utils: TimerUtils) => Record<string, unknown>;
  return fn(a, u);
}

describe('makeTimerUtils', () => {
  it('minute/day/dow 墙钟（上海时区）', () => {
    const t = new Date('2026-11-17T09:05:00+08:00');
    expect(u.minute(t)).toBe(545);
    expect(u.day(t)).toBe('2026-11-17');
    expect(u.dow(t)).toBe(2);
  });
  it('workday：周末/工作日', () => {
    expect(u.workday(new Date('2026-11-17T12:00:00+08:00'))).toBe(true); // 周二
    expect(u.workday(new Date('2026-11-14T12:00:00+08:00'))).toBe(false); // 周六
  });
  it('ms 间隔串解析', () => {
    expect(u.ms('30m')).toBe(1_800_000);
    expect(u.ms('2h30m')).toBe(9_000_000);
    expect(u.ms('bad')).toBeNull();
  });
  it('at 钟面顺延（09:05 后的下一个 09:00 = 次日）', () => {
    const d = u.at('09:00');
    expect(d.getTime()).toBeGreaterThan(new Date('2026-11-17T09:05:00+08:00').getTime());
  });
  it('after 显式锚点', () => {
    const d = u.after('30m', new Date('2026-11-17T08:00:00Z'));
    expect(d.toISOString()).toBe('2026-11-17T08:30:00.000Z');
  });
  it('after：from 收 ISO 串（a.now 可直传）——cr-1149', () => {
    const d = u.after('30m', '2026-11-17T08:00:00Z');
    expect(d.toISOString()).toBe('2026-11-17T08:30:00.000Z');
  });
  it('after：锚点/间隔串解析不出一律抛错（不再静默退化为 now）', () => {
    expect(() => u.after('30m', 123 as unknown as Date)).toThrow('第二参');
    expect(() => u.after('30m', 'not-a-date')).toThrow('无法解析');
    expect(() => u.after('nonsense')).toThrow('间隔串');
  });
  it('at：非法时刻串抛错', () => {
    expect(() => u.at('2027-01-01')).toThrow('u.at');
  });
});

describe('inspectVerdict（cr-1149 干跑/运行期共用判据）', () => {
  const now = new Date('2026-11-17T09:05:00+08:00');
  const later = new Date(now.getTime() + 60_000);
  it('合法 verdict：无 error 无 notes', () => {
    const r = inspectVerdict({ action: 'hi', next: later }, now);
    expect(r.error).toBeUndefined();
    expect(r.notes).toEqual([]);
  });
  it('next 非 Date → error（带 u.ms 不是 Date 的提示）', () => {
    const r = inspectVerdict({ next: '2027-01-01' }, now);
    expect(r.error).toContain('next 须为 Date');
    expect(r.error).toContain('u.ms()');
  });
  it('next 过期超容差（Date(0)）→ error（带 action 会按地板反复投递）', () => {
    const r = inspectVerdict({ next: new Date(0) }, now);
    expect(r.error).toContain('在过去');
    expect(r.error).toContain('反复投递');
  });
  it('next 刚过期（容差内）→ 放行 + 到期提示', () => {
    const r = inspectVerdict({ next: new Date(now.getTime() - 3_000) }, now);
    expect(r.error).toBeUndefined();
    expect(r.notes.join()).toContain('刚过期');
  });
  it('缺 next → error；active:false 不需要 next', () => {
    expect(inspectVerdict({}, now).error).toContain('next');
    expect(inspectVerdict({ active: false }, now).error).toBeUndefined();
  });
  it('action/active 类型不合法 → error', () => {
    expect(inspectVerdict({ action: 1, next: later }, now).error).toContain('action');
    expect(inspectVerdict({ active: 'no', next: later }, now).error).toContain('active');
  });
  it('非对象 verdict → error', () => {
    expect(inspectVerdict(undefined, now).error).toBeTruthy();
    expect(inspectVerdict([], now).error).toBeTruthy();
  });
});

describe('validateScriptEntries', () => {
  it('最小形状通过；缺 code 抛错', () => {
    const ok = validateScriptEntries([{ id: 'a', enabled: true, kind: 'script', code: '(a,u)=>({})' }]);
    expect(ok).toHaveLength(1);
    expect(() => validateScriptEntries([{ id: 'a', enabled: true, kind: 'script' } as never])).toThrow('code');
  });
  it('kind 非 script 抛错', () => {
    expect(() => validateScriptEntries([{ id: 'a', enabled: true, kind: 'mode', code: 'x' } as never])).toThrow('kind');
  });
});

describe('nextWaitMs（Date 唯一形态）', () => {
  it('未来 Date → 差值', () => {
    expect(nextWaitMs(new Date(Date.now() + 60_000))).toBeGreaterThanOrEqual(59_000);
  });
  it('过去 Date → 地板', () => {
    expect(nextWaitMs(new Date(Date.now() - 60_000))).toBe(CHECK_FLOOR_MS);
  });
  it('非 Date / undefined → null（脚本错误路径）', () => {
    expect(nextWaitMs(undefined)).toBeNull();
    expect(nextWaitMs('30m' as unknown as Date)).toBeNull();
    expect(nextWaitMs(new Date('bad'))).toBeNull();
  });
});

describe('compileEntry（不炸不丢）', () => {
  it('delay：首轮静默排满周期；次轮触发续排', () => {
    const code = compileEntry(e({ mode: 'delay', delay: '30m' })).code;
    const first = runCompiled(code, args());
    expect(first.action).toBeUndefined();
    expect(first.state).toEqual({ started: true });
    expect(first.next).toBeInstanceOf(Date);
    const second = runCompiled(code, args({ state: { started: true } }));
    expect(second.action).toBe('h');
    expect(second.next).toBeInstanceOf(Date);
  });
  it('delay 无串：终结', () => {
    expect(runCompiled(compileEntry(e({ mode: 'delay' })).code, args()).active).toBe(false);
  });
  it('random：首轮静默 + 区间内随机 Date', () => {
    const code = compileEntry(e({ mode: 'random', delayMin: '1m', delayMax: '2m' })).code;
    const first = runCompiled(code, args());
    expect(first.action).toBeUndefined();
    const d = first.next as Date;
    const from = Date.now();
    expect(d.getTime() - from).toBeGreaterThanOrEqual(60_000);
    expect(d.getTime() - from).toBeLessThanOrEqual(120_000 + 500);
  });
  it('time 每天：到点 + last 同日防重', () => {
    const code = compileEntry(e({ mode: 'time', time: '09:00' })).code;
    expect(runCompiled(code, args()).action).toBe('h');
    expect(runCompiled(code, args({ last: '2026-11-17T08:00:00+08:00' })).action).toBeUndefined();
    expect(runCompiled(code, args({ last: '2026-11-16T08:00:00+08:00' })).action).toBe('h');
  });
  it('time 每周：周几门控', () => {
    const code = compileEntry(e({ mode: 'time', time: '周日 12:00' })).code;
    expect(runCompiled(code, args()).action).toBeUndefined(); // 周二
  });
  it('time 指定日期：当天到点触发即完成；过日终结', () => {
    const code = compileEntry(e({ mode: 'time', time: '2026-12-01T09:00' })).code;
    expect(runCompiled(code, args()).action).toBeUndefined();
    const gone = runCompiled(code, args({ now: '2026-12-02T10:00:00+08:00' }));
    expect(gone.active).toBe(false);
    const hit = runCompiled(code, args({ now: '2026-12-01T09:05:00+08:00' }));
    expect(hit.action).toBe('h');
    expect(hit.active).toBe(false);
  });
  it('workday/holiday 门控（u.workday）', () => {
    const wd = compileEntry(e({ mode: 'workday', time: '09:00' })).code;
    // 2026-11-17 周二 = 工作日 → hit
    expect(runCompiled(wd, args()).action).toBe('h');
    const hol = compileEntry(e({ mode: 'holiday', time: '10:00' })).code;
    // 周二非节假日 → miss
    expect(runCompiled(hol, args()).action).toBeUndefined();
  });
  it('activeHours：窗外静默', () => {
    const code = compileEntry(e({ mode: 'time', time: '19:00', activeHours: '06:30-23:30' })).code;
    // 09:05 在窗内——用窗外时刻验证 miss（now=23:40）
    const late = runCompiled(code, args({ now: '2026-11-17T23:40:00+08:00' }));
    expect(late.action).toBeUndefined();
  });
  it('repeatCount：count 达阈值触发即终结', () => {
    const code = compileEntry(e({ mode: 'delay', delay: '5m', repeatCount: 3 })).code;
    const last = runCompiled(code, args({ state: { started: true }, count: 2 }));
    expect(last.active).toBe(false);
    expect(last.action).toBe('h');
    const mid = runCompiled(code, args({ state: { started: true }, count: 1 }));
    expect(mid.active).toBeUndefined();
  });
  it('投递侧字段透传', () => {
    const s = compileEntry(e({ mode: 'delay', delay: '30m', conversationId: 'c1', gate: 'x.py', gateOnError: 'run', target: 'a,b' }));
    expect(s.conversationId).toBe('c1');
    expect(s.gate).toBe('x.py');
    expect(s.gateOnError).toBe('run');
    expect(s.target).toBe('a,b');
  });
});

describe('isLegacyEntryShape / 内核留存', () => {
  it('形态判据', () => {
    expect(isLegacyEntryShape({ id: 'x', mode: 'delay', hint: 'h' })).toBe(true);
    expect(isLegacyEntryShape({ id: 'x', kind: 'script', code: '(a,u)=>({})' })).toBe(false);
    expect(isLegacyEntryShape(null)).toBe(false);
  });
  it('parseInterval / msUntilTime / localISO', () => {
    expect(parseInterval('30ms')).toBe(30);
    expect(msUntilTime('09:00', new Date('2026-11-17T23:00:00+08:00'), 'Asia/Shanghai')).toBeGreaterThan(9 * 3600_000);
    expect(localISO(new Date('2026-11-17T01:00:00Z'), 'Asia/Shanghai').startsWith('2026-11-17T09:00:00')).toBe(true);
  });
  it('createHolidayResolver 周末判定', () => {
    const r = createHolidayResolver({}, 'Asia/Shanghai');
    expect(r.isWorkday(new Date('2026-11-17T12:00:00+08:00'))).toBe(true);
    expect(r.isWorkday(new Date('2026-11-14T12:00:00+08:00'))).toBe(false);
  });
});
