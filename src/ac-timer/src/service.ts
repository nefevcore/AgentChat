// ============================================================
// ac-timer/src/service.ts —— 定时任务服务（ctx.timers）
//
// src svc/timer 的调度状态机半边（算法半边在 ac-timer-core 纯库）。
// preview 形态差异（地图 §3.2 落点）：
//   · 叠官方 cordis-timer：排程用 ctx.timeout/ctx.interval（fiber 归属，
//     随本服务卸载自动回收——不再手工管理 timeout 句柄生命周期）
//   · 条目持久化归 ac-agent-store（ADR-5：消灭 src 直写 config.json；
//     entry key 'timer'，完成条目归档 key 'timer-archive'）
//   · 触发 = ctx.conversation.deliver(sender:'event')：串行化门 +
//     next-turn 排队 + MAX_AUTO_WAKES 防自激（src trigger 语义的
//     preview 原语）；history 种子经 ctx.get('session') 可选探测
//   · 机制任务不过 LLM（规约 3）：entry.task = 'archive-all'/'backup-all'
//     直调 ctx.get 对应服务（淘汰 __archive_all__ 字符串协议）
//   · timer 状态文件模式原样继承（资产 #8）：临时文件+rename 原子写 /
//     30s 心跳 / 停机补偿（先记账后触发，防补偿+排程双重触发）
//
// 已知缩水：src 的 .runtime 单写者判定归宿主进程层（M13 supervisor）；
// per-entry maxSteps 不进信封（AgentConfig.maxSteps 统一管辖）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import type {} from '@agentchat/cordis-timer'; // ctx.timeout/interval（官方 timer mixin，组合根必装）
import type {} from 'ac-conversation'; // ctx.conversation 服务类型（type-only）
import {
  createHolidayResolver,
  describeEntry,
  localISO,
  msUntilTime,
  nextDelayOf,
  parseInterval,
  randomDelay,
  renderHint,
  type GlobalScheduleEntry,
  type TimerEntry,
} from 'ac-timer-core';
import type { LlmMessage } from 'ac-llm';

/** 全局条目 owner（sys.timer；target '*' = 全部非 virtual Agent） */
export const GLOBAL_TIMER_OWNER = '__global__';

/** 行配置 */
export interface TimerRowOptions {
  /** 数据根（缺省 './data'；状态文件 = <root>/timer/state.json） */
  root?: string;
  /** 时区（缺省 Asia/Shanghai；心跳/记账时间戳） */
  timezone?: string;
  /** 额外法定节假日（YYYY-MM-DD） */
  holidays?: string[];
  /** 调休工作日（YYYY-MM-DD） */
  makeupWorkdays?: string[];
  /** 全局定时条目（chime 兼容：times 或 tasks） */
  entries?: GlobalScheduleEntry[];
  /** 心跳间隔（缺省 30s；测试可调小） */
  heartbeatMs?: number;
}

/** 持久化运行时状态（停机补偿依据；'_' 前缀 = 内部键） */
interface TimerPersistedState {
  lastTriggeredAt?: string;
  executedCount?: number;
  startedAt?: string;
  totalDelayMs?: number;
}

/** 完成条目归档记录（entry key 'timer-archive' 的行形状） */
interface TimerArchiveRecord extends TimerEntry {
  status: 'completed';
  completedAt: string;
  executedCount: number;
}

/** agent-store 中 timer entry 的持久形态 */
interface TimerStoreEntry {
  entries: TimerEntry[];
}

/** settings['timers'] 配置形状（全局默认层 ∪ Agent 差异层；行 options = 基线） */
interface TimerLayerSettings {
  /** 日历条目（每天 HH:mm/周几/指定日）与记账时间戳所用 IANA 时区 */
  timezone?: string;
  /** 额外法定节假日（YYYY-MM-DD；数组整体替换） */
  holidays?: string[];
  /** 调休工作日（YYYY-MM-DD；优先于节假日判定） */
  makeupWorkdays?: string[];
}

const isDeferred = (mode: TimerEntry['mode']) => mode === 'delay' || mode === 'random';
const isCalendar = (mode: TimerEntry['mode']) => mode === 'time' || mode === 'workday' || mode === 'holiday';
const repeatOf = (entry: TimerEntry) =>
  entry.repeatCount !== undefined && entry.repeatCount !== null && entry.repeatCount > 0
    ? entry.repeatCount
    : -1;

