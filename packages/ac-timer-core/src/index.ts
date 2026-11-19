// ============================================================
// ac-timer-core —— 定时算法纯库（零 cordis 依赖）
//
// cr-1147 脚本化重做（探测循环定位）：定时器 = 探测循环 + 判定函数。
// next 不是业务触发时刻，是下次探测时刻；触发与否由脚本当轮判定。
// 面向 Agent 自管理（人类经 Agent 间接设置）——无模式、无排定锚点。
// 本库承载：
//   · 脚本契约 —— TimerCheckArgs / TimerCheckVerdict / TimerScriptEntry
//     + validateScriptEntries + nextWaitMs（Date 唯一形态）
//   · makeTimerUtils —— utils 纯函数包（per-owner 构造、方法纯）
//   · compileEntry —— 旧 5 模式条目编译器（存量迁移单源，等价性降级
//     为「不炸、不丢」——Agent 后续自会重写成原生形态）
//   · 算法半边留存 —— parseInterval / msUntilTime（utils.at/after 内核）、
//     createHolidayResolver（utils.workday 消费）、localISO（args.now）
// ============================================================
import * as lunar from 'chinese-lunar';
import { DEFAULT_TZ, resolveTimezone } from 'ac-core-utils'; // 缺省时区单源（cr-1053）

// ============================================================
// utils 纯函数包（cr-1147 v2：判定逻辑所需时间词汇——方法对传入时刻
// 求值，同参恒值可单测；墙钟类操作禁入脚本〔进程时区陷阱〕，经 utils
// 走 owner 时区）
// ============================================================

export interface TimerUtils {
  /** 时刻墙上分钟（0-1439；按 owner 时区） */
  minute(date: Date): number;
  /** 时刻墙上日期（'YYYY-MM-DD'；按 owner 时区） */
  day(date: Date): string;
  /** 时刻墙上周几（0=周日；按 owner 时区） */
  dow(date: Date): number;
  /** 时刻是否工作日（农历+配置判定；按 owner 时区） */
  workday(date: Date): boolean;
  /** 间隔串（'30m'/'2h30m'/'7d'）→ 毫秒数（不是 Date——要 Date 用 after 或 new Date(...) 算术） */
  ms(interval: string): number | null;
  /** 下一个钟面时刻（'09:00' 每日顺延 / '周日 12:00' 每周 / '2026-11-20T09:00' 定点）→ Date；解析不出抛错 */
  at(spec: string): Date;
  /**
   * from 后推 interval → Date（探测节奏常用）。from 可为 Date 或 ISO 串
   * （a.now 可直接传）；锚点/间隔串解析不出一律抛错——cr-1149 前静默退化
   * 为 now（错时刻无提示），现 fail-loud。
   */
  after(interval: string, from?: Date | string): Date;
}

/** 周几独立求值（en-US short weekday） */
function zonedDow(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).formatToParts(date);
  const v = parts.find((x) => x.type === 'weekday')?.value ?? 'Sun';
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[v] ?? 0;
}

/** u.after 锚点归一（cr-1149）：Date / ISO 串两形态，其它 fail-loud */
function toAnchor(from: unknown): Date {
  const d = from instanceof Date ? from : typeof from === 'string' ? new Date(from) : null;
  if (d === null) {
    throw new Error('u.after 第二参须为 Date 或 ISO 字符串（收到 ' + typeof from + '）——a.now 可直接传，或传 new Date(a.now)');
  }
  if (isNaN(d.getTime())) throw new Error('u.after 第二参无法解析为时刻：' + String(from));
  return d;
}

/** u.after 间隔串解析——解析不出 fail-loud（cr-1149 前静默当 0） */
function anchorInterval(iv: unknown): number {
  const ms = typeof iv === 'string' ? parseInterval(iv) : null;
  if (ms === null) {
    throw new Error('u.after 间隔串无法解析（' + JSON.stringify(String(iv)) + "）——用 '30m'/'2h30m'/'7d' 形态");
  }
  return ms;
}

