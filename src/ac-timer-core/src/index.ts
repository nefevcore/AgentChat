// ============================================================
// ac-timer-core —— 定时算法纯库（零 cordis 依赖）
//
// src svc/timer/timer.ts 的算法半边原样平移（调度状态机在 ac-timer 行，
// 官方 cordis-timer 的 ctx.timeout/interval 承担排程回收）：
//   · parseInterval   —— 间隔串（0s/5m/1h/2h30m）→ 毫秒
//   · msUntilTime     —— 每日 HH:mm / 指定日期 / 周几 → 目标毫秒
//   · 节假日判定      —— 农历（chinese-lunar）+ 阳历固定 + 周末 +
//                        调休配置覆盖（makeup 优先于 holiday）
//   · localISO        —— 指定时区的 ISO 串（降级 UTC+8）
//   · renderHint      —— {{now}}/{{time}}/{{date}}/{time} 模板
//   · describeEntry   —— 条目的人类可读标签
// ============================================================
import * as lunar from 'chinese-lunar';

/** 定时任务条目（5 模式；持久化形态归 ac-agent-store entry 'timer'） */
export interface TimerEntry {
  id: string;
  enabled: boolean;
  mode: 'time' | 'delay' | 'random' | 'workday' | 'holiday';
  /** mode=time/workday/holiday：HH:mm（每天）/ YYYY-MM-DDTHH:mm（指定）/ 周日 12:00 */
  time?: string;
  /** mode=delay：间隔串（如 30m） */
  delay?: string;
  /** mode=random：下界（缺省 30s） */
  delayMin?: string;
  /** mode=random：上界（缺省 5m） */
  delayMax?: string;
  /** 限定次数（>0；缺省/0 = 永久） */
  repeatCount?: number;
  /** 触发提示词（agent run 的入站内容；模板变量见 renderHint） */
  hint: string;
  /**
   * 机制任务（规约 3：机制任务不过 LLM）：'archive-all' / 'backup-all'——
   * 直调对应服务方法，替代 src 的 __archive_all__ 字符串协议。
   */
  task?: 'archive-all' | 'backup-all';
  /**
   * 目标清单（仅全局条目有意义）：逗号分隔 agent id 或 '*'（全部非
   * virtual Agent）；per-Agent 条目缺省 = 所属 agent。
   */
  target?: string;
  /** 条目来源标注（诊断） */
  source?: string;
}

/** 全局定时条目（chime 兼容形态；target '*' = 全部已注册 agent） */
export interface GlobalScheduleEntry {
  time: string;
  hint?: string;
  targets?: string[];
}

// ============================================================
// 间隔与目标时间
// ============================================================

/**
 * 解析间隔字符串为毫秒数（300ms/0s/5m/1h/2h30m；非法/零 → null）。
 * 单位集合为 src 超集：补 ms（毫秒）供测试与细粒度场景；
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

/**
 * 计算到目标时间的毫秒数（已过 → null，除每日 HH:mm 顺延次日）。
 * 支持：HH:mm（每天）、YYYY-MM-DDTHH:mm / YYYY-MM-DD HH:mm（指定）、
 * Sun 12:00 / 周日 12:00（每周）。
 * @param tz 目标时刻所在 IANA 时区（缺省 = 运行环境本地时区——历史行为
 *   原样；传入时"HH:mm"按该时区的墙上时钟解释，跨夏令时由目标时刻
 *   处的偏移收敛；非法 tz 降级本地）
 */
