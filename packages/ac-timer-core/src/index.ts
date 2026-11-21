// ============================================================
// ac-timer-core —— 定时算法纯库（零 cordis 依赖）
//
// cr-1164 timer v3 换轨（哑触发层，取代 cr-1147 探测循环）：触发器是
// 数据不是代码——when[]（OR 语义触发词汇）+ gates[]（AND 时间门）+
// until / missed / jitter 声明式词汇，本库承载：
//   · 条目契约 —— TimerEntry（entries/timer.json v3 形态）+
//     validateTimerEntries（set 时静态校验单源）
//   · 推导纯函数 —— nextGridMs / lastDueMs（owner 时区墙钟网格，
//     base 三形态 wall / anchor / after-last）、gatesPass、previewFires
//   · match v1 算子 —— eq/ne/gt/lt/in/contains 单层字段（源触发配套）
//   · 迁移编译器 —— migrateLegacyEntry（旧 5 模式 → v3，§八映射表）
//   · 留存内核 —— parseInterval / createHolidayResolver / localISO /
//     时区墙上时钟算术（zonedParts / zonedWallToUtc）
// v2 脚本面（TimerCheckFn 族 / compileEntry / inspectVerdict）随换轨
// 退役——timer 无代码执行面。
// ============================================================
import * as lunar from 'chinese-lunar';
import { DEFAULT_TZ, resolveTimezone } from 'ac-core-utils'; // 缺省时区单源（cr-1053）

// ============================================================
// 条目契约（timer.json v3：整表 { version: 3, entries: [...] }）
// ============================================================

/** 单次触发（missed 缺省 catchup-once：错过补投一次再归档） */
export interface OnceTrigger {
  kind: 'once';
  /** ISO 时刻（含偏移或 Z） */
  at: string;
}

/** 每日触发 */
export interface DailyTrigger {
  kind: 'daily';
  /** 'HH:mm'（owner 时区墙钟） */
  at: string;
}

/** 每周触发（dow: 0=周日 … 6=周六） */
export interface WeeklyTrigger {
  kind: 'weekly';
  dow: number;
  at: string;
}

/**
 * every 的 base 三形态（cr-1161 三裁决：统一形状、不开放——v1 仅 every 消费）：
 *   'wall'（缺省）——当日 00:00 起的墙钟网格（cron 心智）
 *   { at: 'HH:mm' } 或 ISO 串——显式锚（最近锚日起的网格）
 *   'after-last'——链式：max(lastFired, armedAt) + iv（v2 delay 语义）
 */
export type EveryBase = 'wall' | 'after-last' | { at: string } | (string & Record<never, never>);

/** 间隔网格触发 */
export interface EveryTrigger {
  kind: 'every';
  /** 间隔串（'30m' / '2h30m' / '7d'） */
  iv: string;
  base?: EveryBase;
  /** 网格刻度 ± jitter 内随机取点，每刻重抖（扰动不累积）；不与 after-last 组合 */
  jitter?: string;
}

/** match v1 算子条件（单层字段——嵌套路径与正则不进 v1） */
export interface MatchCond {
  field: string;
  op: 'eq' | 'ne' | 'gt' | 'lt' | 'in' | 'contains';
  value: unknown;
}

/** 源事件触发（事件驱动，无时刻；采集层 = source 行，cr-1161 再下一步批） */
export interface SourceTrigger {
  kind: 'source';
  source: string;
  view: string;
  on: 'rows-added' | 'stale';
  match?: MatchCond;
  cooldown?: string;
}

/** 触发器词汇（when 数组 OR 语义——任一命中即投递） */
export type WhenTrigger = OnceTrigger | DailyTrigger | WeeklyTrigger | EveryTrigger | SourceTrigger;

/** 时间门（gates 数组 AND 语义） */
export type TimerGate = { kind: 'workday' } | { kind: 'holiday' } | { kind: 'hours'; from: string; to: string };

/** 终结条件（count 按投递次数记账） */
export type TimerUntil = { count: number } | { date: string };

/** 投递面（宿主安全面持有——v2 原样词汇） */
export interface TimerAction {
  text: string;
  conversationId?: string;
  task?: 'archive-all' | 'backup-all';
  /** 仅全局条目：目标 Agent（',' 分隔；'*'/缺席 = 全部常规 Agent） */
  target?: string;
}

