// ============================================================
// timers-row.ts —— 宿主 timers 行（cr-539：R1 timers 行「定时唤醒
//（唤醒 = 投递信）」preview 落地——A13 持久唤醒恒宿主投递信）
//
// 主线 packages/ac-timer TimersService 排程状态机语义照搬（D10 机制照搬）：
// 5 模式排程 / 限定次与永久 / 停机补偿 / gate 预检 / 日历重排地板 /
// 在途守卫 / 完成归档 / 简化形状归一化——算法住 ac-timer-core 纯库。
// 换数据面（宿主自有服务不进子树——主线四服务依赖换轨）：
//   ctx.agents          → agents-core 直读（listAgentIds + config 过滤）
//   ctx.agentStore      → agents/<id>/entries/timer.json（cr-551 单写者收口：
//                        写口换轨 agents 编辑面，缺省自带直读写降级）
//   ctx.conversation    → 邮局信封投递（po.dispatch——唤醒信预算满额，
//                         user 直发重置语义：sender 恒按主线规则）
//   ctx.config          → 保留（宿主 config 行同树装配，key timer.tasks）
// settingsOf 分层（timers 层）：全局默认层 = config.json[agents.settings]
// 状态文件 <dataRoot>/timer/state.json（临时文件+rename 原子写，同主线）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { Service, type Context, type Plugin } from '@agentchat/cordis';
import { listAgentIds, readAgentConfig, settingsOf, isPresetId } from 'ac-agents-core';
import { DEFAULT_TZ } from 'ac-core-utils'; // 缺省时区基线（cr-1053 单源）

/** entries 写口插槽（agents 编辑面服务键 'agents'——cr-551 单写者收口） */
export interface EntriesEditFace {
  saveEntry(id: string, key: string, data: unknown): void;
  readEntry<T>(id: string, key: string): T | undefined;
}
import { makeEnvelope, issueRequestId } from 'ac-envelope-core';
import type { Envelope } from 'ac-envelope-core';
import type { PostOffice } from 'ac-post-office';
import {
  createHolidayResolver,
  localISO,
  msUntilTime,
  nextDelayOf,
  parseInterval,
  randomDelay,
  renderHint,
  withinActiveHours,
  type TimerEntry,
} from 'ac-timer-core';

/** 全局条目 owner（sys.timer；target '*' = 全部常规 Agent） */
export const GLOBAL_TIMER_OWNER = '__global__';

// validateTimerEntries 已 cr-886 下沉 ac-timer-core（宿主能力面消费成环解法）

/** 行配置 */
export interface TimersHostRowOptions {
  dataRoot: string;
  /** 邮局（唤醒信投递面）——宿主 boot 注入 */
  postOffice: PostOffice;
  /** 时区基线（缺省 Asia/Shanghai） */
  timezone?: string;
  /** 心跳间隔（缺省 30s；测试可调小） */
  heartbeatMs?: number;
  /** gate 预检命令超时（缺省 30s；超时 fail-open） */
  gateTimeoutMs?: number;
  /**
   * agents 编辑面（cr-551 单写者收口——entries 写口单源）。缺席时本行
   * 自带直读写（测试/独立形态——与编辑面同布局同原子性）。
   */
  agentsEdit?: EntriesEditFace;
}

/** 持久化运行时状态（停机补偿依据；'_' 前缀 = 内部键） */
interface TimerPersistedState {
  lastTriggeredAt?: string;
  executedCount?: number;
  startedAt?: string;
  totalDelayMs?: number;
}

/** 完成条目归档记录（entries/timer-archive.json 行形状） */
interface TimerArchiveRecord extends TimerEntry {
  status: 'completed';
  completedAt: string;
  executedCount: number;
}

/** entries/timer.json 持久形态 */
interface TimerStoreEntry {
  entries: TimerEntry[];
}

/** settings 分层形状（行基线 → 全局默认层 → Agent 差异层） */
interface TimerLayerSettings {
  timezone?: string;
  holidays?: string[];
  makeupWorkdays?: string[];
}

/**
 * gate 预检结果（ISSUE-22 补丁三）：
 *   run    = 退出码 0，放行
 *   silent = 退出码 1，约定「预期静默」（如夜间窗口脚本——零 token 跳过）
 *   error  = 其它非零：gate 自身故障（脚本崩/依赖缺失/写法错）
 * 旧实现把 silent 与 error 混作「跳过」，于是 gate 崩掉时条目会永久静默，
 * 且从外部与每夜正常静默完全同形（不可观测）。
 */
type GateVerdict = 'run' | 'silent' | 'error';

/**
 * 「预期静默」的**无歧义**退出码。必须与 1 并存的原因：
 * 1 是绝大多数运行时未捕获异常的默认退出码（python 未捕获异常 = 1、
 * node 未捕获异常 = 1）——把 1 直接当「约定静默」会让 gate 崩溃伪装成
 * 夜间静默（正是 ISSUE-22 要消灭的那种）。
 * 故：1 = 静默**仅当 stderr 为空**；20 = 静默（无论 stderr）；其余非零 = 故障。
 */
export const GATE_SILENT_EXIT = 20;

/** gate stderr 末行（截 400 字符）——故障归因用；空串 = 无输出（导出供单测） */
export function gateStderrTail(stderr: unknown): string {
  if (typeof stderr !== 'string') return '';
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  const last = lines[lines.length - 1];
  return last.length > 400 ? last.slice(0, 400) + '…' : last;
}

/** storedSnapshot 里代表「磁盘上还没有这个文件」的哨兵值 */
const ABSENT = '__ABSENT__';

/**
 * 稳定序列化（键排序）——用于比较「两份条目内容是否相同」。
 * 不能直接用 JSON.stringify：外部写入（人或另一个进程）会改变键序，
 * 那样「内容没变」也会被判成冲突（ISSUE-24）。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  );
}

const isDeferred = (mode: TimerEntry['mode']) => mode === 'delay' || mode === 'random';
const isCalendar = (mode: TimerEntry['mode']) => mode === 'time' || mode === 'workday' || mode === 'holiday';
const repeatOf = (entry: TimerEntry) =>
  entry.repeatCount !== undefined && entry.repeatCount > 0
    ? entry.repeatCount
    : -1;

/** 日历重排地板（主线 2026-09-17 双投递修复语义——最短合法周期是下一目标时刻） */
const CALENDAR_RESCHEDULE_FLOOR_MS = 60_000;
const GATE_TIMEOUT_MS = 30_000;

/**
 * 宿主 timers 服务：排程状态机 + 数据根直读 + 邮局信封投递。
 *
 */
export class HostTimersService extends Service {
  /** 服务级依赖：timer = 官方 cordis-timer（ctx.timeout/interval——排程+心跳）；
   * config = 全局条目层（timer.tasks / agents.settings）。 */
  static inject = ['timer', 'config'];