export class TimersService extends Service {
  /**
   * 服务级依赖声明（构造期/排程闭包的 this.ctx 解析依据）：timer =
   * 官方 cordis-timer 的 ctx.timeout/ctx.interval（排程 + 心跳）。
   */
  static inject = ['timer', 'agents', 'agentStore', 'conversation', 'config'];

  private stateFile: string;
  private readonly tz: string;
  private readonly globalSchedule: GlobalScheduleEntry[];
  private readonly heartbeatMs: number;
  /** 行 options（timezone/holidays/makeupWorkdays 的基线层） */
  private readonly rowOptions: TimerRowOptions;
  /** owner → 条目清单（agent-store 物化 + 全局配置合成） */
  private entriesByAgent = new Map<string, TimerEntry[]>();
  /** key（owner/entryId）→ 排程句柄（dispose 即撤销） */
  private schedules = new Map<string, () => void>();
  /** 懒心跳句柄（有排程才存在） */
  private heartbeatDispose?: () => void;
  /** key → 持久化运行时状态（含 '_heartbeat' 内部键） */
  private persisted = new Map<string, TimerPersistedState>();

  constructor(ctx: Context, options: TimerRowOptions = {}) {
    super(ctx, 'timers');
    this.stateFile = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data', 'timer', 'state.json');
    this.tz = options.timezone ?? 'Asia/Shanghai';
    this.rowOptions = options;
    this.globalSchedule = options.entries ?? [];
    this.heartbeatMs = options.heartbeatMs ?? 30_000;

    // 卸载收尾：停全部排程（心跳 interval 随 fiber 自动回收）
    this.ctx.fiber.effect(
      () => () => this.stopAll(),
      'timers.stop',
    );

    this.reload();
  }

  // ============================================================
  // per-owner 生效层（settings['timers'] 分层：行 options 基线 → 全局
  // 默认层 → Agent 差异层；数组整体替换、差异层键优先——settingsOf 合成。
  // 全局条目 owner = GLOBAL_TIMER_OWNER（未知 id）→ 恒全局层）
  // ============================================================

  private layerOf(owner: string): TimerLayerSettings {
    try {
      const s = this.ctx.agents.settingsOf(owner, 'timers') as TimerLayerSettings | undefined;
      if (s && typeof s === 'object' && !Array.isArray(s)) return s;
    } catch {
      /* agents 服务不可达 → 基线层 */
    }
    return {};
  }

  /** owner 生效时区（日历排程 + 记账时间戳；缺省 Asia/Shanghai） */
  private tzOf(owner: string): string {
    const t = this.layerOf(owner).timezone;
    return typeof t === 'string' && t.trim() ? t.trim() : (this.rowOptions.timezone ?? this.tz);
  }

  /** owner 生效节假日判定器（holidays/makeupWorkdays 整体替换语义） */
  private holidaysOf(owner: string): ReturnType<typeof createHolidayResolver> {
    const s = this.layerOf(owner);
    return createHolidayResolver(
      {
        holidays: Array.isArray(s.holidays) ? s.holidays : (this.rowOptions.holidays ?? []),
        makeupWorkdays: Array.isArray(s.makeupWorkdays) ? s.makeupWorkdays : (this.rowOptions.makeupWorkdays ?? []),
      },
      this.tzOf(owner),
    );
  }