export function msUntilTime(timeStr: string, now = new Date(), tz?: string): number | null {
  if (!tz) return msUntilLocal(timeStr, now);
  let p: ZonedParts;
  try {
    p = zonedParts(now, tz);
  } catch {
    return msUntilLocal(timeStr, now); // 非法 tz 降级本地（localISO 同款容错）
  }
  // 伪本地时刻：本地字段 = tz 墙上时钟 → 复用既有墙上时钟算术
  const pseudo = new Date(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  const localMs = msUntilLocal(timeStr, pseudo);
  if (localMs === null) return null;
  const targetLocal = new Date(pseudo.getTime() + localMs);
  const epoch = zonedWallToUtc(
    targetLocal.getFullYear(), targetLocal.getMonth() + 1, targetLocal.getDate(),
    targetLocal.getHours(), targetLocal.getMinutes(), tz,
  );
  return epoch - now.getTime();
}

/** msUntilTime 的本地时区实现（历史行为原样；tz 路径经伪本地时刻复用） */
function msUntilLocal(timeStr: string, now: Date): number | null {
  const s = timeStr.trim();

  const fullMatch = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2})$/);
  if (fullMatch) {
    const target = new Date(`${fullMatch[1]}T${fullMatch[2]}`);
    if (isNaN(target.getTime())) return null;
    const ms = target.getTime() - now.getTime();
    return ms > 0 ? ms : null;
  }

  const weekdayNames: Record<string, number> = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
    '周日': 0, '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6,
  };
  const weekdayMatch = s.match(/^([A-Za-z\u4e00-\u9fff]+)\s+(\d{1,2}):(\d{2})$/);
  if (weekdayMatch) {
    const wd = weekdayNames[weekdayMatch[1]] ?? weekdayNames[weekdayMatch[1].toLowerCase()];
    if (wd === undefined) return null;
    const h = parseInt(weekdayMatch[2], 10), mi = parseInt(weekdayMatch[3], 10);
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi, 0, 0);
    const dayDiff = (wd + 7 - now.getDay()) % 7;
    if (dayDiff === 0 && target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 7);
    } else {
      target.setDate(target.getDate() + dayDiff);
    }
    return target.getTime() - now.getTime();
  }

  const dailyMatch = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!dailyMatch) return null;
  const h = parseInt(dailyMatch[1], 10), mi = parseInt(dailyMatch[2], 10);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

/** 是否完整日期时间（非每日 HH:mm / 周几格式） */
export function isFullDatetime(timeStr: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(timeStr.trim());
}

const WEEKDAY_CN: Record<string, string> = {
  sun: '周日', mon: '周一', tue: '周二', wed: '周三', thu: '周四', fri: '周五', sat: '周六',
};

/** 是否周几格式（Sun 12:00 / 周一 09:00） */
export function isWeekdayTime(timeStr: string): boolean {
  return /^[A-Za-z\u4e00-\u9fff]+\s+\d{1,2}:\d{2}$/.test(timeStr.trim());
}

// ============================================================
// 时区墙上时钟（tz 参数路径；缺省路径不经过——历史行为零变化）
// ============================================================

/** 时刻在某时区的墙上时钟字段（Intl formatToParts；非法 tz 抛错） */
interface ZonedParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** 周几（0=周日；Intl 短名映射） */
  wd: number;
}

const WEEKDAY_SHORT: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function zonedParts(date: Date, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const wd = WEEKDAY_SHORT[get('weekday')];
  return {
    y: Number(get('year')), m: Number(get('month')), d: Number(get('day')),
    h: Number(get('hour')) % 24, mi: Number(get('minute')), s: Number(get('second')),
    wd: wd ?? NaN,
  };
}

/** 时区墙上时钟 → 纪元毫秒（定点迭代：guess = 基准 − 当前偏移；DST 边界外一步收敛） */
function zonedWallToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const base = Date.UTC(y, m - 1, d, h, mi, 0, 0);
  let guess = base;
  let prev = NaN;
  for (let i = 0; i < 3; i++) {
    if (guess === prev) break; // 已收敛（偏移稳定）
    prev = guess;
    const p = zonedParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s, 0);
    // off = guess − asUtc = −offset（东八区 off=−8h）→ E = 基准 − offset = base + off
    guess = base + (guess - asUtc);
  }
  return guess;
}

/** 周几时间 → 中文标签（Sun 12:00 → 每周日 12:00） */
export function formatWeekdayLabel(timeStr: string): string {
  const m = timeStr.trim().match(/^([A-Za-z\u4e00-\u9fff]+)\s+(\d{1,2}:\d{2})$/);
  if (!m) return timeStr;
  const wd = WEEKDAY_CN[m[1]] ?? WEEKDAY_CN[m[1].toLowerCase()] ?? m[1];
  return `每${wd} ${m[2]}`;
}