/**
 * 构造 utils 包（per-owner：闭包捕获 tz + 节假日配置——配置不随检测变，
 * 构造一次复用）。方法纯：对传入时刻求值，同参恒值。
 */
export function makeTimerUtils(options: { tz?: string; holidays?: string[]; makeupWorkdays?: string[] } = {}): TimerUtils {
  const tz = resolveTimezone(options.tz);
  const holidays = createHolidayResolver({ holidays: options.holidays, makeupWorkdays: options.makeupWorkdays }, tz);
  return {
    minute: (d) => { const w = zonedParts(d, tz); return w.h * 60 + w.mi; },
    day: (d) => localISO(d, tz).slice(0, 10),
    dow: (d) => zonedDow(d, tz),
    workday: (d) => holidays.isWorkday(d),
    ms: (iv) => parseInterval(iv),
    at: (spec) => {
      const ms = msUntilTime(spec, new Date(), tz);
      if (ms === null) {
        throw new Error('u.at 时刻串无法解析或已过（' + JSON.stringify(String(spec)) + "）——支持 '09:00' / '周日 12:00' / '2026-11-20T09:00'（未来）");
      }
      return new Date(Date.now() + ms);
    },
    after: (iv, from) => new Date((from === undefined ? new Date() : toAnchor(from)).getTime() + anchorInterval(iv)),
  };
}

export function validateScriptEntries(raw: unknown): TimerScriptEntry[] {
  if (!Array.isArray(raw)) throw new Error('参数 entries 须为 TimerScriptEntry 数组');
  return raw.map((item, i) => {
    if (item === null || typeof item !== 'object') throw new Error('entries[' + i + '] 非对象');
    const e = item as Record<string, unknown>;
    const at = (k: string): string => 'entries[' + i + '].' + k;
    if (typeof e.id !== 'string' || e.id === '') throw new Error(at('id') + ' 缺失');
    if (e.kind !== undefined && e.kind !== 'script') throw new Error(at('kind') + ' 非法（' + String(e.kind) + '）');
    if (typeof e.code !== 'string' || e.code.trim() === '') throw new Error(at('code') + ' 缺失（判定脚本源码）');
    if (e.enabled !== undefined && typeof e.enabled !== 'boolean') throw new Error(at('enabled') + ' 须为 boolean');
    if (e.conversationId !== undefined && (typeof e.conversationId !== 'string' || !e.conversationId)) {
      throw new Error(at('conversationId') + ' 须为非空字符串');
    }
    if (e.target !== undefined && typeof e.target !== 'string') throw new Error(at('target') + ' 须为字符串');
    if (e.task !== undefined && e.task !== 'archive-all' && e.task !== 'backup-all') throw new Error(at('task') + ' 非法');
    if (e.gate !== undefined && typeof e.gate !== 'string') throw new Error(at('gate') + ' 须为字符串');
    if (e.gateOnError !== undefined && e.gateOnError !== 'skip' && e.gateOnError !== 'run') throw new Error(at('gateOnError') + ' 非法');
    if (e.label !== undefined && typeof e.label !== 'string') throw new Error(at('label') + ' 须为字符串');
    return e as unknown as TimerScriptEntry;
  });
}

/**
 * 旧 5 模式条目（cr-1147 前持久形态；现为 compileEntry 输入 + 迁移判据）。
 * 磁盘上仍可能是此形状——宿主 boot 时经 compileEntry 一次性编译为脚本条目。
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
  /** 预检门命令（存量兼容件：新条目不再宣传——判定逻辑归脚本） */
  gate?: string;
  gateOnError?: 'skip' | 'run';
}

export function isLegacyEntryShape(e: unknown): e is LegacyTimerEntry {
  if (typeof e !== 'object' || e === null) return false;
  const r = e as Record<string, unknown>;
  return r.kind === undefined && typeof r.mode === 'string';
}