  private readonly dataRoot: string;
  private readonly po: PostOffice;
  /** entries 写口（agents 编辑面注入——单写者；缺省自带直读写） */
  private readonly agentsEdit: EntriesEditFace | undefined;
  private readonly baseTz: string;
  private readonly heartbeatMs: number;
  private readonly gateTimeoutMs: number;
  private stateFile: string;
  /** owner → 条目清单（entries 物化 + 全局配置合成） */
  private entriesByAgent = new Map<string, TimerEntry[]>();
  /** key（owner/entryId）→ 排程句柄 */
  private schedules = new Map<string, () => void>();
  private heartbeatDispose?: () => void;
  private persisted = new Map<string, TimerPersistedState>();
  /** key → 已排定的下次触发时刻（ms）——诊断面（timer list 的 nextAt） */
  private nextAtMs = new Map<string, number>();
  /** key → 最近一次触发的迟到量（ms）——诊断面（静默空窗可观测） */
  private lastLagMs = new Map<string, number>();
  /** key → 最近一次「按策略跳过」（门控/静默窗口）——与 lastAt 分格：跳过不写 lastAt */
  private lastSkip = new Map<string, { at: string; reason: string; streak: number }>();
  /** key → 最近一次 gate 自身故障时刻（fail-open 时也记——否则「崩了但照跑」无痕） */
  private lastGateErrorAt = new Map<string, string>();
  /** key → 最近一次 gate 退出码（非 0 才记；让「静默」能区分 20/旧码 1） */
  private lastGateCode = new Map<string, number>();
  /** key → 上面那次退出码的时刻（**必须有**：否则「昨夜 20」会被读成「此刻静默」） */
  private lastGateCodeAt = new Map<string, string>();
  /**
   * owner → 我上一次读到/写出的条目内容指纹（ISSUE-24 乐观并发基准）。
   * save 前拿它与磁盘现值比：不一致 = 期间有别人改过（人或另一进程），
   * 此时整表覆盖会静默抹掉那笔改动（2026-11-17 给 news 补 gate 就是这样差点丢掉）。
   */
  private storedSnapshot = new Map<string, string>();
  /** 已提示过「旧静默码 1」的 key（每进程每 key 只提示一次，避免 30m 档刷屏） */
  private legacyGateNotice = new Set<string>();

  constructor(ctx: Context, options: TimersHostRowOptions) {
    super(ctx, 'timers');
    this.dataRoot = path.resolve(options.dataRoot);
    this.po = options.postOffice;
    this.baseTz = options.timezone ?? DEFAULT_TZ;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.gateTimeoutMs = options.gateTimeoutMs ?? GATE_TIMEOUT_MS;
    this.agentsEdit = options.agentsEdit;
    // 数据分层第二层：排程状态文件迁 meta/timer/（读侧兼容窗回落旧位置）
    this.stateFile = path.join(this.dataRoot, 'meta', 'timer', 'state.json');
    // 卸载收尾（fiber effect——随行卸载自动回收）
    ctx.fiber.effect(() => () => this.stopAll(), 'host-timers.stop');
    this.reload();
  }

  // ============================================================
  // 数据面（agents 树直读 / config 服务 / entries 目录——主线四服务换轨）
  // ============================================================

  /** 宿主 config 服务（同树 config 行；缺席 = 空 config——测试形态） */
  private configService(): { get<T>(key: string, fallback?: T): T | undefined; set(key: string, value: unknown): void } | null {
    const cfg = this.ctx.get('config', false) as
      | { get<T>(key: string, fallback?: T): T | undefined; set(key: string, value: unknown): void }
      | undefined;
    return cfg ?? null;
  }

  /**
   * entries/<owner>/timer.json 直读（agentStore 换轨——缺席 = null）。
   * remember=true（缺省）时把读到的内容指纹记进 storedSnapshot——save 的
   * 冲突检测以它为「我的基准」（ISSUE-24）。
   */
  private readStored(owner: string, opts?: { remember?: boolean }): TimerStoreEntry | null {
    if (owner === GLOBAL_TIMER_OWNER) return null;
    const remember = opts?.remember !== false;
    const finish = (v: TimerStoreEntry | null): TimerStoreEntry | null => {
      if (remember) this.storedSnapshot.set(owner, v === null ? ABSENT : stableStringify(v));
      return v;
    };
    const via = this.agentsEdit?.readEntry<TimerStoreEntry>(owner, 'timer');
    if (via !== undefined) return finish(Array.isArray(via.entries) ? via : null);
    try {
      const file = path.join(this.dataRoot, 'agents', owner, 'entries', 'timer.json');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as TimerStoreEntry;
      return finish(Array.isArray(parsed.entries) ? parsed : null);
    } catch {
      return finish(null);
    }
  }

