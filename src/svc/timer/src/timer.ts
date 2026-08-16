// ============================================================
// src/plugins/builtin/services/timer.ts —— 定时任务管理器（照搬旧 mod src/timer）
//
// 适配新架构：
//   · getGlobalConfig()（已删）→ 构造注入 TimerOptions（agentsDir/workspaceDir/
//     timezone/holidays/makeupWorkdays/全局 timer 配置）
//   · logger → createLogger（src/core）
//   · TimerEntry/TimerConfig/GlobalTimerConfig/GlobalScheduleEntry 类型内联到本文件
//   · 动态 import L4/L5 服务（archive/backup）→ 注入回调 archiveAll/backupAll
//   · 单例由 L5 bootstrap 装配（不再模块级全局单例，导出类 + 工厂）
//
// 依赖方向：仅依赖 src/core + @agents/router 类型 + Node 内置 + chinese-lunar。
// ============================================================

import type { AgentRouter } from '@agentchat/router';
import { createLogger } from '@agentchat/util';
import * as path from 'path';
import * as fs from 'fs';
import * as lunar from 'chinese-lunar';

const logger = createLogger('[TimerManager]');

/** 判断进程是否存活（PID 复用为已知残余风险，锁内附 startedAt 供人工排查） */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM = 进程存在但无权限；ESRCH = 进程不存在
    return err?.code === 'EPERM';
  }
}

// ============================================================
// 类型（内联自旧 @core/types，随服务走）
// ============================================================

/** 定时任务条目 */
export interface TimerEntry {
  id: string;
  enabled: boolean;
  mode: 'time' | 'delay' | 'random' | 'workday' | 'holiday';
  time?: string;
  delay?: string;
  delayMin?: string;
  delayMax?: string;
  repeatCount?: number;
  hint: string;
  target?: string;
  source?: string;
  maxSteps?: number;
}

/** Agent 的定时任务配置（config.json 的 timer 命名空间） */
export interface TimerConfig {
  entries: TimerEntry[];
}

/** 全局定时任务条目 */
export interface GlobalScheduleEntry {
  time: string;
  hint?: string;
  targets?: string[];
}

/** 全局定时任务配置（兼容旧 chime） */
export interface GlobalTimerConfig {
  enabled?: boolean;
  times?: string[];
  tasks?: GlobalScheduleEntry[];
  defaultHint?: string;
}

/** 服务配置（L5 bootstrap 注入，替代 getGlobalConfig） */
export interface TimerOptions {
  /** 工作区根（timer-state.json 所在） */
  workspaceDir: string;
  /** Agent 配置目录（扫描 config.json 的 timer 命名空间） */
  agentsDir: string;
  /** 时区（默认 Asia/Shanghai） */
  timezone?: string;
  /** 额外法定节假日（YYYY-MM-DD） */
  holidays?: string[];
  /** 调休工作日（YYYY-MM-DD） */
  makeupWorkdays?: string[];
  /** 全局定时任务配置（键 timer / chime） */
  globalTimer?: GlobalTimerConfig;
  /** 特殊 hint __archive_all__ 回调（L5 装配注入；缺省禁用） */
  archiveAll?: () => { length: number };
  /** 特殊 hint __backup_all__ 回调（L5 装配注入；缺省禁用） */
  backupAll?: () => { skipped: boolean; file?: string; size?: number };
}

// ============================================================
// 时区 / 时间工具（照搬旧）
// ============================================================

