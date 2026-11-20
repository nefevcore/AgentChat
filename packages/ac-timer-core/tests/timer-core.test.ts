// ============================================================
// ac-timer-core 单测（cr-1164 v3 哑触发层）：推导纯函数（nextGridMs /
// lastDueMs / gatesPass / previewFires / untilReached）、match v1 算子、
// validateTimerEntries、migrateLegacyEntry（§八映射表）。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  createHolidayResolver,
  describeEntry,
  gatesPass,
  isTimeTrigger,
  lastDueMs,
  localISO,
  matchRow,
  migrateLegacyEntry,
  nextGridMs,
  parseInterval,
  previewFires,
  untilReached,
  validateTimerEntries,
  type DeriveCtx,
  type LegacyTimerEntry,
  type TimerEntry,
} from '../src/index.ts';

const TZ = 'Asia/Shanghai';
const resolver = createHolidayResolver({}, TZ);

/** ctx 工厂（armedAt 定点便于断言） */
const ctx = (over: Partial<DeriveCtx> = {}): DeriveCtx => ({ tz: TZ, armedAt: 0, ...over });

/** 2026-11-17 周二 09:05 上海 = 01:05Z */
const NOW = new Date('2026-11-17T09:05:00+08:00').getTime();
const iso = (s: string) => new Date(s).getTime();

const entry = (when: TimerEntry['when'], over: Partial<TimerEntry> = {}): TimerEntry => ({
  id: 'x', enabled: true, when, action: { text: 'hi' }, ...over,
});

describe('nextGridMs（墙钟网格推导）', () => {
  it('once：直取 at', () => {
    expect(nextGridMs({ kind: 'once', at: '2026-12-01T09:00:00+08:00' }, NOW, ctx())).toBe(iso('2026-12-01T09:00:00+08:00'));
  });
  it('daily：当日已过 → 次日同刻', () => {
    const next = nextGridMs({ kind: 'daily', at: '09:00' }, NOW, ctx());
    expect(next).toBe(iso('2026-11-18T09:00:00+08:00'));
    const before = nextGridMs({ kind: 'daily', at: '09:06' }, NOW, ctx());
    expect(before).toBe(iso('2026-11-17T09:06:00+08:00'));
  });
  it('weekly：本周已过 → 次周；未来周直取', () => {
    expect(nextGridMs({ kind: 'weekly', dow: 2, at: '09:00' }, NOW, ctx())).toBe(iso('2026-11-24T09:00:00+08:00'));
    expect(nextGridMs({ kind: 'weekly', dow: 3, at: '08:00' }, NOW, ctx())).toBe(iso('2026-11-18T08:00:00+08:00'));
  });
  it('every wall：当日 00:00 网格，ceil 取下一刻', () => {
    // 09:05 → 00:00 + ceil(545min/30min)*30min = 09:30
    expect(nextGridMs({ kind: 'every', iv: '30m' }, NOW, ctx())).toBe(iso('2026-11-17T09:30:00+08:00'));
    // 恰在网格点 09:00 → 下一刻 09:30（严格未来）
    const onGrid = iso('2026-11-17T09:00:00+08:00');
    expect(nextGridMs({ kind: 'every', iv: '30m' }, onGrid, ctx())).toBe(iso('2026-11-17T09:30:00+08:00'));
  });
  it('every 锚 {at}：「每小时的 :20」—— 09:05 后下一刻 09:20', () => {
    const next = nextGridMs({ kind: 'every', iv: '1h', base: { at: '00:20' } }, NOW, ctx());
    expect(next).toBe(iso('2026-11-17T09:20:00+08:00'));
  });
  it('every 锚 ISO：固定锚网格', () => {
    const next = nextGridMs({ kind: 'every', iv: '1h', base: '2026-11-17T08:00:00+08:00' }, NOW, ctx());
    expect(next).toBe(iso('2026-11-17T10:00:00+08:00'));
  });
  it('every after-last：max(lastFired, armedAt)+iv（可为过去=链到期）', () => {
    const armed = NOW - 3_600_000;
    expect(nextGridMs({ kind: 'every', iv: '30m', base: 'after-last' }, NOW, ctx({ armedAt: armed }))).toBe(armed + 1_800_000);
    expect(nextGridMs({ kind: 'every', iv: '30m', base: 'after-last' }, NOW, ctx({ armedAt: 0, lastFiredAt: NOW - 600_000 }))).toBe(NOW - 600_000 + 1_800_000);
  });
  it('jitter：网格 ± jitter 内随机取点（注入 rand 定点）', () => {
    const t = { kind: 'every', iv: '30m', jitter: '5m' } as const;
    expect(nextGridMs(t, NOW, ctx({ rand: () => 0 }))).toBe(iso('2026-11-17T09:25:00+08:00'));
    expect(nextGridMs(t, NOW, ctx({ rand: () => 1 }))).toBe(iso('2026-11-17T09:35:00+08:00'));
    expect(nextGridMs(t, NOW, ctx({ rand: () => 0.5 }))).toBe(iso('2026-11-17T09:30:00+08:00'));
  });
});