/**
 * 检测入参（宿主记账快照——纯数据，四字段零派生量）。
 */
export interface TimerCheckArgs {
  /** 本轮检测时刻（owner 时区 ISO——localISO 产出；Date 可直接构造） */
  now: string;
  /** 上次投递时刻（owner 时区 ISO；从未触发 = 缺席）——防重/补偿判据 */
  last?: string;
  /** 历史投递次数（宿主权威——gate 跳过轮不计数；「跑满 N 次收工」用） */
  count: number;
  /** 脚本私有持久状态（上次 verdict 带回；结构由脚本自定义） */
  state?: unknown;
}

/**
 * 检测脚本 verdict：正交四轴——触发（action）/ 排程（next）/ 记忆（state）/
 * 生死（active）。探测循环定位：next = 下次探测时刻，非业务触发时刻。
 */
export interface TimerCheckVerdict {
  /** 本轮投递的唤醒文本（undefined = 静默检测轮）。有值即投唤醒信。 */
  action?: string;
  /**
   * 下次探测时刻（Date 唯一形态）。用 utils.at()/after() 构造（宿主 tz
   * 解析）或 epoch 算术；过去值钳到 CHECK_FLOOR_MS 地板。
   */
  next?: Date;
  /** 脚本私有持久状态（宿主原样存取——跨检测记忆，gate 跳过轮也保存） */
  state?: unknown;
  /** false = 任务完成：不排下次、条目摘除归档。缺省 true。与 action 正交。 */
  active?: boolean;
}

/** 检测脚本签名（双参：args 快照 + utils 纯函数包） */
export type TimerCheckFn = (args: TimerCheckArgs, utils: TimerUtils) => TimerCheckVerdict | Promise<TimerCheckVerdict>;

/** 探测间隔地板（防忙循环——探测循环定位下唯一的节奏防线） */
export const CHECK_FLOOR_MS = 10_000;

/**
 * verdict.next（Date）→ 距 now 的等待毫秒（宿主排程唯一入口）。
 * 非 Date/NaN 按 null（调用方按脚本错误处置）；过去值 → 地板（脚本 bug
 * 防线，不静默吞——nextWaitMs 返回地板而非 0，配合 scheduleCheck 双保险）。
 */
export function nextWaitMs(next: Date | undefined, now = new Date()): number | null {
  if (!(next instanceof Date) || isNaN(next.getTime())) return null;
  const wait = next.getTime() - now.getTime();
  if (wait <= 0) return CHECK_FLOOR_MS;
  return wait;
}

/** verdict 字段值的人读描述（错误提示用） */
function showValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof Date) return 'Date(' + (isNaN(v.getTime()) ? 'Invalid' : v.toISOString()) + ')';
  if (Array.isArray(v)) return '数组';
  if (v !== null && typeof v === 'object') return '对象';
  return typeof v + ' ' + String(v);
}

/** inspectVerdict 结果：error = 类型层不合法（拒）；notes = 可运行但可疑（提示） */
export interface VerdictInspection {
  error?: string;
  notes: string[];
}

/** next 过期容差（超出的过去值按错误处置——cr-1149 v2） */
const LATE_TOLERANCE_MS = CHECK_FLOOR_MS;

/**
 * verdict 校验（cr-1149；干跑与运行期共用一份判据）：
 *   · error —— 不合法（干跑直接拒，运行期整轮不处置 + 退避）；
 *   · notes —— 可运行但可疑（next 刚过期等）。
 * active:false 是完成态：不排下次，故不校验 next。
 *
 * next 过期分档（cr-1149 v2）：过去 ≤ LATE_TOLERANCE_MS = 刚到期（执行耗时/
 * 边界竞态），按到期排地板；超出 = 锚点算错的信号——带 action 时会按地板
 * 间隔反复投递（10s 一条刷屏风暴），故升级为 error 整轮不处置。
 */