  /** entries/<owner>/timer.json 原子写（cr-551 单写者：编辑面在场走 saveEntry） */
  private writeStored(owner: string, stored: TimerStoreEntry): void {
    if (owner === GLOBAL_TIMER_OWNER) return;
    // 写完即更新基准：否则下一次 save 会把自己刚写的当成「外部改动」
    this.storedSnapshot.set(owner, stableStringify(stored));
    if (this.agentsEdit !== undefined) {
      this.agentsEdit.saveEntry(owner, 'timer', stored);
      return;
    }
    const file = path.join(this.dataRoot, 'agents', owner, 'entries', 'timer.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  }

  private readArchive(owner: string): TimerArchiveRecord[] {
    if (owner !== GLOBAL_TIMER_OWNER && this.agentsEdit !== undefined) {
      const via = this.agentsEdit.readEntry<TimerArchiveRecord[]>(owner, 'timer-archive');
      if (via !== undefined) return Array.isArray(via) ? via : [];
      return [];
    }
    try {
      const file = path.join(this.dataRoot, 'agents', owner, 'entries', 'timer-archive.json');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as TimerArchiveRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return []; }
  }

  private writeArchive(owner: string, records: TimerArchiveRecord[]): void {
    if (owner !== GLOBAL_TIMER_OWNER && this.agentsEdit !== undefined) {
      this.agentsEdit.saveEntry(owner, 'timer-archive', records);
      return;
    }
    const file = path.join(this.dataRoot, 'agents', owner, 'entries', 'timer-archive.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  }

  /** per-owner 生效层（settingsOf 纯函数：全局默认层 = config[agents.settings]） */
  private layerOf(owner: string): TimerLayerSettings {
    const agent = owner === GLOBAL_TIMER_OWNER ? null : readAgentConfig(this.dataRoot, owner);
    const globalSettings = this.configService()?.get<Record<string, unknown>>('agents.settings') ?? {};
    const s = settingsOf(globalSettings, agent?.settings, 'timers') as TimerLayerSettings | undefined;
    if (s && typeof s === 'object' && !Array.isArray(s)) return s;
    return {};
  }

  /** owner 生效时区 */
  private tzOf(owner: string): string {
    const t = this.layerOf(owner).timezone;
    return typeof t === 'string' && t.trim() ? t.trim() : this.baseTz;
  }

  /** owner 生效节假日判定器（数组整体替换语义） */
  private holidaysOf(owner: string): ReturnType<typeof createHolidayResolver> {
    const s = this.layerOf(owner);
    return createHolidayResolver(
      {
        holidays: Array.isArray(s.holidays) ? s.holidays : [],
        makeupWorkdays: Array.isArray(s.makeupWorkdays) ? s.makeupWorkdays : [],
      },
      this.tzOf(owner),
    );
  }

  /**
   * 重新加载全部条目 + 补偿 + 排程（启动/热重载共用）。主线语义照搬：
   * entries 物化 → 全局 config 合成 → 无主持久化清理 → 停机补偿 → 排程 → 心跳。
   */
  reload(): void {
    this.stopAll();
    this.loadState();
    this.entriesByAgent.clear();

    // 1) per-agent entries（agents/<id>/entries/timer.json 直读）
    for (const agentId of listAgentIds(this.dataRoot)) {
      const stored = this.readStored(agentId);
      const enabled = stored?.entries.filter((e) => e.enabled !== false) ?? [];
      if (enabled.length > 0) this.entriesByAgent.set(agentId, enabled);
    }

    // 2) 全局条目（config timer.tasks——save GLOBAL_TIMER_OWNER 写口）
    const globalEntries = this.configEntries();
    if (globalEntries.length > 0) this.entriesByAgent.set(GLOBAL_TIMER_OWNER, globalEntries);

    // 3) 清理无主持久化状态
    const valid = new Set<string>();
    for (const [owner, entries] of this.entriesByAgent) {
      for (const e of entries) valid.add(`${owner}/${e.id}`);
    }
    for (const key of this.persisted.keys()) {
      if (!key.startsWith('_') && !valid.has(key)) {
        this.persisted.delete(key);
        this.nextAtMs.delete(key);
        this.lastLagMs.delete(key);
        this.lastSkip.delete(key);
        this.lastGateErrorAt.delete(key);
        this.lastGateCode.delete(key);
        this.lastGateCodeAt.delete(key);
      }
    }
    this.saveState();

    // 4) 停机补偿 → 排程 → 心跳
    this.compensateMissedTriggers();
    for (const [owner, entries] of this.entriesByAgent) {
      for (const entry of entries) this.arm(owner, entry);
    }
    this.syncHeartbeat();
  }

  /** 运行时全局条目（config timer.tasks；简化形状归一化主线同款） */
  private configEntries(): TimerEntry[] {
    const raw = this.configService()?.get<unknown>('timer.tasks');
    if (!Array.isArray(raw)) return [];
    const valid: TimerEntry[] = [];
    const MECH_HINTS: Record<string, 'archive-all' | 'backup-all'> = {
      __archive_all__: 'archive-all',
      __backup_all__: 'backup-all',
    };
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue;
      const e = item as Record<string, unknown>;
      // 简化形状 {time, hint, targets?} → TimerEntry（mode 恒 time；同刻同词稳定 id）
      if (e.mode === undefined && typeof e.time === 'string') {
        const simpleHint = typeof e.hint === 'string' ? e.hint.trim() : '';
        e.id = `g-${e.time}-${simpleHint}`;
        e.mode = 'time';
        e.hint = simpleHint;
        if (Array.isArray(e.targets)) {
          const joined = e.targets.filter((t): t is string => typeof t === 'string' && t !== '').join(',');
          e.target = joined !== '' ? joined : undefined;
        }
        delete e.targets;
      }
      const hint = typeof e.hint === 'string' ? e.hint.trim() : '';
      if (hint in MECH_HINTS) {
        e.task = MECH_HINTS[hint];
        e.hint = hint;
      }
      if (
        typeof e.id === 'string' &&
        e.id !== '' &&
        (e.mode === 'time' || e.mode === 'delay' || e.mode === 'random' || e.mode === 'workday' || e.mode === 'holiday') &&
        typeof e.hint === 'string'
      ) {
        valid.push(e as unknown as TimerEntry);
      }
    }
    return valid;
  }

  /** 某 owner 条目（诊断） */
  entries(owner: string): TimerEntry[] {
    return [...(this.entriesByAgent.get(owner) ?? [])];
  }

  /** 全部 owner 视图（诊断） */
  list(): Array<{ owner: string; entries: TimerEntry[] }> {
    return [...this.entriesByAgent].map(([owner, entries]) => ({ owner, entries }));
  }

  /**
   * 排程态快照（诊断面——timer list 暴露 lastAt/nextAt/lagMs）。
   * 排定时刻 = startedAt + totalDelayMs（arm 幂等后该等式恒成立）；nextAt 取
   * 实际已挂的 timeout 时刻，故能反映「下一档真实何时来」。
   *
   * 语义边界（勿混用）：lastAt = 本条目**到点并已投递唤醒信**（fireEntry 走完；
   * 门控跳过、策略静默都不更新）。它**不证明**目标脚本执行成功、更不证明产物
   * 落盘——「本档是否产出」仍以消费方自己的落盘证据（如文件 mtime）为准，
   * 本组字段只回答「为什么没产出 / 为什么迟到 / 下一档何时来」（ISSUE-22）。
   *
   * lastSkipAt / lastSkipReason / skipStreak = 最近一次按策略跳过（门控、静默窗口）：
   * 「lastAt 未前进」由此可细分（未到点 / 按策略跳过 / 系统停摆 / gate 故障）。
   * skipStreak 的判据要带窗口语义——夜间静默窗内的单调增长是正常态（每夜涨到
   * 窗口档数上限），故障判据是「超出该上限」或「窗外仍只记 gate 且不归零」。
   *
   * lastGateCode = 最近一次 gate 非 0 退出码（静默与故障都记）：区分「20 = 脚本声明的
   * 预期静默」与「1 = 旧契约静默（平台靠 stderr 为空推断）」——后者每 key 只提示一次迁移。
   * **必须与 lastGateCodeAt 成对读**：该字段是「最近一次」的历史值，gate 退回 0 时
   * 不清空（清零会让「20 声明静默」和「正常放行」无法区分谁先谁后）。故
   * `lastGateCode=20` + 时间戳是昨夜 → 那是旧值，不是「此刻静默」。
   * 判当前态请看 lastSkip / lastAt 的**时刻**，不要看 code。
   *
   * lastGateErrorAt = gate 自身异常退出（既非 0 也非 1）的最近一次时刻：
   * gateOnError='run'（fail-open）时条目照常投递、lastSkip 不更新，此时只有这个
   * 字段能证明「gate 坏了但我们在放行」——否则崩了以后完全无痕。
   */
  scheduleState(owner: string, entryId: string): {
    lastAt?: string;
    nextAt?: string;
    lagMs?: number;
    lastSkipAt?: string;
    lastSkipReason?: string;
    skipStreak?: number;
    lastGateErrorAt?: string;
    lastGateCode?: number;
    lastGateCodeAt?: string;
  } {
    const key = `${owner}/${entryId}`;
    const ps = this.persisted.get(key);
    const next = this.nextAtMs.get(key);
    const lag = this.lastLagMs.get(key);
    const skip = this.lastSkip.get(key);
    const gateErr = this.lastGateErrorAt.get(key);
    const gateCode = this.lastGateCode.get(key);
    const gateCodeAt = this.lastGateCodeAt.get(key);
    return {
      ...(ps?.lastTriggeredAt ? { lastAt: ps.lastTriggeredAt } : {}),
      ...(next !== undefined ? { nextAt: new Date(next).toISOString() } : {}),
      ...(lag !== undefined ? { lagMs: lag } : {}),
      ...(skip ? { lastSkipAt: skip.at, lastSkipReason: skip.reason, skipStreak: skip.streak } : {}),
      ...(gateErr ? { lastGateErrorAt: gateErr } : {}),
      ...(gateCode !== undefined ? { lastGateCode: gateCode } : {}),
      ...(gateCodeAt ? { lastGateCodeAt: gateCodeAt } : {}),
    };
  }

  /**
   * 保存某 owner 条目（全量覆盖）+ 重排；全局条目落 config。
   *
   * 冲突检测（ISSUE-24）：本方法收到的 `entries` 恒来自调用方的内存副本
   * （timer 工具的 set/cancel 都基于 entries(owner)），而内存副本是 boot 时
   * 装载的。宿主运行期间若有人直接改了 entries/timer.json（例如给条目补
   * gate 字段），再走一次 save 就会用 stale 副本整表覆盖，把外部改动**静默
   * 抹掉**——2026-11-17 给 news 补 gate/gateOnError 时正是这个窗口。
   *
   * 处置：写前比对磁盘现值与「上次读到/写出的指纹」，不一致则**拒写**、
   * 以磁盘为准重载内存、打 warn 并把冲突回给调用方（乐观并发：后写者必须
   * 看见冲突，而不是赢者通吃）。调用方重试即基于新基准成功。
   */
  save(owner: string, entries: TimerEntry[]): { ok: boolean; error?: string } {
    const stored: TimerStoreEntry = { entries };
    if (owner === GLOBAL_TIMER_OWNER) {
      // 全局条目住 config（config 行自管写面与冲突），不走本处快照检测
      this.configService()?.set('timer.tasks', entries);
    } else {
      const disk = this.readStored(owner, { remember: false });
      const diskSig = disk === null ? ABSENT : stableStringify(disk);
      const base = this.storedSnapshot.get(owner);
      if (base !== undefined && base !== diskSig) {
        const msg =
          `条目存储已被外部修改（${owner}）——本次写入已拒绝，请重取条目后重试。` +
          `磁盘现值与宿主内存基准不一致：外部改动会被整表覆盖，故不写入`;
        this.ctx.logger.warn(`[timers] ${msg}`);
        // 以磁盘为准重载内存，让下一次 list/set 基于新基准
        this.adoptStored(owner, disk);
        return { ok: false, error: msg };
      }
      this.writeStored(owner, stored);
    }
    this.stopAgent(owner);
    const enabled = entries.filter((e) => e.enabled !== false);
    if (enabled.length > 0) this.entriesByAgent.set(owner, enabled);
    else this.entriesByAgent.delete(owner);
    const valid = new Set(enabled.map((e) => `${owner}/${e.id}`));
    for (const key of this.persisted.keys()) {
      if (key.startsWith(`${owner}/`) && !valid.has(key)) {
        this.persisted.delete(key);
        this.nextAtMs.delete(key);
        this.lastLagMs.delete(key);
        this.lastSkip.delete(key);
        this.lastGateErrorAt.delete(key);
        this.lastGateCode.delete(key);
        this.lastGateCodeAt.delete(key);
      }
    }
    this.saveState();
    for (const entry of enabled) this.arm(owner, entry);
    // cr-886：条目变更 → 宿主能力面失效通知（在连壳重拉契约——timer 代理面刷新）
    // cr-1121：invalidate 入口退役——注册面契约恒基线（timer 工具 schema 不随
    // 条目变更），壳侧 list 读恒现值，无需失效广播（currentHostFace 移交
    // hostFaceRegistry.sync 承载——贡献登记时才广播）。
    return { ok: true };
  }

  /**
   * 存储一致性快照（诊断面）：entries()/list() 返回的是**内存副本**，宿主
   * boot 后不再自动重读磁盘——所以「改了 entries/timer.json 但 timer list
   * 没变」是正常现象（2026-11-17 news 据此怀疑改动未生效）。本方法让这个
   * 隐式状态显式化：configStale=true 表示磁盘已变而内存仍旧，重启/重载后生效。
   *
   * 注意只读不写快照（remember:false）——诊断动作不能改变冲突检测的基准。
   *
   * **恒返回布尔**（不为 undefined）：字段缺失本身有歧义（「一致」还是「跑的是
   * 没有这个字段的旧代码」），故新代码一律显式给出 true/false；消费方判定顺序
   * 应是「先看有无该字段 ⇒ 再读它的值」（2026-11-17 news 指出，同族第五例）。
   */
  storeState(owner: string): { configStale: boolean } {
    // 全局条目住 config（无内存/磁盘分叉）——恒一致
    if (owner === GLOBAL_TIMER_OWNER) return { configStale: false };
    const base = this.storedSnapshot.get(owner);
    // 基准缺席（该 owner 从未被读过）→ 无从判断，按「可能不一致」保守返回。
    // 正常路径不会走到（reload 对每个 agent 都 readStored 一次）。
    if (base === undefined) return { configStale: true };
    const disk = this.readStored(owner, { remember: false });
    const diskSig = disk === null ? ABSENT : stableStringify(disk);
    return { configStale: base !== diskSig };
  }

  /**
   * 以磁盘内容为准重载某个 owner（冲突后的恢复路径，ISSUE-24）。
   * 只动该 owner 的条目与排程；不动 persisted 里其它 owner 的状态。
   */
  private adoptStored(owner: string, disk: TimerStoreEntry | null): void {
    this.stopAgent(owner);
    const enabled = disk?.entries.filter((e) => e.enabled !== false) ?? [];
    this.storedSnapshot.set(owner, disk === null ? ABSENT : stableStringify(disk));
    if (enabled.length > 0) this.entriesByAgent.set(owner, enabled);
    else this.entriesByAgent.delete(owner);
    const valid = new Set(enabled.map((e) => `${owner}/${e.id}`));
    for (const key of this.persisted.keys()) {
      if (key.startsWith(`${owner}/`) && !valid.has(key)) {
        this.persisted.delete(key);
        this.nextAtMs.delete(key);
        this.lastLagMs.delete(key);
        this.lastSkip.delete(key);
        this.lastGateErrorAt.delete(key);
        this.lastGateCode.delete(key);
        this.lastGateCodeAt.delete(key);
      }
    }
    this.saveState();
    for (const entry of enabled) this.arm(owner, entry);
  }

  /** 手动触发（测试/诊断；不记账） */
  triggerNow(owner: string, entryId: string): boolean {
    const entry = this.entries(owner).find((e) => e.id === entryId);
    if (!entry) return false;
    void this.fireEntry(owner, entry);
    return true;
  }

  // ============================================================
  // 排程状态机（主线 arm/fire 语义照搬：重启防重 / 在途守卫 / 地板重排）
  // ============================================================

  private cancel(key: string): void {
    const dispose = this.schedules.get(key);
    if (dispose) {
      dispose();
      this.schedules.delete(key);
    }
    this.nextAtMs.delete(key);
    this.syncHeartbeat();
  }

  private stopAgent(owner: string): void {
    for (const key of [...this.schedules.keys()]) {
      if (key.startsWith(`${owner}/`)) this.cancel(key);
    }
  }

  private stopAll(): void {
    for (const key of [...this.schedules.keys()]) this.cancel(key);
  }

  /** 懒心跳（有排程才有——空闲零定时器；心跳是停机补偿依据） */
  private syncHeartbeat(): void {
    const ctx = this.ctx;
    const need = this.schedules.size > 0;
    if (need && this.heartbeatDispose === undefined) {
      this.heartbeatDispose = ctx.interval(() => {
        try {
          this.persisted.set('_heartbeat', { lastTriggeredAt: localISO(undefined, this.baseTz) });
          this.saveState();
        } catch {
          /* 心跳写失败不影响运行 */
        }
      }, this.heartbeatMs);
    } else if (!need && this.heartbeatDispose !== undefined) {
      this.heartbeatDispose();
      this.heartbeatDispose = undefined;
    }
  }

  /** 排程一条条目（限定次/永久统一状态机——主线 arm 全语义） */
  private arm(owner: string, entry: TimerEntry): void {
    const key = `${owner}/${entry.id}`;
    this.cancel(key);
    if (entry.enabled === false) return;

    const ctx = this.ctx; // cordis timer 基座（static inject）

    const ps = this.persisted.get(key);
    const tz = this.tzOf(owner);
    let remaining = repeatOf(entry);
    if (remaining > 0 && ps?.executedCount) {
      remaining = Math.max(0, remaining - ps.executedCount);
      if (remaining <= 0) return;
    }

    let delayMs = nextDelayOf(entry, ps, Date.now(), tz);
    if (delayMs === null || (delayMs <= 0 && !isDeferred(entry.mode))) {
      if (remaining > 0 && isCalendar(entry.mode)) {
        this.completeEntry(owner, entry, 0);
        return;
      }
      return;
    }

    // 重启防重（主线 2026-09-17 语义：日历条目 + 有触发史 + 距目标 <10s
    // = 判前进程刚投递过本周期，跳到下一周期——方向保守）
    if (
      isCalendar(entry.mode) &&
      ps?.lastTriggeredAt &&
      delayMs > 0 &&
      delayMs <= 10_000
    ) {
      const shifted = msUntilTime(entry.time!, new Date(Date.now() + delayMs + 1), tz);
      delayMs = shifted;
      if (delayMs === null) return;
    }

    // 排程态持久化（delay/random 恢复依据；random 首抽固化）
    if (isDeferred(entry.mode)) {
      const totalDelayMs =
        entry.mode === 'delay'
          ? (parseInterval(entry.delay ?? '') ?? delayMs)
        : delayMs;
      // 锚点必须与「已排定的下次触发时刻」一致：startedAt + totalDelayMs = nextFire。
      // 旧写法恒写 now：delayMs 却是按旧 startedAt 扣减出来的剩余量 → 每次 arm
      // （含每次宿主 boot 的 reload）都让下一次触发被推到「本次 arm + 整周期」。
      // 实证（ISSUE-20，2026-11-17）：20:12/20:21/20:23 三连重启把 20:15 档推到 20:51；
      // 05:41/05:44 两连重启把 05:46 档推到 06:11。改为按排定时刻倒推锚点，arm 幂等。
      // 同一周期内（ps 在且周期未变）按排定时刻倒推锚点；首次 arm 或周期被改
      // （entry.delay 变更）则从 now 起算一整周期，避免拿旧剩余量套新周期。
      const sameCycle = ps !== undefined && ps.totalDelayMs === totalDelayMs;
      const anchorMs = sameCycle ? Date.now() + delayMs - totalDelayMs : Date.now();
      this.persisted.set(key, {
        executedCount: ps?.executedCount ?? 0,
        ...(ps?.lastTriggeredAt ? { lastTriggeredAt: ps.lastTriggeredAt } : {}),
        startedAt: localISO(new Date(anchorMs), tz),
        totalDelayMs,
      });
      this.saveState();
    }

    let budget = remaining;
    const scheduleNext = (ms: number | null): void => {
      if (ms === null || !Number.isFinite(ms)) return;
      // 负值/NaN 兜底（0 合法：arm 恢复态抵扣完 = 立即补偿触发一次）
      const wait = ms > 0 ? ms : 0;
      const dispose = ctx.timeout(() => void fire(), wait);
      this.schedules.set(key, dispose);
      this.nextAtMs.set(key, Date.now() + wait);
      this.syncHeartbeat();
    };
    const fire = async () => {
      this.schedules.delete(key);
      this.syncHeartbeat();
      const stillArmed = () => {
        const list = this.entriesByAgent.get(owner);
        return list !== undefined && list.some((e) => e.id === entry.id && e.enabled !== false);
      };
      // 跳过记账（ISSUE-22）：门控/静默窗口的「按策略跳过」不写 lastAt（那是真投递），
      // 但必须留痕——否则消费方看「lastAt 未前进」分不清「没到点」「按策略跳过」
      // 「系统停摆」三种。连续跳过次数持续增长 = gate 恒假/静默窗口配错（同样静默）。
      const skip = (reason: string): void => {
        const prev = this.lastSkip.get(key);
        this.lastSkip.set(key, {
          at: localISO(undefined, this.tzOf(owner)),
          reason,
          streak: (prev?.reason === reason ? prev.streak : 0) + 1,
        });
      };
      const tz = this.tzOf(owner);
      const holidays = this.holidaysOf(owner);
      const nextMs = () => (entry.time ? msUntilTime(entry.time, new Date(), tz) : null);
      // 周期解析失败必须 fail-loud 且停排（ISSUE-23）：旧写法 `?? 0` 会让
      // scheduleNext(0) 立即再 fire —— 非法 delay 串（如 "30min" 拼错成 "30 mi"）
      // 会变成忙循环 + 每轮投递唤醒信。现在返回 null，scheduleNext 直接不排。
      const nextCycleDelay = (): number | null => {
        if (isCalendar(entry.mode)) return nextMs();
        if (entry.mode === 'delay') {
          const ms = entry.delay ? parseInterval(entry.delay) : null;
          if (ms === null) {
            this.ctx.logger.warn(
              `[timers] ${key} 周期串无法解析（delay=${String(entry.delay)}）——停止排程，请修正条目`,
            );
          }
          return ms;
        }
        return randomDelay(entry.delayMin, entry.delayMax);
      };
      // 目标会话消亡门控：preview 形态无 singles/group 注册表——键形判据
      //（对桶含 ~ 恒存活）+ 端点在册判定（agent 在场 = 会话可投）
      if (!this.conversationAlive(entry)) {
        skip('conversation');
        if (stillArmed()) scheduleNext(nextCycleDelay());
        return;
      }
      if (entry.mode === 'workday' && !holidays.isWorkday()) {
        skip('workday');
        if (stillArmed()) scheduleNext(nextMs());
        return;
      }
      if (entry.mode === 'holiday' && !holidays.isHoliday()) {
        skip('holiday');
        if (stillArmed()) scheduleNext(nextMs());
        return;
      }
      if (entry.activeHours && !withinActiveHours(entry.activeHours, new Date(), tz)) {
        skip('activeHours');
        if (stillArmed()) scheduleNext(nextCycleDelay());
        return;
      }
      if (entry.gate) {
        const verdict = await this.runGate(key, owner, entry.gate);
        if (verdict !== 'run') {
          // 故障码与「预期静默」分格：都跳过本轮，但 gate-error 要能被消费方识别出来
          const failOpen = verdict === 'error' && entry.gateOnError === 'run';
          if (verdict === 'error') this.lastGateErrorAt.set(key, localISO(undefined, this.tzOf(owner)));
          if (!failOpen) {
            skip(verdict === 'error' ? 'gate-error' : 'gate');
            if (stillArmed()) scheduleNext(nextCycleDelay());
            return;
          }
          // fail-open：优化型 gate（只为省 token，正确性由脚本自身兜住）崩了照跑，
          // 否则条目会永久静默——静默的代价大于跑一次（ISSUE-22）
        }
      }

      // 迟到可见性（ISSUE-22）：delay 条目的排定档位 = startedAt + totalDelayMs。
      // 系统休眠 / 宿主停摆 / 事件循环被长任务占住时，定时器只能在恢复后补触发一次，
      // 不补历史档；旧行为完全静默（news 的 30m 轮巡空窗 51~91 分钟无任何日志）→ fail-loud。
      // 位置必须在门控之后：activeHours / gate / workday 的「按策略跳过」是正常行为，
      // 不算迟到（否则每个夜间条目都会打一条假迟到）。
      if (entry.mode === 'delay' && ps?.startedAt && ps.totalDelayMs != null) {
        const lagMs = Date.now() - (new Date(ps.startedAt).getTime() + ps.totalDelayMs);
        this.lastLagMs.set(key, Math.max(0, lagMs));
        if (lagMs >= 60_000) {
          this.ctx.logger.warn(
            `[timers] ${key} 触发迟到 ${Math.round(lagMs / 60_000)} 分钟（排定档位 ${ps.startedAt} + ${Math.round(ps.totalDelayMs / 60_000)}m）——疑似系统休眠或宿主停摆；本档只补触发一次，不补历史档`,
          );
        }
      }

      await this.fireEntry(owner, entry, key);
      this.lastSkip.delete(key); // 真投递 → 跳过链清零

      // 触发后记账（delay/random 重置 startedAt；random 抽取下一次延迟固化）
      const cur = this.persisted.get(key);
      const executed = (cur?.executedCount ?? 0) + 1;
      let nextDelay: number | null = null;
      if (entry.mode === 'delay') {
        nextDelay = entry.delay ? parseInterval(entry.delay) : null;
      } else if (entry.mode === 'random') {
        nextDelay = randomDelay(entry.delayMin, entry.delayMax);
      }
      this.persisted.set(key, {
        executedCount: executed,
        lastTriggeredAt: localISO(undefined, tz),
        ...(isDeferred(entry.mode)
          ? { startedAt: localISO(undefined, tz), ...(nextDelay != null ? { totalDelayMs: nextDelay } : {}) }
          : {}),
      });
      this.saveState();

      if (budget > 0) {
        budget -= 1;
        if (budget === 0) {
          this.completeEntry(owner, entry, entry.repeatCount ?? executed);
          return;
        }
      }
      if (!stillArmed()) return;
      if (isCalendar(entry.mode)) {
        const ms = nextMs();
        if (ms !== null && ms > 0 && ms < CALENDAR_RESCHEDULE_FLOOR_MS) {
          scheduleNext(msUntilTime(entry.time!, new Date(Date.now() + ms + 1), tz));
        } else {
          scheduleNext(ms);
        }
      } else {
        // delay 模式周期串解析失败 → 停排并 warn（旧写法 `?? 0` = 立即再 fire = 忙循环）
        if (nextDelay === null && entry.mode === 'delay') {
          this.ctx.logger.warn(
            `[timers] ${key} 周期串无法解析（delay=${String(entry.delay)}）——停止排程，请修正条目`,
          );
          return;
        }
        scheduleNext(nextDelay);
      }
    };

    scheduleNext(delayMs);
  }

  /** 目标会话存活判定（preview 形态：对桶键恒存活；agent 在册 = 可投） */
  private conversationAlive(entry: TimerEntry): boolean {
    const cid = entry.conversationId;
    if (!cid || cid.includes('~') || entry.task !== undefined) return true;
    // 独立会话 sid（uuid）或群地址：preview 数据根无 singles 注册表——
    // 以「sid 是否有任何 agent 域账本目录」近似（会话在 = 有落账域）。
    for (const agentId of listAgentIds(this.dataRoot)) {
      if (fs.existsSync(path.join(this.dataRoot, 'agents', agentId, 'sessions', cid))) return true;
    }
    return false;
  }

  /** gate 预检（主线语义：退出码非 0 跳过；启动层失败/超时 fail-open）。
   * cwd = 数据根（preview 形态：无 workspace 行，gate 命令锚定数据根）。
   *
   * 退出码细分（ISSUE-22 补丁三 / 补丁四）：
   *   · 0                  = 放行；
   *   · 20                 = **约定「预期静默」**（无歧义，推荐）；
   *   · 1 + stderr 空      = 约定「预期静默」（旧契约，兼容）；
   *   · 1 + stderr 非空    = **崩溃**（python/node 未捕获异常都退 1）→ 判故障；
   *   · 其它非零           = gate 自身故障 → 打 warn（带 stderr 末行）+ 记
   *                          lastSkipReason='gate-error'，再按 gateOnError 定方向。
   * 超时与启动层失败维持 fail-open(放行)。
   */
  private runGate(key: string, owner: string, command: string): Promise<GateVerdict> {
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      execFile(
isWin ? 'cmd.exe' : '/bin/sh',
isWin ? ['/d', '/s', '/c', command] : ['-c', command],
        {
          timeout: this.gateTimeoutMs,
          windowsHide: true,
          cwd: this.dataRoot,
          maxBuffer: 256 * 1024,
          // Windows 引号陷阱（ISSUE-22 补丁五）：不带 verbatim 时 Node 会把命令行里
          // 的引号转义成 \" 交给 cmd.exe，而 cmd 不认这种转义 → 参数带着引号进进程
          // （实测 `node "x.js"` 变成 MODULE_NOT_FOUND）。加引号本是为了支持含空格
          // 的路径，结果恰好把它弄坏。verbatim 让命令串原样交给 cmd /c。
          ...(process.platform === 'win32' ? { windowsVerbatimArguments: true } : {}),
        },
        (err, _stdout, stderr) => {
          if (err === null) {
            resolve('run');
            return;
          }
          if ((err as { killed?: boolean }).killed) {
            resolve('run');
            return;
          }
          if (typeof err.code !== 'number') {
            resolve('run');
            return;
          }
          const detail = gateStderrTail(stderr);
          this.lastGateCode.set(key, err.code);
          this.lastGateCodeAt.set(key, localISO(undefined, this.tzOf(owner)));
          if (err.code === GATE_SILENT_EXIT) {
            resolve('silent');
            return;
          }
          if (err.code === 1) {
            // 1 + stderr 非空 = 崩溃（python/node 未捕获异常都退 1，traceback 走
            // stderr）；1 + stderr 空 = 旧契约静默。方向保守：含糊时判故障。
            if (detail === '') {
              // 旧码兼容不等于可以沉默：静默码 20 才是「由脚本自己声明」的形态，
              // 1 是平台靠「stderr 恰好为空」推断出来的——每 key 提示一次促迁移。
              if (!this.legacyGateNotice.has(key)) {
                this.legacyGateNotice.add(key);
                this.ctx.logger.info(
                  `[timers] ${key} gate 用旧静默码 1（stderr 为空）——按预期静默处理；` +
                    `建议改用退出码 ${String(GATE_SILENT_EXIT)}：那样声明是明确的，不依赖平台推断`,
                );
              }
              resolve('silent');
              return;
            }
            this.ctx.logger.warn(
              `[timers] ${key} gate 退出码 1 但 stderr 非空（按崩溃处理，不当作「预期静默」）；stderr: ${detail}` +
                '——若这是刻意的静默，请改用退出码 ' + String(GATE_SILENT_EXIT) + ' 或保持 stderr 干净',
            );
            resolve('error');
            return;
          }
          void owner;
          // gate 的 stderr 是唯一可归因线索：脚本自己会打 '[gate-error] …'，
          // 旧实现整段丢弃 → 宿主日志只剩「退出码 N」，排查还得去翻脚本私有日志。
          this.ctx.logger.warn(
            `[timers] ${key} gate 异常退出（code=${String(err.code)}；仅 0/1 有约定语义）` +
              (detail ? `；stderr: ${detail}` : '') +
              '——按条目 gateOnError 处置（缺省跳过；\'run\' = 放行）',
          );
          resolve('error');
        },
      );
    });
  }

  // ============================================================
  // 触发（唤醒信投递 / 机制任务直调）
  // ============================================================

  /**
   * 条目触发（主线 fireEntry 换投递面）：
   *   · 机制任务（archive-all/backup-all）= 宿主自有服务直调（ctx.get 软取；
   *     未装跳过——主线同语义）。
   *   · Agent run = 唤醒信投递：
   *     - uuid = entry.conversationId（会话维度提醒回投既有会话；主线同款）
   *       缺省 = 对角线自会话 <target>~<target>（主线 M19/D2 语义）。
   *       uuid 需在投递前已存在（唤醒信不签发新会话——R-1 签发权归首条
   *       消息发送方；新对角线会话以确定性 pairKey 形态开档：邮局登记
   *       校验首次登记即建——对角线是 agent 自会话的确定性键，无需随机）。
   *     - sender = 有 conversationId 时 user（提醒落用户视线），否则 target 自身。
   *     - budget = DEFAULT（唤醒信满额起跳——user 直发语义面；自动唤醒
   *       消耗在接收方，防自激由接收方 budget 状态机承担）。
   */
  private async fireEntry(owner: string, entry: TimerEntry, key = `${owner}/${entry.id}`): Promise<void> {
    try {
      if (entry.task) {
        if (entry.task === 'archive-all') {
          // D11 裁决（cr-546）：归档全链在壳内——宿主零 archive 职责，机制
          // 任务改批量唤醒信（遍历 agent 域 → 对角线 uuid 投递 archive-all
          // 唤醒信，壳内 archiveAll 自行枚举本域会话判定执行）。
          const targets = listAgentIds(this.dataRoot)
            .map((id) => readAgentConfig(this.dataRoot, id))
            .filter((a): a is NonNullable<typeof a> => a !== null && !a.virtual && !isPresetId(a.id) && a.model !== undefined)
            .map((a) => a.id);
          for (const target of targets) {
            const env: Envelope = makeEnvelope({
              uuid: target + '~' + target, // 对角线自会话键（确定性键，邮局首次登记即建）
              requestId: 't-' + issueRequestId(),
              sender: target, // 机制触发 = 目标自身（自会话语义——与唤醒信同构）
              to: target,
              kind: 'message',
              budget: 1, // 唤醒一次；壳内 archiveAll 不再链跑（机制任务非对话）
              payload: { text: '[archive-all] 批量归档唤醒：请对本域会话执行归档阈值检测与整理（archiveAll）。', mechTask: 'archive-all' },
            });
            await this.po.dispatch(env);
          }
          return;
        }
        const backup = this.ctx.get('backup', false) as { run(opts?: { force?: boolean }): Promise<unknown> } | undefined;
        if (!backup) return;
        await backup.run();
        return;
      }

      const hint = renderHint(entry.hint, entry, new Date(), this.tzOf(owner));
      const targets =
        owner === GLOBAL_TIMER_OWNER
          ? (entry.target || '*') === '*'
            ? listAgentIds(this.dataRoot)
                .map((id) => readAgentConfig(this.dataRoot, id))
                .filter((a): a is NonNullable<typeof a> => a !== null && !a.virtual && !isPresetId(a.id) && a.model !== undefined)
                .map((a) => a.id)
            : entry.target!.split(',').map((t) => t.trim()).filter(Boolean)
          : [owner];
      for (const target of targets) {
        if (readAgentConfig(this.dataRoot, target) === null) continue;
        const convId = entry.conversationId ?? `${target}~${target}`;
        const sender = entry.conversationId ? 'user' : target;
        const env: Envelope = makeEnvelope({
          uuid: convId,
          requestId: 't-' + issueRequestId(),
          sender,
          to: target,
          kind: 'message',
          budget: 3,
          payload: { text: hint },
        });
        await this.po.dispatch(env);
      }
    } catch {
      // 投递失败不记账不重试（at-least-once 由邮局 outbox 承担）
    }
  }

  // ============================================================
  // 完成归档（entries/timer-archive.json）
  // ============================================================

  private completeEntry(owner: string, entry: TimerEntry, executedCount: number): void {
    const key = `${owner}/${entry.id}`;
    this.cancel(key);
    this.persisted.delete(key);
    this.saveState();
    const cached = this.entriesByAgent.get(owner);
    if (cached) {
      const idx = cached.findIndex((e) => e.id === entry.id);
      if (idx >= 0) cached.splice(idx, 1);
      if (cached.length === 0) this.entriesByAgent.delete(owner);
    }
    if (owner === GLOBAL_TIMER_OWNER) return; // 全局条目归配置所有：仅摘运行时

    const stored = this.readStored(owner) ?? { entries: [] };
    stored.entries = stored.entries.filter((e) => e.id !== entry.id);
    this.writeStored(owner, stored);
    const archive = this.readArchive(owner);
    archive.push({
      ...entry,
      enabled: entry.enabled,
      status: 'completed',
      completedAt: localISO(undefined, this.tzOf(owner)),
      executedCount,
    });
    this.writeArchive(owner, archive);
  }

  // ============================================================
  // 状态文件（原子写 + 停机补偿——主线语义照搬）
  // ============================================================

  private loadState(): void {
    try {
      // 新位置缺席 → 兼容窗回落旧位置 timer/state.json（读旧写新，不迁移）
      const file = fs.existsSync(this.stateFile)
        ? this.stateFile
        : path.join(this.dataRoot, 'timer', 'state.json');
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, TimerPersistedState>;
        this.persisted = new Map(Object.entries(raw));
      }
    } catch {
      /* 状态损坏从空开始 */
    }
  }