describe('lastDueMs（catchup-once 判据：≤now 且 >lastFired）', () => {
  it('daily：今日已到刻；lastFired / armedAt 之后才算错过', () => {
    expect(lastDueMs({ kind: 'daily', at: '09:00' }, NOW, ctx())).toBe(iso('2026-11-17T09:00:00+08:00'));
    expect(lastDueMs({ kind: 'daily', at: '09:00' }, NOW, ctx({ lastFiredAt: iso('2026-11-17T09:00:00+08:00') }))).toBeNull();
    // 新条目（armedAt = now）：已过的历史刻不算错过——set 后不立即补投
    expect(lastDueMs({ kind: 'daily', at: '09:00' }, NOW, ctx({ armedAt: NOW }))).toBeNull();
    // armedAt 早于昨日：昨日的刻度是错过（补最近一刻）
    expect(lastDueMs({ kind: 'daily', at: '09:10' }, NOW, ctx({ armedAt: iso('2026-11-15T00:00:00+08:00') }))).toBe(iso('2026-11-16T09:10:00+08:00'));
  });
  it('every wall：最近网格刻', () => {
    expect(lastDueMs({ kind: 'every', iv: '30m' }, NOW, ctx())).toBe(iso('2026-11-17T09:00:00+08:00'));
  });
  it('once：at ≤ now 即到刻', () => {
    expect(lastDueMs({ kind: 'once', at: '2026-11-17T08:00:00+08:00' }, NOW, ctx())).toBe(iso('2026-11-17T08:00:00+08:00'));
    expect(lastDueMs({ kind: 'once', at: '2026-12-01T08:00:00+08:00' }, NOW, ctx())).toBeNull();
  });
  it('after-last 恒 null（链式无网格可补）', () => {
    expect(lastDueMs({ kind: 'every', iv: '30m', base: 'after-last' }, NOW, ctx({ armedAt: 0 }))).toBeNull();
  });
});

describe('gatesPass / untilReached', () => {
  it('workday/holiday（2026-11-17 周二 = 工作日；14 周六）', () => {
    expect(gatesPass([{ kind: 'workday' }], NOW, TZ, resolver)).toBe(true);
    expect(gatesPass([{ kind: 'holiday' }], NOW, TZ, resolver)).toBe(false);
    const sat = iso('2026-11-14T10:00:00+08:00');
    expect(gatesPass([{ kind: 'workday' }], sat, TZ, resolver)).toBe(false);
  });
  it('hours 门：含跨午夜形', () => {
    expect(gatesPass([{ kind: 'hours', from: '08:00', to: '23:00' }], NOW, TZ, resolver)).toBe(true);
    expect(gatesPass([{ kind: 'hours', from: '23:00', to: '07:00' }], NOW, TZ, resolver)).toBe(false);
    const night = iso('2026-11-17T23:30:00+08:00');
    expect(gatesPass([{ kind: 'hours', from: '23:00', to: '07:00' }], night, TZ, resolver)).toBe(true);
  });
  it('until：count 按投递次数 / date 时刻', () => {
    expect(untilReached({ count: 3 }, 3, NOW)).toBe(true);
    expect(untilReached({ count: 3 }, 2, NOW)).toBe(false);
    expect(untilReached({ date: '2026-11-17T09:00:00+08:00' }, 0, NOW)).toBe(true);
  });
});