/** 随机延迟（[min, max]；非法回退 30s~5m） */
export function randomDelay(minStr?: string, maxStr?: string): number {
  const min = parseInterval(minStr || '30s') ?? 30_000;
  const max = parseInterval(maxStr || '5m') ?? 300_000;
  if (min >= max) return max;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 条目的人类可读标签 */
export function describeEntry(entry: TimerEntry): string {
  switch (entry.mode) {
    case 'time':
      return isFullDatetime(entry.time ?? '')
        ? entry.time!
        : isWeekdayTime(entry.time ?? '')
          ? formatWeekdayLabel(entry.time!)
          : `每天 ${entry.time}`;
    case 'workday':
      return `工作日 ${entry.time}`;
    case 'holiday':
      return `节假日 ${entry.time}`;
    case 'random':
      return `随机 ${entry.delayMin || '30s'}~${entry.delayMax || '5m'}`;
    default:
      return `每隔 ${entry.delay}`;
  }
}

// ============================================================
// 节假日判定（农历 + 阳历固定 + 周末 + 配置覆盖）
// ============================================================

export interface HolidayOptions {
  /** 额外法定节假日（YYYY-MM-DD） */
  holidays?: string[];
  /** 调休工作日（YYYY-MM-DD；优先于节假日判定） */
  makeupWorkdays?: string[];
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 农历节日窗口（src 现状原样：正月 1~7 春节 + 正月 28~30 窗口、五月 3~5 端午、八月 14~16 中秋） */
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
 * @param tz 判定所用时区（缺省 = 运行环境本地；传入时"今天/周几"按该
 *   时区墙上时钟取——per-Agent 时区的 workday/holiday 门控）
 */
export function createHolidayResolver(options: HolidayOptions = {}, tz?: string) {
  const holidays = new Set(options.holidays ?? []);
  const makeups = new Set(options.makeupWorkdays ?? []);
  const toLocal = tz
    ? (date: Date): Date => {
        try {
          const p = zonedParts(date, tz);
          return new Date(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
        } catch {
          return date; // 非法 tz 降级本地
        }
      }
    : (date: Date): Date => date;
  const isHoliday = (date = new Date()): boolean => {
    const d = toLocal(date);
    const today = formatDate(d);
    if (makeups.has(today)) return false; // 调休工作日优先
    if (holidays.has(today)) return true;
    if (isLunarHoliday(d)) return true;
    if (isSolarHoliday(d)) return true;
    const wd = d.getDay();
    return wd === 0 || wd === 6;
  };
  return { isHoliday, isWorkday: (date = new Date()) => !isHoliday(date) };
}

// ============================================================
// 时区与模板
// ============================================================

/** 指定时区的 ISO 时间串（sv-SE 格式化 + 偏移推导；降级 UTC+8） */
export function localISO(date = new Date(), tz = 'Asia/Shanghai'): string {
  try {
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    const dateStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;

    const utcParts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const utcGet = (type: string) => utcParts.find((p) => p.type === type)?.value ?? '00';
    const utcTime = new Date(
      `${utcGet('year')}-${utcGet('month')}-${utcGet('day')}T${utcGet('hour')}:${utcGet('minute')}:${utcGet('second')}Z`,
    );
    const offsetMin = Math.round((new Date(`${dateStr}+00:00`).getTime() - utcTime.getTime()) / 60000);
    const sign = offsetMin >= 0 ? '+' : '-';
    const absMin = Math.abs(offsetMin);
    return `${dateStr}${sign}${String(Math.floor(absMin / 60)).padStart(2, '0')}:${String(absMin % 60).padStart(2, '0')}`;
  } catch {
    // 降级：硬编码 UTC+8（src 语义）
  }
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())}T${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}+08:00`;
}

/** hint 模板渲染：{{now}}/{{time}}/{{date}}/{time}（nowDate 注入便于测试） */
export function renderHint(hint: string, entry: TimerEntry, nowDate = new Date()): string {
  const hh = String(nowDate.getHours()).padStart(2, '0');
  const mm = String(nowDate.getMinutes()).padStart(2, '0');
  return (hint || '')
    .replace(/\{\{now\}\}/g, nowDate.toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' }))
    .replace(/\{\{time\}\}/g, `${hh}:${mm}`)
    .replace(/\{\{date\}\}/g, nowDate.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }))
    .replace(/\{time\}/g, entry.time || `${hh}:${mm}`);
}

/**
 * 计算条目下一次延迟（排程用）。
 * random/delay 模式：优先用持久化状态恢复剩余延迟（elapsed 抵扣）；
 * time/workday/holiday：msUntilTime。恢复态由调用方（ac-timer）持有。
 */
export function nextDelayOf(
  entry: TimerEntry,
  persisted: { startedAt?: string; totalDelayMs?: number } | undefined,
  now = Date.now(),
  tz?: string,
): number | null {
  if (entry.mode === 'random') {
    if (persisted?.startedAt && persisted.totalDelayMs != null) {
      const elapsed = now - new Date(persisted.startedAt).getTime();
      return Math.max(0, persisted.totalDelayMs - elapsed);
    }
    return randomDelay(entry.delayMin, entry.delayMax);
  }
  if (entry.mode === 'delay') {
    if (persisted?.startedAt && persisted.totalDelayMs) {
      const elapsed = now - new Date(persisted.startedAt).getTime();
      return Math.max(0, persisted.totalDelayMs - elapsed);
    }
    return entry.delay ? parseInterval(entry.delay) : null;
  }
  return entry.time ? msUntilTime(entry.time, new Date(now), tz) : null;
}
