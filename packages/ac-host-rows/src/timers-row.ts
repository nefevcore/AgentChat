// ============================================================
// timers-row.ts —— 宿主 timers 行（cr-1164 v3 换轨：哑触发层）
//
// timer = 哑的事件匹配器 + 排程器——不采集、不判定、不执行任何用户
// 代码（cr-1161：v2 worker 求值面随三病灶全砍，timer-check-worker 删除）。
// 本行承载：
//   · 时间触发：setTimeout 自续链——下一刻由 ac-timer-core 纯函数推导
//     （wall / anchor / after-last 三 base + jitter），触投后算下一个；
//   · 门与终结：gates AND 求值（刻度不命中直接跳过）；until count/date
//     （count 按投递次数记账）；missed（skip / catchup-once）停机策略；
//   · 源触发（cr-1165 采集层上线）：订阅 source/updated 推送匹配（push
//     为主）+ pull 兜底（10s 地板扫 meta.seq）+ stale 判定（generatedAt
//     超 staleAfter → on:'stale' 条目唤醒）；条目级 cooldown 节流（lastSeq
//     照常推进——判断不丢，投递节流）；源行缺席/无权限 → 条目 dormant；
//   · 投递面原样保留：agents/<id>/entries/timer.json 数据面、agentsEdit
//     单写者口、邮局唤醒信（conversationId 烘焙/对角线缺省/机制任务
//     直调）、乐观并发 storedSnapshot（ISSUE-24）、诊断面、心跳。
//   · 停用但保留（cr-1180）：entriesByAgent 装载全量条目（停用条目留在
//     条目面——list 可见、update/cancel 可达、不参与排程分发）；停用落
//     pausedAt 记号；重新启用即基点快进（armedAt 抬到恢复时刻、lastSeq
//     快进到源现值）——停用期间刻度不回补、事件不补投。
// 记账（state.json）：lastFiredAt / firedCount / armedAt（catchup 下界
// 与 after-last 锚）/ nextAtCache（时钟跳变检测——nextAt 恒可由 entry +
// now 重算，缓存只剩告警价值，断点不再承载排程语义）。审计行落
// meta/timer/audit.jsonl（滚动）。投递失败退避 1m→5m→30m、连续 5 次
// 停排 fail-loud（沿用 v2）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context, type Plugin } from '@agentchat/cordis';
import { listAgentIds, readAgentConfig, settingsOf, isPresetId } from 'ac-agents-core';
import { DEFAULT_TZ } from 'ac-core-utils'; // 缺省时区基线（cr-1053 单源）
import { makeEnvelope, issueRequestId } from 'ac-envelope-core';
import type { Envelope } from 'ac-envelope-core';
import type { PostOffice } from 'ac-post-office';
import {
  createHolidayResolver,
  gatesPass,
  isLegacyEntryShape,
  isScriptEntryShape,
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
  type SourceTrigger,
  type TimeTrigger,
  type TimerEntry,
} from 'ac-timer-core';
import { readMeta, readRowsSince } from 'ac-source-core';
import { hasSourceView } from 'ac-auth-core';

/** 全局条目 owner（sys.timer；target '*' = 全部常规 Agent） */
export const GLOBAL_TIMER_OWNER = '__global__';

/** entries 写口插槽（agents 编辑面服务键 'agents'——cr-551 单写者收口） */
export interface EntriesEditFace {
  saveEntry(id: string, key: string, data: unknown): void;
  readEntry<T>(id: string, key: string): T | undefined;
}

/** 行配置 */
export interface TimersHostRowOptions {
  dataRoot: string;
  postOffice: PostOffice;
  timezone?: string;
  heartbeatMs?: number;
  agentsEdit?: EntriesEditFace;
  /** 单次投递超时（缺省 30s；测试注小值——见 dispatchWithin） */
  dispatchTimeoutMs?: number;
}

/** 持久化记账（meta/timer/state.json）。时刻字段一律纪元毫秒（数值）——
 * 秒级 ISO 截断会让 catchup 判据（lastFired > due）在亚秒刻永真（实测
 * once 7ms 循环重投）；显示层再经 localISO 转 owner 时区。nextAtCache
 * 仅时钟跳变检测用。 */
interface TimerPersistedState {
  /** 条目首次装载时刻（catchup 下界与 after-last 锚——一经写入不变） */
  armedAt?: number;
  lastFiredAt?: number;
  firedCount?: number;
  nextAtCache?: number;
  dormantReason?: string;
  /**
   * 源触发已消费 seq（键 = source/view——设计 §六「源触发按 lastSeq 续读」）。
   * cr-1169：此前只在内存 Map——宿主重启即丢，pull 兜底首扫判「落后」重读
   * 全部行，同 seq 二次投递（news 实测 seq10 双触发）。持久化后续读从断点起。
   */
  lastSeq?: Record<string, number>;
  /** 心跳存活信号（诊断面——不参与任何逻辑） */
  heartbeatAt?: string;
  /** 停用时刻（cr-1180 停用但保留——list 投影；启用着落不写） */
  pausedAt?: number;
}

/** 完成条目归档记录（cancelled = 用户撤销——cr-1171 cancel 归档） */
interface TimerArchiveRecord {
  id: string;
  status: 'completed' | 'dropped' | 'cancelled';
  reason?: string;
  completedAt: string;
  firedCount: number;
  entry?: TimerEntry;
}

/** entries/timer.json 持久形态（v3：整表带 version） */
interface TimerStoreEntry { version: 3; entries: TimerEntry[] }

/** settings 分层形状 */
interface TimerLayerSettings {
  timezone?: string;
  holidays?: string[];
  makeupWorkdays?: string[];
}

/** 哨兵：磁盘无文件 */
const ABSENT = '__ABSENT__';

/** 稳定序列化（键排序——内容比较用，外部写入改变键序不误判冲突） */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(JSON.stringify(value));
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

/** 投递失败退避阶梯（连续失败：1m → 5m → 30m → 30m…；停排阈值次后停） */
const BACKOFF_STEPS_MS = [60_000, 300_000, 1_800_000];
const DISPATCH_STOP_STREAK = 5;

/** setTimeout 时长上限（2^30ms ≈ 12 天——远期目标排中继刻度，到点重算） */
const MAX_TIMEOUT_MS = 2 ** 30;

/** 审计滚动阈值（单文件 1MB → .old 覆盖） */
const AUDIT_ROLL_BYTES = 1_000_000;

/** 时钟跳变告警阈值（重算 nextAt 与缓存偏差超过即记 lastNote） */
const CLOCK_JUMP_MS = 10 * 60_000;

/** 源触发 cooldown 缺省（§十一开放决策：5m） */
const DEFAULT_SOURCE_COOLDOWN = '5m';

/** pull 兜底扫描地板（防兜底扫描风暴——§六防线表） */
const PULL_FLOOR_MS = 10_000;

/**
 * 排程看门狗节拍（cr-1228）。任何一次「排程静默消失」都必须被一个与
 * 排程链无关的独立节拍发现并重建——2026-11-22 现场：11:06~13:05 全量
 * 停摆约 2 小时（audit 空白、fc 停在 49、nextAt 直接从 11:00 跳到 14:00），
 * 而宿主进程存活、日志不断，无任何错误行。看门狗把此类静默死亡从
 * 「直到重启」压到「至多一拍」。
 */
const WATCHDOG_MS = 60_000;
/** 看门狗宽限：排程到期后这么多毫秒仍未触发才判「掉链」（覆盖正常抖动） */
const WATCHDOG_GRACE_MS = 90_000;
/** 单次投递超时（dispatch 内含无超时连接面——挂死会让整条链永久悬停） */
const DISPATCH_TIMEOUT_MS = 30_000;

/** 一次排程计划（source 触发不预排程——事件到达时现构） */
interface FirePlan {
  due: number;
  trigger: TimeTrigger | SourceTrigger;
  cause: 'time' | 'catchup' | 'source';
}

// ============================================================
// 宿主 timers 服务（哑排程引擎）
// ============================================================

export class HostTimersService extends Service {
  static inject = ['timer', 'config'];