export function inspectVerdict(verdict: unknown, now = new Date()): VerdictInspection {
  const notes: string[] = [];
  if (verdict === null || typeof verdict !== 'object' || Array.isArray(verdict)) {
    return { error: '脚本须 return 纯数据对象 { action?, next?, state?, active? }（收到 ' + showValue(verdict) + '）', notes };
  }
  const v = verdict as Record<string, unknown>;
  if (v.active !== undefined && typeof v.active !== 'boolean') {
    return { error: 'verdict.active 须为 boolean（false = 完成归档）——收到 ' + showValue(v.active), notes };
  }
  if (v.action !== undefined && typeof v.action !== 'string') {
    return { error: 'verdict.action 须为字符串（唤醒文本）——收到 ' + showValue(v.action), notes };
  }
  if (v.active === false) return { notes };
  if (v.next === undefined) {
    return { error: 'verdict.next 缺失（须返回下次探测时刻；active:false 才可省）', notes };
  }
  if (!(v.next instanceof Date) || isNaN(v.next.getTime())) {
    return {
      error:
        'verdict.next 须为 Date（u.at()/u.after() 构造或 new Date(epoch 毫秒)）——收到 ' + showValue(v.next) +
        '；u.ms() 只返回毫秒数，要 Date 得 u.after(iv) 或 new Date(Date.now() + u.ms(iv))',
      notes,
    };
  }
  const late = now.getTime() - v.next.getTime();
  if (late > LATE_TOLERANCE_MS) {
    return {
      error:
        'verdict.next 在过去 ' + Math.round(late / 1000) + 's（' + v.next.toISOString() + '）——排程地板 ' +
        CHECK_FLOOR_MS + 'ms，带 action 时会按地板间隔反复投递（10s 一条）；多半是锚点算错（new Date(0)、' +
        '忘加偏移、u.after 传了 a.now 却没解析）',
      notes,
    };
  }
  if (late > 0) {
    notes.push('verdict.next 刚过期 ' + Math.round(late / 1000) + 's（容差 ' + LATE_TOLERANCE_MS + 'ms 内）——按到期处理，钳地板排下一轮');
  }
  return { notes };
}

/**
 * 脚本条目（cr-1147 起唯一持久形态；entries/timer.json）。
 * 检测 = code（判定脚本）；投递 = conversationId/target/task/gate（宿主安全面）。
 */
export interface TimerScriptEntry {
  id: string;
  enabled: boolean;
  kind: 'script';
  /** 判定脚本源码（可擦除 TS 双参谓词——TimerCheckFn 形状，须自包含） */
  code: string;
  /** 人读标签 */
  label?: string;
  conversationId?: string;
  task?: 'archive-all' | 'backup-all';
  target?: string;
  gate?: string;
  gateOnError?: 'skip' | 'run';
}

// ============================================================
// compileEntry（存量迁移编译器——语义等价降级为「不炸、不丢」）
// ============================================================


/**
 * 旧 5 模式条目 → 脚本条目编译器（迁移单源；boot 与手工迁移共用）。
 * v2 语义等价降级为「不炸、不丢」：产物为 (a,u) 双参谓词，判定逻辑
 * 机械直译旧模式意图，锚点精确性不再追求（探测循环定位——Agent 后续
 * 自会重写为原生形态）。
 *   · time 每天/周几 → u.minute(a.now) 到点判定 + u.day(a.last) 防重 + next=u.at(time)
 *   · time 指定日期 → 过日终结；到点触发即完成
 *   · delay → 首轮静默排满周期（state.started）；次轮起 action + next=u.after(delay)
 *   · random → 每轮现抽 [rmin,rmax]
 *   · workday/holiday → u.workday(new Date(a.now)) 门控
 *   · activeHours → u.minute 窗口判定（跨午夜或形）
 *   · repeatCount → a.count+1 >= N 时 action + active:false
 * hint → 静态 action 文本。
 */
