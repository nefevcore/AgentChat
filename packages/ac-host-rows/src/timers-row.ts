// ============================================================
// timers-row.ts —— 宿主 timers 行（cr-1147 脚本化重做：检测逻辑
// 下沉为可擦除 TS 判定脚本，宿主只剩 check/dispatch 极简循环）
//
// 保留面（资产不是债务）：agents/<id>/entries/timer.json 数据面、
//   agentsEdit 单写者口、邮局唤醒信投递（conversationId 烘焙/对角线缺省/
//   机制任务直调）、乐观并发 storedSnapshot（ISSUE-24）、诊断面、心跳。
// 换轨面：5 模式排程状态机（arm/fire/nextDelayOf/补偿三 case）→
//   runCheck（worker 求值）→ verdict 分派。旧条目 boot 时 compileEntry
//   一次性编译迁移（timer.json.bak 备份）。
// cr-1149：verdict 校验前移为 inspectVerdict 单源判据（与干跑同一份）——
//   类型不合法的轮整轮不处置 + 退避记账；可疑项（next 在过去等）记 lastNote
//   诊断面（同提示不刷屏）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { Service, type Context, type Plugin } from '@agentchat/cordis';
import { listAgentIds, readAgentConfig, settingsOf, isPresetId } from 'ac-agents-core';
import { DEFAULT_TZ } from 'ac-core-utils'; // 缺省时区基线（cr-1053 单源）
import { makeEnvelope, issueRequestId } from 'ac-envelope-core';
import type { Envelope } from 'ac-envelope-core';
import type { PostOffice } from 'ac-post-office';
import {
  CHECK_FLOOR_MS,
  compileEntry,
  createHolidayResolver,
  inspectVerdict,
  isLegacyEntryShape,
  localISO,
  makeTimerUtils,
  nextWaitMs,
  validateScriptEntries,
  type TimerCheckArgs,
  type TimerCheckVerdict,
  type TimerScriptEntry,
  type TimerUtils,
} from 'ac-timer-core';

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
  gateTimeoutMs?: number;
  /** 单次检测墙钟上限（缺省 30s；worker 超时杀——死循环防线） */
  checkWallMs?: number;
  agentsEdit?: EntriesEditFace;
}

/** 持久化运行时状态（meta/timer/state.json）。persistNextAt = 探测循环
 * 断点（verdict.next 的 ISO——重启 arm 直排未来值，不重跑脚本防风暴）。 */
interface TimerPersistedState {
  lastTriggeredAt?: string;
  executedCount?: number;
  scriptState?: unknown;
  persistNextAt?: string;
}

/** 完成条目归档记录 */
interface TimerArchiveRecord extends TimerScriptEntry {
  status: 'completed';
  completedAt: string;
  executedCount: number;
}

/** entries/timer.json 持久形态 */
interface TimerStoreEntry { entries: TimerScriptEntry[]; }

/** settings 分层形状 */
interface TimerLayerSettings {
  timezone?: string;
  holidays?: string[];
  makeupWorkdays?: string[];
}

/**
 * gate 预检结果（ISSUE-22 语义原样——gate 归位投递侧）：
 *   run = 0 放行 / silent = 1(空 stderr) 或 20 / error = 其它非零。
 */
type GateVerdict = 'run' | 'silent' | 'error';

/** gate 无歧义静默退出码 */
export const GATE_SILENT_EXIT = 20;

