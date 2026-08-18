// ============================================================
// Token 用量 API —— GET /api/usage/tokens
// 读取 workspace/usage/token_*.jsonl 文件，返回聚合用量数据
//
// 性能优化：使用 usage_summary.json 快照缓存历史数据，
// 每次请求仅解析当天 JSONL，大幅提升响应速度。
//
// 日期范围过滤（GET /api/usage/tokens?days=30 或 ?from=&to=）：
//   · 传入范围时按日文件名直接聚合该区间的 JSONL（按日分文件，
//     天然支持范围裁剪，量级 ~几十 KB/天，无需快照）；
//   · 未传范围时走全量快照路径（历史行为不变）。
//   · 响应附 range: { from, to }（数据实际覆盖的日期区间，供前端展示）。
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
  /** 兼容字段：部分版本写入 model 而非 llm */
  model?: string;
  /** ReAct 步数（一次 LLM 请求 + 其工具执行） */
  react_steps?: number;
  /** 兼容字段：旧版写入 react_turns */
  react_turns?: number;
  /** 最后一次 LLM 调用的输入（多步 run 只含末步；整次累计在 accumulated_prompt_tokens） */
  prompt_tokens: number;
  /** 整次 run 全部步输出之和（写入端 accumulateUsage 逐步累加） */
  completion_tokens: number;
  /** 最后一次 LLM 调用的 total（多步 run 只含末步） */
  total_tokens: number;
  /** 整次 run 全部步输入之和（= cache_hit + cache_miss；旧数据缺省 → 回退 prompt_tokens） */
  accumulated_prompt_tokens?: number;
  /** 整次 run 全部步 total 之和（旧数据缺省 → 回退 total_tokens） */
  accumulated_total_tokens?: number;
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
  /** 最近一次 run 末步输入（≈ 该 Agent 当前上下文规模，归档/容量判断参照） */
  last_prompt_tokens?: number;
  /** 最近一次 run 末步 total */
  last_total_tokens?: number;
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
  /** 缓存命中的 Token 数（旧快照可能缺失） */
  total_cache_hit?: number;
  /** 缓存未命中的 Token 数（旧快照可能缺失） */
  total_cache_miss?: number;
  /** 当日各 run 末步输入合计（上下文处理量口径，旧快照可能缺失） */
  last_step_prompt_tokens?: number;
  /** 当日各 run 末步 total 合计（旧快照可能缺失） */
  last_step_total_tokens?: number;
}

/** 按日期 × LLM 模型聚合的用量（前端用量统计堆叠图「按模型」视图） */
interface DayLlmUsage {
  date: string;
  llm: string;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
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
  /** 各 run 末步输入合计（上下文处理量口径；归档/容量判断参照） */
  last_step_prompt_tokens?: number;
  /** 各 run 末步 total 合计 */
  last_step_total_tokens?: number;
}