/** v3 条目（entries/timer.json 唯一持久形态） */
export interface TimerEntry {
  id: string;
  enabled: boolean;
  label?: string;
  when: WhenTrigger[];
  gates?: TimerGate[];
  until?: TimerUntil;
  /** 停机策略：周期触发缺省 skip，once 缺省 catchup-once */
  missed?: 'skip' | 'catchup-once';
  action: TimerAction;
}

/** 源触发 cooldown 缺省值（§十一倾向：5m） */
export const DEFAULT_COOLDOWN = '5m';

const HHMM = /^(\d{1,2}):(\d{2})$/;

function isHhmm(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = v.match(HHMM);
  if (m === null) return false;
  const h = Number(m[1]), mi = Number(m[2]);
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
}

function errAt(i: number, field: string, msg: string): never {
  throw new Error('entries[' + i + '].' + field + ' ' + msg);
}

function validateWhen(i: number, raw: unknown): WhenTrigger {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) errAt(i, 'when[]', '须为触发器对象');
  const t = raw as Record<string, unknown>;
  switch (t.kind) {
    case 'once':
      if (typeof t.at !== 'string' || isNaN(new Date(t.at).getTime())) errAt(i, 'when[].at', '须为可解析的 ISO 时刻');
      return { kind: 'once', at: t.at };
    case 'daily':
      if (!isHhmm(t.at)) errAt(i, 'when[].at', "须为 'HH:mm' 墙钟时刻");
      return { kind: 'daily', at: t.at };
    case 'weekly':
      if (typeof t.dow !== 'number' || t.dow < 0 || t.dow > 6 || !Number.isInteger(t.dow)) errAt(i, 'when[].dow', '须为 0-6（0=周日）');
      if (!isHhmm(t.at)) errAt(i, 'when[].at', "须为 'HH:mm' 墙钟时刻");
      return { kind: 'weekly', dow: t.dow, at: t.at };
    case 'every': {
      if (typeof t.iv !== 'string' || parseInterval(t.iv) === null) errAt(i, 'when[].iv', "须为可解析的间隔串（'30m'/'2h30m'/'7d'）");
      let base: EveryBase | undefined;
      if (t.base !== undefined) {
        if (t.base === 'wall' || t.base === 'after-last') base = t.base;
        else if (typeof t.base === 'string') {
          if (isNaN(new Date(t.base).getTime())) errAt(i, 'when[].base', 'ISO 串须可解析');
          base = t.base as string;
        } else if (typeof t.base === 'object' && !Array.isArray(t.base) && isHhmm((t.base as { at?: unknown }).at)) {
          base = { at: (t.base as { at: string }).at };
        } else errAt(i, 'when[].base', "须为 'wall' | 'after-last' | { at: 'HH:mm' } | ISO 串");
      }
      let jitter: string | undefined;
      if (t.jitter !== undefined) {
        if (typeof t.jitter !== 'string' || parseInterval(t.jitter) === null) errAt(i, 'when[].jitter', '须为可解析的间隔串');
        if (base === 'after-last') errAt(i, 'when[].jitter', '不与 after-last 组合（链式起算的抖动会越漂越远）');
        jitter = t.jitter;
      }
      return { kind: 'every', iv: t.iv, ...(base !== undefined ? { base } : {}), ...(jitter !== undefined ? { jitter } : {}) };
    }
    case 'source': {
      if (typeof t.source !== 'string' || !t.source) errAt(i, 'when[].source', '须为非空字符串');
      if (typeof t.view !== 'string' || !t.view) errAt(i, 'when[].view', '须为非空字符串');
      if (t.on !== 'rows-added' && t.on !== 'stale') errAt(i, 'when[].on', "须为 'rows-added' | 'stale'");
      let match: MatchCond | undefined;
      if (t.match !== undefined) {
        const m = t.match as Record<string, unknown> | null;
        if (m === null || typeof m !== 'object') errAt(i, 'when[].match', '须为 { field, op, value } 对象');
        if (typeof m.field !== 'string' || !m.field) errAt(i, 'when[].match.field', '须为非空字符串（单层字段）');
        if (m.op !== 'eq' && m.op !== 'ne' && m.op !== 'gt' && m.op !== 'lt' && m.op !== 'in' && m.op !== 'contains') {
          errAt(i, 'when[].match.op', '须为 eq/ne/gt/lt/in/contains（v1 算子集）');
        }
        if (m.op === 'in' && !Array.isArray(m.value)) errAt(i, 'when[].match.value', 'in 算子须为数组');
        match = { field: m.field as string, op: m.op as MatchCond['op'], value: m.value };
      }
      let cooldown: string | undefined;
      if (t.cooldown !== undefined) {
        if (typeof t.cooldown !== 'string' || parseInterval(t.cooldown) === null) errAt(i, 'when[].cooldown', '须为可解析的间隔串');
        cooldown = t.cooldown;
      }
      return { kind: 'source', source: t.source, view: t.view, on: t.on, ...(match !== undefined ? { match } : {}), ...(cooldown !== undefined ? { cooldown } : {}) };
    }
    default:
      errAt(i, 'when[].kind', '非法（' + String(t.kind) + "）——once/daily/weekly/every/source");
  }
}