/** gate stderr 末行（截 400 字符） */
export function gateStderrTail(stderr: unknown): string {
  if (typeof stderr !== 'string') return '';
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  const last = lines[lines.length - 1];
  return last.length > 400 ? last.slice(0, 400) + '…' : last;
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

/** 错误退避阶梯（连续失败：1m → 5m → 30m → 30m…；CHECK_STOP_STREAK 次后停排） */
const BACKOFF_STEPS_MS = [60_000, 300_000, 1_800_000];
/** 连续错误停排阈值（fail-loud：诊断面 lastErrorAt + list 透出） */
const CHECK_STOP_STREAK = 5;
const GATE_TIMEOUT_MS = 30_000;
const CHECK_WALL_MS = 30_000;

// ============================================================
// check runner（worker containment——每检测即拉即弃）
// ============================================================

/** utilsConfig 形状（per-owner 配置随检测传 worker——makeTimerUtils 构造） */
export interface UtilsConfig {
  tz?: string;
  holidays?: string[];
  makeupWorkdays?: string[];
}

/** worker 求值一次检测脚本（dev 形态直跑 .ts；墙钟超时杀） */
function runCheckInWorker(code: string, args: TimerCheckArgs, utilsConfig: UtilsConfig, wallMs: number): Promise<{ ok: true; verdict: TimerCheckVerdict | undefined } | { ok: false; error: string; interrupted?: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { ok: true; verdict: TimerCheckVerdict | undefined } | { ok: false; error: string; interrupted?: boolean }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      try { worker.terminate(); } catch { /* 已退出 */ }
      resolve(r);
    };
    let worker: Worker;
    const entryUrl = new URL('./timer-check-worker.ts', import.meta.url);
    const STRIP_FLAG = '--experimental-strip-types';
    const noWarn = process.execArgv.includes('--no-warnings') ? process.execArgv : [...process.execArgv, '--no-warnings'];
    const execArgv = noWarn.includes(STRIP_FLAG) ? noWarn : [...noWarn, STRIP_FLAG];
    try {
      worker = new Worker(entryUrl, { execArgv });
    } catch (err: unknown) {
      resolve({ ok: false, error: '检测 worker 构造失败：' + (err instanceof Error ? err.message : String(err)) });
      return;
    }
    if (typeof worker.unref === 'function') worker.unref();
    const killTimer = setTimeout(() => {
      finish({ ok: false, error: `检测脚本墙钟超时（${wallMs}ms）——疑似死循环，已杀`, interrupted: true });
    }, wallMs);
    if (typeof killTimer.unref === 'function') killTimer.unref();
    const onMessage = (m: unknown): void => {
      if (typeof m !== 'object' || m === null) return;
      const r = m as { type?: string; ok?: boolean; verdict?: TimerCheckVerdict; error?: string; interrupted?: boolean };
      if (r.type === 'ready') {
        worker.postMessage({ type: 'init', code, args, utilsConfig });
        return;
      }
      if (r.type === 'done') {
        if (r.ok === true) finish({ ok: true, verdict: r.verdict });
        else finish({ ok: false, error: r.error ?? '检测脚本失败', interrupted: r.interrupted });
      }
    };
    worker.on('message', onMessage);
    worker.on('error', (err: Error) => finish({ ok: false, error: '检测 worker 异常：' + err.message }));
    worker.on('exit', (c: number) => {
      if (!settled) finish({ ok: false, error: `检测 worker 提前退出（code=${c}）` });
    });
  });
}

// ============================================================
// 宿主 timers 服务（check/dispatch 循环）
// ============================================================

export class HostTimersService extends Service {
  static inject = ['timer', 'config'];

  private readonly dataRoot: string;
  private readonly po: PostOffice;
  private readonly agentsEdit: EntriesEditFace | undefined;
  private readonly baseTz: string;
  private readonly heartbeatMs: number;
  private readonly gateTimeoutMs: number;
  private readonly checkWallMs: number;
  private stateFile: string;
  private entriesByAgent = new Map<string, TimerScriptEntry[]>();
  private schedules = new Map<string, () => void>();
  private heartbeatDispose?: () => void;
  private persisted = new Map<string, TimerPersistedState>();
  private nextAtMs = new Map<string, number>();
  private lastSkip = new Map<string, { at: string; reason: string; streak: number }>();
  private lastGateErrorAt = new Map<string, string>();
  private lastGateCode = new Map<string, number>();
  private lastGateCodeAt = new Map<string, string>();
  private lastError = new Map<string, { at: string; message: string; streak: number }>();
  /** verdict 非致命提示（next 在过去等，cr-1149）——同文本不重复记 */
  private lastNote = new Map<string, { at: string; text: string }>();
  private storedSnapshot = new Map<string, string>();
  private legacyGateNotice = new Set<string>();
  private migrating = false;