/** 快照文件结构 */
interface UsageSnapshot {
  /** 聚合口径版本：2 = 多步累计（accumulated_*）；不一致触发全量重建 */
  version: number;
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
  /** key = `date|llm`（按日期 × 模型聚合；旧快照缺失时触发重建） */
  by_day_llm?: Record<string, DayLlmUsage>;
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
    last_step_prompt_tokens: 0,
    last_step_total_tokens: 0,
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

/** 快照聚合口径版本：3 = 多步累计 + last step 口径并存；
 *  2 = 仅多步累计；1/缺省 = 末步误计。不一致时全量重建 */
const SNAPSHOT_VERSION = 3;

/** 昨天的日期字符串 */
function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 解析单条 JSONL 记录并累加到统计对象 */
function accumulateRecord(record: TokenRecord, overall: OverallStats, agentMap: Map<string, AgentUsage>, dayMap: Map<string, DailyUsage>, llmMap: Map<string, LlmUsage>, pairMap: Map<string, PairUsage>, date: string, dayLlmMap?: Map<string, DayLlmUsage>): void {
  // ── 口径：以「整次 run 全部 step 之和」计费（与官网对账一致）。
  // 写入端（agent-loop accumulateUsage）prompt_tokens/total_tokens 为最后一次调用值，
  // 多步累计在 accumulated_* 字段；completion_tokens / cache_hit / cache_miss 本身即累计值。
  // 旧记录（单步时代）无 accumulated_* → 回退字段值即全量。
  const accPrompt = record.accumulated_prompt_tokens ?? record.prompt_tokens;
  const accCompletion = record.completion_tokens;
  const accTotal = record.accumulated_total_tokens ?? record.total_tokens;

  overall.total_prompt_tokens += accPrompt;
  overall.total_completion_tokens += accCompletion;
  overall.total_tokens += accTotal;
  // last step 口径单独累计（≈ 上下文处理量；供归档/容量判断，勿与计费口径混用）
  overall.last_step_prompt_tokens = (overall.last_step_prompt_tokens ?? 0) + record.prompt_tokens;
  overall.last_step_total_tokens = (overall.last_step_total_tokens ?? 0) + record.total_tokens;
  const steps = record.react_steps ?? record.react_turns ?? 0;
  overall.total_react_steps += steps;
  overall.total_cache_hit += record.prompt_cache_hit_tokens ?? 0;
  overall.total_cache_miss += record.prompt_cache_miss_tokens ?? 0;
  if ((record.prompt_cache_hit_tokens ?? 0) > 0) overall.total_cache_hit_count++;
  if ((record.prompt_cache_miss_tokens ?? 0) > 0) overall.total_cache_miss_count++;
  overall.total_records++;

  let au = agentMap.get(record.agent);
  if (!au) {
    au = {
      agent: record.agent,
      total_prompt_tokens: 0, total_completion_tokens: 0, total_tokens: 0, total_react_steps: 0,
      total_cache_hit: 0, total_cache_miss: 0, total_cache_hit_count: 0, total_cache_miss_count: 0,
      record_count: 0, last_used: record.timestamp,
      // 创建即记末步值（首条记录 timestamp === last_used，不会再走下方 > 分支）
      last_prompt_tokens: record.prompt_tokens, last_total_tokens: record.total_tokens,
    };
    agentMap.set(record.agent, au);
  }
  au.total_prompt_tokens += accPrompt;
  au.total_completion_tokens += accCompletion;
  au.total_tokens += accTotal;
  au.total_react_steps += steps;
  au.total_cache_hit += record.prompt_cache_hit_tokens ?? 0;
  au.total_cache_miss += record.prompt_cache_miss_tokens ?? 0;
  if ((record.prompt_cache_hit_tokens ?? 0) > 0) au.total_cache_hit_count++;
  if ((record.prompt_cache_miss_tokens ?? 0) > 0) au.total_cache_miss_count++;
  au.record_count++;
  if (record.timestamp > au.last_used) {
    au.last_used = record.timestamp;
    // 最近一次 run 的末步值（≈ 该 Agent 当前上下文规模）
    au.last_prompt_tokens = record.prompt_tokens;
    au.last_total_tokens = record.total_tokens;
  }

  let du = dayMap.get(date);
  if (!du) {
    du = { date, total_prompt_tokens: 0, total_completion_tokens: 0, total_tokens: 0, record_count: 0, total_cache_hit: 0, total_cache_miss: 0, last_step_prompt_tokens: 0, last_step_total_tokens: 0 };
    dayMap.set(date, du);
  }
  du.total_prompt_tokens += accPrompt;
  du.total_completion_tokens += accCompletion;
  du.total_tokens += accTotal;
  du.total_cache_hit = (du.total_cache_hit ?? 0) + (record.prompt_cache_hit_tokens ?? 0);
  du.total_cache_miss = (du.total_cache_miss ?? 0) + (record.prompt_cache_miss_tokens ?? 0);
  du.last_step_prompt_tokens = (du.last_step_prompt_tokens ?? 0) + record.prompt_tokens;
  du.last_step_total_tokens = (du.last_step_total_tokens ?? 0) + record.total_tokens;
  du.record_count++;

  // 按 LLM 聚合（兼容旧数据：llm 缺失时回退到 model，仍缺失 → "unknown"）
  const llmKey = record.llm || record.model || 'unknown';
  let lu = llmMap.get(llmKey);
  if (!lu) {
    lu = { llm: llmKey, total_prompt_tokens: 0, total_completion_tokens: 0, total_tokens: 0, total_react_steps: 0, total_cache_hit: 0, total_cache_miss: 0, total_cache_hit_count: 0, total_cache_miss_count: 0, record_count: 0, last_used: record.timestamp };
    llmMap.set(llmKey, lu);
  }
  lu.total_prompt_tokens += accPrompt;
  lu.total_completion_tokens += accCompletion;
  lu.total_tokens += accTotal;
  lu.total_react_steps += steps;
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
    pu.total_tokens += accTotal;
    pu.record_count++;
  }