function validateGate(i: number, raw: unknown): TimerGate {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) errAt(i, 'gates[]', '须为门对象');
  const g = raw as Record<string, unknown>;
  if (g.kind === 'workday' || g.kind === 'holiday') return { kind: g.kind };
  if (g.kind === 'hours') {
    if (!isHhmm(g.from) || !isHhmm(g.to)) errAt(i, 'gates[]', "hours 门须带 'HH:mm' 形 from/to（from > to 为跨午夜形）");
    return { kind: 'hours', from: g.from, to: g.to };
  }
  errAt(i, 'gates[].kind', '非法（' + String(g.kind) + '）——workday/holiday/hours');
}

/** v3 条目静态校验（set / boot 装载 / UI 保存共用单源；非法整表拒） */
export function validateTimerEntries(raw: unknown): TimerEntry[] {
  if (!Array.isArray(raw)) throw new Error('参数 entries 须为 TimerEntry 数组');
  return raw.map((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) errAt(i, '', '非对象');
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.id === '') errAt(i, 'id', '须为非空字符串');
    if (e.kind !== undefined) errAt(i, 'kind', '字段已退役（v3 无 kind）');
    if (typeof e.enabled !== 'boolean') errAt(i, 'enabled', '须为 boolean');
    if (e.label !== undefined && typeof e.label !== 'string') errAt(i, 'label', '须为字符串');
    if (!Array.isArray(e.when) || e.when.length === 0) errAt(i, 'when', '须为非空触发器数组（OR 语义）');
    const when = e.when.map((t) => validateWhen(i, t));
    let gates: TimerGate[] | undefined;
    if (e.gates !== undefined) {
      if (!Array.isArray(e.gates)) errAt(i, 'gates', '须为门数组（AND 语义）');
      gates = e.gates.map((g) => validateGate(i, g));
    }
    let until: TimerUntil | undefined;
    if (e.until !== undefined) {
      const u = e.until as Record<string, unknown> | null;
      if (u === null || typeof u !== 'object') errAt(i, 'until', '须为 { count } 或 { date }');
      if (u.count !== undefined) {
        if (typeof u.count !== 'number' || !Number.isInteger(u.count) || u.count < 1) errAt(i, 'until.count', '须为正整数');
        until = { count: u.count };
      } else if (u.date !== undefined) {
        if (typeof u.date !== 'string' || isNaN(new Date(u.date).getTime())) errAt(i, 'until.date', '须为可解析的 ISO 时刻');
        until = { date: u.date };
      } else errAt(i, 'until', '须为 { count } 或 { date }');
    }
    if (e.missed !== undefined && e.missed !== 'skip' && e.missed !== 'catchup-once') errAt(i, 'missed', "须为 'skip' | 'catchup-once'");
    const a = e.action as Record<string, unknown> | null;
    if (a === null || typeof a !== 'object') errAt(i, 'action', '须为 { text } 对象');
    if (typeof a.text !== 'string' || a.text.trim() === '') errAt(i, 'action.text', '须为非空字符串（唤醒文本）');
    if (a.conversationId !== undefined && (typeof a.conversationId !== 'string' || !a.conversationId)) errAt(i, 'action.conversationId', '须为非空字符串');
    if (a.task !== undefined && a.task !== 'archive-all' && a.task !== 'backup-all') errAt(i, 'action.task', '非法');
    if (a.target !== undefined && (typeof a.target !== 'string' || !a.target)) errAt(i, 'action.target', '须为非空字符串');
    return {
      id: e.id, enabled: e.enabled,
      ...(typeof e.label === 'string' ? { label: e.label } : {}),
      when,
      ...(gates !== undefined ? { gates } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(e.missed !== undefined ? { missed: e.missed as 'skip' | 'catchup-once' } : {}),
      action: {
        text: a.text as string,
        ...(a.conversationId !== undefined ? { conversationId: a.conversationId as string } : {}),
        ...(a.task !== undefined ? { task: a.task as 'archive-all' | 'backup-all' } : {}),
        ...(a.target !== undefined ? { target: a.target as string } : {}),
      },
    };
  });
}