  constructor(ctx: Context, options: TimersHostRowOptions) {
    super(ctx, 'timers');
    this.dataRoot = path.resolve(options.dataRoot);
    this.po = options.postOffice;
    this.baseTz = options.timezone ?? DEFAULT_TZ;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.gateTimeoutMs = options.gateTimeoutMs ?? GATE_TIMEOUT_MS;
    this.checkWallMs = options.checkWallMs ?? CHECK_WALL_MS;
    this.agentsEdit = options.agentsEdit;
    this.stateFile = path.join(this.dataRoot, 'meta', 'timer', 'state.json');
    ctx.fiber.effect(() => () => this.stopAll(), 'host-timers.stop');
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
    if (via !== undefined) return finish(Array.isArray(via.entries) ? via : null);
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
    const globalSettings = this.configService()?.get<Record<string, unknown>>('agents.settings') ?? {};
    const s = settingsOf(globalSettings, agent?.settings, 'timers') as TimerLayerSettings | undefined;
    if (s && typeof s === 'object' && !Array.isArray(s)) return s;
    return {};
  }

  private tzOf(owner: string): string {
    const t = this.layerOf(owner).timezone;
    return typeof t === 'string' && t.trim() ? t.trim() : this.baseTz;
  }

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

  // ── 迁移（cr-1147：boot 时旧条目一次性编译） ──