  private readonly dataRoot: string;
  private readonly po: PostOffice;
  private readonly agentsEdit: EntriesEditFace | undefined;
  private readonly baseTz: string;
  private readonly heartbeatMs: number;
  private readonly dispatchTimeoutMs: number;
  private stateFile: string;
  private auditFile: string;
  private entriesByAgent = new Map<string, TimerEntry[]>();
  private schedules = new Map<string, () => void>();
  private scheduledDue = new Map<string, FirePlan>();
  /** 在途投递（看门狗据此跳过——避免与正在跑的 fire 抢排程） */
  private inFlight = new Set<string>();
  /** 看门狗 interval dispose（自有 fiber） */
  private watchdogDispose?: () => void;
  private heartbeatDispose?: () => void;
  private persisted = new Map<string, TimerPersistedState>();
  private nextAtMs = new Map<string, number>();
  private lastSkip = new Map<string, { at: string; reason: string; streak: number }>();
  private lastError = new Map<string, { at: string; message: string; streak: number }>();
  /** 非致命提示（时钟跳变等）——同文本不重复记 */
  private lastNote = new Map<string, { at: string; text: string }>();
  private storedSnapshot = new Map<string, string>();
  private migrating = false;
  // ── 源触发运行时（cr-1165/1169）：lastSeq 走 persisted（重启续读）、cooldown 内存 ──
  /** 条目键 → 各源触发器 cooldown 窗口截止时刻（纪元毫秒；重启丢失无害——
   *  lastSeq 已持久化，无「新行」可重投，cooldown 只是投递节流瞬态） */
  private cooldownUntil = new Map<string, Record<string, number>>();
  /** pull 兜底扫描 interval dispose（10s 地板；仅源条目在场时活） */
  private pullDispose?: () => void;
  /** 源事件订阅 dispose（source/updated） */
  private sourceSubDispose?: () => void;

  constructor(ctx: Context, options: TimersHostRowOptions) {
    super(ctx, 'timers');
    this.dataRoot = path.resolve(options.dataRoot);
    this.po = options.postOffice;
    this.baseTz = options.timezone ?? DEFAULT_TZ;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.dispatchTimeoutMs = options.dispatchTimeoutMs ?? DISPATCH_TIMEOUT_MS;
    this.agentsEdit = options.agentsEdit;
    this.stateFile = path.join(this.dataRoot, 'meta', 'timer', 'state.json');
    this.auditFile = path.join(this.dataRoot, 'meta', 'timer', 'audit.jsonl');
    ctx.fiber.effect(() => () => {
      if (this.watchdogDispose !== undefined) { this.watchdogDispose(); this.watchdogDispose = undefined; }
      this.stopAll();
    }, 'host-timers.stop');
    this.ctx.on('source/updated', (p: { source: string; view: string; seq: number }) => {
      this.onSourceUpdated(p.source, p.view, p.seq);
    });
    this.reload();
  }

  // ── 数据面（原样保留：agents 树直读/编辑面/原子写/归档） ──

  private configService(): { get<T>(key: string, fallback?: T): T | undefined; set(key: string, value: unknown): void } | null {
    const cfg = this.ctx.get('config', false) as
      | { get<T>(key: string, fallback?: T): T | undefined; set(key: string, value: unknown): void }
      | undefined;
    return cfg ?? null;
  }

  private readStored(owner: string, opts?: { remember?: boolean }): TimerStoreEntry | null {
    if (owner === GLOBAL_TIMER_OWNER) return null;
    const remember = opts?.remember !== false;
    const finish = (v: TimerStoreEntry | null): TimerStoreEntry | null => {
      if (remember) this.storedSnapshot.set(owner, v === null ? ABSENT : stableStringify(v));
      return v;
    };
    const via = this.agentsEdit?.readEntry<TimerStoreEntry>(owner, 'timer');
    if (via !== undefined) return finish(Array.isArray((via as { entries?: unknown }).entries) ? (via as TimerStoreEntry) : null);
    try {
      const file = path.join(this.dataRoot, 'agents', owner, 'entries', 'timer.json');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as TimerStoreEntry;
      return finish(Array.isArray(parsed.entries) ? parsed : null);
    } catch {
      return finish(null);
    }
  }

  private writeStored(owner: string, stored: TimerStoreEntry): void {
    if (owner === GLOBAL_TIMER_OWNER) return;
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
      return [];
    }
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

  private layerOf(owner: string): TimerLayerSettings {
    const agent = owner === GLOBAL_TIMER_OWNER ? null : readAgentConfig(this.dataRoot, owner);
    // cr-1202：全局层键对齐主线合成口（ac-agents settingsOf 读顶层 'settings'
    // ——config.json 全局默认层；cr-1147 起此处误读 'agents.settings' 死键，
    // 全局层 timezone/holidays 恒不生效）。每现查不缓存——config/changed 后
    // 新值即生效（订阅刷新模式，与 ConfigService 订阅刷新语义同源）。
    const globalSettings = this.configService()?.get<Record<string, unknown>>('settings') ?? {};
    const s = settingsOf(globalSettings, agent?.settings, 'timers') as TimerLayerSettings | undefined;
    if (s && typeof s === 'object' && !Array.isArray(s)) return s;
    return {};
  }

  private tzOf(owner: string): string {
    const t = this.layerOf(owner).timezone;
    return typeof t === 'string' && t.trim() ? t.trim() : this.baseTz;
  }

  private resolverOf(owner: string): ReturnType<typeof createHolidayResolver> {
    const s = this.layerOf(owner);
    return createHolidayResolver(
      {
        holidays: Array.isArray(s.holidays) ? s.holidays : [],
        makeupWorkdays: Array.isArray(s.makeupWorkdays) ? s.makeupWorkdays : [],
      },
      this.tzOf(owner),
    );
  }

  // ── 迁移（cr-1164：boot 时旧形态一次性转 v3） ──