/** 返回指定时区的 ISO 格式时间字符串 */
function localISO(date?: Date, tz?: string): string {
  const d = date ?? new Date();
  const timezone = tz || 'Asia/Shanghai';

  try {
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(d);

    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
    const dateStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;

    const utcStr = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const utcGet = (type: string) => utcStr.find(p => p.type === type)?.value ?? '00';
    const utcTime = new Date(`${utcGet('year')}-${utcGet('month')}-${utcGet('day')}T${utcGet('hour')}:${utcGet('minute')}:${utcGet('second')}Z`);
    const localTime = new Date(`${dateStr}+00:00`);
    const offsetMin = Math.round((localTime.getTime() - utcTime.getTime()) / 60000);
    const sign = offsetMin >= 0 ? '+' : '-';
    const absMin = Math.abs(offsetMin);
    const offH = String(Math.floor(absMin / 60)).padStart(2, '0');
    const offM = String(absMin % 60).padStart(2, '0');

    return `${dateStr}${sign}${offH}:${offM}`;
  } catch {
    // 降级：硬编码 UTC+8
  }

  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const y = bj.getUTCFullYear();
  const mo = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const da = String(bj.getUTCDate()).padStart(2, '0');
  const h = String(bj.getUTCHours()).padStart(2, '0');
  const mi = String(bj.getUTCMinutes()).padStart(2, '0');
  const s = String(bj.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${da}T${h}:${mi}:${s}+08:00`;
}

/** 解析间隔字符串为毫秒数（0s/5m/1h/2h30m） */
export function parseInterval(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;

  const regex = /(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hour|hours|d|day|days)/g;
  let total = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(s)) !== null) {
    const value = parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
      case 's': case 'sec': case 'second': case 'seconds': total += value * 1000; break;
      case 'm': case 'min': case 'minute': case 'minutes': total += value * 60 * 1000; break;
      case 'h': case 'hour': case 'hours': total += value * 60 * 60 * 1000; break;
      case 'd': case 'day': case 'days': total += value * 24 * 60 * 60 * 1000; break;
    }
  }

  return total > 0 ? total : null;
}

/**
 * 计算到目标时间的毫秒数。
 * 支持：HH:mm（每天）、YYYY-MM-DDTHH:mm / YYYY-MM-DD HH:mm（指定）、Sun 12:00 / 周日 12:00。
 */
function msUntilTime(timeStr: string): number | null {
  const s = timeStr.trim();

  const fullMatch = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2})$/);
  if (fullMatch) {
    const target = new Date(fullMatch[1] + 'T' + fullMatch[2]);
    if (isNaN(target.getTime())) return null;
    const ms = target.getTime() - Date.now();
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

    const now = new Date();
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
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

/** 判断是否为完整日期时间（非每日 HH:mm 格式） */
function isFullDatetime(timeStr: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(timeStr.trim());
}

/** 星期几英文缩写 → 中文 */
const WEEKDAY_CN: Record<string, string> = {
  sun: '周日', mon: '周一', tue: '周二', wed: '周三', thu: '周四', fri: '周五', sat: '周六',
};

/** 判断是否为星期几格式（如 Sun 12:00、周一 09:00） */
function isWeekdayTime(timeStr: string): boolean {
  return /^[A-Za-z\u4e00-\u9fff]+\s+\d{1,2}:\d{2}$/.test(timeStr.trim());
}

/** 格式化星期几时间为中文显示 */
function formatWeekdayLabel(timeStr: string): string {
  const m = timeStr.trim().match(/^([A-Za-z\u4e00-\u9fff]+)\s+(\d{1,2}:\d{2})$/);
  if (!m) return timeStr;
  const wd = WEEKDAY_CN[m[1]] ?? WEEKDAY_CN[m[1].toLowerCase()] ?? m[1];
  return `每${wd} ${m[2]}`;
}

interface TimerState {
  timeout: NodeJS.Timeout;
  remaining: number;
}

/** 持久化的定时器运行时状态（用于重启恢复） */
interface TimerPersistedState {
  lastTriggeredAt?: string;
  executedCount?: number;
  startedAt?: string;
  totalDelayMs?: number;
}

// ============================================================
// 节假日判断（基于 chinese-lunar + 固定列表 + 配置覆盖）
// ============================================================

const HOLIDAYS = new Set<string>([]);
const MAKEUP_WORKDAYS = new Set<string>([]);

/** 判断是否为节假日（调休工作日优先，其次固定列表/农历/阳历/周末） */
function isHoliday(): boolean {
  const now = new Date();
  const today = formatDate(now);

  if (MAKEUP_WORKDAYS.has(today)) return false;
  if (HOLIDAYS.has(today)) return true;
  if (isLunarHoliday(now)) return true;
  if (isSolarHoliday(now)) return true;

  const d = now.getDay();
  return d === 0 || d === 6;
}

function isWorkday(): boolean { return !isHoliday(); }

/** 农历节日：春节、端午、中秋 */
function isLunarHoliday(date: Date): boolean {
  try {
    const l = lunar.solarToLunar(date);
    if (l.month === 1 && l.day >= 28 && l.day <= 30) return true;
    if (l.month === 1 && l.day >= 1 && l.day <= 7) return true;
    if (l.month === 5 && l.day >= 3 && l.day <= 5) return true;
    if (l.month === 8 && l.day >= 14 && l.day <= 16) return true;
  } catch { /* lunar conversion failed */ }
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

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ============================================================
// TimerManager
// ============================================================

export class TimerManager {
  private static readonly GLOBAL_AGENT_ID = '__global__';

  private router: AgentRouter | null = null;
  private timers: Map<string, TimerState> = new Map();
  private entries: Map<string, TimerEntry[]> = new Map();
  private persistedState: Map<string, TimerPersistedState> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lockHeld = false;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly agentsDir: string;
  private readonly tz: string;
  private readonly archiveAll?: () => { length: number };
  private readonly backupAll?: () => { skipped: boolean; file?: string; size?: number };
  private readonly globalTimerConfig?: GlobalTimerConfig;

  constructor(options: TimerOptions) {
    this.statePath = path.join(options.workspaceDir, 'timer-state.json');
    this.lockPath = path.join(options.workspaceDir, 'timer-instance.lock');
    this.agentsDir = options.agentsDir;
    this.tz = options.timezone || 'Asia/Shanghai';
    this.archiveAll = options.archiveAll;
    this.backupAll = options.backupAll;
    this.globalTimerConfig = options.globalTimer;

    // 配置覆盖节假日/调休
    for (const d of options.holidays ?? []) HOLIDAYS.add(d);
    for (const d of options.makeupWorkdays ?? []) MAKEUP_WORKDAYS.add(d);

    // 全局定时任务配置（reloadAll 会清空重载，因此抽成可重复调用的注册方法）
    this.registerGlobalEntries();
  }

  /** 注册全局定时条目（构造时 + reloadAll 重载时各调用一次） */
  private registerGlobalEntries(): void {
    const globalCfg = this.globalTimerConfig;
    if (!globalCfg) return;
    const times = globalCfg.times ?? [];
    const tasks = (globalCfg.tasks?.length ? globalCfg.tasks : times.map(t => ({ time: t }))) as GlobalScheduleEntry[];
    if (tasks.length > 0) {
      this.entries.set(TimerManager.GLOBAL_AGENT_ID, tasks.map(t => ({
        id: `chime-${t.time}`,
        mode: 'time',
        time: t.time,
        hint: t.hint ?? globalCfg.defaultHint ?? '',
        target: t.targets?.length ? t.targets.join(',') : '*',
        enabled: true,
      } as TimerEntry)));
      logger.info(`已加载全局定时 ${tasks.length} 条`);
    }
  }

  /** 注入 Router（bootstrap 后调用） */
  setRouter(router: AgentRouter): void {
    this.router = router;
  }

  /** 重新加载所有 Agent 的定时配置 */
  reloadAll(): void {
    this.stopAll();
    if (!this.acquireInstanceLock()) {
      logger.warn('检测到其他 AgentChat 实例正在运行（timer-instance.lock），本进程跳过定时任务调度');
      return;
    }
    this.entries.clear();
    this.registerGlobalEntries();
    this.loadState();

    const agentsDir = this.agentsDir;
    if (!fs.existsSync(agentsDir)) return;

    for (const dir of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, dir.name, 'config.json');
      if (!fs.existsSync(cfgPath)) continue;

      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        const timerCfg = cfg['timer'] as TimerConfig | undefined;
        if (!timerCfg?.entries?.length) continue;

        const agentId = cfg.agent_id || dir.name;
        const enabled = timerCfg.entries.filter(e => e.enabled !== false);
        if (enabled.length === 0) continue;

        this.entries.set(agentId, enabled);
      } catch { /* 跳过无法解析的配置 */ }
    }

    // 清理不存在于任何 Agent 配置中的持久化状态条目
    const allValidIds = new Set<string>();
    for (const [agentId, agentEntries] of this.entries) {
      for (const e of agentEntries) allValidIds.add(`${agentId}/${e.id}`);
    }
    for (const key of this.persistedState.keys()) {
      if (key.startsWith('_')) continue;
      if (!allValidIds.has(key)) this.persistedState.delete(key);
    }
    this.saveState();

    this.compensateMissedTriggers();
    this.startAll();
    this.startHeartbeat();
    logger.info(
      `已加载 ${this.entries.size} 个 Agent 的定时任务` +
      (this.entries.size > 0 ? ` (共 ${Array.from(this.entries.values()).reduce((s, e) => s + e.length, 0)} 个)` : '')
    );
  }

  /** 获取指定 Agent 的定时任务配置 */
  getEntries(agentId: string): TimerEntry[] {
    return this.entries.get(agentId) ?? [];
  }

  /** 保存指定 Agent 的定时任务配置，并清理不属于当前列表的持久化状态 */
  saveEntries(agentId: string, entries: TimerEntry[]): void {
    if (!this.lockHeld) {
      logger.warn('本进程未持有定时器实例锁，跳过保存配置（避免多实例互相覆盖）');
      return;
    }
    const agentsDir = this.agentsDir;
    if (!fs.existsSync(agentsDir)) return;

    for (const dir of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, dir.name, 'config.json');
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        if (cfg.agent_id === agentId) {
          cfg['timer'] = { entries };
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
          this.stopAgent(agentId);
          this.entries.set(agentId, entries.filter(e => e.enabled !== false));
          this.startAgent(agentId);
          logger.info(`Agent "${agentId}" 定时配置已保存 (${entries.length} 个)`);
          const validIds = new Set(entries.map(e => e.id));
          for (const key of this.persistedState.keys()) {
            if (key.startsWith(`${agentId}/`)) {
              const entryId = key.slice(agentId.length + 1);
              if (!validIds.has(entryId)) this.persistedState.delete(key);
            }
          }
          this.saveState();
        }
      } catch { /* skip */ }
    }
  }

  // ============================================================
  // 持久化状态管理
  // ============================================================

  private loadState(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
        this.persistedState = new Map(Object.entries(raw));
        logger.info(`已加载持久化状态 (${this.persistedState.size} 个)`);
      }
    } catch (err: any) {
      logger.warn(`加载持久化状态失败: ${err.message}`);
    }
  }

  private saveState(): void {
    try {
      const obj: Record<string, TimerPersistedState> = {};
      for (const [k, v] of this.persistedState) obj[k] = v;
      // 先写临时文件再 rename，避免并发读写读到半截 JSON（多实例问题根治后仍保留保险）
      const tmpPath = `${this.statePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.statePath);
    } catch (err: any) {
      logger.warn(`保存状态失败: ${err.message}`);
    }
  }

  private saveEntryState(key: string, state: TimerPersistedState): void {
    this.persistedState.set(key, state);
    this.saveState();
  }

  private clearEntryState(key: string): void {
    this.persistedState.delete(key);
    this.saveState();
  }

  // ============================================================
  // 实例锁 —— 多个进程共享同一 workspace 时，只允许一个实例
  // 调度定时任务/写 timer-state.json。否则每次重启旧进程残留 +
  // 新进程一起跑，心跳与触发回写互相覆盖，delay/random 任务的
  // startedAt 被回退成旧值 → 每次重启都立即补触发。
  // ============================================================

  private acquireInstanceLock(): boolean {
    if (this.lockHeld) return true;

    const ownLock = JSON.stringify({
      pid: process.pid,
      startedAt: localISO(undefined, this.tz),
      purpose: 'agentchat-timer-single-instance',
    }, null, 2);

    // 三次尝试：处理锁文件刚被并发创建/陈旧锁刚被清理的竞态
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.writeFileSync(this.lockPath, ownLock, { encoding: 'utf-8', flag: 'wx' });
        this.lockHeld = true;
        logger.info(`已取得定时器实例锁 (pid=${process.pid})`);
        return true;
      } catch (err: any) {
        if (err?.code !== 'EEXIST') {
          // 锁文件不可写（权限/磁盘）时按无锁继续，不因此禁用定时功能
          logger.warn(`创建实例锁失败，按无锁模式继续: ${err?.message ?? String(err)}`);
          this.lockHeld = true;
          return true;
        }
      }

      try {
        const holder = JSON.parse(fs.readFileSync(this.lockPath, 'utf-8')) as { pid?: number };
        const holderAlive = Number.isInteger(holder?.pid)
          && holder.pid !== process.pid
          && isProcessAlive(holder.pid!);
        if (holderAlive) {
          logger.warn(`另一个 AgentChat 实例 (pid=${holder.pid}) 持有定时器实例锁，本实例不调度定时任务`);
          return false;
        }
      } catch {
        // 锁文件损坏：按陈旧处理，走删除重建
      }

      try { fs.unlinkSync(this.lockPath); } catch { /* 已被其他进程清理 */ }
    }

    logger.warn('实例锁竞争失败，本实例不调度定时任务');
    return false;
  }

  private releaseInstanceLock(): void {
    if (!this.lockHeld) return;
    try {
      const holder = JSON.parse(fs.readFileSync(this.lockPath, 'utf-8')) as { pid?: number };
      if (holder?.pid === process.pid) fs.unlinkSync(this.lockPath);
    } catch { /* 锁已不存在/损坏 */ }
    this.lockHeld = false;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      try {
        this.persistedState.set('_heartbeat', { lastTriggeredAt: localISO(undefined, this.tz) });
        this.saveState();
      } catch { /* 心跳写入失败不影响运行 */ }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** 补偿停机期间应触发但未触发的定时任务 */
  private async compensateMissedTriggers(): Promise<void> {
    const heartbeat = this.persistedState.get('_heartbeat');
    if (!heartbeat?.lastTriggeredAt) return;

    const lastHeartbeat = new Date(heartbeat.lastTriggeredAt).getTime();
    const now = Date.now();
    const downtime = now - lastHeartbeat;

    if (downtime < 5 * 60 * 1000) {
      logger.debug(`停机 ${(downtime/1000).toFixed(0)}s，无需补偿`);
      return;
    }

    logger.info(`检测到停机 ${(downtime/60000).toFixed(1)} 分钟，检查补偿...`);

    for (const [agentId, entries] of this.entries) {
      for (const entry of entries) {
        const key = `${agentId}/${entry.id}`;
        const ps = this.persistedState.get(key);
        if (!ps) continue;

        // 一次性任务补偿
        if (entry.repeatCount === 1 && ps.startedAt && ps.totalDelayMs) {
          const expectedTime = new Date(ps.startedAt).getTime() + ps.totalDelayMs;
          if (expectedTime <= now && expectedTime > lastHeartbeat && !ps.lastTriggeredAt) {
            logger.debug(`补偿一次性任务 "${key}"`);
            // 先完成记账（禁用 + 归档，同步完成）再异步触发：
            // reloadAll 中紧随的 startAll 读到 enabled=false 后跳过排程，避免重复触发。
            entry.enabled = false;
            this.archiveCompletedEntry(agentId, entry, 1);
            void this.fireEntry(agentId, entry, key).catch((err: any) => {
              logger.error(`补偿触发 "${key}" 失败: ${err.message}`);
            });
          }
        }

        // random/delay 首次触发补偿
        if ((entry.mode === 'delay' || entry.mode === 'random') && !ps.lastTriggeredAt && ps.startedAt && ps.totalDelayMs) {
          const expectedTime = new Date(ps.startedAt).getTime() + ps.totalDelayMs;
          if (expectedTime <= now && expectedTime > lastHeartbeat) {
            logger.debug(`补偿首次触发 "${key}"`);
            // 先更新记账（lastTriggeredAt/startedAt 置为当前）再异步触发：
            // 使紧随的 startAll 按新 startedAt 计算完整延迟排程下一次，避免立即重复触发。
            const newCount = (ps.executedCount ?? 0) + 1;
            this.saveEntryState(key, {
              lastTriggeredAt: localISO(undefined, this.tz),
              executedCount: newCount,
              startedAt: localISO(undefined, this.tz),
              totalDelayMs: ps.totalDelayMs,
            });
            if (entry.repeatCount && entry.repeatCount > 0 && newCount >= entry.repeatCount) {
              entry.enabled = false;
              this.disableEntryPersist(agentId, entry.id);
            }
            void this.fireEntry(agentId, entry, key).catch((err: any) => {
              logger.error(`补偿触发 "${key}" 失败: ${err.message}`);
            });
          }
        }

        // delay/random 重复任务（已触发过）周期补偿
        if ((entry.mode === 'delay' || entry.mode === 'random') && ps.lastTriggeredAt && ps.startedAt && ps.totalDelayMs) {
          const lastTrigger = new Date(ps.lastTriggeredAt).getTime();
          let nextExpected = lastTrigger + ps.totalDelayMs;
          let compensated = 0;
          const maxCompensate = entry.repeatCount && entry.repeatCount > 0
            ? entry.repeatCount - (ps.executedCount ?? 0)
            : 3;

          while (nextExpected <= now && compensated < maxCompensate) {
            compensated++;
            nextExpected += ps.totalDelayMs;
          }

          if (compensated > 0) {
            // 先更新记账（lastTriggeredAt/startedAt 置为当前、executedCount 累计）再异步触发，
            // 使紧随的 startAll 按新 startedAt 计算完整延迟排程，避免补偿+排程重复触发。
            const newCount = (ps.executedCount ?? 0) + compensated;
            this.saveEntryState(key, {
              ...ps,
              lastTriggeredAt: localISO(undefined, this.tz),
              executedCount: newCount,
              startedAt: localISO(undefined, this.tz),
            });
            if (entry.repeatCount && entry.repeatCount > 0 && newCount >= entry.repeatCount) {
              entry.enabled = false;
              this.disableEntryPersist(agentId, entry.id);
            }
            for (let i = 0; i < compensated; i++) {
              void this.fireEntry(agentId, entry, key).catch((err: any) => {
                logger.error(`补偿触发 "${key}" 失败: ${err.message}`);
              });
            }
          }
        }

        // random 模式（无 totalDelayMs 持久化）
        if (entry.mode === 'random' && !ps.totalDelayMs && ps.startedAt) {
          const startedAt = new Date(ps.startedAt).getTime();
          if (startedAt > lastHeartbeat) {
            const randomMs = this.randomDelay(entry.delayMin, entry.delayMax);
            if (randomMs !== null && startedAt + randomMs <= now) {
              const remaining = entry.repeatCount && entry.repeatCount > 0
                ? entry.repeatCount - (ps.executedCount ?? 0)
                : -1;
              if (remaining !== 0) {
                logger.debug(`补偿随机任务 "${key}"`);
                // 先更新记账再异步触发（同 delay 补偿：防止 startAll 按旧状态重复排程）
                const newCount = (ps.executedCount ?? 0) + 1;
                this.saveEntryState(key, {
                  lastTriggeredAt: localISO(undefined, this.tz),
                  executedCount: newCount,
                  startedAt: localISO(undefined, this.tz),
                });
                if (entry.repeatCount && entry.repeatCount > 0 && newCount >= entry.repeatCount) {
                  entry.enabled = false;
                  this.disableEntryPersist(agentId, entry.id);
                }
                void this.fireEntry(agentId, entry, key).catch((err: any) => {
                  logger.error(`补偿触发 "${key}" 失败: ${err.message}`);
                });
              }
            }
          }
        }
      }
    }
  }

  /** 触发单条任务（不涉及调度逻辑） */
  private async fireEntry(agentId: string, entry: TimerEntry, key: string): Promise<void> {
    if (!this.router) return;
    const targets = (entry.target || 'user').split(',').map(t => t.trim()).filter(Boolean);
    for (const target of targets) {
      try {
        logger.debug(`触发 "${key}" → ${target}`);
        void this.router.trigger(agentId, {
          hint: entry.hint, target,
          source: entry.source ?? entry.id,
          sourceMeta: { kind: 'timer', form: 'hint', summary: (entry.hint || '').slice(0, 60) || undefined },
          maxSteps: entry.maxSteps,
        });
      } catch (err: any) {
        logger.error(`"${key}" → ${target} 失败: ${err.message}`);
      }
    }
  }

  /** 仅写 config.json 禁用条目（不清理状态） */
  private disableEntryPersist(agentId: string, entryId: string): void {
    const agentsDir = this.agentsDir;
    if (!fs.existsSync(agentsDir)) return;
    for (const dir of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, dir.name, 'config.json');
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        if (cfg.agent_id !== agentId) continue;
        const timer = cfg['timer'] as TimerConfig | undefined;
        if (!timer?.entries) return;
        const e = timer.entries.find((x: TimerEntry) => x.id === entryId);
        if (e) {
          e.enabled = false;
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
        }
        return;
      } catch { /* skip */ }
    }
  }

  private getDelay(entry: TimerEntry): number | null {
    if (entry.mode === 'time' || entry.mode === 'workday' || entry.mode === 'holiday') {
      return entry.time ? msUntilTime(entry.time) : null;
    }
    if (entry.mode === 'random') {
      return this.randomDelay(entry.delayMin, entry.delayMax);
    }
    return entry.delay ? parseInterval(entry.delay) : null;
  }

  private randomDelay(minStr?: string, maxStr?: string): number | null {
    const min = parseInterval(minStr || '30s') ?? 30000;
    const max = parseInterval(maxStr || '5m') ?? 300000;
    if (min >= max) return max;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private getRepeatCount(entry: TimerEntry): number {
    const c = entry.repeatCount;
    if (c === undefined || c === null || c <= 0) return -1;
    return c;
  }

  /** 限定次数定时器完成后归档：从 config.json 移除条目并追加到 <agentDir>/timer-archive.jsonl */
  private archiveCompletedEntry(agentId: string, entry: TimerEntry, executedCount?: number): void {
    const key = `${agentId}/${entry.id}`;
    this.clearEntryState(key);
    // 同步内存缓存：无论磁盘条目是否存在，先移除缓存中的已归档条目。
    // 修复前只改磁盘不同步缓存 → list_timers 仍显示已归档条目（[启用]），
    // 且 set_timer/disable_timer 基于缓存整体写回 config.json → 条目"复活"循环归档
    // （08-14 test/timer-1786618094927 归档 3 次仍在 config.json；08-12 agent_chat_dev/timer-1786542157847 ×2 同源）。
    const cached = this.entries.get(agentId);
    if (cached) {
      const ci = cached.findIndex((e: TimerEntry) => e.id === entry.id);
      if (ci >= 0) cached.splice(ci, 1);
      if (cached.length === 0) this.entries.delete(agentId);
    }
    const count = executedCount ?? entry.repeatCount ?? 1;
    const agentsDir = this.agentsDir;
    if (!agentsDir || !fs.existsSync(agentsDir)) return;
    for (const dir of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, dir.name, 'config.json');
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        if (cfg.agent_id !== agentId) continue;
        const timer = cfg['timer'] as TimerConfig | undefined;
        if (!timer?.entries) return;
        const idx = timer.entries.findIndex((e: TimerEntry) => e.id === entry.id);
        if (idx === -1) return;
        const [removed] = timer.entries.splice(idx, 1);
        const archivePath = path.join(agentsDir, dir.name, 'timer-archive.jsonl');
        try {
          const rec = { ...removed, status: 'completed', completedAt: localISO(undefined, this.tz), executedCount: count };
          fs.appendFileSync(archivePath, JSON.stringify(rec) + '\n', 'utf-8');
        } catch (err: any) {
          logger.warn(`写入归档失败 ${archivePath}: ${err.message}`);
        }
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
        logger.info(`"${key}" 已完成 ${count} 次，已归档至 timer-archive.jsonl`);
        return;
      } catch (err: any) {
        logger.warn(`归档失败 ${key}: ${err.message}`);
      }
    }
  }

  private scheduleEntry(agentId: string, entry: TimerEntry): void {
    const key = `${agentId}/${entry.id}`;
    // 禁用条目不排程：补偿路径完成记账后置 enabled=false，防止 reloadAll 中紧随的
    // startAll 把已补偿/已归档的任务再次排程（重复触发）。
    if (entry.enabled === false) {
      logger.debug(`"${key}" 已禁用，跳过调度`);
      return;
    }

    const ps = this.persistedState.get(key);
    let remaining = this.getRepeatCount(entry);
    if (ps?.executedCount !== undefined && remaining > 0) {
      remaining = Math.max(0, remaining - ps.executedCount);
      if (remaining <= 0) {
        logger.debug(`"${key}" 已执行完毕（持久化计数 ${ps.executedCount}），跳过调度`);
        return;
      }
    }

    let delayMs: number | null;
    if (entry.mode === 'random') {
      if (ps?.startedAt && ps?.totalDelayMs != null) {
        const elapsed = Date.now() - new Date(ps.startedAt).getTime();
        delayMs = Math.max(0, ps.totalDelayMs - elapsed);
      } else {
        delayMs = this.randomDelay(entry.delayMin, entry.delayMax);
      }
    } else if ((entry.mode === 'delay') && ps?.startedAt && ps?.totalDelayMs) {
      const elapsed = Date.now() - new Date(ps.startedAt).getTime();
      delayMs = Math.max(0, ps.totalDelayMs - elapsed);
    } else {
      delayMs = this.getDelay(entry);
    }

    if (delayMs === null || (delayMs <= 0 && entry.mode !== 'random' && entry.mode !== 'delay')) {
      // 一次性（有限次）日历任务已过期：自动归档，避免僵尸条目永久驻留
      // （如过期的一次性 mode=time 任务，getDelay 恒为负值 → 既不会触发也不会清理）。
      const repeat = this.getRepeatCount(entry);
      if (repeat > 0 && (entry.mode === 'time' || entry.mode === 'workday' || entry.mode === 'holiday')) {
        logger.warn(`"${key}" 已过期 (mode=${entry.mode})，自动归档`);
        this.archiveCompletedEntry(agentId, entry, 0);
        return;
      }
      logger.warn(`"${key}" 延迟无效 (mode=${entry.mode})`);
      return;
    }

    const modeLabel = entry.mode === 'time'
      ? (isFullDatetime(entry.time!) ? entry.time
        : isWeekdayTime(entry.time!) ? formatWeekdayLabel(entry.time!)
        : `每天 ${entry.time}`)
      : entry.mode === 'workday' ? `工作日 ${entry.time}`
      : entry.mode === 'holiday' ? `节假日 ${entry.time}`
      : entry.mode === 'random' ? `随机 ${entry.delayMin || '30s'}~${entry.delayMax || '5m'}`
      : `每隔 ${entry.delay}`;
    const isGlobal = agentId === TimerManager.GLOBAL_AGENT_ID;
    const targets = isGlobal && (entry.target || '') === '*'
      ? (this.router?.getAgentIds() ?? [])
      : (entry.target || 'user').split(',').map(t => t.trim()).filter(Boolean);

    const persistAfterTrigger = (executed: number, nextDelay?: number) => {
      this.saveEntryState(key, {
        lastTriggeredAt: localISO(undefined, this.tz),
        executedCount: executed,
        startedAt: (entry.mode === 'delay' || entry.mode === 'random')
          ? localISO(undefined, this.tz) : undefined,
        totalDelayMs: (entry.mode === 'delay')
          ? (parseInterval(entry.delay!) ?? delayMs ?? undefined)
          : (entry.mode === 'random' && nextDelay != null)
            ? nextDelay
            : undefined,
      });
    };

    const trigger = async () => {
      if (entry.mode === 'workday' && !isWorkday()) return;
      if (entry.mode === 'holiday' && !isHoliday()) return;
      if (!this.router) return;

      // 特殊 hint：__archive_all__ —— 全局批量归档（不走 LLM，纯机制）
      if (entry.hint?.trim() === '__archive_all__') {
        try {
          if (!this.archiveAll) { logger.warn('__archive_all__ 未装配 archiveAll 回调，跳过'); return; }
          const result = this.archiveAll();
          logger.info(`批量归档（__archive_all__）：${result.length} 会话`);
        } catch (err: any) {
          logger.error(`批量归档失败: ${err.message}`);
        }
        return;
      }

      // 特殊 hint：__backup_all__ —— 数据备份（不走 LLM，纯机制）
      if (entry.hint?.trim() === '__backup_all__') {
        try {
          if (!this.backupAll) { logger.warn('__backup_all__ 未装配 backupAll 回调，跳过'); return; }
          const result = this.backupAll();
          if (!result.skipped) {
            logger.info(`数据备份（__backup_all__）：${result.file} (${((result.size ?? 0) / 1024 / 1024).toFixed(2)}MB)`);
          }
        } catch (err: any) {
          logger.error(`数据备份失败: ${err.message}`);
        }
        return;
      }

      // 模板占位符替换
      const nowDate = new Date();
      const hh = String(nowDate.getHours()).padStart(2, '0');
      const mm = String(nowDate.getMinutes()).padStart(2, '0');
      const hint = (entry.hint || '')
        .replace(/\{\{now\}\}/g, nowDate.toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' }))
        .replace(/\{\{time\}\}/g, `${hh}:${mm}`)
        .replace(/\{\{date\}\}/g, nowDate.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }))
        .replace(/\{time\}/g, entry.time || `${hh}:${mm}`);
      for (const target of targets) {
        try {
          logger.debug(`触发 "${key}" → ${target} (${modeLabel})`);
          void this.router.trigger(agentId, {
            hint, target,
            source: entry.source ?? entry.id,
            sourceMeta: { kind: 'timer', form: 'hint', summary: hint.slice(0, 60) },
            maxSteps: entry.maxSteps,
          });
        } catch (err: any) {
          logger.error(`"${key}" → ${target} 失败: ${err.message}`);
        }
      }
    };

    const isRandom = entry.mode === 'random';

    this.saveEntryState(key, {
      executedCount: ps?.executedCount ?? 0,
      startedAt: (entry.mode === 'delay' || entry.mode === 'random')
        ? (ps?.startedAt ?? localISO(undefined, this.tz))
        : undefined,
      totalDelayMs: (entry.mode === 'delay')
        ? (parseInterval(entry.delay!) ?? delayMs ?? undefined)
        : (entry.mode === 'random')
          ? (ps?.totalDelayMs ?? delayMs ?? undefined)
          : undefined,
    });

    if (isRandom && remaining !== 1) {
      const isForever = remaining < 0;
      const resumed = ps?.startedAt && ps?.totalDelayMs != null;

      let c = remaining;
      let nextDelay = delayMs ?? 0;
      const arm = () => {
        if (!isForever && c <= 0) {
          this.timers.delete(key);
          this.archiveCompletedEntry(agentId, entry, entry.repeatCount);
          return;
        }
        const t = setTimeout(async () => {
          await trigger();
          if (!isForever) c--;
          const s = this.timers.get(key);
          if (s) { s.remaining = isForever ? -1 : c; }
          const totalExecuted = (entry.repeatCount ?? 0) > 0 ? entry.repeatCount! - c : (ps?.executedCount ?? 0) + 1;
          const d2 = this.randomDelay(entry.delayMin, entry.delayMax);
          if (d2 !== null) { nextDelay = d2; persistAfterTrigger(totalExecuted, d2); }
          else { persistAfterTrigger(totalExecuted); }
          if (isForever || c > 0) arm();
          else {
            this.timers.delete(key);
            this.archiveCompletedEntry(agentId, entry, entry.repeatCount);
          }
        }, nextDelay);
        this.timers.set(key, { timeout: t, remaining: isForever ? -1 : c });
      };
      arm();
      const resumedNote = (resumed && delayMs === 0)
        ? ' [重启恢复：随机延迟已过，立即触发]' : '';
      logger.info(`"${key}" (${modeLabel}, ${isForever ? '永久' : remaining + '次'})${resumedNote}`);
    } else if (remaining === 1) {
      const t = setTimeout(async () => {
        await trigger();
        this.timers.delete(key);
        persistAfterTrigger((ps?.executedCount ?? 0) + 1);
        this.archiveCompletedEntry(agentId, entry, entry.repeatCount ?? 1);
      }, delayMs);
      this.timers.set(key, { timeout: t, remaining: 1 });
      logger.info(`"${key}" (${modeLabel}, 一次性, ${(delayMs/1000).toFixed(0)}s)`);
    } else if (remaining > 1) {
      if (entry.mode === 'time' || entry.mode === 'workday' || entry.mode === 'holiday') {
        let c = remaining;
        const scheduleNext = () => {
          if (c <= 0) {
            this.timers.delete(key);
            this.archiveCompletedEntry(agentId, entry, entry.repeatCount);
            return;
          }
          const nextMs = entry.time ? msUntilTime(entry.time) : null;
          if (nextMs === null) return;
          const t = setTimeout(async () => {
            await trigger(); c--;
            const s = this.timers.get(key); if (s) s.remaining = c;
            const totalExecuted = entry.repeatCount! - c;
            persistAfterTrigger(totalExecuted);
            scheduleNext();
          }, nextMs);
          this.timers.set(key, { timeout: t, remaining: c });
        };
        scheduleNext();
        logger.info(`"${key}" (${modeLabel}, ${remaining} 次, ${(delayMs!/1000).toFixed(0)}s → 下次重算)`);
      } else {
        let c = remaining;
        const fullDelay = parseInterval(entry.delay!);
        const scheduleNext = (isFirst: boolean) => {
          if (c <= 0) {
            this.timers.delete(key);
            this.archiveCompletedEntry(agentId, entry, entry.repeatCount);
            return;
          }
          const d = isFirst ? Math.max(0, delayMs) : (fullDelay ?? Math.max(0, delayMs));
          const t = setTimeout(async () => {
            await trigger(); c--;
            const s = this.timers.get(key); if (s) s.remaining = c;
            const totalExecuted = entry.repeatCount! - c;
            persistAfterTrigger(totalExecuted);
            if (c > 0) scheduleNext(false);
            else {
              this.timers.delete(key);
              this.archiveCompletedEntry(agentId, entry, entry.repeatCount);
            }
          }, d);
          this.timers.set(key, { timeout: t, remaining: c });
        };
        scheduleNext(true);
        logger.info(`"${key}" (${modeLabel}, ${remaining} 次, 首轮 ${(delayMs/1000).toFixed(0)}s → 周期 ${((fullDelay ?? delayMs)/1000).toFixed(0)}s)`);
      }
    } else {
      if (entry.mode === 'time' || entry.mode === 'workday' || entry.mode === 'holiday') {
        let execCount = ps?.executedCount ?? 0;
        const scheduleNext = () => {
          const nextMs = entry.time ? msUntilTime(entry.time) : null;
          if (nextMs === null) return;
          const t = setTimeout(async () => {
            await trigger();
            execCount++;
            persistAfterTrigger(execCount);
            scheduleNext();
          }, nextMs);
          this.timers.set(key, { timeout: t, remaining: -1 });
        };
        scheduleNext();
        logger.info(`"${key}" (${modeLabel}, 永久, ${(delayMs!/1000).toFixed(0)}s → 下次重算)`);
      } else {
        let execCount = ps?.executedCount ?? 0;
        const fullDelay = parseInterval(entry.delay!);
        const scheduleNext = (isFirst: boolean) => {
          const d = isFirst ? Math.max(0, delayMs) : (fullDelay ?? Math.max(0, delayMs));
          const t = setTimeout(async () => {
            await trigger();
            execCount++;
            persistAfterTrigger(execCount);
            scheduleNext(false);
          }, d);
          this.timers.set(key, { timeout: t, remaining: -1 });
        };
        scheduleNext(true);
        logger.info(`"${key}" (${modeLabel}, 永久, 首轮 ${(delayMs/1000).toFixed(0)}s → 周期 ${((fullDelay ?? delayMs)/1000).toFixed(0)}s)`);
      }
    }
  }

  private startAgent(agentId: string): void {
    const entries = this.entries.get(agentId);
    if (!entries || !this.router) return;
    for (const entry of entries) this.scheduleEntry(agentId, entry);
  }

  private startAll(): void {
    for (const agentId of this.entries.keys()) {
      this.startAgent(agentId);
    }
  }

  private stopAgent(agentId: string): void {
    for (const [key, state] of this.timers) {
      if (key.startsWith(agentId + '/')) {
        clearTimeout(state.timeout); clearInterval(state.timeout);
        this.timers.delete(key);
      }
    }
  }

  stopAll(): void {
    this.stopHeartbeat();
    for (const [key, state] of this.timers) {
      clearTimeout(state.timeout); clearInterval(state.timeout);
      logger.debug(`已停止 "${key}"`);
    }
    this.timers.clear();
    this.releaseInstanceLock();
  }

  /** 释放全部资源（停止调度 + 释放实例锁），供插件 dispose 使用 */
  dispose(): void {
    this.stopAll();
  }
}