  /** 重新加载全部条目 + 补偿 + 排程（启动/热重载共用） */
  reload(): void {
    this.stopAll();
    this.loadState();
    this.entriesByAgent.clear();

    // 1) agent-store 条目（ADR-5：目录读取唯一合法通道）
    for (const agentId of this.ctx.agentStore.agentIds()) {
      const stored = this.ctx.agentStore.readEntry<TimerStoreEntry>(agentId, 'timer');
      const enabled = stored?.entries?.filter((e) => e.enabled !== false) ?? [];
      if (enabled.length > 0) this.entriesByAgent.set(agentId, enabled);
    }

    // 2) 全局条目 = row 配置 chime 条目（builtin 保护：设置面板只读，
    //    重启按配置复活）+ 运行时 config 'timer.tasks'（可编辑，全局配置所有）
    const globalEntries: TimerEntry[] = [
      ...this.globalSchedule.map((t) => ({
        id: `chime-${t.time}`,
        enabled: true,
        mode: 'time' as const,
        time: t.time,
        hint: t.hint ?? '',
        target: t.targets?.length ? t.targets.join(',') : '*',
        source: 'builtin',
      })),
      ...this.configEntries(),
    ];
    if (globalEntries.length > 0) this.entriesByAgent.set(GLOBAL_TIMER_OWNER, globalEntries);

    // 3) 清理无主持久化状态（条目已删；保留 '_' 内部键）
    const valid = new Set<string>();
    for (const [owner, entries] of this.entriesByAgent) {
      for (const e of entries) valid.add(`${owner}/${e.id}`);
    }
    for (const key of this.persisted.keys()) {
      if (!key.startsWith('_') && !valid.has(key)) this.persisted.delete(key);
    }
    this.saveState();

    // 4) 停机补偿（先记账后触发）→ 排程 → 心跳
    this.compensateMissedTriggers();
    for (const [owner, entries] of this.entriesByAgent) {
      for (const entry of entries) this.arm(owner, entry);
    }
    this.startHeartbeat();
    this.ctx.logger.info(
      '[timers] 已加载 %C 个 owner 的定时任务',
      String(this.entriesByAgent.size),
    );
  }

  // ============================================================
  // 查询与维护 API
  // ============================================================