describe('previewFires（静态预览）', () => {
  it('daily 三连刻', () => {
    const fires = previewFires(entry([{ kind: 'daily', at: '09:00' }]), NOW, ctx(), 3);
    expect(fires.map((f) => f.at)).toEqual([
      iso('2026-11-18T09:00:00+08:00'), iso('2026-11-19T09:00:00+08:00'), iso('2026-11-20T09:00:00+08:00'),
    ]);
  });
  it('多触发器取每步最小（OR 语义）', () => {
    const fires = previewFires(entry([{ kind: 'daily', at: '09:00' }, { kind: 'daily', at: '20:00' }]), NOW, ctx(), 3);
    expect(fires.map((f) => f.at)).toEqual([
      iso('2026-11-17T20:00:00+08:00'), iso('2026-11-18T09:00:00+08:00'), iso('2026-11-18T20:00:00+08:00'),
    ]);
  });
  it('after-last 标注链式', () => {
    const armed = NOW - 600_000;
    const fires = previewFires(entry([{ kind: 'every', iv: '30m', base: 'after-last' }]), NOW, ctx({ armedAt: armed }), 2);
    expect(fires.every((f) => f.chained)).toBe(true);
    expect(fires[0]!.at).toBe(armed + 1_800_000);
    expect(fires[1]!.at).toBe(armed + 3_600_000);
  });
  it('every wall 网格点（周网格 7d：当日 00:00 起）', () => {
    const fires = previewFires(entry([{ kind: 'every', iv: '7d' }]), NOW, ctx(), 2);
    expect(fires[0]!.at).toBe(iso('2026-11-24T00:00:00+08:00'));
    expect(fires[1]!.at).toBe(iso('2026-12-01T00:00:00+08:00'));
  });
  it('诚实性（cr-1167）：once 单条不重复 / until.count 截断 / 过期 once 空列', () => {
    // once 只进一条（v3 换轨首版曾同刻重复 3 条——预览谎报触点数）
    const once = previewFires(entry([{ kind: 'once', at: '2026-11-18T09:00:00+08:00' }]), NOW, ctx(), 3);
    expect(once).toHaveLength(1);
    // until.count 2 → 最多 2 条（首版仍给 3——超出终结点的投递不存在）
    const capped = previewFires(entry([{ kind: 'every', iv: '1h' }], { until: { count: 2 } }), NOW, ctx(), 3);
    expect(capped).toHaveLength(2);
    // 过期 once（at < now 且无 catchup 语义）：未来无点可期——空列
    const expired = previewFires(entry([{ kind: 'once', at: '2026-11-16T09:00:00+08:00' }]), NOW, ctx(), 3);
    expect(expired).toHaveLength(0);
  });
});

describe('matchRow（v1 算子）', () => {
  const row = { chat: '产品群', n: 42, tags: ['a', 'b'] } as Record<string, unknown>;
  it('eq/ne/in/contains', () => {
    expect(matchRow({ field: 'chat', op: 'eq', value: '产品群' }, row)).toBe(true);
    expect(matchRow({ field: 'chat', op: 'ne', value: '别的' }, row)).toBe(true);
    expect(matchRow({ field: 'chat', op: 'in', value: ['产品群', 'x'] }, row)).toBe(true);
    expect(matchRow({ field: 'chat', op: 'contains', value: '产品' }, row)).toBe(true);
    expect(matchRow({ field: 'tags', op: 'contains', value: 'a' }, row)).toBe(true);
  });
  it('gt/lt 数值与数值串', () => {
    expect(matchRow({ field: 'n', op: 'gt', value: 40 }, row)).toBe(true);
    expect(matchRow({ field: 'n', op: 'lt', value: '50' }, row)).toBe(true);
    expect(matchRow({ field: 'chat', op: 'gt', value: 1 }, row)).toBe(false); // 非数值不命中
  });
  it('字段缺席不命中', () => {
    expect(matchRow({ field: 'nope', op: 'eq', value: undefined }, row)).toBe(false);
  });
});

describe('validateTimerEntries（set 静态校验单源）', () => {
  const ok = (over: Record<string, unknown> = {}) => ({
    id: 'a', enabled: true, when: [{ kind: 'daily', at: '09:00' }], action: { text: '早' }, ...over,
  });
  it('合法条目通过并归一', () => {
    const list = validateTimerEntries([ok()]);
    expect(list).toHaveLength(1);
    expect(list[0]!.when[0]).toEqual({ kind: 'daily', at: '09:00' });
  });
  it('kind 字段已退役 / 非法 when / gates / until / action 拒', () => {
    expect(() => validateTimerEntries([ok({ kind: 'script' })])).toThrow('kind');
    expect(() => validateTimerEntries([ok({ when: [{ kind: 'cron', expr: '*' }] })])).toThrow('when[].kind');
    expect(() => validateTimerEntries([ok({ when: [{ kind: 'daily', at: '9点' }] })])).toThrow('HH:mm');
    expect(() => validateTimerEntries([ok({ gates: [{ kind: 'hours', from: 'x', to: '09:00' }] })])).toThrow('hours');
    expect(() => validateTimerEntries([ok({ until: { count: 0 } })])).toThrow('until.count');
    expect(() => validateTimerEntries([ok({ action: {} })])).toThrow('action.text');
  });
  it('every 校验：iv 可解析 / jitter 不与 after-last 组合', () => {
    expect(() => validateTimerEntries([ok({ when: [{ kind: 'every', iv: 'soon' }] })])).toThrow('iv');
    expect(() => validateTimerEntries([ok({ when: [{ kind: 'every', iv: '30m', base: 'after-last', jitter: '5m' }] })])).toThrow('after-last');
  });
  it('source 校验：on 词汇 / match 算子集', () => {
    expect(() => validateTimerEntries([ok({ when: [{ kind: 'source', source: 's', view: 'v', on: 'oops' }] })])).toThrow('on');
    expect(() => validateTimerEntries([ok({ when: [{ kind: 'source', source: 's', view: 'v', on: 'rows-added', match: { field: 'a', op: 'regex', value: 'x' } }] })])).toThrow('op');
    expect(() => validateTimerEntries([ok({ when: [{ kind: 'source', source: 's', view: 'v', on: 'rows-added', match: { field: 'a', op: 'in', value: 'x' } }] })])).toThrow('in');
  });
});

