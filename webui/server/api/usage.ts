// ============================================================
// Token 用量 API —— GET /api/usage/tokens
// 读取 workspace/usage/token_*.jsonl 文件，返回聚合用量数据
//
// 性能优化：使用 usage_summary.json 快照缓存历史数据，
// 每次请求仅解析当天 JSONL，大幅提升响应速度。
// ============================================================

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalConfig } from '@core/config';

interface TokenRecord {
  timestamp: string;
  agent: string;
  counterpart: string;
  react_turns: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

interface AgentUsage {
  agent: string;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_react_turns: number;
  total_cache_hit: number;
  total_cache_miss: number;
  record_count: number;
  last_used: string;
}

interface DailyUsage {
  date: string;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  record_count: number;
}

interface OverallStats {
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_react_turns: number;
  total_cache_hit: number;
  total_cache_miss: number;
  total_records: number;
}

/** 快照文件结构 */
interface UsageSnapshot {
  generated_at: string;
  /** 快照覆盖的最后一个日期（不含当日） */
  last_date: string;
  overall: OverallStats;
  /** key = agent name */
  by_agent: Record<string, AgentUsage>;
  /** key = YYYY-MM-DD */
  by_day: Record<string, DailyUsage>;
}

/** 空统计初始值 */
function emptyOverall(): OverallStats {
  return {
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    total_tokens: 0,
    total_react_turns: 0,
    total_cache_hit: 0,
    total_cache_miss: 0,
    total_records: 0,
  };
}

/** 获取 usageDir 路径 */
function getUsageDir(): string {
  const config = getGlobalConfig();
  return path.join(path.dirname(config.sessionsDir), 'usage');
}

/** 获取快照文件路径 */
function getSnapshotPath(usageDir: string): string {
  return path.join(usageDir, 'usage_summary.json');
}

/** 今天的日期字符串 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 昨天的日期字符串 */
function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 解析单条 JSONL 记录并累加到统计对象 */
function accumulateRecord(record: TokenRecord, overall: OverallStats, agentMap: Map<string, AgentUsage>, dayMap: Map<string, DailyUsage>, date: string): void {
  overall.total_prompt_tokens += record.prompt_tokens;
  overall.total_completion_tokens += record.completion_tokens;
  overall.total_tokens += record.total_tokens;
  overall.total_react_turns += record.react_turns;
  overall.total_cache_hit += record.prompt_cache_hit_tokens ?? 0;
  overall.total_cache_miss += record.prompt_cache_miss_tokens ?? 0;
  overall.total_records++;

  let au = agentMap.get(record.agent);
  if (!au) {
    au = { agent: record.agent, total_prompt_tokens: 0, total_completion_tokens: 0, total_tokens: 0, total_react_turns: 0, total_cache_hit: 0, total_cache_miss: 0, record_count: 0, last_used: record.timestamp };
    agentMap.set(record.agent, au);
  }
  au.total_prompt_tokens += record.prompt_tokens;
  au.total_completion_tokens += record.completion_tokens;
  au.total_tokens += record.total_tokens;
  au.total_react_turns += record.react_turns;
  au.total_cache_hit += record.prompt_cache_hit_tokens ?? 0;
  au.total_cache_miss += record.prompt_cache_miss_tokens ?? 0;
  au.record_count++;
  if (record.timestamp > au.last_used) au.last_used = record.timestamp;

  let du = dayMap.get(date);
  if (!du) {
    du = { date, total_prompt_tokens: 0, total_completion_tokens: 0, total_tokens: 0, record_count: 0 };
    dayMap.set(date, du);
  }
  du.total_prompt_tokens += record.prompt_tokens;
  du.total_completion_tokens += record.completion_tokens;
  du.total_tokens += record.total_tokens;
  du.record_count++;
}

/** 解析一个 JSONL 文件并累加 */
function parseJsonlFile(filePath: string, date: string, overall: OverallStats, agentMap: Map<string, AgentUsage>, dayMap: Map<string, DailyUsage>): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.trim().split('\n')) {
    if (!line) continue;
    try {
      accumulateRecord(JSON.parse(line) as TokenRecord, overall, agentMap, dayMap, date);
    } catch { /* skip malformed */ }
  }
}

/** 生成快照：解析所有非今日的 JSONL 文件并写入 usage_summary.json */
function buildSnapshot(usageDir: string): UsageSnapshot | null {
  const files = fs.readdirSync(usageDir)
    .filter(f => f.startsWith('token_') && f.endsWith('.jsonl'))
    .sort();
  if (files.length === 0) return null;

  const todayStr = today();
  const overall = emptyOverall();
  const agentMap = new Map<string, AgentUsage>();
  const dayMap = new Map<string, DailyUsage>();
  let lastDate = '';

  for (const file of files) {
    const date = file.replace('token_', '').replace('.jsonl', '');
    // 只索引非今日文件（今日数据实时解析）
    if (date >= todayStr) continue;
    parseJsonlFile(path.join(usageDir, file), date, overall, agentMap, dayMap);
    lastDate = date;
  }

  const snapshot: UsageSnapshot = {
    generated_at: new Date().toISOString(),
    last_date: lastDate,
    overall,
    by_agent: Object.fromEntries(agentMap),
    by_day: Object.fromEntries(dayMap),
  };

  fs.writeFileSync(getSnapshotPath(usageDir), JSON.stringify(snapshot), 'utf-8');
  console.log(`[usage] 快照已更新，覆盖至 ${lastDate}，共 ${overall.total_records} 条记录`);
  return snapshot;
}