// ============================================================
// 推导纯函数（owner 时区墙钟网格；恒 24h——DST 偏差视为噪声，cr-1161 裁决 1）
// ============================================================

/** 时间触发器（有网格刻度可推导；source 事件驱动不在列） */
export type TimeTrigger = OnceTrigger | DailyTrigger | WeeklyTrigger | EveryTrigger;

export function isTimeTrigger(t: WhenTrigger): t is TimeTrigger {
  return t.kind === 'once' || t.kind === 'daily' || t.kind === 'weekly' || t.kind === 'every';
}

/** 推导上下文：tz = owner 时区；armedAt = 条目首次装载时刻（持久——after-last 锚与 catchup 下界）；
 * lastFiredAt = 上次投递时刻（after-last 链式起点 / catchup 判据）；
 * rand = jitter 随机源（可注入定点测试）。 */
export interface DeriveCtx {
  tz: string;
  armedAt: number;
  lastFiredAt?: number;
  rand?: () => number;
}

function hhmmToMin(s: string): number {
  const m = s.match(HHMM)!;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** tz 墙上日期的某墙钟时刻 → 纪元毫秒 */
function wallEpoch(y: number, mo: number, d: number, min: number, tz: string): number {
  return zonedWallToUtc(y, mo, d, Math.floor(min / 60), min % 60, tz);
}

/** now 的 tz 墙上 parts */
interface WallNow { y: number; m: number; d: number; min: number; dow: number }
function wallNow(now: number, tz: string): WallNow {
  const p = zonedParts(new Date(now), tz);
  const wd = new Date(p.y, p.m - 1, p.d).getDay(); // 墙上日历无 tz 歧义（恒 24h 裁决）
  return { y: p.y, m: p.m, d: p.d, min: p.h * 60 + p.mi, dow: wd };
}

function addDaysEpoch(epoch: number, days: number): number {
  return epoch + days * 86_400_000;
}

/** every 锚点纪元：wall = 当日 00:00；{at:'HH:mm'} / 'HH:mm' = 最近锚日该时刻（≤ now，
 * 锚随日 recession——网格永不耗尽）；ISO 串 = 定锚。 */
function anchorEpoch(t: EveryTrigger, now: number, ctx: DeriveCtx): number {
  const base = t.base ?? 'wall';
  if (base === 'wall') {
    const w = wallNow(now, ctx.tz);
    return wallEpoch(w.y, w.m, w.d, 0, ctx.tz);
  }
  const at = typeof base === 'object' ? base.at : base;
  if (HHMM.test(at)) {
    const w = wallNow(now, ctx.tz);
    const min = hhmmToMin(at);
    let anchor = wallEpoch(w.y, w.m, w.d, min, ctx.tz);
    if (anchor > now) anchor = addDaysEpoch(anchor, -1);
    return anchor;
  }
  return new Date(at).getTime();
}

/**
 * 严格未来的下一刻（epoch ms）。after-last 链式：max(lastFired, armedAt) + iv
 * ——可为过去（链到期该投，调用方立即触发）；jitter 仅网格刻度应用（每刻重抖，
 * 扰动不累积），链式不抖（越漂越远）。
 */
export function nextGridMs(t: TimeTrigger, now: number, ctx: DeriveCtx): number {
  const jitterMs = t.kind === 'every' && t.jitter !== undefined ? parseInterval(t.jitter)! : 0;
  const grid = nextGridStrict(t, now, ctx);
  if (jitterMs === 0) return grid;
  const rand = ctx.rand ?? Math.random;
  return grid + Math.floor(rand() * (2 * jitterMs)) - jitterMs;
}

function nextGridStrict(t: TimeTrigger, now: number, ctx: DeriveCtx): number {
  if (t.kind === 'once') return new Date(t.at).getTime();
  if (t.kind === 'daily') {
    const w = wallNow(now, ctx.tz);
    const min = hhmmToMin(t.at);
    let at = wallEpoch(w.y, w.m, w.d, min, ctx.tz);
    if (at <= now) at = addDaysEpoch(at, 1);
    return at;
  }
  if (t.kind === 'weekly') {
    const w = wallNow(now, ctx.tz);
    const min = hhmmToMin(t.at);
    const offset = (t.dow - w.dow + 7) % 7;
    let at = wallEpoch(w.y, w.m, w.d + offset, min, ctx.tz);
    if (at <= now) at = wallEpoch(w.y, w.m, w.d + offset + 7, min, ctx.tz);
    return at;
  }
  // every
  const iv = parseInterval(t.iv)!;
  if ((t.base ?? 'wall') === 'after-last') {
    return Math.max(ctx.lastFiredAt ?? -Infinity, ctx.armedAt) + iv;
  }
  const anchor = anchorEpoch(t, now, ctx);
  return anchor + (Math.floor((now - anchor) / iv) + 1) * iv;
}

/**
 * 最近一个已到刻度（≤ now 且 > max(lastFiredAt, armedAt)——错过未投的那
 * 个；catchup-once 判据）。armedAt = 条目首次装载时刻：新条目不回补历史
 * 刻（set 后首个已过刻不算错过）。after-last 恒 null（链式无网格可补：
 * 到期即投，无「错过」概念）。once：at ≤ now 即到刻。
 */
export function lastDueMs(t: TimeTrigger, now: number, ctx: DeriveCtx): number | null {
  const last = Math.max(ctx.lastFiredAt ?? -Infinity, ctx.armedAt);
  if (t.kind === 'once') {
    const at = new Date(t.at).getTime();
    return at <= now && at > last ? at : null;
  }
  if (t.kind === 'every' && (t.base ?? 'wall') === 'after-last') return null;
  const due = nextGridStrict(t, now, { ...ctx, lastFiredAt: undefined, armedAt: -Infinity });
  // nextGridStrict 对 calendar/every 返回严格未来刻；往前退一刻即最近已到刻
  const prev = t.kind === 'every' ? due - parseInterval(t.iv)! : t.kind === 'daily' ? addDaysEpoch(due, -1) : addDaysEpoch(due, -7);
  return prev <= now && prev > last ? prev : null;
}

/** gatesAND 求值（at 时刻；workday/holiday 需 resolver——per-owner 配置构造） */
export function gatesPass(
  gates: TimerGate[] | undefined,
  at: number,
  tz: string,
  resolver: { isWorkday(date: Date): boolean },
): boolean {
  if (gates === undefined || gates.length === 0) return true;
  const w = wallNow(at, tz);
  for (const g of gates) {
    if (g.kind === 'workday' && !resolver.isWorkday(new Date(at))) return false;
    if (g.kind === 'holiday' && resolver.isWorkday(new Date(at))) return false;
    if (g.kind === 'hours') {
      const f = hhmmToMin(g.from), to = hhmmToMin(g.to);
      const inWin = f < to ? w.min >= f && w.min < to : w.min >= f || w.min < to; // from > to 跨午夜形
      if (!inWin) return false;
    }
  }
  return true;
}

/** until 终结判定（now 已过 date / firedCount 已达 count） */
export function untilReached(until: TimerUntil | undefined, firedCount: number, now: number): boolean {
  if (until === undefined) return false;
  if ('count' in until) return firedCount >= until.count;
  return now >= new Date(until.date).getTime();
}

export interface PreviewFire { at: number; trigger: TimeTrigger; chained: boolean }

/**
 * 静态预览（test / set 返回体）：未来 n 个严格网格点（不 jitter——扰动是
 * 运行期取点；after-last 标注 chained 且从 max(lastFired, armedAt)+iv 起链）。
 * 预览是诚实快照而非机械填满 n 条：once 到点即出局（同一时刻不重复入列，
 * 无推进可言）、until.count 截断（只到终结前的投递点）、once/date 已过
 * 终结的条目给空列——预览不可当语义证据，但至少不说谎。
 */
export function previewFires(entry: TimerEntry, now: number, ctx: DeriveCtx, n = 3): PreviewFire[] {
  const cap = entry.until !== undefined && 'count' in entry.until ? Math.min(n, entry.until.count) : n;
  const out: PreviewFire[] = [];
  const virtual: DeriveCtx = { ...ctx };
  for (let k = 0; k < cap; k++) {
    let best: PreviewFire | undefined;
    for (const t of entry.when) {
      if (!isTimeTrigger(t)) continue;
      const at = nextGridStrict(t, now, virtual);
      // once 推进无意义（下一刻恒同值）——首次入列后出局，不参与后续轮
      if (t.kind === 'once' && out.some((f) => f.trigger === t)) continue;
      const chained = t.kind === 'every' && (t.base ?? 'wall') === 'after-last';
      // 未来点才可期：过期 once（missed skip 语义）无点可给；after-last 链式
      // 例外——链到期即投（max(lastFired, armedAt)+iv 可为过去，是运行语义）
      if (!chained && at <= now) continue;
      if (best === undefined || at < best.at) best = { at, trigger: t, chained };
    }
    if (best === undefined) break;
    out.push(best);
    // 虚拟推进：把命中的触发器推到下一刻（链式按 lastFired 推进）
    if (best.chained) virtual.lastFiredAt = best.at;
    else now = best.at;
  }
  return out;
}

// ============================================================
// match v1 算子（源触发配套；timers 行同步求值，微秒级）
// ============================================================

/** 单条件求值（row 单层字段；字段缺席 = 不命中，gt/lt 仅数值与数值串） */
export function matchRow(match: MatchCond, row: Record<string, unknown>): boolean {
  if (!(match.field in row)) return false; // 字段缺席不命中
  const v = row[match.field];
  switch (match.op) {
    case 'eq': return v === match.value;
    case 'ne': return v !== match.value;
    case 'gt': case 'lt': {
      const a = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : null;
      const b = typeof match.value === 'number' ? match.value : typeof match.value === 'string' && match.value.trim() !== '' && !isNaN(Number(match.value)) ? Number(match.value) : null;
      if (a === null || b === null) return false;
      return match.op === 'gt' ? a > b : a < b;
    }
    case 'in': return Array.isArray(match.value) && match.value.includes(v as never);
    case 'contains':
      if (typeof v === 'string' && typeof match.value === 'string') return v.includes(match.value);
      if (Array.isArray(v)) return v.includes(match.value as never);
      return false;
  }
}

// ============================================================
// 迁移编译器（旧 5 模式 → v3，cr-1161 §八映射表；数据 → 数据直译）
// ============================================================

/**
 * 旧 5 模式条目（cr-1147 前持久形态）。磁盘上仍可能是此形状——宿主 boot 时
 * 经 migrateLegacyEntry 一次性转 v3。
 */
export interface LegacyTimerEntry {
  id: string;
  enabled: boolean;
  mode: 'time' | 'delay' | 'random' | 'workday' | 'holiday';
  time?: string;
  delay?: string;
  delayMin?: string;
  delayMax?: string;
  repeatCount?: number;
  hint: string;
  task?: 'archive-all' | 'backup-all';
  target?: string;
  conversationId?: string;
  activeHours?: string;
}

export function isLegacyEntryShape(e: unknown): e is LegacyTimerEntry {
  if (typeof e !== 'object' || e === null) return false;
  const r = e as Record<string, unknown>;
  return r.kind === undefined && typeof r.mode === 'string';
}

/** v2 脚本条目判据（code 形态——换轨退役，boot 迁移丢弃归档） */
export function isScriptEntryShape(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  return (e as Record<string, unknown>).kind === 'script';
}

const DOW_NAMES: Record<string, number> = { 周日: 0, 周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6 };

/**
 * 旧 5 模式 → v3 条目（迁移单源）：
 *   · time HH:mm → daily；time 周X → weekly；time 定点 ISO → once（missed 缺省补投）
 *   · workday/holiday 模式 → daily + gates
 *   · delay → every after-last（显式链式保行为等价）
 *   · random min~max → every iv:min jitter:max−min（近似——不炸不丢口径）
 *   · activeHours → gates hours；repeatCount → until count
 *   · gate / gateOnError 丢弃（语义判断归 Agent / 源侧）
 */
export function migrateLegacyEntry(legacy: LegacyTimerEntry): TimerEntry {
  const when: WhenTrigger[] = [];
  const gates: TimerGate[] = [];
  let until: TimerUntil | undefined;
  let missed: 'skip' | 'catchup-once' | undefined;

  const time = legacy.time ?? '';
  const daily = time.match(HHMM);
  const weekly = time.match(/^(周日|周一|周二|周三|周四|周五|周六)\s+(\d{1,2}):(\d{2})$/);
  const full = time.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})$/);
  if (legacy.mode === 'time' || legacy.mode === 'workday' || legacy.mode === 'holiday') {
    if (full !== null) {
      when.push({ kind: 'once', at: full[1] + 'T' + full[2].padStart(2, '0') + ':' + full[3] + ':00' });
      missed = 'catchup-once';
    } else if (weekly !== null) {
      when.push({ kind: 'weekly', dow: DOW_NAMES[weekly[1]] ?? 0, at: weekly[2].padStart(2, '0') + ':' + weekly[3] });
    } else {
      const at = daily !== null ? daily[1].padStart(2, '0') + ':' + daily[2] : '09:00';
      when.push({ kind: 'daily', at });
    }
    if (legacy.mode === 'workday') gates.push({ kind: 'workday' });
    if (legacy.mode === 'holiday') gates.push({ kind: 'holiday' });
  } else if (legacy.mode === 'delay') {
    when.push({ kind: 'every', iv: legacy.delay ?? '30m', base: 'after-last' });
  } else {
    // random：min~max → every iv:min jitter:max−min（缺省 30s~5m）
    const minMs = legacy.delayMin ? parseInterval(legacy.delayMin) ?? 30_000 : 30_000;
    const maxMs = legacy.delayMax ? parseInterval(legacy.delayMax) ?? 300_000 : 300_000;
    const lo = Math.min(minMs, maxMs), hi = Math.max(minMs, maxMs);
    when.push({ kind: 'every', iv: fmtIv(lo), ...(hi > lo ? { jitter: fmtIv(hi - lo) } : {}) });
  }
  const win = (legacy.activeHours ?? '').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (win !== null) {
    gates.push({ kind: 'hours', from: win[1].padStart(2, '0') + ':' + win[2], to: win[3].padStart(2, '0') + ':' + win[4] });
  }
  if (typeof legacy.repeatCount === 'number' && legacy.repeatCount > 0) until = { count: legacy.repeatCount };

  const a = legacy as unknown as Record<string, unknown>;
  const action: TimerAction = { text: legacy.hint };
  if (typeof a.conversationId === 'string' && a.conversationId) action.conversationId = a.conversationId;
  if (legacy.task !== undefined) action.task = legacy.task;
  if (legacy.target !== undefined) action.target = legacy.target;
  return {
    id: legacy.id,
    enabled: legacy.enabled,
    when,
    ...(gates.length > 0 ? { gates } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(missed !== undefined ? { missed } : {}),
    action,
  };
}

