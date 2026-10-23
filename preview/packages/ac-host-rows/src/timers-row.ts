// ============================================================
// timers-row.ts —— 宿主 timers 行（cr-539：R1 timers 行「定时唤醒
//（唤醒 = 投递信）」preview 落地——A13 持久唤醒恒宿主投递信）
//
// 主线 src/ac-timer TimersService 排程状态机语义照搬（D10 机制照搬）：
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
import { listAgentIds, readAgentConfig, settingsOf } from 'ac-agents-core';

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
  describeEntry,
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

/**
 * 定时条目形状校验（timer/save 入站；非法抛错——防脏配置落盘）。
 * 主线 ac-web-api 的 validateTimerEntries 同源平移（宿主 timers 行 = owning）。
 */
export function validateTimerEntries(raw: unknown): TimerEntry[] {
  if (!Array.isArray(raw)) throw new Error('参数 entries 须为 TimerEntry 数组');
  return raw.map((item, i) => {
    if (item === null || typeof item !== 'object') throw new Error('entries[' + i + '] 非对象');
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.id === '') throw new Error('entries[' + i + '].id 缺失');
    if (e.mode !== 'time' && e.mode !== 'delay' && e.mode !== 'random' && e.mode !== 'workday' && e.mode !== 'holiday') {
      throw new Error('entries[' + i + '].mode 非法（' + String(e.mode) + '）');
    }
    if (typeof e.hint !== 'string') throw new Error('entries[' + i + '].hint 须为字符串');
    if (e.enabled !== undefined && typeof e.enabled !== 'boolean') throw new Error('entries[' + i + '].enabled 须为 boolean');
    if (e.conversationId !== undefined && (typeof e.conversationId !== 'string' || !e.conversationId)) {
      throw new Error('entries[' + i + '].conversationId 须为非空字符串');
    }
    return e as unknown as TimerEntry;
  });
}

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

  constructor(ctx: Context, options: TimersHostRowOptions) {
    super(ctx, 'timers');
    this.dataRoot = path.resolve(options.dataRoot);
    this.po = options.postOffice;
    this.baseTz = options.timezone ?? 'Asia/Shanghai';
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.gateTimeoutMs = options.gateTimeoutMs ?? GATE_TIMEOUT_MS;
    this.agentsEdit = options.agentsEdit;
    this.stateFile = path.join(this.dataRoot, 'timer', 'state.json');
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

  /** entries/<owner>/timer.json 直读（agentStore 换轨——缺席 = null） */
  private readStored(owner: string): TimerStoreEntry | null {
    if (owner === GLOBAL_TIMER_OWNER) return null;
    const via = this.agentsEdit?.readEntry<TimerStoreEntry>(owner, 'timer');
    if (via !== undefined) return Array.isArray(via.entries) ? via : null;
    try {
      const file = path.join(this.dataRoot, 'agents', owner, 'entries', 'timer.json');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as TimerStoreEntry;
      return Array.isArray(parsed.entries) ? parsed : null;
    } catch {
      return null; }
  }

  /** entries/<owner>/timer.json 原子写（cr-551 单写者：编辑面在场走 saveEntry） */
  private writeStored(owner: string, stored: TimerStoreEntry): void {
    if (owner === GLOBAL_TIMER_OWNER) return;
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
      if (!key.startsWith('_') && !valid.has(key)) this.persisted.delete(key);
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

  /** 保存某 owner 条目（全量覆盖）+ 重排；全局条目落 config */
  save(owner: string, entries: TimerEntry[]): void {
    const stored: TimerStoreEntry = { entries };
    if (owner === GLOBAL_TIMER_OWNER) {
      this.configService()?.set('timer.tasks', entries);
    } else {
      this.writeStored(owner, stored);
    }
    this.stopAgent(owner);
    const enabled = entries.filter((e) => e.enabled !== false);
    if (enabled.length > 0) this.entriesByAgent.set(owner, enabled);
    else this.entriesByAgent.delete(owner);
    const valid = new Set(enabled.map((e) => `${owner}/${e.id}`));
    for (const key of this.persisted.keys()) {
      if (key.startsWith(`${owner}/`) && !valid.has(key)) this.persisted.delete(key);
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
      this.persisted.set(key, {
        executedCount: ps?.executedCount ?? 0,
        ...(ps?.lastTriggeredAt ? { lastTriggeredAt: ps.lastTriggeredAt } : {}),
        startedAt: localISO(undefined, tz),
        totalDelayMs,
      });
      this.saveState();
    }

    let budget = remaining;
    const scheduleNext = (ms: number | null): void => {
      if (ms === null) return;
      const dispose = ctx.timeout(() => void fire(), ms);
      this.schedules.set(key, dispose);
      this.syncHeartbeat();
    };
    const fire = async () => {
      this.schedules.delete(key);
      this.syncHeartbeat();
      const stillArmed = () => {
        const list = this.entriesByAgent.get(owner);
        return list !== undefined && list.some((e) => e.id === entry.id && e.enabled !== false);
      };
      const tz = this.tzOf(owner);
      const holidays = this.holidaysOf(owner);
      const nextMs = () => (entry.time ? msUntilTime(entry.time, new Date(), tz) : null);
      const nextCycleDelay = () =>
        isCalendar(entry.mode)
          ? nextMs()
          : entry.mode === 'delay' ? (parseInterval(entry.delay ?? '') ?? 0) : randomDelay(entry.delayMin, entry.delayMax);
      // 目标会话消亡门控：preview 形态无 singles/group 注册表——键形判据
      //（对桶含 ~ 恒存活）+ 端点在册判定（agent 在场 = 会话可投）
      if (!this.conversationAlive(entry)) {
        if (stillArmed()) scheduleNext(nextCycleDelay());
        return;
      }
      if (entry.mode === 'workday' && !holidays.isWorkday()) {
        if (stillArmed()) scheduleNext(nextMs());
        return;
      }
      if (entry.mode === 'holiday' && !holidays.isHoliday()) {
        if (stillArmed()) scheduleNext(nextMs());
        return;
      }
      if (entry.activeHours && !withinActiveHours(entry.activeHours, new Date(), tz)) {
        if (stillArmed()) scheduleNext(nextCycleDelay());
        return;
      }
      if (entry.gate && !(await this.runGate(key, owner, entry.gate))) {
        if (stillArmed()) scheduleNext(nextCycleDelay());
        return;
      }

      await this.fireEntry(owner, entry, key);

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
        scheduleNext(nextDelay ?? 0);
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
   * cwd = 数据根（preview 形态：无 workspace 行，gate 命令锚定数据根）。 */
  private runGate(key: string, owner: string, command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      execFile(
isWin ? 'cmd.exe' : '/bin/sh',
isWin ? ['/d', '/s', '/c', command] : ['-c', command],
        { timeout: this.gateTimeoutMs, windowsHide: true, cwd: this.dataRoot },
        (err) => {
          if (err === null) {
            resolve(true);
            return;
          }
          if ((err as { killed?: boolean }).killed) {
            resolve(true);
            return;
          }
          if (typeof err.code !== 'number') {
            resolve(true);
            return;
          }
          void owner;
          resolve(false);
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
            .filter((a): a is NonNullable<typeof a> => a !== null && !a.virtual && !a.preset && a.model !== undefined)
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
                .filter((a): a is NonNullable<typeof a> => a !== null && !a.virtual && !a.preset && a.model !== undefined)
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
      if (fs.existsSync(this.stateFile)) {
        const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8')) as Record<string, TimerPersistedState>;
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
    inject: [],
    apply(ctx: Context) {
      ctx.plugin(class extends HostTimersService {
        constructor(c: Context) { super(c, options); }
      });
    },
  } satisfies Plugin;
}