/**
 * 找出快照 last_date（含）到目标日期（含）之间，实际存在 JSONL 文件的日期列表。
 * 用于增量更新——只解析缺口日期的文件。
 */
function findMissingDates(usageDir: string, fromDate: string, toDate: string): string[] {
  const existingFiles = new Set(
    fs.readdirSync(usageDir).filter(f => f.startsWith('token_') && f.endsWith('.jsonl'))
  );
  const result: string[] = [];
  const from = new Date(fromDate);
  const to = new Date(toDate);
  // 从 fromDate 后一天开始（fromDate 本身已在快照中）
  from.setDate(from.getDate() + 1);
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    if (existingFiles.has(`token_${dateStr}.jsonl`)) {
      result.push(dateStr);
    }
  }
  return result;
}

/**
 * 将快照中的 Map 数据原地恢复为可变对象，以便增量累加。
 * 注意：这里浅拷贝 overall 和重建 Map，避免修改原始快照对象。
 */
function snapshotToMutable(snap: UsageSnapshot): {
  overall: OverallStats;
  agentMap: Map<string, AgentUsage>;
  dayMap: Map<string, DailyUsage>;
} {
  return {
    overall: { ...snap.overall },
    agentMap: new Map(Object.entries(snap.by_agent)),
    dayMap: new Map(Object.entries(snap.by_day)),
  };
}

/** 将可变统计写回快照对象并持久化 */
function saveSnapshot(
  usageDir: string, snap: UsageSnapshot,
  overall: OverallStats, agentMap: Map<string, AgentUsage>, dayMap: Map<string, DailyUsage>,
  newLastDate: string,
): void {
  snap.overall = overall;
  snap.by_agent = Object.fromEntries(agentMap);
  snap.by_day = Object.fromEntries(dayMap);
  snap.last_date = newLastDate;
  snap.generated_at = new Date().toISOString();
  fs.writeFileSync(getSnapshotPath(usageDir), JSON.stringify(snap), 'utf-8');
}

/** 加载快照，若过期则增量更新（只解析缺口日期的 JSONL），避免全量重建 */
function loadSnapshot(usageDir: string): UsageSnapshot | null {
  const snapPath = getSnapshotPath(usageDir);

  // 首次运行：全量构建
  if (!fs.existsSync(snapPath)) {
    return buildSnapshot(usageDir);
  }

  let snap: UsageSnapshot;
  try {
    snap = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
  } catch {
    // 快照损坏，全量重建
    return buildSnapshot(usageDir);
  }

  const yest = yesterday();
  if (!snap.last_date || snap.last_date >= yest) {
    // 快照已覆盖到昨天，无需更新
    return snap;
  }

  // ── 增量更新：只解析缺口日期 ──
  const missingDates = findMissingDates(usageDir, snap.last_date, yest);
  if (missingDates.length === 0) {
    // 缺口日期没有实际 JSONL 文件，仅推进 last_date
    snap.last_date = yest;
    snap.generated_at = new Date().toISOString();
    fs.writeFileSync(snapPath, JSON.stringify(snap), 'utf-8');
    return snap;
  }

  const { overall, agentMap, dayMap } = snapshotToMutable(snap);

  for (const date of missingDates) {
    parseJsonlFile(path.join(usageDir, `token_${date}.jsonl`), date, overall, agentMap, dayMap);
  }

  const newLastDate = missingDates[missingDates.length - 1];
  saveSnapshot(usageDir, snap, overall, agentMap, dayMap, newLastDate);
  console.log(`[usage] 快照增量更新：+${missingDates.length} 天 (${missingDates[0]} → ${newLastDate})，共 ${overall.total_records} 条`);
  return snap;
}

/** 将快照 + 当日实时数据合并为最终响应 */
function mergeWithToday(snap: UsageSnapshot | null, usageDir: string) {
  const todayStr = today();
  const overall: OverallStats = snap ? { ...snap.overall } : emptyOverall();
  const agentMap = new Map<string, AgentUsage>(
    snap ? Object.entries(snap.by_agent) : []
  );
  const dayMap = new Map<string, DailyUsage>(
    snap ? Object.entries(snap.by_day) : []
  );

  // 解析今日 JSONL（如果存在）
  const todayFile = path.join(usageDir, `token_${todayStr}.jsonl`);
  if (fs.existsSync(todayFile)) {
    parseJsonlFile(todayFile, todayStr, overall, agentMap, dayMap);
  }

  return {
    overall,
    by_agent: [...agentMap.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    by_day: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export function createUsageRouter(): Router {
  const router = Router();

  router.get('/tokens', (_req: Request, res: Response) => {
    try {
      const usageDir = getUsageDir();

      if (!fs.existsSync(usageDir)) {
        return res.json({
          overall: emptyOverall(),
          by_agent: [],
          by_day: [],
        });
      }

      const snap = loadSnapshot(usageDir);
      const summary = mergeWithToday(snap, usageDir);
      res.json(summary);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to read token usage data' });
    }
  });

  // POST /api/usage/refresh —— 强制重建快照
  router.post('/refresh', (_req: Request, res: Response) => {
    try {
      const usageDir = getUsageDir();
      if (!fs.existsSync(usageDir)) {
        return res.json({ ok: true, message: '无数据目录' });
      }
      const snap = buildSnapshot(usageDir);
      res.json({ ok: true, last_date: snap?.last_date, records: snap?.overall.total_records });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
