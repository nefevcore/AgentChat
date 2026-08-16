// ============================================================
// Token 用量 API —— GET /api/usage/tokens
// 读取 workspace/usage/token_*.jsonl 文件，返回聚合用量数据
//
// 性能优化：使用 usage_summary.json 快照缓存历史数据，
// 每次请求仅解析当天 JSONL，大幅提升响应速度。
// ============================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { configService } from '../config-service';
import { createLogger } from '@agentchat/util';
const logger = createLogger('[server:usage]');

interface TokenRecord {
  timestamp: string;
  agent: string;
  counterpart: string;
  /** LLM 标识（provider/model），按模型统计用；旧数据无此字段 */
  llm?: string;
  /** ReAct 步数（一次 LLM 请求 + 其工具执行） */
  react_steps: number;
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
  total_react_steps: number;
  /** 缓存命中的 Token 数（累计） */
  total_cache_hit: number;
  /** 缓存未命中的 Token 数（累计） */
  total_cache_miss: number;
  /** 有缓存命中的记录数（次数） */
  total_cache_hit_count: number;
  /** 有缓存未命中的记录数（次数） */
  total_cache_miss_count: number;
  record_count: number;
  last_used: string;
}

/** 按 LLM 模型聚合的用量 */
interface LlmUsage {
  llm: string;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_react_steps: number;
  total_cache_hit: number;
  total_cache_miss: number;
  total_cache_hit_count: number;
  total_cache_miss_count: number;
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

/** 按 agent 对（1v1 会话）聚合的用量，用于云图连接线 */
interface PairUsage {
  a: string;
  b: string;
  total_tokens: number;
  record_count: number;
}

interface OverallStats {
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_react_steps: number;
  /** 缓存命中的 Token 数（累计） */
  total_cache_hit: number;
  /** 缓存未命中的 Token 数（累计） */
  total_cache_miss: number;
  /** 有缓存命中的记录数（次数），与 total_records 可比 */
  total_cache_hit_count: number;
  /** 有缓存未命中的记录数（次数） */
  total_cache_miss_count: number;
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
  /** key = llm 标识 */
  by_llm: Record<string, LlmUsage>;
  /** key = 排序后的 `a|b`（agent 对） */
  by_pair: Record<string, PairUsage>;
}

/** 空统计初始值 */
function emptyOverall(): OverallStats {
  return {
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    total_tokens: 0,
    total_react_steps: 0,
    total_cache_hit: 0,
    total_cache_miss: 0,
    total_cache_hit_count: 0,
    total_cache_miss_count: 0,
    total_records: 0,
  };
}

/** 获取 usageDir 路径 */
function getUsageDir(): string {
  const config = configService.getGlobalConfig();
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
function accumulateRecord(record: TokenRecord, overall: OverallStats, agentMap: Map<string, AgentUsage>, dayMap: Map<string, DailyUsage>, llmMap: Map<string, LlmUsage>, pairMap: Map<string, PairUsage>, date: string): void {
  overall.total_prompt_tokens += record.prompt_tokens;
  overall.total_completion_tokens += record.completion_tokens;
  overall.total_tokens += record.total_tokens;
  overall.total_react_steps += record.react_steps;
  overall.total_cache_hit += record.prompt_cache_hit_tokens ?? 0;
  overall.total_cache_miss += record.prompt_cache_miss_tokens ?? 0;
  if ((record.prompt_cache_hit_tokens ?? 0) > 0) overall.total_cache_hit_count++;
  if ((record.prompt_cache_miss_tokens ?? 0) > 0) overall.total_cache_miss_count++;
  overall.total_records++;

  let au = agentMap.get(record.agent);
  if (!au) {
    au = { agent: record.agent, total_prompt_tokens: 0, total_completion_tokens: 0, total_tokens: 0, total_react_steps: 0, total_cache_hit: 0, total_cache_miss: 0, total_cache_hit_count: 0, total_cache_miss_count: 0, record_count: 0, last_used: record.timestamp };
    agentMap.set(record.agent, au);
  }
  au.total_prompt_tokens += record.prompt_tokens;
  au.total_completion_tokens += record.completion_tokens;
  au.total_tokens += record.total_tokens;
  au.total_react_steps += record.react_steps;
  au.total_cache_hit += record.prompt_cache_hit_tokens ?? 0;
  au.total_cache_miss += record.prompt_cache_miss_tokens ?? 0;
  if ((record.prompt_cache_hit_tokens ?? 0) > 0) au.total_cache_hit_count++;
  if ((record.prompt_cache_miss_tokens ?? 0) > 0) au.total_cache_miss_count++;
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

  // 按 LLM 聚合（旧数据无 llm 字段 → 归入 "unknown"）
  const llmKey = record.llm || 'unknown';
  let lu = llmMap.get(llmKey);
  if (!lu) {
    lu = { llm: llmKey, total_prompt_tokens: 0, total_completion_tokens: 0, total_tokens: 0, total_react_steps: 0, total_cache_hit: 0, total_cache_miss: 0, total_cache_hit_count: 0, total_cache_miss_count: 0, record_count: 0, last_used: record.timestamp };
    llmMap.set(llmKey, lu);
  }
  lu.total_prompt_tokens += record.prompt_tokens;
  lu.total_completion_tokens += record.completion_tokens;
  lu.total_tokens += record.total_tokens;
  lu.total_react_steps += record.react_steps;
  lu.total_cache_hit += record.prompt_cache_hit_tokens ?? 0;
  lu.total_cache_miss += record.prompt_cache_miss_tokens ?? 0;
  if ((record.prompt_cache_hit_tokens ?? 0) > 0) lu.total_cache_hit_count++;
  if ((record.prompt_cache_miss_tokens ?? 0) > 0) lu.total_cache_miss_count++;
  lu.record_count++;
  if (record.timestamp > lu.last_used) lu.last_used = record.timestamp;

  // 按 agent 对聚合（未知 '?' 跳过；群聊 group~ / group: / room: 保留，供前端区分或后续群聊图谱）
  const cp = record.counterpart;
  if (cp && cp !== '?') {
    const parts = [record.agent, cp].sort();
    const key = `${parts[0]}|${parts[1]}`;
    let pu = pairMap.get(key);
    if (!pu) {
      pu = { a: parts[0], b: parts[1], total_tokens: 0, record_count: 0 };
      pairMap.set(key, pu);
    }
    pu.total_tokens += record.total_tokens;
    pu.record_count++;
  }
}

/** 解析一个 JSONL 文件并累加 */
function parseJsonlFile(filePath: string, date: string, overall: OverallStats, agentMap: Map<string, AgentUsage>, dayMap: Map<string, DailyUsage>, llmMap: Map<string, LlmUsage>, pairMap: Map<string, PairUsage>): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.trim().split('\n')) {
    if (!line) continue;
    try {
      accumulateRecord(JSON.parse(line) as TokenRecord, overall, agentMap, dayMap, llmMap, pairMap, date);
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
  const llmMap = new Map<string, LlmUsage>();
  const pairMap = new Map<string, PairUsage>();
  let lastDate = '';

  for (const file of files) {
    const date = file.replace('token_', '').replace('.jsonl', '');
    // 只索引非今日文件（今日数据实时解析）
    if (date >= todayStr) continue;
    parseJsonlFile(path.join(usageDir, file), date, overall, agentMap, dayMap, llmMap, pairMap);
    lastDate = date;
  }

  const snapshot: UsageSnapshot = {
    generated_at: new Date().toISOString(),
    last_date: lastDate,
    overall,
    by_agent: Object.fromEntries(agentMap),
    by_day: Object.fromEntries(dayMap),
    by_llm: Object.fromEntries(llmMap),
    by_pair: Object.fromEntries(pairMap),
  };

  fs.writeFileSync(getSnapshotPath(usageDir), JSON.stringify(snapshot), 'utf-8');
  logger.info(`[usage] 快照已更新，覆盖至 ${lastDate}，共 ${overall.total_records} 条记录`);
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
  llmMap: Map<string, LlmUsage>;
  pairMap: Map<string, PairUsage>;
} {
  return {
    overall: { ...snap.overall },
    agentMap: new Map(Object.entries(snap.by_agent)),
    dayMap: new Map(Object.entries(snap.by_day)),
    llmMap: new Map(Object.entries(snap.by_llm ?? {})),
    pairMap: new Map(Object.entries(snap.by_pair ?? {})),
  };
}

/** 将可变统计写回快照对象并持久化 */
function saveSnapshot(
  usageDir: string, snap: UsageSnapshot,
  overall: OverallStats, agentMap: Map<string, AgentUsage>, dayMap: Map<string, DailyUsage>, llmMap: Map<string, LlmUsage>, pairMap: Map<string, PairUsage>,
  newLastDate: string,
): void {
  snap.overall = overall;
  snap.by_agent = Object.fromEntries(agentMap);
  snap.by_day = Object.fromEntries(dayMap);
  snap.by_llm = Object.fromEntries(llmMap);
  snap.by_pair = Object.fromEntries(pairMap);
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

  const { overall, agentMap, dayMap, llmMap, pairMap } = snapshotToMutable(snap);

  for (const date of missingDates) {
    parseJsonlFile(path.join(usageDir, `token_${date}.jsonl`), date, overall, agentMap, dayMap, llmMap, pairMap);
  }

  const newLastDate = missingDates[missingDates.length - 1];
  saveSnapshot(usageDir, snap, overall, agentMap, dayMap, llmMap, pairMap, newLastDate);
  logger.info(`[usage] 快照增量更新：+${missingDates.length} 天 (${missingDates[0]} → ${newLastDate})，共 ${overall.total_records} 条`);
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
  const llmMap = new Map<string, LlmUsage>(
    snap ? Object.entries(snap.by_llm ?? {}) : []
  );
  const pairMap = new Map<string, PairUsage>(
    snap ? Object.entries(snap.by_pair ?? {}) : []
  );

  // 解析今日 JSONL（如果存在）
  const todayFile = path.join(usageDir, `token_${todayStr}.jsonl`);
  if (fs.existsSync(todayFile)) {
    parseJsonlFile(todayFile, todayStr, overall, agentMap, dayMap, llmMap, pairMap);
  }

  return {
    overall,
    by_agent: [...agentMap.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    by_day: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    by_llm: [...llmMap.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    by_pair: [...pairMap.values()].sort((a, b) => b.total_tokens - a.total_tokens),
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
          by_llm: [],
          by_pair: [],
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