  private saveState(): void {
    try {
      const obj: Record<string, TimerPersistedState> = {};
      for (const [k, v] of this.persisted) obj[k] = v;
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
      fs.renameSync(tmp, this.stateFile);
    } catch {
      /* 状态写失败不致命（下一心跳重试） */
    }
  }

  /** 停机补偿（主线 compensateMissedTriggers 三 case 语义照搬） */
  private compensateMissedTriggers(): void {
    const heartbeat = this.persisted.get('_heartbeat');
    if (!heartbeat?.lastTriggeredAt) return;
    const lastHeartbeat = new Date(heartbeat.lastTriggeredAt).getTime();
    const now = Date.now();
    if (now - lastHeartbeat < 5 * 60_000) return;

    for (const [owner, entries] of this.entriesByAgent) {
      for (const entry of entries) {
        const key = `${owner}/${entry.id}`;
        const ps = this.persisted.get(key);
        if (!ps?.startedAt || ps.totalDelayMs == null) continue;
        const expected = new Date(ps.startedAt).getTime() + ps.totalDelayMs;
        if (!(expected <= now && expected > lastHeartbeat)) {
          // 周期补偿（已触发过的 delay/random 按周期数补，上限 3 或剩余次数）
          if (!(isDeferred(entry.mode) && ps.lastTriggeredAt)) continue;
          const lastTrigger = new Date(ps.lastTriggeredAt).getTime();
          let nextExpected = lastTrigger + ps.totalDelayMs;
          let compensated = 0;
          const repeat = repeatOf(entry);
          const maxCompensate = repeat > 0 ? Math.max(0, repeat - (ps.executedCount ?? 0)) : 3;
          while (nextExpected <= now && compensated < maxCompensate) {
            compensated++;
            nextExpected += ps.totalDelayMs!;
          }
          if (compensated <= 0) continue;
          const newCount = (ps.executedCount ?? 0) + compensated;
          this.persisted.set(key, {
            ...ps,
            lastTriggeredAt: localISO(undefined, this.tzOf(owner)),
            executedCount: newCount,
            startedAt: localISO(undefined, this.tzOf(owner)),
          });
          if (repeat > 0 && newCount >= repeat) {
            entry.enabled = false;
            this.disablePersist(owner, entry);
          }
          for (let i = 0; i < compensated; i++) void this.fireEntry(owner, entry, key);
          continue;
        }

        if (entry.repeatCount === 1 && !ps.lastTriggeredAt) {
          // 一次性任务：先完成记账再触发（防排程重复）
          entry.enabled = false;
          this.completeEntry(owner, entry, 1);
          void this.fireEntry(owner, entry, key);
          continue;
        }

        if (isDeferred(entry.mode) && !ps.lastTriggeredAt) {
          // 首次触发补偿：记账置为当前，排程按新 startedAt 走完整延迟
          const newCount = (ps.executedCount ?? 0) + 1;
          const repeat = repeatOf(entry);
          this.persisted.set(key, {
            lastTriggeredAt: localISO(undefined, this.tzOf(owner)),
            executedCount: newCount,
            startedAt: localISO(undefined, this.tzOf(owner)),
            totalDelayMs: ps.totalDelayMs,
          });
          if (repeat > 0 && newCount >= repeat) {
            entry.enabled = false;
            this.disablePersist(owner, entry);
          }
          void this.fireEntry(owner, entry, key);
        }
      }
    }
    this.saveState();
  }