/** 毫秒 → 简明间隔串（迁移 random 用） */
function fmtIv(ms: number): string {
  if (ms % 86_400_000 === 0) return (ms / 86_400_000) + 'd';
  if (ms % 3_600_000 === 0) return (ms / 3_600_000) + 'h';
  if (ms % 60_000 === 0) return (ms / 60_000) + 'm';
  return (ms / 1000) + 's';
}

// ============================================================
// 人读摘要（list / UI 展示单源）
// ============================================================

const DOW_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function describeTrigger(t: WhenTrigger): string {
  switch (t.kind) {
    case 'once': return '单次 ' + t.at;
    case 'daily': return '每天 ' + t.at;
    case 'weekly': return '每' + (DOW_CN[t.dow] ?? String(t.dow)) + ' ' + t.at;
    case 'every': {
      const base = t.base ?? 'wall';
      const baseDesc = base === 'wall' ? '' : base === 'after-last' ? '（链式）' : typeof base === 'object' ? '（锚 ' + base.at + '）' : '（锚 ' + base + '）';
      return '每 ' + t.iv + baseDesc + (t.jitter !== undefined ? ' ±' + t.jitter : '');
    }
    case 'source': {
      const m = t.match !== undefined ? ' 匹配 ' + t.match.field + ' ' + t.match.op + ' ' + String(t.match.value) : '';
      return '源 ' + t.source + '/' + t.view + ' ' + t.on + m + (t.cooldown !== undefined ? '（冷却 ' + t.cooldown + '）' : '');
    }
  }
}