  /**
   * 运行时全局条目（config 'timer.tasks'，设置面板 sys.timer 写口）。
   * 形状校验宽松降级：非法条目跳过并记日志（防脏配置拖垮排程）。
   */
  private configEntries(): TimerEntry[] {
    const raw = this.ctx.config.get<unknown>('timer.tasks');
    if (!Array.isArray(raw)) return [];
    const valid: TimerEntry[] = [];
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue;
      const e = item as Record<string, unknown>;
      if (
        typeof e.id === 'string' &&
        e.id !== '' &&
        (e.mode === 'time' || e.mode === 'delay' || e.mode === 'random' || e.mode === 'workday' || e.mode === 'holiday') &&
        typeof e.hint === 'string'
      ) {
        valid.push(e as unknown as TimerEntry);
      } else {
        this.ctx.logger.warn('[timers] config timer.tasks 含非法条目，跳过: %C', JSON.stringify(item));
      }
    }
    return valid;
  }

  /** 某 Agent 的条目（全局条目经 GLOBAL_TIMER_OWNER 查询） */
  entries(agentId: string): TimerEntry[] {
    return [...(this.entriesByAgent.get(agentId) ?? [])];
  }

  /** 全部 owner 的条目视图（诊断） */
  list(): Array<{ owner: string; entries: TimerEntry[] }> {
    return [...this.entriesByAgent].map(([owner, entries]) => ({ owner, entries }));
  }

  /**
   * 保存某 Agent 的条目（全量覆盖），并重排该 Agent 的全部条目。
   * 全局条目（GLOBAL_TIMER_OWNER）归全局配置所有：builtin（row 配置）
   * 不可写，其余落 config 'timer.tasks'（重启按配置复活）。
   */
  save(agentId: string, entries: TimerEntry[]): void {
    const stored: TimerStoreEntry = { entries };
    if (agentId === GLOBAL_TIMER_OWNER) {
      this.ctx.config.set('timer.tasks', entries.filter((e) => e.source !== 'builtin'));
    } else {
      this.ctx.agentStore.saveEntry(agentId, 'timer', stored);
    }
    this.stopAgent(agentId);
    const enabled = entries.filter((e) => e.enabled !== false);
    if (enabled.length > 0) this.entriesByAgent.set(agentId, enabled);
    else this.entriesByAgent.delete(agentId);
    // 清理不在新清单里的持久化状态
    const valid = new Set(enabled.map((e) => `${agentId}/${e.id}`));
    for (const key of this.persisted.keys()) {
      if (key.startsWith(`${agentId}/`) && !valid.has(key)) this.persisted.delete(key);
    }
    this.saveState();
    for (const entry of enabled) this.arm(agentId, entry);
  }

  /** 手动触发一次条目（测试/诊断；不记账） */
  triggerNow(agentId: string, entryId: string): boolean {
    const entry = this.entries(agentId).find((e) => e.id === entryId);
    if (!entry) return false;
    void this.fireEntry(agentId, entry);
    return true;
  }

  // ============================================================
  // 排程状态机（5 模式 × 一次性/限定次/永久）
  // ============================================================

  private cancel(key: string): void {
    const dispose = this.schedules.get(key);
    if (dispose) {
      dispose();
      this.schedules.delete(key);
    }
    this.syncHeartbeat();
  }

  private stopAgent(agentId: string): void {
    for (const key of [...this.schedules.keys()]) {
      if (key.startsWith(`${agentId}/`)) this.cancel(key);
    }
  }

  private stopAll(): void {
    for (const key of [...this.schedules.keys()]) this.cancel(key);
  }

  private startHeartbeat(): void {
    this.syncHeartbeat();
  }

  /**
   * 懒心跳：有排程才有心跳（空闲零定时器——boot 后无任务进程可自退；
   * 心跳是停机补偿的依据，只在有任务可补偿时才需要跳动）。
   */
  private syncHeartbeat(): void {
    const need = this.schedules.size > 0;
    if (need && !this.heartbeatDispose) {
      this.heartbeatDispose = this.ctx.interval(() => {
        try {
          this.persisted.set('_heartbeat', { lastTriggeredAt: localISO(undefined, this.tz) });
          this.saveState();
        } catch {
          /* 心跳写入失败不影响运行 */
        }
      }, this.heartbeatMs);
    } else if (!need && this.heartbeatDispose) {
      this.heartbeatDispose();
      this.heartbeatDispose = undefined;
    }
  }

  /** 排程一条条目（限定次/永久统一状态机） */
  private arm(owner: string, entry: TimerEntry): void {
    const key = `${owner}/${entry.id}`;
    this.cancel(key);
    if (entry.enabled === false) return; // 补偿路径完成记账后置禁用，防重复排程

    const ps = this.persisted.get(key);
    const tz = this.tzOf(owner); // per-owner 生效时区（日历排程 + 记账）
    let remaining = repeatOf(entry);
    if (remaining > 0 && ps?.executedCount) {
      remaining = Math.max(0, remaining - ps.executedCount);
      if (remaining <= 0) return; // 已执行完毕（残留防御）
    }

    let delayMs = nextDelayOf(entry, ps, Date.now(), tz);
    if (delayMs === null || (delayMs <= 0 && !isDeferred(entry.mode))) {
      // 过期一次性日历任务 → 自动归档（防僵尸条目永久驻留，src 语义）
      if (remaining > 0 && isCalendar(entry.mode)) {
        this.ctx.logger.warn('[timers] "%C" 已过期，自动归档', key);
        this.completeEntry(owner, entry, 0);
        return;
      }
      this.ctx.logger.warn('[timers] "%C" 延迟无效 (mode=%C)', key, entry.mode);
      return;
    }

    // 排程态持久化（delay/random 恢复依据；random 首次抽取即固化）
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

    let budget = remaining; // 剩余次数（-1 = 永久）；闭包内递减
    const scheduleNext = (ms: number | null): void => {
      if (ms === null) {
        this.ctx.logger.warn('[timers] "%C" 下次时刻不可解，停止排程', key);
        return;
      }
      const dispose = this.ctx.timeout(() => void fire(), ms);
      this.schedules.set(key, dispose);
      this.syncHeartbeat();
    };
    const fire = async () => {
      this.schedules.delete(key);
      this.syncHeartbeat(); // 一次性到点：先按无排程收敛（重排路径会重新拉起）
      // per-owner 生效层（热更友好：每次触发时重读——config/changed 后下一窗口生效）
      const tz = this.tzOf(owner);
      const holidays = this.holidaysOf(owner);
      const nextMs = () => (entry.time ? msUntilTime(entry.time, new Date(), tz) : null);
      // 日历门控：workday/holiday 非目标日 → 不触发不计数，重排下一窗口
      if (entry.mode === 'workday' && !holidays.isWorkday()) {
        scheduleNext(nextMs());
        return;
      }
      if (entry.mode === 'holiday' && !holidays.isHoliday()) {
        scheduleNext(nextMs());
        return;
      }

      await this.fireEntry(owner, entry, key);

      // 触发后记账：delay/random 重置 startedAt（下一周期全程），
      // random 抽取下一次延迟并固化（src persistAfterTrigger 语义）
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
          this.timersLogComplete(owner, entry, entry.repeatCount ?? executed);
          this.completeEntry(owner, entry, entry.repeatCount ?? executed);
          return;
        }
      }
      // 重排：日历重算目标时刻；delay/random 用 nextDelay
      if (isCalendar(entry.mode)) {
        scheduleNext(nextMs());
      } else {
        scheduleNext(nextDelay ?? 0);
      }
    };

    scheduleNext(delayMs);
    this.ctx.logger.info(
      '[timers] "%C" (%C, %C)',
      key,
      describeEntry(entry),
      budget < 0 ? '永久' : `${budget}次`,
    );
  }

  private timersLogComplete(owner: string, entry: TimerEntry, executed: number): void {
    this.ctx.logger.info('[timers] "%C/%C" 已完成 %C 次，归档', owner, entry.id, String(executed));
  }

  // ============================================================
  // 触发（agent run / 机制任务直调）
  // ============================================================

  private async fireEntry(owner: string, entry: TimerEntry, key = `${owner}/${entry.id}`): Promise<void> {
    try {
      // 机制任务：直调服务方法，不过 LLM（规约 3）
      if (entry.task) {
        if (entry.task === 'archive-all') {
          const archive = this.ctx.get('archive') as { archiveAll(): Promise<unknown> } | undefined;
          if (!archive) {
            this.ctx.logger.warn('[timers] archive-all：ac-archive 未装载，跳过');
            return;
          }
          const report = await archive.archiveAll();
          this.ctx.logger.info('[timers] 批量归档（archive-all）：%C', JSON.stringify(report));
        } else if (entry.task === 'backup-all') {
          const backup = this.ctx.get('backup') as { run(opts?: { force?: boolean }): Promise<unknown> } | undefined;
          if (!backup) {
            this.ctx.logger.warn('[timers] backup-all：ac-backup 未装载，跳过');
            return;
          }
          const result = await backup.run();
          this.ctx.logger.info('[timers] 数据备份（backup-all）：%C', JSON.stringify(result));
        }
        return;
      }

      // Agent run：source:'event' 信封投递（串行化门 + MAX_AUTO_WAKES）。
      // 经 ctx.get 取 conversation：root-traced 无限制——deliver 内部还要
      // 访问 router/agentLoop，受限 fiber 链（本服务 inject 表）解析不到。
      const conversation = this.ctx.get('conversation') as {
        deliver(
          agentId: string,
          inbound: string,
          options: { sender: string; source: 'event'; conversationId: string; history?: LlmMessage[] },
        ): Promise<unknown>;
      } | undefined;
      if (!conversation) {
        this.ctx.logger.warn('[timers] conversation 服务不可用，跳过触发');
        return;
      }
      const hint = renderHint(entry.hint, entry);
      const targets =
        owner === GLOBAL_TIMER_OWNER
          ? (entry.target || '*') === '*'
            // 预设 Agent 不参与 '*' 广播：__standard__ 等是独立会话的路由
            // 目标（UI 名册不显示、无协作语义）——打到它们只会产生无人消费
            // 的预设自会话桶（实测病灶：sessions/__standard__~__standard__）
            ? this.ctx.agents.list().filter((a) => !a.virtual && !a.preset && a.model).map((a) => a.id)
            : entry.target!.split(',').map((t) => t.trim()).filter(Boolean)
          : [owner];
      for (const target of targets) {
        if (!this.ctx.agents.has(target)) continue;
        // M19/D2：定时触发（个人自触发与全局条目同规）归 Agent 自会话桶
        // pairKey(target, target)（对角线）——sender = 目标自身（自会话
        // 语义），source='event'（机制触发）。与用户直答对桶
        // pairKey(viewer, target) 分离，定时自唤醒消息不混进用户对话流。
        const convId = `${target}~${target}`;
        const history = await this.seedHistory(convId, target);
        void conversation
          .deliver(target, hint, {
            sender: target,
            source: 'event',
            conversationId: convId,
            ...(history ? { history } : {}),
          })
          .catch((err: unknown) => {
            this.ctx.logger.error('[timers] "%C" → %C 投递失败: %C', key, target, String(err));
          });
      }
    } catch (err: unknown) {
      this.ctx.logger.error('[timers] 触发 "%C" 失败: %C', key, String(err));
    }
  }

  /** 会话历史种子（可选能力：ctx.get('session') 运行时探测）。
   *  viewer=目标 Agent（M21/D1）：自会话桶回放按读者投影 */
  private async seedHistory(convId: string, viewer: string): Promise<LlmMessage[] | undefined> {
    const session = this.ctx.get('session') as
      | { history(id: string, options?: { viewer?: string }): Promise<LlmMessage[]> }
      | undefined;
    if (!session) return undefined;
    try {
      return await session.history(convId, { viewer });
    } catch {
      return undefined;
    }
  }

  // ============================================================
  // 完成归档（agent-store 'timer-archive'）
  // ============================================================

  /** 条目完成：缓存移除 + store 摘除 + 归档记录（内存缓存与磁盘同步，src 教训） */
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
    if (owner === GLOBAL_TIMER_OWNER) return; // 全局条目归配置所有：仅摘运行时（重启按配置复活）

    const stored = this.ctx.agentStore.readEntry<TimerStoreEntry>(owner, 'timer') ?? { entries: [] };
    stored.entries = stored.entries.filter((e) => e.id !== entry.id);
    this.ctx.agentStore.saveEntry(owner, 'timer', stored);
    const archive = this.ctx.agentStore.readEntry<TimerArchiveRecord[]>(owner, 'timer-archive') ?? [];
    archive.push({
      ...entry,
      enabled: entry.enabled,
      status: 'completed',
      completedAt: localISO(undefined, this.tzOf(owner)),
      executedCount,
    });
    this.ctx.agentStore.saveEntry(owner, 'timer-archive', archive);
  }

  // ============================================================
  // 状态文件（原子写 + 停机补偿）
  // ============================================================

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8')) as Record<
          string,
          TimerPersistedState
        >;
        this.persisted = new Map(Object.entries(raw));
      }
    } catch (err: unknown) {
      this.ctx.logger.warn('[timers] 加载状态失败: %C', String(err));
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
    } catch (err: unknown) {
      this.ctx.logger.warn('[timers] 保存状态失败: %C', String(err));
    }
  }

  /**
   * 补偿停机期间应触发但未触发的任务（src compensateMissedTriggers
   * 核心三case 原样；legacy 无 totalDelayMs 的 random 状态不迁）。
   * 心跳缺失/停机 < 5min 不补偿。先记账后触发：紧随的排程按新状态
   * 计算，避免补偿+排程双重触发。
   */
  private compensateMissedTriggers(): void {
    const heartbeat = this.persisted.get('_heartbeat');
    if (!heartbeat?.lastTriggeredAt) return;
    const lastHeartbeat = new Date(heartbeat.lastTriggeredAt).getTime();
    const now = Date.now();
    if (now - lastHeartbeat < 5 * 60_000) return;

    this.ctx.logger.info(
      '[timers] 检测到停机 %C 分钟，检查补偿...',
      String(((now - lastHeartbeat) / 60000).toFixed(1)),
    );

    for (const [owner, entries] of this.entriesByAgent) {
      for (const entry of entries) {
        const key = `${owner}/${entry.id}`;
        const ps = this.persisted.get(key);
        if (!ps?.startedAt || ps.totalDelayMs == null) continue;
        const expected = new Date(ps.startedAt).getTime() + ps.totalDelayMs;
        if (!(expected <= now && expected > lastHeartbeat)) {
          // 周期补偿：已触发过的 delay/random 按周期数补（上限 3 或剩余次数）
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
          // 一次性任务：先完成记账（禁用+归档）再触发，防排程重复
          this.ctx.logger.info('[timers] 补偿一次性任务 "%C"', key);
          entry.enabled = false;
          this.completeEntry(owner, entry, 1);
          void this.fireEntry(owner, entry, key);
          continue;
        }

        if (isDeferred(entry.mode) && !ps.lastTriggeredAt) {
          // 首次触发补偿：记账置为当前，排程按新 startedAt 走完整延迟
          this.ctx.logger.info('[timers] 补偿首次触发 "%C"', key);
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
    const stored = this.ctx.agentStore.readEntry<TimerStoreEntry>(owner, 'timer');
    if (!stored?.entries) return;
    const target = stored.entries.find((e) => e.id === entry.id);
    if (target) {
      target.enabled = false;
      this.ctx.agentStore.saveEntry(owner, 'timer', stored);
    }
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 定时任务服务（ac-timer 提供）：5 模式调度 + 停机补偿 + 机制任务直调 */
    timers: TimersService;
  }
}