  /**
   * 旧条目 → v3（migrateLegacyEntry 单源，§八映射表）。三类旧形态：
   *   · v1 5 模式（mode 字段）→ 直译；
   *   · v2 脚本条目（kind:'script'）→ 丢弃归档（code 存量为零——执行面
   *     砍除是换轨本体，脚本语义无法数据化直译）；
   *   · 简化全局形状（{time,hint,targets}，GlobalTimerHost UI 产物）→ v3。
   * 记账 key 迁移：executedCount→firedCount / lastTriggeredAt→lastFiredAt；
   * scriptState / persistNextAt 丢弃。timer.json.bak 备份后写 {version:3}。
   */
  private migrateLegacy(): void {
    for (const agentId of listAgentIds(this.dataRoot)) {
      const file = path.join(this.dataRoot, 'agents', agentId, 'entries', 'timer.json');
      let raw: { version?: number; entries?: unknown[] } | null = null;
      try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { version?: number; entries?: unknown[] }; } catch { continue; }
      if (!Array.isArray(raw.entries)) continue;
      if (raw.version === 3 && !raw.entries.some((e) => isLegacyEntryShape(e) || isScriptEntryShape(e) || isSimplifiedGlobalShape(e))) continue;
      const dropped: TimerArchiveRecord[] = [];
      const migrated: TimerEntry[] = [];
      for (const e of raw.entries) {
        if (isLegacyEntryShape(e)) { migrated.push(migrateLegacyEntry(e)); continue; }
        if (isSimplifiedGlobalShape(e)) { migrated.push(simplifiedToV3(e as { time: string; hint: string; targets?: string[]; builtin?: boolean })); continue; }
        if (isScriptEntryShape(e)) {
          dropped.push({ id: (e as { id: string }).id, status: 'dropped', reason: 'script-face-retired', completedAt: localISO(undefined, this.baseTz), firedCount: 0 });
          continue;
        }
        // v3 条目原样保留（version 戳缺失的散装 v3）
        try { migrated.push(...validateTimerEntries([e])); } catch {
          dropped.push({ id: '<unknown>', status: 'dropped', reason: 'invalid', completedAt: localISO(undefined, this.baseTz), firedCount: 0 });
        }
      }
      try {
        fs.copyFileSync(file, file + '.bak');
        fs.writeFileSync(file, JSON.stringify({ version: 3, entries: validateTimerEntries(migrated) }, null, 2), 'utf-8');
        if (dropped.length > 0) {
          this.writeArchive(agentId, [...this.readArchive(agentId), ...dropped]);
          this.ctx.logger.warn('[timers] ' + agentId + ' v2 脚本/无效条目已丢弃归档（' + dropped.length + ' 条——执行面随 v3 砍除，备份 timer.json.bak）');
        }
        this.ctx.logger.info('[timers] ' + agentId + ' 条目已迁移 v3（' + migrated.length + ' 条，备份 timer.json.bak）');
      } catch (err: unknown) {
        this.ctx.logger.warn('[timers] ' + agentId + ' 迁移写盘失败：' + (err instanceof Error ? err.message : String(err)) + '——下次 boot 重试');
      }
    }
    // 记账 key 迁移（executedCount→firedCount 等；scriptState/persistNextAt 丢弃）
    for (const [key, ps] of [...this.persisted]) {
      if (key.startsWith('_')) continue;
      const legacy = ps as TimerPersistedState & { executedCount?: number; lastTriggeredAt?: string; scriptState?: unknown; persistNextAt?: string };
      if (legacy.executedCount !== undefined || legacy.lastTriggeredAt !== undefined || legacy.scriptState !== undefined || legacy.persistNextAt !== undefined) {
        const { executedCount, lastTriggeredAt, scriptState: _s, persistNextAt: _n, ...keep } = legacy;
        const legacyFired = lastTriggeredAt !== undefined ? new Date(lastTriggeredAt).getTime() : undefined;
        this.persisted.set(key, {
          ...keep,
          ...(Number.isFinite(legacyFired) && keep.lastFiredAt === undefined ? { lastFiredAt: legacyFired as number } : {}),
          ...(executedCount !== undefined && keep.firedCount === undefined ? { firedCount: executedCount } : {}),
        });
      }
    }
    // 全局条目（config timer.tasks）：简化形状 / v1 / v2 → v3 落 config
    const cfg = this.configService();
    const rawTasks = cfg?.get<unknown[]>('timer.tasks');
    if (Array.isArray(rawTasks) && rawTasks.some((e) => isLegacyEntryShape(e) || isScriptEntryShape(e) || isSimplifiedGlobalShape(e))) {
      const dropped: unknown[] = [];
      const migrated: TimerEntry[] = [];
      for (const e of rawTasks) {
        if (isLegacyEntryShape(e)) { migrated.push(migrateLegacyEntry(e)); continue; }
        if (isSimplifiedGlobalShape(e)) { migrated.push(simplifiedToV3(e as { time: string; hint: string; targets?: string[]; builtin?: boolean })); continue; }
        if (isScriptEntryShape(e)) { dropped.push(e); continue; }
        try { migrated.push(...validateTimerEntries([e])); } catch { dropped.push(e); }
      }
      cfg?.set('timer.tasks', { version: 3, entries: validateTimerEntries(migrated) });
      if (dropped.length > 0) this.ctx.logger.warn('[timers] 全局条目 ' + dropped.length + ' 条 v2 脚本/无效已丢弃（执行面随 v3 砍除）');
      this.ctx.logger.info('[timers] 全局条目已迁移 v3（' + migrated.length + ' 条）');
    }
  }

  // ── 装载/排程 ──

  /**
   * 重新加载全部条目 + 排程（启动/热重载共用）。v3 哑层无断点语义：
   * nextAt 恒可由 entry + now 重算——重启即重排；缓存值偏差过大（时钟
   * 跳变）记 lastNote 告警。
   */
  reload(): void {
    this.stopAll();
    this.loadState();
    this.entriesByAgent.clear();
    this.migrating = true;
    try { this.migrateLegacy(); } finally { this.migrating = false; }
    this.saveState();
    for (const agentId of listAgentIds(this.dataRoot)) {
      const stored = this.readStored(agentId);
      // cr-1180：全量装载（含停用条目）——条目面不因 enabled:false 蒸发；
      // 排程/分发点按启用过滤（arm / onSourceUpdated / syncPull）。
      const entries = stored?.entries ?? [];
      if (entries.length > 0) this.entriesByAgent.set(agentId, entries);
    }
    const globalEntries = this.configEntries();
    if (globalEntries.length > 0) this.entriesByAgent.set(GLOBAL_TIMER_OWNER, globalEntries);
    const valid = new Set<string>();
    for (const [owner, entries] of this.entriesByAgent) {
      for (const e of entries) valid.add(`${owner}/${e.id}`);
    }
    for (const key of this.persisted.keys()) {
      if (!key.startsWith('_') && !valid.has(key)) this.forget(key);
    }
    this.saveState();
    for (const [owner, entries] of this.entriesByAgent) {
      for (const entry of entries) this.arm(owner, entry);
    }
    this.syncHeartbeat();
    this.syncPull();
    this.startWatchdog();
  }

  private configEntries(): TimerEntry[] {
    const raw = this.configService()?.get<unknown>('timer.tasks');
    const list = Array.isArray(raw)
      ? raw
      : raw !== null && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown[] }).entries)
        ? (raw as { entries: unknown[] }).entries
        : [];
    const valid: TimerEntry[] = [];
    for (const item of list) {
      if (isSimplifiedGlobalShape(item)) {
        // 简化形状 {time, hint, targets}（GlobalTimerHost UI 产出）→ v3
        valid.push(simplifiedToV3(item as { time: string; hint: string; targets?: string[]; builtin?: boolean }));
        continue;
      }
      try { valid.push(...validateTimerEntries([item])); } catch { /* 无效全局条目跳过（迁移期已告警） */ }
    }
    return valid;
  }

  entries(owner: string): TimerEntry[] {
    return [...(this.entriesByAgent.get(owner) ?? [])];
  }

  list(): Array<{ owner: string; entries: TimerEntry[] }> {
    return [...this.entriesByAgent].map(([owner, entries]) => ({ owner, entries }));
  }

  /**
   * 排程态快照（诊断面）。
   *
   * **时间字段一律用 owner 时区的带偏移 ISO**（localISO）：曾出现 lastAt 带
   * +08:00 而 nextAt 是 UTC Z，直接字符串相减差 8 小时——同类字段必须同
   * 格式，「能算但算错」比「不能算」更危险。
   *
   * 惰性字段（lastSkip* / lastError* / lastNote*）只在事件发生后才出现，
   * 且都是内存态（宿主重启即清空）——缺失 = 本次启动以来未发生该事件
   * （前提 listVersion 达到引入版本，见 timer-face）。
   */
  scheduleState(owner: string, entryId: string): {
    lastAt?: string;
    nextAt?: string;
    chained?: boolean;
    dormantReason?: string;
    /** 停用时刻（cr-1180 停用但保留——list 投影；启用着落不写） */
    pausedAt?: string;
    /** 源健康（cr-1172：§七「list 源健康」——meta 现读，数组 = 条目全部订阅） */
    sources?: Array<{ source: string; view: string; generatedAt: string; seq: number; stale: boolean }>;
    lastSkipAt?: string;
    lastSkipReason?: string;
    skipStreak?: number;
    lastErrorAt?: string;
    lastError?: string;
    errorStreak?: number;
    lastNoteAt?: string;
    lastNote?: string;
    triggeredCount?: number;
  } {
    const key = `${owner}/${entryId}`;
    const ps = this.persisted.get(key);
    const next = this.nextAtMs.get(key);
    const skip = this.lastSkip.get(key);
    const err = this.lastError.get(key);
    const note = this.lastNote.get(key);
    const tz = this.tzOf(owner);
    const entry = this.entriesByAgent.get(owner)?.find((e) => e.id === entryId);
    const chained = entry?.when.some((t) => t.kind === 'every' && (t.base ?? 'wall') === 'after-last') ?? false;
    // 源健康投影（cr-1172）：条目全部源订阅 → meta 现读。stale 判据与
    // staleSweep 同口径（generatedAt 超 staleAfterMs）；meta 缺席 = 源
    // 不可用（dormantReason: source-unavailable 已另有投影，不在此重复）。
    const sources = entry?.when.filter((t): t is SourceTrigger => t.kind === 'source') ?? [];
    const now = Date.now();
    const health = sources.flatMap((t) => {
      const meta = readMeta(path.join(this.dataRoot, 'exports', t.source, t.view));
      if (meta === null) return [];
      return [{
        source: t.source, view: t.view,
        generatedAt: meta.generatedAt, seq: meta.seq,
        stale: now - new Date(meta.generatedAt).getTime() > meta.staleAfterMs,
      }];
    });
    return {
      ...(health.length > 0 ? { sources: health } : {}),
      ...(ps?.lastFiredAt !== undefined ? { lastAt: localISO(new Date(ps.lastFiredAt), tz) } : {}),
      ...(next !== undefined ? { nextAt: localISO(new Date(next), tz) } : {}),
      ...(chained ? { chained: true } : {}),
      ...(ps?.dormantReason ? { dormantReason: ps.dormantReason } : {}),
      ...(ps?.pausedAt !== undefined ? { pausedAt: localISO(new Date(ps.pausedAt), tz) } : {}),
      ...(skip ? { lastSkipAt: skip.at, lastSkipReason: skip.reason, skipStreak: skip.streak } : {}),
      ...(err ? { lastErrorAt: err.at, lastError: err.message, errorStreak: err.streak } : {}),
      ...(note ? { lastNoteAt: note.at, lastNote: note.text } : {}),
      ...(ps?.firedCount !== undefined ? { triggeredCount: ps.firedCount } : {}),
    };
  }

  /**
   * 幂等改写单条（cr-1171 update 语义）：按 id 替换，记账（armedAt/
   * firedCount/lastSeq）保留——改触发词汇不丢历史；条目不存在报错。
   */
  update(owner: string, entry: TimerEntry): { ok: boolean; error?: string } {
    let valid: TimerEntry;
    try { valid = validateTimerEntries([entry])[0]!; } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const current = this.entries(owner);
    const idx = current.findIndex((e) => e.id === valid.id);
    if (idx < 0) return { ok: false, error: '条目不存在: ' + valid.id };
    const next = [...current];
    next[idx] = valid;
    return this.save(owner, next);
  }

  /**
   * 撤单条并归档留痕（cr-1171 cancel 语义）：不走 save 过滤（那会静默蒸发），
   * 经 completeEntry 同款归档链——status 'cancelled'，firedCount 固化，
   * timer-archive.json 可查。条目不存在报错。
   */
  cancelEntry(owner: string, entryId: string): { ok: boolean; error?: string } {
    const entry = this.entries(owner).find((e) => e.id === entryId);
    if (entry === undefined) return { ok: false, error: '条目不存在: ' + entryId };
    this.completeEntry(owner, entry, this.persisted.get(owner + '/' + entryId)?.firedCount ?? 0, 'cancelled');
    return { ok: true };
  }

  /**
   * 写回条目表并重排（v3 纯数据写——校验单源 validateTimerEntries）。
   * 新条目 armedAt 落现在（catchup 不回补 set 前的历史刻）。
   */
  save(owner: string, entries: TimerEntry[]): { ok: boolean; error?: string } {
    let valid: TimerEntry[];
    try { valid = validateTimerEntries(entries); } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const stored: TimerStoreEntry = { version: 3, entries: valid };
    if (owner === GLOBAL_TIMER_OWNER) {
      this.configService()?.set('timer.tasks', stored);
    } else {
      const disk = this.readStored(owner, { remember: false });
      const diskSig = disk === null ? ABSENT : stableStringify(disk);
      const base = this.storedSnapshot.get(owner);
      if (base !== undefined && base !== diskSig) {
        const msg =
          `条目存储已被外部修改（${owner}）——本次写入已拒绝，请重取条目后重试。` +
          `磁盘现值与宿主内存基准不一致：外部改动会被整表覆盖，故不写入`;
        this.ctx.logger.warn(`[timers] ${msg}`);
        this.adoptStored(owner, disk);
        return { ok: false, error: msg };
      }
      this.writeStored(owner, stored);
    }
    this.stopAgent(owner);
    // cr-1180：全量装载（含停用条目——UI 整表保存后 list 仍可见）；
    // 翻转检测基准 = 覆盖前内存表（wasEnabled 在 set 之前取）
    const prev = this.entriesByAgent.get(owner);
    const wasEnabledOf = (id: string): boolean => prev?.find((x) => x.id === id)?.enabled !== false;
    if (valid.length > 0) this.entriesByAgent.set(owner, valid);
    else this.entriesByAgent.delete(owner);
    const validKeys = new Set(valid.map((e) => `${owner}/${e.id}`));
    for (const key of this.persisted.keys()) {
      if (key.startsWith(`${owner}/`) && !validKeys.has(key)) this.forget(key);
    }
    // 新条目 armedAt = 现在；既有条目保留原 armedAt（catchup 下界稳定）；
    // 启停翻转（cr-1180 停用但保留）：停用落 pausedAt（启停时刻记号），
    // 启用即基点快进——armedAt 抬到恢复时刻（停用期间刻度不回补）、
    // lastSeq 快进到各订阅源现值（停用期间事件不补投）。save 是整表写，
    // 同一次保存里 UI 可能翻转多条——逐条对照覆盖前状态判定。
    const now = Date.now();
    for (const e of valid) {
      const key = `${owner}/${e.id}`;
      const ps = this.persisted.get(key);
      if (ps === undefined) { this.persisted.set(key, { armedAt: now }); continue; }
      const wasEnabled = wasEnabledOf(e.id);
      if (e.enabled === false) {
        if (wasEnabled && ps.pausedAt === undefined) this.persisted.set(key, { ...ps, pausedAt: now });
      } else if (!wasEnabled) {
        // 重新启用：基点快进（armedAt 抬到恢复时刻 + lastSeq 快进 + 清 pausedAt）
        const { pausedAt, ...keep } = ps;
        const next: TimerPersistedState = { ...keep, armedAt: Math.max(ps.armedAt ?? now, now) };
        for (const t of e.when) {
          if (t.kind !== 'source') continue;
          const meta = readMeta(path.join(this.dataRoot, 'exports', t.source, t.view));
          if (meta === null) continue; // 源从未物化——快进到 0 与缺省同，跳过
          next.lastSeq = { ...(next.lastSeq ?? {}), [t.source + '/' + t.view]: Math.max(next.lastSeq?.[t.source + '/' + t.view] ?? 0, meta.seq) };
        }
        this.persisted.set(key, next);
      } else if (ps.armedAt === undefined) this.persisted.set(key, { ...ps, armedAt: now });
    }
    this.saveState();
    for (const entry of valid) this.arm(owner, entry);
    return { ok: true };
  }

  storeState(owner: string): { configStale: boolean } {
    if (owner === GLOBAL_TIMER_OWNER) return { configStale: false };
    const base = this.storedSnapshot.get(owner);
    if (base === undefined) return { configStale: true };
    const disk = this.readStored(owner, { remember: false });
    const diskSig = disk === null ? ABSENT : stableStringify(disk);
    return { configStale: base !== diskSig };
  }

  private adoptStored(owner: string, disk: TimerStoreEntry | null): void {
    // cr-1180：全量装载（含停用条目）——与 reload/save 同口径
    const entries = disk?.entries ?? [];
    if (entries.length > 0) this.entriesByAgent.set(owner, entries);
    else this.entriesByAgent.delete(owner);
    const valid = new Set(entries.map((e) => `${owner}/${e.id}`));
    for (const key of this.persisted.keys()) {
      if (key.startsWith(`${owner}/`) && !valid.has(key)) this.forget(key);
    }
    this.saveState();
    for (const entry of entries) this.arm(owner, entry);
  }

  /**
   * 静态预览（timer 工具 test / set 返回体——owner 时区求值；after-last
   * 从 armedAt=now 起链并标注 chained）。
   */
  preview(owner: string, entry: TimerEntry): { fires: Array<{ at: string; trigger: string; chained: boolean }> } {
    const now = Date.now();
    return {
      // cr-1225/ISSUE-23③：预览应用 gates——与运行期 fire 同一 resolver。
      fires: previewFires(entry, now, { tz: this.tzOf(owner), armedAt: now }, 3, this.resolverOf(owner)).map((f) => ({
        at: localISO(new Date(f.at), this.tzOf(owner)),
        trigger: f.trigger.kind,
        chained: f.chained,
      })),
    };
  }

  /** 手动触发（测试/诊断；直接投递——不走触发判定） */
  triggerNow(owner: string, entryId: string): boolean {
    const entry = this.entries(owner).find((e) => e.id === entryId);
    if (!entry) return false;
    void this.fire(owner, entry, { due: Date.now(), trigger: { kind: 'once', at: new Date().toISOString() }, cause: 'time' }, true);
    return true;
  }

  // ============================================================
  // 哑排程引擎（arm → fire → re-arm 自续链）
  // ============================================================

  /**
   * 自有 fiber 的定时器（cr-1228）。**不再借 ctx.timeout()**：那是
   * TimerService 的 effect，挂在 timer 行的 fiber 上（mixin 的 this.ctx
   * 恒解析为服务自身 ctx）——timer 行一旦重载，宿主全域所有排程会被
   * 静默清空，而本行的 schedules 表仍持有陈旧 dispose → 永不重排，
   * 且无异常、无日志、进程存活（2026-11-22 现场形态）。挂到本行 fiber
   * 上后，排程生命周期 = 本行生命周期，语义自洽。
   */
  private ownTimeout(fn: () => void, ms: number): () => void {
    return this.ctx.effect(() => {
      const timer = setTimeout(fn, Math.max(0, ms));
      return () => clearTimeout(timer);
    }, 'timers.schedule');
  }

  /** 自有 fiber 的周期节拍（心跳/源 pull/看门狗共用——同上理由） */
  private ownInterval(fn: () => void, ms: number): () => void {
    return this.ctx.effect(() => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    }, 'timers.interval');
  }

  /**
   * 排程看门狗（cr-1228 纵深防线）：与排程链完全独立的一拍，逐条目核对
   * 「启用的时间触发条目必须有在途排程，且到期后宽限内必须已动手」。
   * 不满足即重排并记 warn——静默死亡从此有界且可观测。
   */
  private startWatchdog(): void {
    if (this.watchdogDispose !== undefined) return;
    this.watchdogDispose = this.ownInterval(() => {
      try { this.watchdogTick(); } catch (err) { this.ctx.logger.warn('[timers] 看门狗异常：' + String(err)); }
    }, WATCHDOG_MS);
  }

  private watchdogTick(): void {
    const now = Date.now();
    const repaired: string[] = [];
    for (const [owner, entries] of this.entriesByAgent) {
      for (const entry of entries) {
        if (entry.enabled === false) continue;
        if (!entry.when.some((t) => isTimeTrigger(t))) continue; // 纯源条目归 pull/stale 面
        const key = owner + '/' + entry.id;
        if (this.inFlight.has(key)) continue;
        const scheduled = this.scheduledDue.get(key);
        if (scheduled !== undefined && scheduled.due > now - WATCHDOG_GRACE_MS) continue;
        repaired.push(scheduled === undefined
          ? key + '(缺排)'
          : key + '(到期未动 ' + Math.round((now - scheduled.due) / 1000) + 's)');
        this.arm(owner, entry);
      }
    }
    if (repaired.length > 0) {
      this.ctx.logger.warn('[timers] 看门狗补排 ' + repaired.length + ' 条：' + repaired.join('，'));
    }
  }

  private cancel(key: string): void {
    const dispose = this.schedules.get(key);
    if (dispose) {
      dispose();
      this.schedules.delete(key);
    }
    this.scheduledDue.delete(key);
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
    this.stopSourceRuntime();
  }

  // ============================================================
  // 源触发运行时（cr-1165：push 分发 + pull 兜底 + stale + cooldown）
  // ============================================================

  private stopSourceRuntime(): void {
    if (this.pullDispose !== undefined) { this.pullDispose(); this.pullDispose = undefined; }
  }

  /** 条目的源触发器全集 */
  private sourceTriggersOf(entry: TimerEntry): SourceTrigger[] {
    return entry.when.filter((t): t is SourceTrigger => t.kind === 'source');
  }

  /**
   * 源视图授权判定（cr-1166 双闸之一）：per-agent inline grant 投影
   * （hasSourceView 单源——timer-face set 校验与本行分发共用口径）。
   * 全局条目（GLOBAL_TIMER_OWNER）恒过——它的扇出面是用户配置的 target
   * 白名单，不经 LLM 面。
   */
  maySubscribe(owner: string, source: string, view: string): boolean {
    if (owner === GLOBAL_TIMER_OWNER) return true;
    return hasSourceView(this.dataRoot, owner, source, view);
  }

  /**
   * 会话键归属判定（cr-1170 set 校验用）：唤醒信投到 owner 的哪条会话线程
   * 由 conversationId 决定——必须属于本 owner，防跨 Agent 注入（news 指定
   * nana~user = 向 nana 的会话线程投信）。合法形态：
   *   · a~b 键 owner 为任一侧（含 owner~owner 对角线自会话——v1 语义回归，
   *     会话线程按需物化，不要求已存在）；
   *   · 单段键（用户会话 / 群 gid）须已存在于 owner 的 sessions 目录。
   */
  mayAddress(owner: string, conversationId: string): boolean {
    if (owner === GLOBAL_TIMER_OWNER) return true; // 全局条目扇出面是 target 白名单
    if (conversationId.includes('~')) {
      const [a, b] = conversationId.split('~');
      return a === owner || b === owner;
    }
    return fs.existsSync(path.join(this.dataRoot, 'agents', owner, 'sessions', conversationId));
  }

  /** 源在场（cr-1167 test 预警用）：物化 meta 在场 = 源行已产数据（与 arm 的 dormant 判据同口径） */
  sourcePresent(source: string, view: string): boolean {
    try {
      return readMeta(path.join(this.dataRoot, 'exports', source, view)) !== null;
    } catch {
      return false; // sourceViewDir 同款路径组件拒绝——判不在场
    }
  }

  /**
   * source/updated 分发（push 主通道）：对每个订阅该 source/view 的条目
   * 做增量匹配。读物化面 rows（readRowsSince lastSeq）——事件只带 seq，
   * 行数据以物化面为准（事件是「来读」的信号，不是数据载体）。
   */
  private onSourceUpdated(source: string, view: string, seq: number): void {
    for (const [owner, entries] of this.entriesByAgent) {
      for (const entry of entries) {
        if (entry.enabled === false) continue; // cr-1180：停用条目不投
        const trigs = this.sourceTriggersOf(entry).filter((t) => t.source === source && t.view === view);
        if (trigs.length === 0) continue;
        // 二道闸（cr-1166）：未授权条目不投——直改 timer.json 注入的订阅绕不过
        // set 校验（磁盘文件在 Agent 双禁域内，此闸防将来任何旁路写入口）。
        // 授权变更（吊销）后已存条目自动失效——每事件现查。
        if (!this.maySubscribe(owner, source, view)) continue;
        // dormant 解除：源行上线（物化出现）即重评估（arm 内 clearDormant）
        if (this.persisted.get(owner + '/' + entry.id)?.dormantReason === 'source-unavailable') this.arm(owner, entry);
        void this.matchAndFire(owner, entry, trigs, source, view, seq);
      }
    }
    this.syncPull();
  }

  /**
   * 增量匹配与投递：新行对触发器逐条求值（match 缺席 = 新行即命中）；
   * cooldown 窗口内不投但 lastSeq 照常推进（判断不丢，投递节流）。
   * 窗口外首次命中即投——本次事件的其余新行不再重复投递。
   */
  private async matchAndFire(
    owner: string,
    entry: TimerEntry,
    trigs: SourceTrigger[],
    source: string,
    view: string,
    seq: number,
  ): Promise<void> {
    const key = owner + '/' + entry.id;
    const since = this.lastSeqOf(key, source, view);
    const rows = readRowsSince(path.join(this.dataRoot, 'exports', source, view), since);
    if (rows.length === 0) return;
    // 读后即占位（cr-1169）：投递是异步的——若投递完才推进，窗口期内的
    // pull 兜底/后续事件会重读同批行再投一次。先推进 seq 再投；投递失败
    // 不回退（at-least-once 由邮局 outbox 承担——与时间触发记账语义一致）。
    const maxSeq = Math.max(seq, ...rows.map((r) => r.seq as number));
    this.advanceLastSeq(key, source, view, maxSeq);
    for (const trig of trigs) {
      if (trig.on !== 'rows-added') continue;
      const hit = trig.match === undefined || rows.some((row) => matchRow(trig.match!, row));
      if (!hit) continue;
      const cd = parseInterval(trig.cooldown ?? DEFAULT_SOURCE_COOLDOWN) ?? 5 * 60_000;
      const now = Date.now();
      const until = this.cooldownUntil.get(key)?.[source + '/' + view] ?? 0;
      if (now < until) break; // 窗口内：不投（方法尾 lastSeq 照常推进——判断不丢）
      if (await this.fireSource(owner, entry, trig, { source, view, seq })) {
        const cur = this.cooldownUntil.get(key) ?? {};
        cur[source + '/' + view] = now + cd;
        this.cooldownUntil.set(key, cur);
      }
      break; // 一投即止（同事件内不重复投）
    }
  }

  private lastSeqOf(key: string, source: string, view: string): number {
    return this.persisted.get(key)?.lastSeq?.[source + '/' + view] ?? 0;
  }

  /** lastSeq 推进并立即落盘（cr-1169：持久化——重启后续读从断点起，防同 seq 重投） */
  private advanceLastSeq(key: string, source: string, view: string, seq: number): void {
    const cur = this.persisted.get(key);
    if (cur === undefined) return; // 条目已清理（fire 链 completeEntry 竞态）——无记账面
    const prev = cur.lastSeq?.[source + '/' + view] ?? 0;
    if (prev >= seq) return;
    this.persisted.set(key, { ...cur, lastSeq: { ...(cur.lastSeq ?? {}), [source + '/' + view]: seq } });
    this.saveState();
  }

  /**
   * pull 兜底（源声明 fallbackPoll——事件驱动为主，push 断了（行崩溃）
   * 也有第二通道）：扫订阅源 meta.seq，比记账推进多即当一次事件处理。
   * 10s 地板（防兜底扫描风暴——§六防线表）。
   */
  private syncPull(): void {
    // cr-1180：仅启用条目参与 pull/stale 扫描（停用条目不订阅源事件面）
    const needPull = [...this.entriesByAgent.values()].some((entries) => entries.some((e) => e.enabled !== false && this.sourceTriggersOf(e).length > 0));
    if (needPull && this.pullDispose === undefined) {
      let lastSweep = 0;
      this.pullDispose = this.ownInterval(() => {
        const now = Date.now();
        if (now - lastSweep < PULL_FLOOR_MS) return;
        lastSweep = now;
        this.pullSweep();
        this.staleSweep();
      }, 10_000);
    } else if (!needPull && this.pullDispose !== undefined) {
      this.stopSourceRuntime();
    }
  }

  private pullSweep(): void {
    const pairs = new Map<string, { source: string; view: string; seq: number }>();
    for (const entries of this.entriesByAgent.values()) {
      for (const entry of entries) {
        for (const t of this.sourceTriggersOf(entry)) {
          if (pairs.has(t.source + '/' + t.view)) continue;
          const meta = readMeta(path.join(this.dataRoot, 'exports', t.source, t.view));
          if (meta !== null) pairs.set(t.source + '/' + t.view, { source: t.source, view: t.view, seq: meta.seq });
        }
      }
    }
    for (const p of pairs.values()) {
      // 只在终态 seq 超过所有订阅条目的 lastSeq 时当一次事件（缺位 = 首见）
      let behind = false;
      for (const [owner, entries] of this.entriesByAgent) {
        for (const entry of entries) {
          if (!this.sourceTriggersOf(entry).some((t) => t.source === p.source && t.view === p.view)) continue;
          if (this.lastSeqOf(owner + '/' + entry.id, p.source, p.view) < p.seq) behind = true;
        }
      }
      if (behind) this.onSourceUpdated(p.source, p.view, p.seq);
    }
  }

  /**
   * stale 判定与唤醒（监控监控者——§五）：源 staleAfter 过期即投递
   * on:'stale' 条目。由 pull 兜底扫描顺带执行（事件通道断了的 stale
   * 也要能发现——meta.generatedAt 是源活性心跳）。
   */
  private staleSweep(): void {
    const now = Date.now();
    for (const [owner, entries] of this.entriesByAgent) {
      for (const entry of entries) {
        const staleTrig = this.sourceTriggersOf(entry).find((t) => t.on === 'stale');
        if (staleTrig === undefined) continue;
        const meta = readMeta(path.join(this.dataRoot, 'exports', staleTrig.source, staleTrig.view));
        if (meta === null) continue; // 源从未物化（源行缺席）——dormant 面已有
        const genMs = new Date(meta.generatedAt).getTime();
        if (!Number.isFinite(genMs) || now - genMs < meta.staleAfterMs) continue;
        // stale 唤醒也吃 cooldown（防告警风暴）——窗口内不投
        const cdKey = staleTrig.source + '/' + staleTrig.view;
        const until = this.cooldownUntil.get(owner + '/' + entry.id)?.[cdKey] ?? 0;
        if (now < until) continue;
        void this.fireSource(owner, entry, staleTrig, { source: staleTrig.source, view: staleTrig.view, seq: meta.seq }).then((ok) => {
          if (!ok) return;
          const cur = this.cooldownUntil.get(owner + '/' + entry.id) ?? {};
          cur[cdKey] = now + (parseInterval(staleTrig.cooldown ?? '') ?? 30 * 60_000);
          this.cooldownUntil.set(owner + '/' + entry.id, cur);
        });
      }
    }
  }

  /**
   * 源投递（与时间触发共用 fire 链的门/记账/审计/until 语义）：手动
   * 组 FirePlan（cause 'source'）。投递成功即记账推进（lastFiredAt /
   * firedCount / until 终结）。
   */
  private async fireSource(owner: string, entry: TimerEntry, trig: SourceTrigger, ev: { source: string; view: string; seq: number }): Promise<boolean> {
    const key = owner + '/' + entry.id;
    const now = Date.now();
    const tz = this.tzOf(owner);
    // 门不命中的事件轮不投（事件丢弃，由下一物化接续——§三）；手动语义不适用
    if (!gatesPass(entry.gates, now, tz, this.resolverOf(owner))) return false;
    const plan: FirePlan = { due: now, trigger: trig, cause: 'source' };
    const ok = await this.dispatch(owner, entry, key);
    if (!ok) {
      this.retryDispatch(key, owner, entry, plan, false, () =>
        this.entriesByAgent.get(owner)?.some((e) => e.id === entry.id && e.enabled !== false) ?? false);
      return false;
    }
    this.lastError.delete(key);
    this.lastSkip.delete(key);
    const cur = this.persisted.get(key);
    const newCount = (cur?.firedCount ?? 0) + 1;
    this.persisted.set(key, { ...(cur ?? {}), firedCount: newCount, lastFiredAt: now });
    this.saveState();
    this.appendAudit(owner, entry, plan, now, ev.seq);
    if (untilReached(entry.until, newCount, now)) this.completeEntry(owner, entry, newCount, 'until');
    return true;
  }

  private syncHeartbeat(): void {
    const ctx = this.ctx;
    const need = this.schedules.size > 0;
    if (need && this.heartbeatDispose === undefined) {
      this.heartbeatDispose = this.ownInterval(() => {
        try {
          this.persisted.set('_heartbeat', { heartbeatAt: localISO(undefined, this.baseTz) });
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

  /** 触发器级 missed 策略：once 缺省 catchup-once，其余缺省 skip */
  private missedOf(entry: TimerEntry, t: TimeTrigger): 'skip' | 'catchup-once' {
    return entry.missed ?? (t.kind === 'once' ? 'catchup-once' : 'skip');
  }

  /**
   * 排程一条条目：catchup 候选（错过未投的最近刻，门命中）与下一刻候选
   * 取最小。无时间触发器（纯源）→ dormant；once 已过期且 skip → 归档；
   * after-last 链到期（下一刻在过去）→ 立即投。
   */
  private arm(owner: string, entry: TimerEntry): void {
    const key = `${owner}/${entry.id}`;
    this.cancel(key);
    if (entry.enabled === false) {
      // cr-1180：直接落盘/adopt 的停用条目（未经 save 翻转链）补 pausedAt——
      // boot reload 的 arm 调用点在这，启动装载即有停用记号（list 投影完整）。
      // 无记账记录也建（显示记号；armedAt 不写——从未武装，无快进基准可言）
      const ps = this.persisted.get(key);
      if (ps?.pausedAt === undefined) {
        this.persisted.set(key, { ...(ps ?? {}), pausedAt: Date.now() });
        this.saveState();
      }
      return;
    }
    const now = Date.now();
    const tz = this.tzOf(owner);
    // armedAt 落账（boot 首见即固定——catchup 下界与 after-last 锚）
    const ps = this.persisted.get(key);
    if (ps === undefined || ps.armedAt === undefined) {
      this.persisted.set(key, { ...(ps ?? {}), armedAt: now });
    }
    const state = this.persisted.get(key)!;
    const armed = state.armedAt!;
    const firedCount = state.firedCount ?? 0;
    const resolver = this.resolverOf(owner);

    // 终结判定（count 已满 / date 已过）→ 归档
    if (untilReached(entry.until, firedCount, now)) {
      this.completeEntry(owner, entry, firedCount, entry.until !== undefined ? 'until' : 'manual');
      return;
    }

    const deriveCtx = { tz, armedAt: armed, ...(state.lastFiredAt !== undefined ? { lastFiredAt: state.lastFiredAt } : {}) };
    let best: FirePlan | undefined;
    let hasSource = false;
    for (const t of entry.when) {
      if (!isTimeTrigger(t)) { hasSource = true; continue; }
      if (t.kind === 'once' && new Date(t.at).getTime() <= now) {
        // 过期 once：catchup 可补（下方 lastDue 分支）；无补即出局——nextGrid
        // 恒为过去值，排了就是无限重投（at > lastFired 已在 lastDue 判据挡掉）
        if (this.missedOf(entry, t) === 'skip') continue;
        if (lastDueMs(t, now, deriveCtx) === null) continue;
      }
      const due = lastDueMs(t, now, deriveCtx);
      if (due !== null && this.missedOf(entry, t) === 'catchup-once' && gatesPass(entry.gates, due, tz, resolver)) {
        const plan: FirePlan = { due, trigger: t, cause: 'catchup' };
        if (best === undefined || plan.due < best.due) best = plan;
      }
      const next = nextGridMs(t, now, deriveCtx);
      const plan: FirePlan = { due: next, trigger: t, cause: 'time' };
      if (best === undefined || plan.due < best.due) best = plan;
    }

    if (best === undefined) {
      if (hasSource) {
        // 纯源条目：源已物化（meta 在场）即活——事件/pull 驱动；源行缺席
        // → dormant（不报错，list 可见；源上线事件到达时 re-arm 解除）
        const anyLive = this.sourceTriggersOf(entry).some((t) =>
          readMeta(path.join(this.dataRoot, 'exports', t.source, t.view)) !== null);
        if (anyLive) { this.clearDormant(key); return; }
        this.setDormant(key, owner, 'source-unavailable');
        return;
      }
      // 时间触发器全部出局（过期 once 且 skip）→ 归档
      this.completeEntry(owner, entry, firedCount, 'expired');
      return;
    }
    this.clearDormant(key);
    // 时钟跳变检测：重算值与缓存偏差过大 → lastNote（缓存不承载排程语义）
    const cache = this.persisted.get(key)?.nextAtCache;
    if (best.cause === 'time' && cache !== undefined && Math.abs(cache - best.due) > CLOCK_JUMP_MS) {
      this.note(key, owner, 'nextAt 重算与上次缓存偏差超过 ' + Math.round(CLOCK_JUMP_MS / 60_000) + ' 分钟（' + new Date(cache).toISOString() + ' → ' + new Date(best.due).toISOString() + '）——疑似时钟跳变或条目被外部改写');
    }
    this.schedulePlan(key, owner, entry, best);
  }

  /** 挂一次投递（远期目标排中继刻度，到点重算不误投） */
  private schedulePlan(key: string, owner: string, entry: TimerEntry, plan: FirePlan): void {
    const wait = Math.max(plan.due - Date.now(), 0);
    const relay = wait > MAX_TIMEOUT_MS;
    const dispose = this.ownTimeout(() => {
      // 回调里任何异常都不得让链条静默断掉（cr-1228）：catch 后按退避重排，
      // 并记 warn——「fire 抛错 → 无 re-arm → 该条目永久停摆」是本次事故
      // 的同族风险面（fire 为 async，裸 void 调用会吞成 unhandled rejection）。
      const guard = (): void => {
        try {
          if (relay || Date.now() < plan.due - 1_000) {
            // 中继刻度或时钟回拨：尚未到点——重算排程
            this.arm(owner, entry);
            return;
          }
          void this.fire(owner, entry, plan, false).catch((err: unknown) => {
            this.ctx.logger.warn('[timers] ' + key + ' 投递链异常，退避重排：' + String(err));
            if (this.schedules.has(key)) return;
            this.schedules.set(key, this.ownTimeout(() => this.arm(owner, entry), BACKOFF_STEPS_MS[0]));
          });
        } catch (err) {
          this.ctx.logger.warn('[timers] ' + key + ' 排程回调异常：' + String(err));
        }
      };
      guard();
    }, Math.min(wait, MAX_TIMEOUT_MS));
    this.schedules.set(key, dispose);
    this.scheduledDue.set(key, plan);
    this.nextAtMs.set(key, plan.due);
    const cur = this.persisted.get(key);
    if (cur !== undefined) {
      this.persisted.set(key, { ...cur, nextAtCache: plan.due });
      this.saveState();
    }
    this.syncHeartbeat();
  }

  /**
   * 一次投递：门命中 → 邮局投递 → 记账/审计 → 终结判定 → 重排。
   * 投递失败走退避重试（at-least-once 由邮局 outbox 承担，此处防死循环）。
   */
  private async fire(owner: string, entry: TimerEntry, plan: FirePlan, manual: boolean): Promise<void> {
    const key = `${owner}/${entry.id}`;
    // 在途标记（cr-1228）：看门狗据此跳过正在跑的条目（否则会在投递窗口内
    // 抢着补排，导致同一刻度双投）。
    this.inFlight.add(key);
    try {
      await this.fireInner(owner, entry, plan, manual);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async fireInner(owner: string, entry: TimerEntry, plan: FirePlan, manual: boolean): Promise<void> {
    const key = `${owner}/${entry.id}`;
    this.schedules.delete(key);
    this.scheduledDue.delete(key);
    this.nextAtMs.delete(key);
    this.syncHeartbeat();
    const stillArmed = (): boolean => {
      const list = this.entriesByAgent.get(owner);
      return list !== undefined && list.some((e) => e.id === entry.id && e.enabled !== false);
    };
    if (!stillArmed()) return;
    const now = Date.now();
    const tz = this.tzOf(owner);
    const resolver = this.resolverOf(owner);
    const firedCount = this.persisted.get(key)?.firedCount ?? 0;

    // 门不命中：时间刻度直接跳过（不投递不计数）——重排下一刻
    if (!manual && !gatesPass(entry.gates, now, tz, resolver)) {
      const prev = this.lastSkip.get(key);
      const reason = 'gate';
      this.lastSkip.set(key, {
        at: localISO(new Date(now), tz),
        reason,
        streak: (prev?.reason === reason ? prev.streak : 0) + 1,
      });
      if (stillArmed()) this.arm(owner, entry);
      return;
    }

    // 投递（手动触发跳过会话存活门——诊断面语义）。cr-1228：包一层超时——
    // dispatch 内部含无超时的连接面（client.connect），挂死会让整条排程链
    // 永久悬停（无 audit / 无日志 / 进程存活），与本行其余静默面同型。
    const ok = await this.dispatchWithin(owner, entry, key);
    if (!ok) {
      this.retryDispatch(key, owner, entry, plan, manual, stillArmed);
      return;
    }
    this.lastError.delete(key);
    this.lastSkip.delete(key);
    const cur = this.persisted.get(key);
    const newCount = firedCount + 1;
    this.persisted.set(key, { ...(cur ?? {}), firedCount: newCount, lastFiredAt: now });
    this.saveState();
    this.appendAudit(owner, entry, plan, now);
    if (untilReached(entry.until, newCount, now)) {
      this.completeEntry(owner, entry, newCount, 'until');
      return;
    }
    if (stillArmed()) this.arm(owner, entry);
  }

  /** 投递失败处置：退避重试（连续 DISPATCH_STOP_STREAK 次停排 fail-loud） */
  private retryDispatch(key: string, owner: string, entry: TimerEntry, plan: FirePlan, manual: boolean, stillArmed: () => boolean): void {
    const prev = this.lastError.get(key);
    const streak = (prev?.streak ?? 0) + 1;
    this.lastError.set(key, { at: localISO(undefined, this.tzOf(owner)), message: '投递失败（邮局 dispatch 异常）', streak });
    this.ctx.logger.warn(`[timers] ${key} 投递失败（第 ${streak} 次）`);
    if (streak >= DISPATCH_STOP_STREAK) {
      this.ctx.logger.warn(`[timers] ${key} 连续 ${streak} 次投递失败——停排（fail-loud），修正后重新 save/重启恢复`);
      return;
    }
    if (!stillArmed()) return;
    const wait = BACKOFF_STEPS_MS[Math.min(streak - 1, BACKOFF_STEPS_MS.length - 1)];
    const dispose = this.ownTimeout(() => void this.fire(owner, entry, plan, manual), wait);
    this.schedules.set(key, dispose);
    this.syncHeartbeat();
  }

  /** 非致命提示：记诊断面 + 文本变化才曝光日志（同提示不刷屏） */
  private note(key: string, owner: string, text: string): void {
    if (this.lastNote.get(key)?.text === text) return;
    this.lastNote.set(key, { at: localISO(undefined, this.tzOf(owner)), text });
    this.ctx.logger.warn(`[timers] ${key} 提示：${text}`);
  }

  private setDormant(key: string, owner: string, reason: string): void {
    const cur = this.persisted.get(key);
    this.persisted.set(key, { ...(cur ?? {}), dormantReason: reason });
    this.saveState();
    this.note(key, owner, 'dormant：' + reason);
  }

  private clearDormant(key: string): void {
    const cur = this.persisted.get(key);
    if (cur?.dormantReason !== undefined) {
      const { dormantReason: _d, ...keep } = cur;
      this.persisted.set(key, keep);
    }
  }

  /** 条目记账单点清理（取消排程 + 清全量诊断/记账态——新增 Map 只改这里） */
  private forget(key: string): void {
    this.cancel(key);
    this.persisted.delete(key);
    this.lastSkip.delete(key);
    this.lastError.delete(key);
    this.lastNote.delete(key);
    this.cooldownUntil.delete(key);
  }

  private conversationAlive(entry: TimerEntry): boolean {
    const cid = entry.action.conversationId;
    if (!cid || cid.includes('~') || entry.action.task !== undefined) return true;
    for (const agentId of listAgentIds(this.dataRoot)) {
      if (fs.existsSync(path.join(this.dataRoot, 'agents', agentId, 'sessions', cid))) return true;
    }
    return false;
  }

  /** 有界投递（cr-1228）：超时按失败处置（走退避重试，不悬停） */
  private async dispatchWithin(owner: string, entry: TimerEntry, key: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.dispatchTimeoutMs);
    });
    try {
      return await Promise.race([this.dispatch(owner, entry, key), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 唤醒信投递（投递面 v2 原样：机制任务直调 / 邮局信封）；false = 失败 */
  private async dispatch(owner: string, entry: TimerEntry, key: string): Promise<boolean> {
    try {
      const action = entry.action;
      if (action.task) {
        if (action.task === 'archive-all') {
          const targets = listAgentIds(this.dataRoot)
            .map((id) => readAgentConfig(this.dataRoot, id))
            .filter((a): a is NonNullable<typeof a> => a !== null && !a.virtual && !isPresetId(a.id) && a.model !== undefined)
            .map((a) => a.id);
          for (const target of targets) {
            const env: Envelope = makeEnvelope({
              uuid: target + '~' + target,
              requestId: 't-' + issueRequestId(),
              sender: target,
              to: target,
              kind: 'message',
              budget: 1,
              payload: { text: '[archive-all] 批量归档唤醒：请对本域会话执行归档阈值检测与整理（archiveAll）。', mechTask: 'archive-all' },
            });
            await this.po.dispatch(env);
          }
          return true;
        }
        const backup = this.ctx.get('backup', false) as { run(opts?: { force?: boolean }): Promise<unknown> } | undefined;
        if (!backup) return true;
        await backup.run();
        return true;
      }
      if (!this.conversationAlive(entry)) {
        const prev = this.lastSkip.get(key);
        this.lastSkip.set(key, { at: localISO(undefined, this.tzOf(owner)), reason: 'conversation', streak: (prev?.reason === 'conversation' ? prev.streak : 0) + 1 });
        return true; // 会话消亡按已处置（不退避不重试）
      }
      const text = action.text;
      const targets =
        owner === GLOBAL_TIMER_OWNER
          ? (action.target || '*') === '*'
            ? listAgentIds(this.dataRoot)
                .map((id) => readAgentConfig(this.dataRoot, id))
                .filter((a): a is NonNullable<typeof a> => a !== null && !a.virtual && !isPresetId(a.id) && a.model !== undefined)
                .map((a) => a.id)
            : action.target!.split(',').map((t) => t.trim()).filter(Boolean)
          : [owner];
      for (const target of targets) {
        if (readAgentConfig(this.dataRoot, target) === null) continue;
        const convId = action.conversationId ?? `${target}~${target}`;
        const sender = action.conversationId ? 'user' : target;
        const env: Envelope = makeEnvelope({
          uuid: convId,
          requestId: 't-' + issueRequestId(),
          sender,
          to: target,
          kind: 'message',
          budget: 3,
          payload: { text },
        });
        await this.po.dispatch(env);
      }
      return true;
    } catch {
      // 投递异常 → 调用方退避重试
      return false;
    }
  }

  /** 审计行（滚动 jsonl：{at, owner, entryId, cause, trigger, seq?, target, budget}） */
  private appendAudit(owner: string, entry: TimerEntry, plan: FirePlan, at: number, seq?: number): void {
    try {
      let size = 0;
      try { size = fs.statSync(this.auditFile).size; } catch { /* 首件 */ }
      if (size > AUDIT_ROLL_BYTES) {
        try { fs.renameSync(this.auditFile, this.auditFile + '.old'); } catch { /* 无旧件 */ }
      }
      fs.mkdirSync(path.dirname(this.auditFile), { recursive: true });
      const target = owner === GLOBAL_TIMER_OWNER ? (entry.action.target ?? '*') : owner;
      fs.appendFileSync(this.auditFile, JSON.stringify({
        at: new Date(at).toISOString(),
        owner,
        entryId: entry.id,
        cause: plan.cause,
        trigger: plan.trigger.kind,
        ...(seq !== undefined ? { seq } : {}),
        target,
        budget: entry.action.task !== undefined ? 1 : 3,
      }) + '\n', 'utf-8');
    } catch {
      /* 审计写失败不影响投递 */
    }
  }

  private completeEntry(owner: string, entry: TimerEntry, firedCount: number, reason: string): void {
    const key = `${owner}/${entry.id}`;
    this.forget(key);
    this.saveState();
    const cached = this.entriesByAgent.get(owner);
    if (cached) {
      const idx = cached.findIndex((e) => e.id === entry.id);
      if (idx >= 0) cached.splice(idx, 1);
      if (cached.length === 0) this.entriesByAgent.delete(owner);
    }
    if (owner === GLOBAL_TIMER_OWNER) return;
    const stored = this.readStored(owner) ?? { version: 3, entries: [] };
    stored.entries = stored.entries.filter((e) => e.id !== entry.id);
    this.writeStored(owner, stored);
    const archive = this.readArchive(owner);
    archive.push({
      ...entry,
      // 归档状态随终结语义（cr-1171）：until/expired/manual = completed、
      // 用户撤销 = cancelled、迁移丢弃 = dropped（migrateLegacy 另路写）
      status: reason === 'cancelled' ? 'cancelled' : 'completed',
      reason,
      completedAt: localISO(undefined, this.tzOf(owner)),
      firedCount,
    });
    this.writeArchive(owner, archive);
  }

  private loadState(): void {
    try {
      const file = fs.existsSync(this.stateFile)
        ? this.stateFile
        : path.join(this.dataRoot, 'timer', 'state.json');
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, TimerPersistedState>;
        this.persisted = new Map(Object.entries(raw));
      }
    } catch {
      /* 状态损坏从空开始（nextAt 可重算——缓存语义，无损） */
    }
  }

  private saveState(): void {
    if (this.migrating) return; // 迁移中批量改记账，完毕后统一落盘
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
}

// ============================================================
// 全局简化形状归一（GlobalTimerHost UI 产出 {time,hint,targets} → v3）
// ============================================================

function isSimplifiedGlobalShape(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const r = e as Record<string, unknown>;
  return r.kind === undefined && r.mode === undefined && r.when === undefined && typeof r.time === 'string' && typeof r.hint === 'string';
}

const MECH_HINTS: Record<string, 'archive-all' | 'backup-all'> = {
  __archive_all__: 'archive-all',
  __backup_all__: 'backup-all',
};

function simplifiedToV3(e: { time: string; hint: string; targets?: string[]; builtin?: boolean }): TimerEntry {
  const hint = e.hint.trim();
  const targets = Array.isArray(e.targets) ? e.targets.filter((t): t is string => typeof t === 'string' && t !== '') : [];
  return {
    id: 'g-' + e.time + '-' + hint,
    enabled: true,
    when: [{ kind: 'daily', at: /^\d{1,2}:\d{2}$/.test(e.time) ? e.time.padStart(5, '0') : '09:00' }],
    action: {
      text: hint,
      ...(hint in MECH_HINTS ? { task: MECH_HINTS[hint] } : {}),
      ...(targets.length > 0 ? { target: targets.join(',') } : {}),
    },
  };
}

/** 宿主 timers 行工厂 */
export function makeTimersHostRow(options: TimersHostRowOptions): Plugin {
  return {
    name: 'host-timers-row',
    apply(ctx: Context) {
      ctx.plugin(class extends HostTimersService {
        constructor(c: Context) { super(c, options); }
      });
    },
  } satisfies Plugin;
}