/** 人读摘要：停用条目带前缀（cr-1180 停用但保留——list / UI 单源） */
export function describeEntry(e: TimerEntry): string {
  const parts = e.when.map(describeTrigger);
  const gates = e.gates?.map((g) => g.kind === 'hours' ? g.from + '-' + g.to : g.kind === 'workday' ? '工作日' : '节假日').join(' 且 ') ?? '';
  const base = parts.join(' 或 ') + (gates ? '｜' + gates : '') + (e.until ? '｜' + ('count' in e.until ? '满 ' + e.until.count + ' 次' : '至 ' + e.until.date) : '');
  return e.enabled ? base : '已停用｜' + base;
}

// ============================================================
// 间隔解析（every iv / jitter / cooldown 内核）
// ============================================================

/**
 * 解析间隔字符串为毫秒数（300ms/0s/5m/1h/2h30m/7d；非法/零 → null）。
 * 正则交替序 ms 先于 m（否则 '30ms' 被吞成 30 分钟）。
 */
export function parseInterval(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const regex = /(\d+)\s*(ms|s|sec|second|seconds|m|min|minute|minutes|h|hour|hours|d|day|days)/g;
  let total = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(s)) !== null) {
    const value = parseInt(match[1], 10);
    switch (match[2]) {
      case 'ms': total += value; break;
      case 's': case 'sec': case 'second': case 'seconds': total += value * 1000; break;
      case 'm': case 'min': case 'minute': case 'minutes': total += value * 60 * 1000; break;
      case 'h': case 'hour': case 'hours': total += value * 60 * 60 * 1000; break;
      case 'd': case 'day': case 'days': total += value * 24 * 60 * 60 * 1000; break;
    }
  }
  return total > 0 ? total : null;
}