export function compileEntry(legacy: LegacyTimerEntry): TimerScriptEntry {
  const mode = legacy.mode;
  const isCal = mode === 'time' || mode === 'workday' || mode === 'holiday';
  const time = isCal ? (legacy.time ?? '') : '';
  const daily = time.match(/^(\d{1,2}):(\d{2})$/);
  const weekly = time.match(/^(周日|周一|周二|周三|周四|周五|周六)\s+(\d{1,2}):(\d{2})$/);
  const full = time.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})$/);
  const repeat = typeof legacy.repeatCount === 'number' && legacy.repeatCount > 0 ? legacy.repeatCount : 0;
  const text = JSON.stringify(legacy.hint);
  const dow: Record<string, number> = { 周日: 0, 周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6 };
  const win = (legacy.activeHours ?? '').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  const winS = win ? parseInt(win[1], 10) * 60 + parseInt(win[2], 10) : 0;
  const winE = win ? parseInt(win[3], 10) * 60 + parseInt(win[4], 10) : 0;
  const inWin = win
    ? winS < winE
      ? 'u.minute(now) >= ' + winS + ' && u.minute(now) < ' + winE
      : '(u.minute(now) >= ' + winS + ' || u.minute(now) < ' + winE + ')'
    : '';
  const workdayGate = mode === 'workday' ? ' && u.workday(now)' : mode === 'holiday' ? ' && !u.workday(now)' : '';
  const repeatArm = repeat > 0
    ? '  if (a.count + 1 >= ' + repeat + ') return { action: text, active: false };\n'
    : '';
  const head = '  const text = ' + text + ';\n  const now = new Date(a.now);\n';
  const guard = inWin ? '  if (!(' + inWin + ')) return { next: u.after(\'1h\') };\n' : '';
  let body = '';
  if (!isCal && mode === 'delay' && !legacy.delay) {
    body = head + '  return { active: false };';
  } else if (!isCal) {
    const nextLit = mode === 'delay' ? 'u.after(' + JSON.stringify(legacy.delay ?? '30m') + ')' : 'd';
    const draw = mode === 'random'
      ? (() => {
          const min = legacy.delayMin ? (parseInterval(legacy.delayMin) ?? 30_000) : 30_000;
          const max = legacy.delayMax ? (parseInterval(legacy.delayMax) ?? 300_000) : 300_000;
          const lo = Math.min(min, max), hi = Math.max(min, max);
          return '  const d = new Date(Date.now() + ' + lo + ' + Math.floor(Math.random() * ' + (hi - lo + 1) + '));\n';
        })()
      : '';
    body = head
      + draw
      + guard
      + '  if (!(a.state && a.state.started)) return { next: ' + nextLit + ', state: { started: true } };\n'
      + repeatArm
      + '  return { action: text, next: ' + nextLit + ' };';
  } else if (full !== null) {
    const day = full[1];
    const targetMin = parseInt(full[2], 10) * 60 + parseInt(full[3], 10);
    body = head
      + '  if (u.day(now) > ' + JSON.stringify(day) + ') return { active: false };\n'
      + '  const hit = u.day(now) === ' + JSON.stringify(day) + ' && u.minute(now) >= ' + targetMin + workdayGate + ' && !a.last;\n'
      + '  return hit ? { action: text, active: false } : { next: u.at(' + JSON.stringify(day + 'T' + full[2] + ':' + full[3]) + ') };';
  } else {
    const specLit = JSON.stringify(time);
    let hitCond = '';
    if (weekly !== null) {
      const wd = dow[weekly[1]] ?? 0;
      const targetMin = parseInt(weekly[2], 10) * 60 + parseInt(weekly[3], 10);
      hitCond = 'u.dow(now) === ' + wd + ' && u.minute(now) >= ' + targetMin;
    } else {
      const m = daily !== null ? daily : ['0', '0', '0'] as unknown as RegExpMatchArray;
      const targetMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      hitCond = 'u.minute(now) >= ' + targetMin;
    }
    const lastGuard = ' && (!a.last || u.day(new Date(a.last)) !== u.day(now))';
    const repeatHit = repeat > 0
      ? '  if (hit && a.count + 1 >= ' + repeat + ') return { action: text, active: false };\n'
      : '';
    body = head
      + guard
      + '  const hit = ' + hitCond + lastGuard + workdayGate + ';\n'
      + repeatHit
      + '  return hit ? { action: text, next: u.at(' + specLit + ') } : { next: u.at(' + specLit + ') };';
  }
  return {
    id: legacy.id,
    enabled: legacy.enabled,
    kind: 'script',
    code: '(a, u) => {\n' + body + '\n}',
    label: describeLegacy(legacy),
    ...(legacy.conversationId !== undefined ? { conversationId: legacy.conversationId } : {}),
    ...(legacy.task !== undefined ? { task: legacy.task } : {}),
    ...(legacy.target !== undefined ? { target: legacy.target } : {}),
    ...(legacy.gate !== undefined ? { gate: legacy.gate } : {}),
    ...(legacy.gateOnError !== undefined ? { gateOnError: legacy.gateOnError } : {}),
  };
}