describe('migrateLegacyEntry（§八映射表）', () => {
  const L = (over: Partial<LegacyTimerEntry> & Record<string, unknown>): LegacyTimerEntry => ({ id: 'x', enabled: true, mode: 'delay', hint: 'h', ...over } as LegacyTimerEntry);
  it('time 每天 / 周X / 定点 ISO（once 缺省 catchup-once）', () => {
    expect(migrateLegacyEntry(L({ mode: 'time', time: '09:00' })).when).toEqual([{ kind: 'daily', at: '09:00' }]);
    expect(migrateLegacyEntry(L({ mode: 'time', time: '周日 12:00' })).when).toEqual([{ kind: 'weekly', dow: 0, at: '12:00' }]);
    const once = migrateLegacyEntry(L({ mode: 'time', time: '2026-12-01T09:00' }));
    expect(once.when).toEqual([{ kind: 'once', at: '2026-12-01T09:00:00' }]);
    expect(once.missed).toBe('catchup-once');
  });
  it('delay → every after-last；random → every iv:min jitter:max−min', () => {
    const d = migrateLegacyEntry(L({ mode: 'delay', delay: '30m' }));
    expect(d.when).toEqual([{ kind: 'every', iv: '30m', base: 'after-last' }]);
    const r = migrateLegacyEntry(L({ mode: 'random', delayMin: '1m', delayMax: '3m' }));
    expect(r.when).toEqual([{ kind: 'every', iv: '1m', jitter: '2m' }]);
  });
  it('workday/holiday → daily + gates；activeHours / repeatCount 直译', () => {
    expect(migrateLegacyEntry(L({ mode: 'workday', time: '09:00' })).gates).toEqual([{ kind: 'workday' }]);
    expect(migrateLegacyEntry(L({ mode: 'holiday', time: '10:00' })).gates).toEqual([{ kind: 'holiday' }]);
    const g = migrateLegacyEntry(L({ mode: 'time', time: '19:00', activeHours: '06:30-23:30' }));
    expect(g.gates).toEqual([{ kind: 'hours', from: '06:30', to: '23:30' }]);
    expect(migrateLegacyEntry(L({ mode: 'delay', delay: '5m', repeatCount: 3 })).until).toEqual({ count: 3 });
  });
  it('gate/gateOnError 丢弃；投递面透传', () => {
    const m = migrateLegacyEntry(L({ mode: 'time', time: '09:00', conversationId: 'c1', task: 'archive-all', target: 'a,b', gate: 'x.py', gateOnError: 'run' }));
    expect(m.action).toEqual({ text: 'h', conversationId: 'c1', task: 'archive-all', target: 'a,b' });
    expect('gate' in m).toBe(false);
  });
  it('迁移产物过 v3 校验', () => {
    const list = validateTimerEntries([
      migrateLegacyEntry(L({ mode: 'time', time: '09:00' })),
      migrateLegacyEntry(L({ mode: 'delay', delay: '30m', repeatCount: 2 })),
      migrateLegacyEntry(L({ mode: 'random', delayMin: '1m', delayMax: '2m' })),
    ]);
    expect(list).toHaveLength(3);
  });
});

describe('人读摘要 / 留存内核', () => {
  it('isTimeTrigger / describeEntry', () => {
    expect(isTimeTrigger({ kind: 'source', source: 's', view: 'v', on: 'stale' })).toBe(false);
    expect(describeEntry(entry([{ kind: 'daily', at: '09:00' }], { gates: [{ kind: 'workday' }], until: { count: 5 } }))).toContain('每天 09:00');
  });
  it('parseInterval / localISO', () => {
    expect(parseInterval('30ms')).toBe(30);
    expect(parseInterval('2h30m')).toBe(9_000_000);
    expect(parseInterval('bad')).toBeNull();
    expect(localISO(new Date('2026-11-17T01:00:00Z'), 'Asia/Shanghai').startsWith('2026-11-17T09:00:00')).toBe(true);
  });
});