// ============================================================
// 时区墙上时钟（推导与 localISO 内核）
// ============================================================

interface ZonedParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function zonedParts(date: Date, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    y: Number(get('year')), m: Number(get('month')), d: Number(get('day')),
    h: Number(get('hour')) % 24, mi: Number(get('minute')), s: Number(get('second')),
  };
}

/** 时区墙上时钟 → 纪元毫秒（定点迭代：DST 边界外一步收敛） */
function zonedWallToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const base = Date.UTC(y, m - 1, d, h, mi, 0, 0);
  let guess = base;
  let prev = NaN;
  for (let i = 0; i < 3; i++) {
    if (guess === prev) break;
    prev = guess;
    const p = zonedParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s, 0);
    guess = base + (guess - asUtc);
  }
  return guess;
}

// ============================================================
// 节假日判定（gates workday/holiday 消费）
// ============================================================

export interface HolidayOptions {
  holidays?: string[];
  makeupWorkdays?: string[];
}

function formatDate(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 农历节日窗口（src 现状原样） */
function isLunarHoliday(date: Date): boolean {
  try {
    const l = lunar.solarToLunar(date);
    if (l.month === 1 && l.day >= 28 && l.day <= 30) return true;
    if (l.month === 1 && l.day >= 1 && l.day <= 7) return true;
    if (l.month === 5 && l.day >= 3 && l.day <= 5) return true;
    if (l.month === 8 && l.day >= 14 && l.day <= 16) return true;
  } catch {
    /* lunar conversion failed */
  }
  return false;
}

/** 阳历固定节日：元旦、清明、劳动节、国庆 */
function isSolarHoliday(date: Date): boolean {
  const m = date.getMonth() + 1, d = date.getDate();
  if (m === 1 && d === 1) return true;
  if (m === 4 && (d === 4 || d === 5)) return true;
  if (m === 5 && d >= 1 && d <= 3) return true;
  if (m === 10 && d >= 1 && d <= 3) return true;
  return false;
}

/**
 * 创建节假日判定器（调休优先 → 配置节假日 → 农历 → 阳历 → 周末）。
 * tz = owner 生效时区（cr-1053 单源）。
 */
export function createHolidayResolver(options: HolidayOptions = {}, tz?: string) {
  const holidays = new Set(options.holidays ?? []);
  const makeups = new Set(options.makeupWorkdays ?? []);
  const zone = resolveTimezone(tz);
  const toLocal = (date: Date): Date => {
    const p = zonedParts(date, zone);
    return new Date(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  };
  const isHoliday = (date = new Date()): boolean => {
    const d = toLocal(date);
    const today = formatDate(d);
    if (makeups.has(today)) return false;
    if (holidays.has(today)) return true;
    if (isLunarHoliday(d)) return true;
    if (isSolarHoliday(d)) return true;
    const wd = d.getDay();
    return wd === 0 || wd === 6;
  };
  return { isHoliday, isWorkday: (date = new Date()) => !isHoliday(date) };
}

/**
 * 指定时区的 ISO 时间串（墙上时钟在前 + 偏移尾——slice(0,10) 即该时区
 * 日期；诊断面时间字段生产者）。
 */
export function localISO(date = new Date(), tz = DEFAULT_TZ): string {
  const wall = zonedParts(date, resolveTimezone(tz));
  const dateStr = wall.y + '-' + pad2(wall.m) + '-' + pad2(wall.d) + 'T' + pad2(wall.h) + ':' + pad2(wall.mi) + ':' + pad2(wall.s);
  const offsetMin = Math.round((new Date(dateStr + '+00:00').getTime() - date.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  return dateStr + sign + pad2(Math.floor(absMin / 60)) + ':' + pad2(absMin % 60);
}