  /**
   * 旧 5 模式条目 → 脚本条目（compileEntry 单源）。逐 owner：读盘 → 编译 →
   * 备份 timer.json.bak → 写回。已跑条目连续性：executedCount/lastTriggeredAt
   * 留在 meta/timer/state.json（key 不变——count 语义直译，无需转换）。
   * 全局条目（config timer.tasks）同形编译，落 config。
   */
  private migrateLegacy(): void {
    for (const agentId of listAgentIds(this.dataRoot)) {
      const file = path.join(this.dataRoot, 'agents', agentId, 'entries', 'timer.json');
      let raw: { entries?: unknown[] } | null = null;
      try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { entries?: unknown[] }; } catch { continue; }
      if (!Array.isArray(raw.entries)) continue;
      const hasLegacy = raw.entries.some((e) => isLegacyEntryShape(e));
      if (!hasLegacy) continue;
      // 迁移即换判定实现：旧 scriptState（若有 v1 残留 started 旗标）清空——
      // 编译产物首轮自带静默排期，旗标残留会导致迁移后立即触发。记账
      // （executedCount/lastTriggeredAt/persistNextAt）保留——count 连续性。
      for (const e of raw.entries) {
        if (isLegacyEntryShape(e)) {
          const k = agentId + '/' + e.id;
          const ps = this.persisted.get(k);
          if (ps !== undefined) {
            const { scriptState: _drop, ...keep } = ps;
            this.persisted.set(k, keep);
          }
        }
      }
      const compiled = raw.entries.map((e) =>
        isLegacyEntryShape(e) ? compileEntry(e) : (e as TimerScriptEntry),
      );
      try {
        fs.copyFileSync(file, file + '.bak');
        fs.writeFileSync(file, JSON.stringify({ entries: validateScriptEntries(compiled) }, null, 2), 'utf-8');
        this.ctx.logger.info('[timers] ' + agentId + ' 旧条目已迁移为脚本条目（' + compiled.length + ' 条，备份 timer.json.bak）');
      } catch (err: unknown) {
        this.ctx.logger.warn('[timers] ' + agentId + ' 迁移写盘失败：' + (err instanceof Error ? err.message : String(err)) + '——下次 boot 重试');
      }
    }
    const cfg = this.configService();
    const rawTasks = cfg?.get<unknown[]>('timer.tasks');
    if (Array.isArray(rawTasks) && rawTasks.some((e) => isLegacyEntryShape(e))) {
      const compiled = rawTasks.map((e) => (isLegacyEntryShape(e) ? compileEntry(e) : e)) as TimerScriptEntry[];
      cfg?.set('timer.tasks', validateScriptEntries(compiled));
      this.ctx.logger.info('[timers] 全局条目已迁移为脚本条目（' + compiled.length + ' 条）');
    }
  }

  // ── 装载/排程 ──

  /**
   * 重新加载全部条目 + 排程（启动/热重载共用）。脚本化后无停机补偿
   * case 分析：nextCheckAt 已过 = 立即跑一次检测，脚本看 args.last/
   * args.now 自决补触发还是跳下周期（补偿逻辑从宿主卸载）。
   */
  reload(): void {
    this.stopAll();
    this.loadState();
    this.entriesByAgent.clear();
    this.migrateLegacy();
    for (const agentId of listAgentIds(this.dataRoot)) {
      const stored = this.readStored(agentId);
      const enabled = stored?.entries.filter((e) => e.enabled !== false) ?? [];
      if (enabled.length > 0) this.entriesByAgent.set(agentId, enabled);
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
  }

  private configEntries(): TimerScriptEntry[] {
    const raw = this.configService()?.get<unknown>('timer.tasks');
    if (!Array.isArray(raw)) return [];
    const valid: TimerScriptEntry[] = [];
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue;
      const e = item as Record<string, unknown>;
      // 简化形状 {time, hint, targets}（GlobalTimerHost UI 产出）→ 旧条目 → 编译
      if (e.kind === undefined && typeof e.time === 'string' && typeof e.hint === 'string') {
        const MECH_HINTS: Record<string, 'archive-all' | 'backup-all'> = {
          __archive_all__: 'archive-all',
          __backup_all__: 'backup-all',
        };
        const hint = e.hint.trim();
        const legacy = {
          id: 'g-' + e.time + '-' + hint,
          enabled: true,
          mode: 'time' as const,
          time: e.time,
          hint,
          ...(hint in MECH_HINTS ? { task: MECH_HINTS[hint] } : {}),
          ...(Array.isArray(e.targets)
            ? { target: e.targets.filter((t): t is string => typeof t === 'string' && t !== '').join(',') || undefined }
            : {}),
        };
        valid.push(compileEntry(legacy));
        continue;
      }
      if (typeof e.id === 'string' && e.id !== '' && e.kind === 'script' && typeof e.code === 'string') {
        valid.push(e as unknown as TimerScriptEntry);
      }
    }
    return valid;
  }

  entries(owner: string): TimerScriptEntry[] {
    return [...(this.entriesByAgent.get(owner) ?? [])];
  }

  list(): Array<{ owner: string; entries: TimerScriptEntry[] }> {
    return [...this.entriesByAgent].map(([owner, entries]) => ({ owner, entries }));
  }

  /**
   * 排程态快照（诊断面——脚本型字段）。
   *
   * **时间字段一律用 owner 时区的带偏移 ISO**（`localISO`）：曾出现 `lastAt`
   * 带 `+08:00` 而 `nextAt` 是 UTC `Z`，直接字符串相减差 8 小时——消费方
   * （news 2026-11-17）据此差点把正常 30m 判成 7h30m 漂移。同类字段必须同格式，
   * 否则「能算但算错」比「不能算」更危险。
   *
   * 惰性字段（lastSkip* / lastGate* / lastError* / lastNote*）**只在事件发生后才
   * 出现**，且都是内存态（宿主重启即清空）。故「缺失」的含义是：本次启动以来
   * 未发生该事件——前提是 `listVersion` 已达到引入该字段的版本（见 timer-face）。
   */
  scheduleState(owner: string, entryId: string): {
    lastAt?: string;
    nextAt?: string;
    lastSkipAt?: string;
    lastSkipReason?: string;
    skipStreak?: number;
    lastGateErrorAt?: string;
    lastGateCode?: number;
    lastGateCodeAt?: string;
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
    const gateErr = this.lastGateErrorAt.get(key);
    const gateCode = this.lastGateCode.get(key);
    const gateCodeAt = this.lastGateCodeAt.get(key);
    const err = this.lastError.get(key);
    const note = this.lastNote.get(key);
    const tz = this.tzOf(owner);
    return {
      ...(ps?.lastTriggeredAt ? { lastAt: ps.lastTriggeredAt } : {}),
      ...(next !== undefined ? { nextAt: localISO(new Date(next), tz) } : {}),
      ...(skip ? { lastSkipAt: skip.at, lastSkipReason: skip.reason, skipStreak: skip.streak } : {}),
      ...(gateErr ? { lastGateErrorAt: gateErr } : {}),
      ...(gateCode !== undefined ? { lastGateCode: gateCode } : {}),
      ...(gateCodeAt ? { lastGateCodeAt: gateCodeAt } : {}),
      ...(err ? { lastErrorAt: err.at, lastError: err.message, errorStreak: err.streak } : {}),
      ...(note ? { lastNoteAt: note.at, lastNote: note.text } : {}),
      ...(ps?.executedCount !== undefined ? { triggeredCount: ps.executedCount } : {}),
    };
  }

  /**
   * 写回条目表并重排。seed = 新条目的首检初值（cr-1149 v2：set 时干跑即首检，
   * 其 state + next 直接落为记账/排程断点——arm 见未来断点直排，不再立即探测
   * 投递；「设置即投递」这条路径由此从宿主侧消除，不依赖脚本纪律）。
   */
  save(
    owner: string,
    entries: TimerScriptEntry[],
    seed?: Record<string, { state?: unknown; nextAt?: Date }>,
  ): { ok: boolean; error?: string } {
    const stored: TimerStoreEntry = { entries };
    if (owner === GLOBAL_TIMER_OWNER) {
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
      if (key.startsWith(`${owner}/`) && !valid.has(key)) this.forget(key);
    }
    if (seed !== undefined) {
      for (const [id, s] of Object.entries(seed)) {
        if (!valid.has(`${owner}/${id}`)) continue;
        if (!(s.nextAt instanceof Date) || isNaN(s.nextAt.getTime())) continue;
        this.persisted.set(`${owner}/${id}`, {
          ...(s.state !== undefined ? { scriptState: s.state } : {}),
          persistNextAt: s.nextAt.toISOString(),
        });
      }
    }
    this.saveState();
    for (const entry of enabled) this.arm(owner, entry);
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
    this.stopAgent(owner);
    const enabled = disk?.entries.filter((e) => e.enabled !== false) ?? [];
    this.storedSnapshot.set(owner, disk === null ? ABSENT : stableStringify(disk));
    if (enabled.length > 0) this.entriesByAgent.set(owner, enabled);
    else this.entriesByAgent.delete(owner);
    const valid = new Set(enabled.map((e) => `${owner}/${e.id}`));
    for (const key of this.persisted.keys()) {
      if (key.startsWith(`${owner}/`) && !valid.has(key)) this.forget(key);
    }
    this.saveState();
    for (const entry of enabled) this.arm(owner, entry);
  }

  /** 手动触发（测试/诊断；直接投递——不走脚本判定） */
  triggerNow(owner: string, entryId: string): boolean {
    const entry = this.entries(owner).find((e) => e.id === entryId);
    if (!entry) return false;
    void this.fireEntry(owner, entry);
    return true;
  }

  /**
   * 干跑检测（timer 工具 test / set 自检——不触发不排程）。校验与运行期同一份
   * 判据（inspectVerdict，cr-1149）：类型错误直接拒，可疑项经 notes 回话。
   */
  async dryRun(owner: string, code: string, state?: unknown): Promise<{ ok: true; verdict: TimerCheckVerdict; notes: string[] } | { ok: false; error: string }> {
    const args = this.checkArgsOf(owner, { id: 'dry-run', enabled: true, kind: 'script', code }, state);
    const r = await runCheckInWorker(code, args, this.utilsConfigOf(owner), this.checkWallMs);
    if (!r.ok) return { ok: false, error: r.error };
    const verdict = r.verdict;
    if (typeof verdict !== 'object') {
      return { ok: false, error: 'verdict 缺失（脚本须 return { action?, next?, state?, active? }）' };
    }
    const insp = inspectVerdict(verdict);
    if (insp.error !== undefined) return { ok: false, error: insp.error };
    return { ok: true, verdict, notes: insp.notes };
  }

  // ============================================================
  // check/dispatch 循环（排程引擎核心）
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

  /** 检测入参组装（宿主记账快照——纯数据四字段，零派生量） */
  private checkArgsOf(owner: string, entry: TimerScriptEntry, stateOverride?: unknown): TimerCheckArgs {
    const key = `${owner}/${entry.id}`;
    const ps = this.persisted.get(key);
    return {
      now: localISO(new Date(), this.tzOf(owner)),
      ...(ps?.lastTriggeredAt ? { last: ps.lastTriggeredAt } : {}),
      count: ps?.executedCount ?? 0,
      ...(stateOverride !== undefined ? { state: stateOverride } : (ps?.scriptState !== undefined ? { state: ps.scriptState } : {})),
    };
  }

  /** utils 构造配置（per-owner tz + 节假日——随检测传 worker） */
  private utilsConfigOf(owner: string): UtilsConfig {
    const s = this.layerOf(owner);
    return { tz: this.tzOf(owner), ...(Array.isArray(s.holidays) ? { holidays: s.holidays } : {}), ...(Array.isArray(s.makeupWorkdays) ? { makeupWorkdays: s.makeupWorkdays } : {}) };
  }

  /**
   * 排程一条条目。重启断点（persistNextAt）：未来值直接排（不跑脚本——
   * 防重启触发风暴）；过期/缺席立即首检（新条目首轮 verdict 定节奏；
   * 过期场景脚本看 args.last 自决补偿）。
   */
  private arm(owner: string, entry: TimerScriptEntry): void {
    const key = `${owner}/${entry.id}`;
    this.cancel(key);
    if (entry.enabled === false) return;
    const ps = this.persisted.get(key);
    const resume = ps?.persistNextAt !== undefined ? Date.now() - new Date(ps.persistNextAt).getTime() : NaN;
    const wait = Number.isFinite(resume) && resume < 0 ? -resume : 0; // 未来差值 = 直排；过期/缺席 = 立即检
    const dispose = this.ctx.timeout(() => void this.check(owner, entry, key), wait);
    this.schedules.set(key, dispose);
    this.nextAtMs.set(key, Date.now() + wait);
    this.syncHeartbeat();
  }

  /**
   * 一次检测：worker 求值脚本 → verdict 分派。错误退避（连续失败
   * 1m→5m→30m，CHECK_STOP_STREAK 次停排 fail-loud）；成功清 streak。
   */
  private async check(owner: string, entry: TimerScriptEntry, key: string): Promise<void> {
    this.schedules.delete(key);
    this.syncHeartbeat();
    const stillArmed = (): boolean => {
      const list = this.entriesByAgent.get(owner);
      return list !== undefined && list.some((e) => e.id === entry.id && e.enabled !== false);
    };
    const skip = (reason: string): void => {
      const prev = this.lastSkip.get(key);
      this.lastSkip.set(key, {
        at: localISO(undefined, this.tzOf(owner)),
        reason,
        streak: (prev?.reason === reason ? prev.streak : 0) + 1,
      });
    };
    const args = this.checkArgsOf(owner, entry);
    const r = await runCheckInWorker(entry.code, args, this.utilsConfigOf(owner), this.checkWallMs);
    if (!r.ok) {
      this.retryAfterError(key, owner, entry, r.error, stillArmed);
      return;
    }
    this.lastError.delete(key);
    const verdict = r.verdict;
    if (verdict === undefined) {
      this.retryAfterError(key, owner, entry, '脚本无返回值（须 return { action?, next?, state?, active? }）', stillArmed);
      return;
    }
    // 类型层校验（cr-1149）：与干跑同一份判据——不合法整轮不处置（fail-loud）
    const insp = inspectVerdict(verdict);
    if (insp.error !== undefined) {
      this.retryAfterError(key, owner, entry, insp.error, stillArmed);
      return;
    }
    if (insp.notes.length > 0) this.noteVerdict(key, owner, insp.notes);
    if (verdict.active === false) {
      const cur = this.persisted.get(key);
      const fired = verdict.action !== undefined && verdict.action !== '';
      this.persisted.set(key, {
        executedCount: (cur?.executedCount ?? 0) + (fired ? 1 : 0),
        ...(fired || cur?.lastTriggeredAt ? { lastTriggeredAt: localISO(undefined, this.tzOf(owner)) } : {}),
        ...(verdict.state !== undefined ? { scriptState: verdict.state } : {}),
      });
      this.saveState();
      if (fired) await this.fireEntry(owner, entry, key, verdict.action);
      this.completeEntry(owner, entry, (cur?.executedCount ?? 0) + (fired ? 1 : 0));
      return;
    }
    // 状态前置持久化：脚本产出即落盘（state + persistNextAt 断点）——gate
    // 跳过/会话消亡轮不丢记忆；重启直排未来值防风暴。后续仅投递记账覆盖。
    {
      const cur = this.persisted.get(key);
      this.persisted.set(key, {
        ...(cur ?? {}),
        ...(verdict.state !== undefined ? { scriptState: verdict.state } : {}),
        ...(verdict.next instanceof Date && !isNaN(verdict.next.getTime()) ? { persistNextAt: verdict.next.toISOString() } : {}),
      });
      this.saveState();
    }
    if (verdict.action !== undefined && verdict.action !== '') {
      if (entry.gate) {
        const gateResult = await this.runGate(key, owner, entry.gate);
        if (gateResult !== 'run') {
          const failOpen = gateResult === 'error' && entry.gateOnError === 'run';
          if (gateResult === 'error') this.lastGateErrorAt.set(key, localISO(undefined, this.tzOf(owner)));
          if (!failOpen) {
            skip(gateResult === 'error' ? 'gate-error' : 'gate');
            const gateNextMs = nextWaitMs(verdict.next) ?? BACKOFF_STEPS_MS[0];
            if (stillArmed()) this.scheduleCheck(key, owner, entry, gateNextMs);
            return;
          }
        }
      }
      if (!this.conversationAlive(entry)) {
        skip('conversation');
      } else {
        await this.fireEntry(owner, entry, key, verdict.action);
        const cur = this.persisted.get(key);
        this.persisted.set(key, {
          ...(cur ?? {}),
          executedCount: (cur?.executedCount ?? 0) + 1,
          lastTriggeredAt: localISO(undefined, this.tzOf(owner)),
        });
        this.saveState();
        this.lastSkip.delete(key);
      }
    }
    if (!stillArmed()) return;
    // next 已由 inspectVerdict 保证为 Date（active 轮必在）；nextWaitMs 只做地板钳制
    const nextMs = nextWaitMs(verdict.next);
    if (nextMs === null) {
      this.retryAfterError(key, owner, entry, 'verdict.next 无法排程：' + String(verdict.next), stillArmed);
      return;
    }
    this.scheduleCheck(key, owner, entry, nextMs);
  }

  /** 失败处置：记账 + 退避重排（连续 CHECK_STOP_STREAK 次停排 fail-loud） */
  private retryAfterError(key: string, owner: string, entry: TimerScriptEntry, message: string, stillArmed: () => boolean): void {
    const prev = this.lastError.get(key);
    const streak = (prev?.streak ?? 0) + 1;
    this.lastError.set(key, { at: localISO(undefined, this.tzOf(owner)), message, streak });
    this.ctx.logger.warn(`[timers] ${key} 检测失败（第 ${streak} 次）：${message}`);
    if (streak >= CHECK_STOP_STREAK) {
      this.ctx.logger.warn(`[timers] ${key} 连续 ${streak} 次失败——停排（fail-loud），修正脚本后重新 save/重启恢复`);
      return;
    }
    if (stillArmed()) this.scheduleCheck(key, owner, entry, BACKOFF_STEPS_MS[Math.min(streak - 1, BACKOFF_STEPS_MS.length - 1)]);
  }

  /** verdict 非致命提示：记诊断面 + 文本变化才曝光日志（同提示不刷屏） */
  private noteVerdict(key: string, owner: string, notes: string[]): void {
    const text = notes.join('；');
    if (this.lastNote.get(key)?.text === text) return;
    this.lastNote.set(key, { at: localISO(undefined, this.tzOf(owner)), text });
    this.ctx.logger.warn(`[timers] ${key} verdict 提示：${text}`);
  }

  /** 条目记账单点清理（取消排程 + 清全量诊断/记账态——新增 Map 只改这里） */
  private forget(key: string): void {
    this.cancel(key);
    this.persisted.delete(key);
    this.lastSkip.delete(key);
    this.lastGateErrorAt.delete(key);
    this.lastGateCode.delete(key);
    this.lastGateCodeAt.delete(key);
    this.lastError.delete(key);
    this.lastNote.delete(key);
  }

  /** 挂下次检测（地板钳制 CHECK_FLOOR_MS——防忙循环） */
  private scheduleCheck(key: string, owner: string, entry: TimerScriptEntry, ms: number): void {
    const wait = Math.max(ms, CHECK_FLOOR_MS);
    const dispose = this.ctx.timeout(() => void this.check(owner, entry, key), wait);
    this.schedules.set(key, dispose);
    this.nextAtMs.set(key, Date.now() + wait);
    this.syncHeartbeat();
  }

  private conversationAlive(entry: TimerScriptEntry): boolean {
    const cid = entry.conversationId;
    if (!cid || cid.includes('~') || entry.task !== undefined) return true;
    for (const agentId of listAgentIds(this.dataRoot)) {
      if (fs.existsSync(path.join(this.dataRoot, 'agents', agentId, 'sessions', cid))) return true;
    }
    return false;
  }

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
          ...(process.platform === 'win32' ? { windowsVerbatimArguments: true } : {}),
        },
        (err, _stdout, stderr) => {
          if (err === null) { resolve('run'); return; }
          if ((err as { killed?: boolean }).killed) { resolve('run'); return; }
          if (typeof err.code !== 'number') { resolve('run'); return; }
          const detail = gateStderrTail(stderr);
          this.lastGateCode.set(key, err.code);
          this.lastGateCodeAt.set(key, localISO(undefined, this.tzOf(owner)));
          if (err.code === GATE_SILENT_EXIT) { resolve('silent'); return; }
          if (err.code === 1) {
            if (detail === '') {
              if (!this.legacyGateNotice.has(key)) {
                this.legacyGateNotice.add(key);
                this.ctx.logger.info(
                  '[timers] ' + key + ' gate 用旧静默码 1（stderr 为空）——按预期静默处理；' +
                    '建议改用退出码 20：那样声明是明确的，不依赖平台推断',
                );
              }
              resolve('silent');
              return;
            }
            this.ctx.logger.warn(
              '[timers] ' + key + ' gate 退出码 1 但 stderr 非空（按崩溃处理，不当作「预期静默」）；stderr: ' + detail +
                '——若这是刻意的静默，请改用退出码 20 或保持 stderr 干净',
            );
            resolve('error');
            return;
          }
          this.ctx.logger.warn(
            '[timers] ' + key + ' gate 异常退出（code=' + String(err.code) + '；仅 0/1 有约定语义）' +
              (detail ? '；stderr: ' + detail : '') +
              '——按条目 gateOnError 处置（缺省跳过；run = 放行）',
          );
          resolve('error');
        },
      );
    });
  }

  private async fireEntry(owner: string, entry: TimerScriptEntry, key = `${owner}/${entry.id}`, action?: string): Promise<void> {
    try {
      if (entry.task) {
        if (entry.task === 'archive-all') {
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
          return;
        }
        const backup = this.ctx.get('backup', false) as { run(opts?: { force?: boolean }): Promise<unknown> } | undefined;
        if (!backup) return;
        await backup.run();
        return;
      }
      const text = action ?? entry.label ?? entry.id;
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
          payload: { text },
        });
        await this.po.dispatch(env);
      }
    } catch {
      // 投递失败不记账不重试（at-least-once 由邮局 outbox 承担）
    }
    void key;
  }

  private completeEntry(owner: string, entry: TimerScriptEntry, executedCount: number): void {
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
