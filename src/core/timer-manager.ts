// ============================================================
// TimerManager —— 定时任务管理器
//
// 读取所有 Agent 的 timer 配置，调用 setInterval 定时触发
// ============================================================

import { TimerEntry, TimerConfig, ChimeConfig } from './types';
import { getGlobalConfig } from './config';
import type { AgentRouter } from '../routing/router';
import * as path from 'path';
import * as fs from 'fs';
import * as lunar from 'chinese-lunar';
import { logger } from '../utils/logger';

/**
 * 解析间隔字符串为毫秒数。
 * 支持格式：0s / 5m / 1h / 2h30m
 */
/**
 * 返回指定时区的 ISO 格式时间字符串，如 "2026-07-26T21:30:00+08:00"。
 * 时区从全局配置 timezone 读取，默认 "Asia/Shanghai"。
 */
function localISO(date?: Date): string {
  const d = date ?? new Date();
  const tz = getGlobalConfig().timezone || 'Asia/Shanghai';

  // 尝试用 Intl.DateTimeFormat 格式化
  try {
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(d);

    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
    const dateStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;

    // 计算该时区 offset
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
    // 降级：直接用 UTC+8（兼容无效时区名）
  }

  // 降级方案：硬编码 UTC+8
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const y = bj.getUTCFullYear();
  const mo = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const da = String(bj.getUTCDate()).padStart(2, '0');
  const h = String(bj.getUTCHours()).padStart(2, '0');
  const mi = String(bj.getUTCMinutes()).padStart(2, '0');
  const s = String(bj.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${da}T${h}:${mi}:${s}+08:00`;
}

export function parseInterval(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;

  const regex = /(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hour|hours)/g;
  let total = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(s)) !== null) {
    const value = parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
      case 's': case 'sec': case 'second': case 'seconds': total += value * 1000; break;
      case 'm': case 'min': case 'minute': case 'minutes': total += value * 60 * 1000; break;
      case 'h': case 'hour': case 'hours': total += value * 60 * 60 * 1000; break;
    }
  }

  return total > 0 ? total : null;
}

/**
 * 计算到目标时间的毫秒数。
 * 支持格式：
 *   "HH:mm" —— 每天该时间（今天已过则明天）
 *   "YYYY-MM-DDTHH:mm" / "YYYY-MM-DD HH:mm" —— 指定日期时间
 */
function msUntilTime(timeStr: string): number | null {
  const s = timeStr.trim();

  // 完整日期时间：YYYY-MM-DDTHH:mm 或 YYYY-MM-DD HH:mm
  const fullMatch = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2})$/);
  if (fullMatch) {
    const target = new Date(fullMatch[1] + 'T' + fullMatch[2]);
    if (isNaN(target.getTime())) return null;
    const ms = target.getTime() - Date.now();
    return ms > 0 ? ms : null; // 已过期返回 null（不调度）
  }

  // 星期几 + 时间：Sun 12:00 / 周日 12:00
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
    // 计算到目标星期几的天数差
    const dayDiff = (wd + 7 - now.getDay()) % 7;
    if (dayDiff === 0 && target.getTime() <= now.getTime()) {
      // 今天就是目标星期几但时间已过 → 下个星期
      target.setDate(target.getDate() + 7);
    } else {
      target.setDate(target.getDate() + dayDiff);
    }
    return target.getTime() - now.getTime();
  }

  // 每日时间：HH:mm
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
  /** 剩余次数，-1 = forever */
  remaining: number;
}

/** 持久化的定时器运行时状态（用于重启恢复） */
interface TimerPersistedState {
  /** 上次触发时间 (ISO) */
  lastTriggeredAt?: string;
  /** 已执行次数 */
  executedCount?: number;
  /** 当前延迟周期的开始时间 (ISO)，用于 delay/random 模式计算剩余时间 */
  startedAt?: string;
  /** 当前延迟周期的总时长 (ms) */
  totalDelayMs?: number;
}

// ============================================================
// 节假日判断（基于 chinese-lunar 农历计算 + 固定列表）
// ============================================================

/** 判断是否为工作日（周一至周五 + 排除节假日 + 含调休工作日） */
function isWorkday(): boolean { return !isHoliday(); }

function isHoliday(): boolean {
  const now = new Date();
  const today = formatDate(now);
  ensureExtraHolidaysLoaded();

  // 调休工作日优先
  if (MAKEUP_WORKDAYS.has(today)) return false;

  // 法定节假日（固定列表）
  if (HOLIDAYS.has(today)) return true;

  // 农历节假日
  if (isLunarHoliday(now)) return true;

  // 固定阳历节日（元旦、清明、劳动节、国庆）
  if (isSolarHoliday(now)) return true;

  // 周末
  const d = now.getDay();
  return d === 0 || d === 6;
}

/** 农历节日：春节、端午、中秋 */
function isLunarHoliday(date: Date): boolean {
  try {
    const l = lunar.solarToLunar(date);
    // 春节：正月初一前后共 5 天
    if (l.month === 1 && l.day >= 28 && l.day <= 30) return true; // 腊月廿八~三十
    if (l.month === 1 && l.day >= 1 && l.day <= 7) return true;   // 正月初一~初七
    // 端午：五月初五前后
    if (l.month === 5 && l.day >= 3 && l.day <= 5) return true;
    // 中秋：八月十五前后
    if (l.month === 8 && l.day >= 14 && l.day <= 16) return true;
  } catch { /* lunar conversion failed */ }
  return false;
}

/** 阳历固定节日：元旦、清明、劳动节、国庆 */
function isSolarHoliday(date: Date): boolean {
  const m = date.getMonth() + 1, d = date.getDate();
  // 元旦 1/1
  if (m === 1 && d === 1) return true;
  // 清明 4/4-4/5
  if (m === 4 && (d === 4 || d === 5)) return true;
  // 劳动节 5/1-5/3
  if (m === 5 && d >= 1 && d <= 3) return true;
  // 国庆 10/1-10/3
  if (m === 10 && d >= 1 && d <= 3) return true;
  return false;
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

let _extraHolidaysLoaded = false;
function ensureExtraHolidaysLoaded(): void {
  if (_extraHolidaysLoaded) return;
  _extraHolidaysLoaded = true;
  try {
    const cfg = getGlobalConfig() as any;
    if (cfg.holidays && Array.isArray(cfg.holidays)) {
      for (const d of cfg.holidays) HOLIDAYS.add(String(d));
    }
    if (cfg.makeupWorkdays && Array.isArray(cfg.makeupWorkdays)) {
      for (const d of cfg.makeupWorkdays) MAKEUP_WORKDAYS.add(String(d));
    }
  } catch { /* ignore */ }
}

/** 法定节假日（非周末的固定日期覆盖，会与农历节日取并集） */
const HOLIDAYS = new Set<string>([]);

/** 调休工作日（周末但需上班） */
const MAKEUP_WORKDAYS = new Set<string>([]);

export class TimerManager {
  private router: AgentRouter | null = null;
  private timers: Map<string, TimerState> = new Map();
  private entries: Map<string, TimerEntry[]> = new Map();
  private persistedState: Map<string, TimerPersistedState> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly statePath: string;

  /** 全局报时定时器 */
  private chimeTimer: NodeJS.Timeout | null = null;
  /** 上一次触发报时的分钟标识（"HH:mm"），防止同一分钟重复触发 */
  private lastChimeMinute: string | null = null;

  constructor() {
    this.statePath = path.join(getGlobalConfig().workspaceDir, 'timer-state.json');
  }

  /** 注入 Router（bootstrap 后调用） */
  setRouter(router: AgentRouter): void {
    this.router = router;
  }

  /** 重新加载所有 Agent 的定时配置 */
  reloadAll(): void {
    this.stopAll();
    this.entries.clear();
    this.loadState();

    const agentsDir = getGlobalConfig().agentsDir;
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
      } catch {
        // 跳过无法解析的配置
      }
    }

    // 清理不存在于任何 Agent 配置中的持久化状态条目
    const allValidIds = new Set<string>();
    for (const [agentId, agentEntries] of this.entries) {
      for (const e of agentEntries) allValidIds.add(`${agentId}/${e.id}`);
    }
    for (const key of this.persistedState.keys()) {
      if (key.startsWith('_')) continue; // 保留 heartbeat
      if (!allValidIds.has(key)) this.persistedState.delete(key);
    }
    this.saveState();

    this.compensateMissedTriggers();
    this.startAll();
    this.startHeartbeat();
    this.startChime();
    logger.info(
      `[TimerManager] 已加载 ${this.entries.size} 个 Agent 的定时任务` +
      (this.entries.size > 0 ? ` (共 ${Array.from(this.entries.values()).reduce((s, e) => s + e.length, 0)} 个)` : '')
    );
  }

  /** 获取指定 Agent 的定时任务配置 */
  getEntries(agentId: string): TimerEntry[] {
    return this.entries.get(agentId) ?? [];
  }

  /** 保存指定 Agent 的定时任务配置 */
  /** 保存指定 Agent 的定时任务配置，并清理不属于当前列表的持久化状态 */
  saveEntries(agentId: string, entries: TimerEntry[]): void {
    const agentsDir = getGlobalConfig().agentsDir;
    if (!fs.existsSync(agentsDir)) return;

    // 找到 Agent 目录
    for (const dir of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, dir.name, 'config.json');
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        if (cfg.agent_id === agentId) {
          cfg['timer'] = { entries };
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
          // 热重载：停止该 Agent 的旧定时器，启动新的
          this.stopAgent(agentId);
          this.entries.set(agentId, entries.filter(e => e.enabled !== false));
          this.startAgent(agentId);
          logger.info(`[TimerManager] Agent "${agentId}" 定时配置已保存 (${entries.length} 个)`);
          // 清理已不存在的定时器持久化状态
          const validIds = new Set(entries.map(e => e.id));
          for (const key of this.persistedState.keys()) {
            if (key.startsWith(`${agentId}/`)) {
              const entryId = key.slice(agentId.length + 1);
              if (!validIds.has(entryId)) this.persistedState.delete(key);
            }
          }
          this.saveState();

          logger.info(`[TimerManager] Agent "${agentId}" 定时配置已保存 (${entries.length} 个)`);
        }
      } catch { /* skip */ }
    }
  }

  // ============================================================
  // 持久化状态管理
  // ============================================================

  /** 从磁盘加载定时器运行时状态 */
  private loadState(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
        this.persistedState = new Map(Object.entries(raw));
        logger.info(`[TimerManager] 已加载持久化状态 (${this.persistedState.size} 个)`);
      }
    } catch (err: any) {
      logger.warn(`[TimerManager] 加载持久化状态失败: ${err.message}`);
    }
  }

  /** 将运行时状态写入磁盘 */
  private saveState(): void {
    try {
      const obj: Record<string, TimerPersistedState> = {};
      for (const [k, v] of this.persistedState) obj[k] = v;
      fs.writeFileSync(this.statePath, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err: any) {
      logger.warn(`[TimerManager] 保存状态失败: ${err.message}`);
    }
  }

  /** 保存单条条目的状态并写入磁盘 */
  private saveEntryState(key: string, state: TimerPersistedState): void {
    this.persistedState.set(key, state);
    this.saveState();
  }

  /** 清除指定条目的持久化状态 */
  private clearEntryState(key: string): void {
    this.persistedState.delete(key);
    this.saveState();
  }

  /** 启动心跳（每 30 秒写入当前时间戳） */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      try {
        this.persistedState.set('_heartbeat', { lastTriggeredAt: localISO() });
        // 只写文件不触发完整 saveState 的序列化开销
        const obj: Record<string, TimerPersistedState> = {};
        for (const [k, v] of this.persistedState) obj[k] = v;
        fs.writeFileSync(this.statePath, JSON.stringify(obj, null, 2), 'utf-8');
      } catch { /* 心跳写入失败不影响运行 */ }
    }, 30_000);
  }

  /** 停止心跳 */
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

    // 停机时间 < 5 分钟，不补偿（避免短时间重启重复触发）
    if (downtime < 5 * 60 * 1000) {
      logger.debug(`[TimerManager] 停机 ${(downtime/1000).toFixed(0)}s，无需补偿`);
      return;
    }

    logger.info(`[TimerManager] 检测到停机 ${(downtime/60000).toFixed(1)} 分钟，检查补偿...`);

    for (const [agentId, entries] of this.entries) {
      for (const entry of entries) {
        const key = `${agentId}/${entry.id}`;
        const ps = this.persistedState.get(key);
        if (!ps) continue;

        // 一次性任务：如果 startedAt + totalDelayMs 已过，补偿触发
        if (entry.repeatCount === 1 && ps.startedAt && ps.totalDelayMs) {
          const expectedTime = new Date(ps.startedAt).getTime() + ps.totalDelayMs;
          if (expectedTime <= now && expectedTime > lastHeartbeat && !ps.lastTriggeredAt) {
            logger.debug(`[TimerManager] 补偿一次性任务 "${key}"（应在 ${new Date(expectedTime).toLocaleString('zh-CN')} 触发）`);
            await this.fireEntry(agentId, entry, key);
            this.clearEntryState(key);
            // 标记为已触发，不重复调度
            entry.enabled = false;
          }
        }

        // random/delay 任务从未触发过：用持久化的 totalDelayMs 判断是否应补偿首次触发
        if ((entry.mode === 'delay' || entry.mode === 'random') && !ps.lastTriggeredAt && ps.startedAt && ps.totalDelayMs) {
          const expectedTime = new Date(ps.startedAt).getTime() + ps.totalDelayMs;
          if (expectedTime <= now && expectedTime > lastHeartbeat) {
            logger.debug(`[TimerManager] 补偿首次触发 "${key}"（应在 ${new Date(expectedTime).toLocaleString('zh-CN')} 触发）`);
            await this.fireEntry(agentId, entry, key);
            const newCount = (ps.executedCount ?? 0) + 1;
            this.saveEntryState(key, {
              lastTriggeredAt: localISO(),
              executedCount: newCount,
              startedAt: localISO(),
              totalDelayMs: ps.totalDelayMs,
            });
            if (entry.repeatCount && entry.repeatCount > 0 && newCount >= entry.repeatCount) {
              entry.enabled = false;
              this.disableEntryPersist(agentId, entry.id);
            }
          }
        }

        // delay/random 重复任务（已触发过）：检查上次触发后是否有应触发但未触发的周期
        if ((entry.mode === 'delay' || entry.mode === 'random') && ps.lastTriggeredAt && ps.startedAt && ps.totalDelayMs) {
          const lastTrigger = new Date(ps.lastTriggeredAt).getTime();
          // 从上次触发到现在的周期
          let nextExpected = lastTrigger + ps.totalDelayMs;
          let compensated = 0;
          const maxCompensate = entry.repeatCount && entry.repeatCount > 0
            ? entry.repeatCount - (ps.executedCount ?? 0)
            : 3; // 永久任务最多补偿 3 次，防止大量积压

          while (nextExpected <= now && compensated < maxCompensate) {
            logger.debug(`[TimerManager] 补偿任务 "${key}"（第 ${compensated + 1} 次）`);
            await this.fireEntry(agentId, entry, key);
            compensated++;
            nextExpected += ps.totalDelayMs;
          }

          if (compensated > 0) {
            const newCount = (ps.executedCount ?? 0) + compensated;
            this.saveEntryState(key, {
              ...ps,
              lastTriggeredAt: localISO(),
              executedCount: newCount,
              startedAt: localISO(), // 下一周期从现在开始
            });

            // 如果次数已用完，标记禁用并跳过正常调度
            if (entry.repeatCount && entry.repeatCount > 0 && newCount >= entry.repeatCount) {
              entry.enabled = false;
              this.disableEntryPersist(agentId, entry.id);
            }
          }
        }

        // random 模式（无 totalDelayMs 持久化）：用新随机延迟 + startedAt 判断本次周期是否已落入停机区间
        if (entry.mode === 'random' && !ps.totalDelayMs && ps.startedAt) {
          const startedAt = new Date(ps.startedAt).getTime();
          // 只补偿 startedAt 在上次心跳之后的条目，避免重复补偿已正常触发的周期
          if (startedAt > lastHeartbeat) {
            const randomMs = this.randomDelay(entry.delayMin, entry.delayMax);
            if (randomMs !== null && startedAt + randomMs <= now) {
              const remaining = entry.repeatCount && entry.repeatCount > 0
                ? entry.repeatCount - (ps.executedCount ?? 0)
                : -1;
              if (remaining !== 0) {
                logger.debug(`[TimerManager] 补偿随机任务 "${key}"（随机延迟 ${(randomMs/1000).toFixed(0)}s 已落入停机区间）`);
                await this.fireEntry(agentId, entry, key);
                const newCount = (ps.executedCount ?? 0) + 1;
                this.saveEntryState(key, {
                  lastTriggeredAt: localISO(),
                  executedCount: newCount,
                  startedAt: localISO(),
                });
                if (entry.repeatCount && entry.repeatCount > 0 && newCount >= entry.repeatCount) {
                  entry.enabled = false;
                  this.disableEntryPersist(agentId, entry.id);
                }
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
        logger.debug(`[TimerManager] 触发 "${key}" → ${target}`);
        await this.router.trigger(agentId, {
          hint: entry.hint, target,
          source: entry.source ?? entry.id, maxTurns: entry.maxTurns ?? 99999,
        });
      } catch (err: any) {
        logger.error(`[TimerManager] "${key}" → ${target} 失败: ${err.message}`);
      }
    }
  }

  /** 仅写 config.json 禁用条目（不清理状态） */
  private disableEntryPersist(agentId: string, entryId: string): void {
    const agentsDir = getGlobalConfig().agentsDir;
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

  /** 在 [min, max] 范围内生成随机毫秒数 */
  private randomDelay(minStr?: string, maxStr?: string): number | null {
    const min = parseInterval(minStr || '30s') ?? 30000;
    const max = parseInterval(maxStr || '5m') ?? 300000;
    if (min >= max) return max;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private getRepeatCount(entry: TimerEntry): number {
    const c = entry.repeatCount;
    if (c === undefined || c === null || c <= 0) return -1; // forever
    return c;
  }

  /** 将指定条目标记为 disabled（写入 config.json）并清理持久化状态 */
  private disableEntry(agentId: string, entryId: string): void {
    const key = `${agentId}/${entryId}`;
    this.clearEntryState(key);
    const agentsDir = getGlobalConfig().agentsDir;
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
        const entry = timer.entries.find((e: TimerEntry) => e.id === entryId);
        if (entry) {
          entry.enabled = false;
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
          logger.info(`[TimerManager] "${agentId}/${entryId}" 已达次数上限，已自动禁用`);
        }
        return;
      } catch { /* skip */ }
    }
  }

  private scheduleEntry(agentId: string, entry: TimerEntry): void {
    const key = `${agentId}/${entry.id}`;

    // 从持久化状态恢复已执行次数
    const ps = this.persistedState.get(key);
    let remaining = this.getRepeatCount(entry);
    if (ps?.executedCount !== undefined && remaining > 0) {
      remaining = Math.max(0, remaining - ps.executedCount);
      if (remaining <= 0) {
        logger.debug(`[TimerManager] "${key}" 已执行完毕（持久化计数 ${ps.executedCount}），跳过调度`);
        return;
      }
    }

    // 计算首次延迟（delay/random 模式尝试从持久化状态恢复剩余时间）
    let delayMs = this.getDelay(entry);
    if ((entry.mode === 'delay' || entry.mode === 'random') && ps?.startedAt && ps?.totalDelayMs) {
      const elapsed = Date.now() - new Date(ps.startedAt).getTime();
      delayMs = Math.max(0, ps.totalDelayMs - elapsed);
    }

    // random 模式重启恢复（无 totalDelayMs）：生成新随机延迟与 startedAt 比较
    if (entry.mode === 'random' && !ps?.totalDelayMs && ps?.startedAt) {
      const elapsed = Date.now() - new Date(ps.startedAt).getTime();
      const freshDelay = this.randomDelay(entry.delayMin, entry.delayMax);
      if (freshDelay !== null) {
        delayMs = Math.max(0, freshDelay - elapsed);
      }
    }

    // random 模式 delayMs=0 表示延迟已过应立即触发，由后续 fireImmediately 处理
    if (delayMs === null || (delayMs <= 0 && entry.mode !== 'random')) {
      logger.warn(`[TimerManager] "${key}" 延迟无效 (mode=${entry.mode})`);
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
    const targets = (entry.target || 'user').split(',').map(t => t.trim()).filter(Boolean);

    // random 模式：生成下一周期的随机延迟（持久化后供重启恢复使用）
    const nextCycleDelayMs = (entry.mode === 'random')
      ? this.randomDelay(entry.delayMin, entry.delayMax) : undefined;

    const persistAfterTrigger = (executed: number) => {
      this.saveEntryState(key, {
        lastTriggeredAt: localISO(),
        executedCount: executed,
        startedAt: (entry.mode === 'delay' || entry.mode === 'random')
          ? localISO() : undefined,
        totalDelayMs: (entry.mode === 'delay')
          ? (parseInterval(entry.delay!) ?? delayMs ?? undefined)
          : (entry.mode === 'random' && nextCycleDelayMs != null)
            ? nextCycleDelayMs
            : undefined,
      });
    };

    const trigger = async () => {
      if (entry.mode === 'workday' && !isWorkday()) return;
      if (entry.mode === 'holiday' && !isHoliday()) return;
      if (!this.router) return;
      for (const target of targets) {
        try {
          logger.debug(`[TimerManager] 触发 "${key}" → ${target} (${modeLabel})`);
          await this.router.trigger(agentId, {
            hint: entry.hint, target,
            source: entry.source ?? entry.id, maxTurns: entry.maxTurns ?? 99999,
          });
        } catch (err: any) {
          logger.error(`[TimerManager] "${key}" → ${target} 失败: ${err.message}`);
        }
      }
    };

    const isRandom = entry.mode === 'random';

    // 记录初始状态（保留已有的 startedAt / totalDelayMs，避免每次重启重置时钟）
    this.saveEntryState(key, {
      executedCount: ps?.executedCount ?? 0,
      startedAt: (entry.mode === 'delay' || entry.mode === 'random')
        ? (ps?.startedAt ?? localISO())
        : undefined,
      totalDelayMs: (entry.mode === 'delay')
        ? (parseInterval(entry.delay!) ?? delayMs)
        : (entry.mode === 'random')
          ? (ps?.totalDelayMs ?? undefined)
          : undefined,
    });

    if (isRandom && remaining !== 1) {
      const isForever = remaining < 0;

      // 重启恢复：用持久化的 totalDelayMs 或新随机延迟判断是否已过触发时间
      const fireImmediately = ((): boolean => {
        if (!ps?.startedAt) return false;
        const elapsed = Date.now() - new Date(ps.startedAt).getTime();
        // 优先用已持久化的随机延迟；若未持久化则生成新的（兼容旧状态文件）
        const refDelay = ps?.totalDelayMs
          ? ps.totalDelayMs
          : this.randomDelay(entry.delayMin, entry.delayMax);
        return refDelay !== null && refDelay <= elapsed;
      })();

      const setupRandom = (skipFirstDelay: boolean) => {
        let c = remaining;
        const next = (isFirstCall: boolean) => {
          if (!isForever && c <= 0) {
            this.timers.delete(key);
            this.disableEntry(agentId, entry.id);
            logger.info(`[TimerManager] "${key}" 已完成${isForever ? '' : ' ' + remaining + ' 次'}，已自动禁用`);
            return;
          }
          // 首次调用：若 skipFirstDelay 则立即触发；否则用 delayMs（含持久化恢复的剩余时间）
          // 后续调用：生成新的随机延迟
          const d = isFirstCall
            ? (skipFirstDelay ? 0 : delayMs)
            : this.randomDelay(entry.delayMin, entry.delayMax);
          if (d === null) return;
          const t = setTimeout(async () => {
            await trigger();
            if (!isForever) c--;
            const s = this.timers.get(key);
            if (s) { s.remaining = isForever ? -1 : c; }
            const totalExecuted = (entry.repeatCount ?? 0) > 0 ? entry.repeatCount! - c : (ps?.executedCount ?? 0) + 1;
            persistAfterTrigger(totalExecuted);
            if (isForever || c > 0) next(false);
            else {
              this.timers.delete(key);
              this.disableEntry(agentId, entry.id);
              logger.info(`[TimerManager] "${key}" 已完成 ${remaining} 次，已自动禁用`);
            }
          }, d);
          this.timers.set(key, { timeout: t, remaining: isForever ? -1 : c });
        };
        next(true);
      };

      setupRandom(fireImmediately);
      if (fireImmediately) {
        logger.info(`[TimerManager] "${key}" (${modeLabel}, ${isForever ? '永久' : remaining + '次'}) [重启恢复：随机延迟已过，立即触发]`);
      } else {
        logger.info(`[TimerManager] "${key}" (${modeLabel}, ${isForever ? '永久' : remaining + '次'})`);
      }
    } else if (remaining === 1) {
      const t = setTimeout(async () => {
        await trigger();
        this.timers.delete(key);
        persistAfterTrigger((ps?.executedCount ?? 0) + 1);
        this.disableEntry(agentId, entry.id);
      }, delayMs);
      this.timers.set(key, { timeout: t, remaining: 1 });
      logger.info(`[TimerManager] "${key}" (${modeLabel}, 一次性, ${(delayMs/1000).toFixed(0)}s)`);
    } else if (remaining > 1) {
      // time/workday/holiday 模式：每次触发后重新计算到下次目标时间的延迟
      if (entry.mode === 'time' || entry.mode === 'workday' || entry.mode === 'holiday') {
        let c = remaining;
        const scheduleNext = () => {
          if (c <= 0) {
            this.timers.delete(key);
            this.disableEntry(agentId, entry.id);
            logger.info(`[TimerManager] "${key}" 已完成 ${remaining} 次，已自动禁用`);
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
        logger.info(`[TimerManager] "${key}" (${modeLabel}, ${remaining} 次, ${(delayMs!/1000).toFixed(0)}s → 下次重算)`);
      } else {
        let c = remaining;
        const t = setInterval(async () => {
          await trigger(); c--;
          const s = this.timers.get(key); if (s) s.remaining = c;
          const totalExecuted = entry.repeatCount! - c;
          persistAfterTrigger(totalExecuted);
          if (c <= 0) {
            clearInterval(t); this.timers.delete(key);
            this.disableEntry(agentId, entry.id);
            logger.info(`[TimerManager] "${key}" 已完成 ${remaining} 次，已自动禁用`);
          }
        }, delayMs);
        this.timers.set(key, { timeout: t, remaining: c });
        logger.info(`[TimerManager] "${key}" (${modeLabel}, ${remaining} 次, ${(delayMs/1000).toFixed(0)}s)`);
      }
    } else {
      // time/workday/holiday 模式：每次触发后重新计算到下次目标时间的延迟
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
        logger.info(`[TimerManager] "${key}" (${modeLabel}, 永久, ${(delayMs!/1000).toFixed(0)}s → 下次重算)`);
      } else {
        let execCount = ps?.executedCount ?? 0;
        const t = setInterval(async () => {
          await trigger();
          execCount++;
          persistAfterTrigger(execCount);
        }, delayMs);
        this.timers.set(key, { timeout: t, remaining: -1 });
        logger.info(`[TimerManager] "${key}" (${modeLabel}, 永久, ${(delayMs/1000).toFixed(0)}s)`);
      }
    }
  }

  private startAgent(agentId: string): void {
    const entries = this.entries.get(agentId);
    if (!entries || !this.router) return;
    for (const entry of entries) this.scheduleEntry(agentId, entry);
  }

  /** 启动所有定时器 */
  private startAll(): void {
    for (const agentId of this.entries.keys()) {
      this.startAgent(agentId);
    }
  }

  /** 停止单个 Agent 的定时器 */
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
    this.stopChime();
    for (const [key, state] of this.timers) {
      clearTimeout(state.timeout); clearInterval(state.timeout);
      logger.debug(`[TimerManager] 已停止 "${key}"`);
    }
    this.timers.clear();
  }

  // ============================================================
  // 全局报时机制
  // ============================================================

  /** 启动全局报时 */
  private startChime(): void {
    this.stopChime();
    const chime = getGlobalConfig().chime;
    if (!chime?.enabled || !chime.times?.length) return;

    // 每 30 秒检查一次是否到达报时时间
    this.chimeTimer = setInterval(() => this.checkChime(), 30_000);

    // 启动时立即检查一次（补偿启动时刻刚好踩点）
    this.checkChime();

    logger.info(`[TimerManager] 全局报时已启动，时间点：${chime.times.join(', ')}`);
  }

  /** 停止全局报时 */
  private stopChime(): void {
    if (this.chimeTimer) {
      clearInterval(this.chimeTimer);
      this.chimeTimer = null;
    }
    this.lastChimeMinute = null;
  }

  /** 检查当前时间是否需要报时 */
  private checkChime(): void {
    const chime = getGlobalConfig().chime;
    if (!chime?.enabled || !chime.times?.length) return;

    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const currentMinute = `${hh}:${mm}`;

    // 防止同一分钟重复触发
    if (this.lastChimeMinute === currentMinute) return;

    if (chime.times.includes(currentMinute)) {
      this.lastChimeMinute = currentMinute;
      this.fireChime(currentMinute);
    }
  }

  /** 向所有 Agent 发送报时通知 */
  private async fireChime(timeStr: string): Promise<void> {
    if (!this.router) return;

    const agentIds = this.router.getAgentIds();
    const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    const hint = `现在是 ${today} ${timeStr}。`;

    logger.info(`[TimerManager] 全局报时 ${timeStr}，向 ${agentIds.length} 个 Agent 发送通知`);

    // 并行触发所有 Agent
    const results = await Promise.allSettled(
      agentIds.map(agentId =>
        this.router!.trigger(agentId, {
          hint,
          source: `chime-${timeStr}`,
          target: agentId,
        })
      )
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        logger.error(`[TimerManager] 报时 ${timeStr} → ${agentIds[i]} 失败: ${r.reason?.message || r.reason}`);
      }
    }
  }
}

/** 全局单例 */
export const timerManager = new TimerManager();