/** 旧条目人读标签（迁移 label 固化） */
function describeLegacy(legacy: LegacyTimerEntry): string {
  const sched = legacy.time ?? legacy.delay ?? (legacy.delayMin && legacy.delayMax ? legacy.delayMin + '~' + legacy.delayMax : '');
  return '定时 ' + legacy.mode + (sched ? ' ' + sched : '');
}

// ============================================================
// 间隔与目标时间（utils.at/after 解析内核）
// ============================================================

/**
 * 解析间隔字符串为毫秒数（300ms/0s/5m/1h/2h30m；非法/零 → null）。
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
 * tz = owner 生效时区（cr-1053 单源）。
 */
export function msUntilTime(timeStr: string, now = new Date(), tz?: string): number | null {
  const p = zonedParts(now, resolveTimezone(tz));
  const pseudo = new Date(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  const localMs = msUntilLocal(timeStr, pseudo);
  if (localMs === null) return null;
  const targetLocal = new Date(pseudo.getTime() + localMs);
  const epoch = zonedWallToUtc(
    targetLocal.getFullYear(), targetLocal.getMonth() + 1, targetLocal.getDate(),
    targetLocal.getHours(), targetLocal.getMinutes(), resolveTimezone(tz),
  );
  return epoch - now.getTime();
}

/** msUntilTime 的墙上时钟算术内核（仅内部消费） */
function msUntilLocal(timeStr: string, now: Date): number | null {
  const s = timeStr.trim();

  const fullMatch = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})$/);
  if (fullMatch) {
    const target = new Date(fullMatch[1] + 'T' + fullMatch[2] + ':' + fullMatch[3]);
    if (isNaN(target.getTime())) return null;
    const ms = target.getTime() - now.getTime();
    return ms > 0 ? ms : null;
  }

  const weekdayNames: Partial<Record<string, number>> = {
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

// ============================================================
// 时区墙上时钟（utils.minute/day 与 args.now 的内核）
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
// 节假日判定（utils.workday 消费）
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
 * 日期；args.now / args.last 的生产者）。
 */
export function localISO(date = new Date(), tz = DEFAULT_TZ): string {
  const wall = zonedParts(date, resolveTimezone(tz));
  const dateStr = wall.y + '-' + pad2(wall.m) + '-' + pad2(wall.d) + 'T' + pad2(wall.h) + ':' + pad2(wall.mi) + ':' + pad2(wall.s);
  const offsetMin = Math.round((new Date(dateStr + '+00:00').getTime() - date.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  return dateStr + sign + pad2(Math.floor(absMin / 60)) + ':' + pad2(absMin % 60);
}