  /** 仅写 store 禁用条目（补偿路径限定次完成；不清理状态） */
  private disablePersist(owner: string, entry: TimerEntry): void {
    if (owner === GLOBAL_TIMER_OWNER) return;
    const stored = this.readStored(owner);
    if (!stored?.entries) return;
    const target = stored.entries.find((e) => e.id === entry.id);
    if (target) {
      target.enabled = false;
      this.writeStored(owner, stored);
    }
  }
}

// 服务键 'timers' 不重复 declare——主线 ac-timer 已占用该键（declare module
// 全局合并同键须同类型，ac-shell-conversation 同款先例）；preview 运行时
// 注册 HostTimersService（方法面子集兼容主线消费方言），cutover 后主线行
// 退役本行成为唯一提供者。

/** 宿主 timers 行工厂（boot HOST_ROW_FACTORIES 装配——usage 行同构） */
export function makeTimersHostRow(options: TimersHostRowOptions): Plugin {
  return {
    name: 'host-timers-row',
    apply(ctx: Context) {
      ctx.plugin(class extends HostTimersService {
        constructor(c: Context) { super(c, options); }
      });
      // GUIDELINES_TIMER 段（cr-881 自 ac-system-prompt 迁）已随 cr-883 回退：
      // agentLoop 住壳进程——宿主行集不含 agent-loop 行（boot 终检 PENDING），
      // 且跨进程注册到不了壳 prompt；当前出厂壳亦无 timer 工具注册面
      //（BUILTIN 占名超集，ac-timer-tools 已随旧树退役）→ 注册恒空串。
      // 待 shell 侧 timer 工具行落地时由其 owner 注册。
    },
  } satisfies Plugin;
}