  // 按日期 × 模型聚合（前端「按模型」堆叠图）
  if (dayLlmMap) {
    const key = `${date}|${llmKey}`;
    let dl = dayLlmMap.get(key);
    if (!dl) {
      dl = { date, llm: llmKey, total_prompt_tokens: 0, total_completion_tokens: 0, total_tokens: 0 };
      dayLlmMap.set(key, dl);
    }
    dl.total_prompt_tokens += accPrompt;
    dl.total_completion_tokens += accCompletion;
    dl.total_tokens += accTotal;
  }
}

/** 解析一个 JSONL 文件并累加 */
function parseJsonlFile(filePath: string, date: string, overall: OverallStats, agentMap: Map<string, AgentUsage>, dayMap: Map<string, DailyUsage>, llmMap: Map<string, LlmUsage>, pairMap: Map<string, PairUsage>, dayLlmMap?: Map<string, DayLlmUsage>): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.trim().split('\n')) {
    if (!line) continue;
    try {
      accumulateRecord(JSON.parse(line) as TokenRecord, overall, agentMap, dayMap, llmMap, pairMap, date, dayLlmMap);
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
  const dayLlmMap = new Map<string, DayLlmUsage>();
  let lastDate = '';

  for (const file of files) {
    const date = file.replace('token_', '').replace('.jsonl', '');
    // 只索引非今日文件（今日数据实时解析）
    if (date >= todayStr) continue;
    parseJsonlFile(path.join(usageDir, file), date, overall, agentMap, dayMap, llmMap, pairMap, dayLlmMap);
    lastDate = date;
  }

  const snapshot: UsageSnapshot = {
    version: SNAPSHOT_VERSION,
    generated_at: new Date().toISOString(),
    last_date: lastDate,
    overall,
    by_agent: Object.fromEntries(agentMap),
    by_day: Object.fromEntries(dayMap),
    by_llm: Object.fromEntries(llmMap),
    by_pair: Object.fromEntries(pairMap),
    by_day_llm: Object.fromEntries(dayLlmMap),
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
  dayLlmMap: Map<string, DayLlmUsage>;
} {
  return {
    overall: { ...snap.overall },
    agentMap: new Map(Object.entries(snap.by_agent)),
    dayMap: new Map(Object.entries(snap.by_day)),
    llmMap: new Map(Object.entries(snap.by_llm ?? {})),
    pairMap: new Map(Object.entries(snap.by_pair ?? {})),
    dayLlmMap: new Map(Object.entries(snap.by_day_llm ?? {})),
  };
}

/** 将可变统计写回快照对象并持久化 */
function saveSnapshot(
  usageDir: string, snap: UsageSnapshot,
  overall: OverallStats, agentMap: Map<string, AgentUsage>, dayMap: Map<string, DailyUsage>, llmMap: Map<string, LlmUsage>, pairMap: Map<string, PairUsage>, dayLlmMap: Map<string, DayLlmUsage>,
  newLastDate: string,
): void {
  snap.overall = overall;
  snap.by_agent = Object.fromEntries(agentMap);
  snap.by_day = Object.fromEntries(dayMap);
  snap.by_llm = Object.fromEntries(llmMap);
  snap.by_pair = Object.fromEntries(pairMap);
  snap.by_day_llm = Object.fromEntries(dayLlmMap);
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

  // 旧版快照（缺 by_day_llm 或口径版本不一致）→ 一次性全量重建
  if (!snap.by_day_llm || snap.version !== SNAPSHOT_VERSION) {
    logger.info(`[usage] 检测到旧版快照（version=${snap.version ?? 1}），按最新口径全量重建`);
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

  const { overall, agentMap, dayMap, llmMap, pairMap, dayLlmMap } = snapshotToMutable(snap);

  for (const date of missingDates) {
    parseJsonlFile(path.join(usageDir, `token_${date}.jsonl`), date, overall, agentMap, dayMap, llmMap, pairMap, dayLlmMap);
  }

  const newLastDate = missingDates[missingDates.length - 1];
  saveSnapshot(usageDir, snap, overall, agentMap, dayMap, llmMap, pairMap, dayLlmMap, newLastDate);
  logger.info(`[usage] 快照增量更新：+${missingDates.length} 天 (${missingDates[0]} → ${newLastDate})，共 ${overall.total_records} 条`);
  return snap;
}

/** 将快照 + 当日实时数据合并为最终响应（range = 数据实际覆盖区间） */
function mergeWithToday(snap: UsageSnapshot | null, usageDir: string): UsageResponse {
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
  const dayLlmMap = new Map<string, DayLlmUsage>(
    snap ? Object.entries(snap.by_day_llm ?? {}) : []
  );

  // 解析今日 JSONL（如果存在）
  const todayFile = path.join(usageDir, `token_${todayStr}.jsonl`);
  if (fs.existsSync(todayFile)) {
    parseJsonlFile(todayFile, todayStr, overall, agentMap, dayMap, llmMap, pairMap, dayLlmMap);
  }

  const dayKeys = [...dayMap.keys()].sort();

  return {
    overall,
    by_agent: [...agentMap.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    by_day: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    by_llm: [...llmMap.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    by_pair: [...pairMap.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    by_day_llm: sortDayLlm([...dayLlmMap.values()]),
    range: { from: dayKeys[0] ?? null, to: dayKeys[dayKeys.length - 1] ?? null },
  };
}

/** 合并后的最终响应结构（range = 数据实际覆盖的日期区间） */
interface UsageResponse {
  overall: OverallStats;
  by_agent: AgentUsage[];
  by_day: DailyUsage[];
  by_llm: LlmUsage[];
  by_pair: PairUsage[];
  /** 按日期 × 模型聚合（「按模型」堆叠图） */
  by_day_llm: DayLlmUsage[];
  range: { from: string | null; to: string | null };
}

/** by_day_llm 排序输出（日期升序） */
function sortDayLlm(entries: DayLlmUsage[]): DayLlmUsage[] {
  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

/** 日期字符串 YYYY-MM-DD 校验 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 解析查询参数为聚合范围 [from, to]（含两端）。
 * 支持 ?days=N（最近 N 天，含今日）或 ?from=YYYY-MM-DD&to=YYYY-MM-DD；
 * 均未提供时返回 null（→ 全量快照路径）。非法值一律忽略回退。
 */
function parseRangeQuery(query: Record<string, unknown>): { from: string; to: string } | null {
  let from: string | undefined;
  let to: string | undefined;

  const daysRaw = query.days;
  if (typeof daysRaw === 'string' && daysRaw.trim() !== '') {
    const days = Number.parseInt(daysRaw, 10);
    if (Number.isFinite(days) && days > 0 && days <= 3660) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - (days - 1));
      from = d.toISOString().slice(0, 10);
      to = today();
    }
  }
  const qFrom = query.from;
  if (typeof qFrom === 'string' && DATE_RE.test(qFrom) && !Number.isNaN(Date.parse(qFrom))) from = qFrom;
  const qTo = query.to;
  if (typeof qTo === 'string' && DATE_RE.test(qTo) && !Number.isNaN(Date.parse(qTo))) to = qTo;

  if (!from && !to) return null;
  if (!to) to = today();
  if (!from) from = '0000-01-01'; // 仅给 to：从最早文件起
  if (from > to) [from, to] = [to, from]; // 顺序颠倒自动交换
  return { from, to };
}

/** 聚合指定日期区间（按日文件名过滤，含两端） */
function aggregateRange(usageDir: string, from: string, to: string): UsageResponse {
  const overall = emptyOverall();
  const agentMap = new Map<string, AgentUsage>();
  const dayMap = new Map<string, DailyUsage>();
  const llmMap = new Map<string, LlmUsage>();
  const pairMap = new Map<string, PairUsage>();
  const dayLlmMap = new Map<string, DayLlmUsage>();
  let earliest: string | null = null;
  let latest: string | null = null;

  const files = fs.readdirSync(usageDir)
    .filter(f => f.startsWith('token_') && f.endsWith('.jsonl'))
    .sort();
  for (const file of files) {
    const date = file.slice('token_'.length, -'.jsonl'.length);
    if (date < from || date > to) continue;
    parseJsonlFile(path.join(usageDir, file), date, overall, agentMap, dayMap, llmMap, pairMap, dayLlmMap);
    if (!earliest) earliest = date;
    latest = date;
  }

  return {
    overall,
    by_agent: [...agentMap.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    by_day: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    by_llm: [...llmMap.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    by_pair: [...pairMap.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    by_day_llm: sortDayLlm([...dayLlmMap.values()]),
    range: { from: earliest, to: latest },
  };
}

export function createUsageRouter(): Router {
  const router = Router();

  router.get('/tokens', (req: Request, res: Response) => {
    try {
      const usageDir = getUsageDir();

      if (!fs.existsSync(usageDir)) {
        return res.json({
          overall: emptyOverall(),
          by_agent: [],
          by_day: [],
          by_llm: [],
          by_pair: [],
          by_day_llm: [],
          range: { from: null, to: null },
        } satisfies UsageResponse);
      }

      // 日期范围过滤：有范围 → 直接按日文件聚合（不走全量快照）
      const range = parseRangeQuery(req.query as Record<string, unknown>);
      if (range) {
        return res.json(aggregateRange(usageDir, range.from, range.to));
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
