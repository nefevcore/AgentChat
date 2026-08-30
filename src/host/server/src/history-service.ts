// ============================================================
// HistoryService —— 消息历史/归档服务（L4 门面）
//
// webui/TUI/Desktop 统一经此查询 1:1 会话历史、删除消息、标记记忆审查。
// 内部实现走 L3 持久化约定（<ws>/sessions/<dialogId>/messages.jsonl），
// 本服务是薄包装，对外隐藏插件内部路径。
//
// 适配新架构：
//   · 旧 canonical 路径（sessions/<lo>/<hi>/）→ 新方向敏感 dialogId 平铺
//     （<ws>/sessions/<from>__<to>/messages.jsonl，与 hooks/session saveSession、
//      tools/session query_history 一致）。
//   · 旧插件 message-query/archive/idle-timer 直连 → 查询本服务直接实现；
//     归档（archive）实现尚未落地（L3 为占位、由 L5 注入），本服务经构造注入的
//     archive 回调暴露门面，未注入时降级跳过。
//
// 依赖方向：services → plugins/core（允许）；Node fs/path。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { workspaceRoot } from '@agentchat/toolkit';
import { chatDialogKey } from '@agentchat/tools';
import { createLogger } from '@agentchat/util';
import { legacyTriggerSource, stableMessageIdOf, unwrapTriggerContent } from '@agentchat/agent-session';
import type { PersistedMessage } from '@agentchat/protocol';
const log = createLogger('[services:history]');

export type { PersistedMessage } from '@agentchat/protocol';

/** 1:1 会话文件：<ws>/sessions/chat~<lo>~<hi>/messages.jsonl（lo/hi 排序保证唯一） */
function sessionFile(wsRoot: string, from: string, to: string): string {
  return path.join(wsRoot, 'sessions', chatDialogKey(from, to), 'messages.jsonl');
}

/** 按会话键的会话文件（chat~/single~ 通用；群组无 messages.jsonl） */
function dialogSessionFile(wsRoot: string, dialogId: string): string {
  return path.join(wsRoot, 'sessions', dialogId, 'messages.jsonl');
}

/** 读 JSONL 原始行（忽略空行；保留损坏行由调用方 parse 时跳过） */
function readJsonlLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.trim());
}

/** 读 JSONL（忽略损坏行） */
function readJsonl(filePath: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const line of readJsonlLines(filePath)) {
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * 历史 API 读取归一化：
 *   · 旧 role='trigger' → user + source（保留 legacyRole 诊断标记），正文解包 `<trigger>`
 *   · 历史损坏（trigger + tool_call_id）→ 兜底为 tool
 *   · 新 role='event' 原样返回（source 为事件渲染依据）
 */
function normalizeApiMessage(raw: Record<string, any>): PersistedMessage {
  if (raw.role === 'trigger') {
    if (raw.tool_call_id) {
      return { ...raw, role: 'tool', content: raw.content ?? '' } as PersistedMessage;
    }
    return {
      ...raw,
      role: 'user',
      content: unwrapTriggerContent(raw.content),
      source: (raw.source as PersistedMessage['source']) ?? legacyTriggerSource(raw.content),
    } as unknown as PersistedMessage;
  }
  return raw as PersistedMessage;
}

/**
 * 反向行迭代器：从文件尾部向前逐行产出（64KB 分块，按字节切 \n，多字节
 * UTF-8 字符不会被块边界截断）。供 readTailLines 与轮次窗口分页共用；
 * 消费方提前 break 会经 generator return() 触发 finally 关闭 fd。
 * fromByteExclusive：只迭代 [0, fromByteExclusive) 字节内的行（交错校正
 * 从 phase-1 的到达点继续向前，而非从文件尾重扫——避免重复收集无
 * message_id 的消息）。
 */
function* iterLinesBackward(filePath: string, fromByteExclusive?: number): Generator<string> {
  const CHUNK = 64 * 1024; // 64KB 反向分块
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return; // 文件不存在/不可读：视作无内容（调用方多已 existsSync 预检）
  }
  try {
    const size = fs.fstatSync(fd).size;
    let pos = Math.min(fromByteExclusive ?? size, size);
    let leftover = Buffer.alloc(0); // 尚未以 \n 结尾的前缀字节（向前累积）
    while (pos > 0) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, pos);
      // 当前块在前（更早字节）、遗留在后（更晚字节）→ 时间正序拼接
      const chunk = Buffer.concat([buf, leftover]);
      let end = chunk.length;
      // 从尾部向前切出完整行
      while (end > 0) {
        const nl = chunk.lastIndexOf(0x0a, end - 1);
        if (nl === -1) break;
        const line = chunk.toString('utf-8', nl + 1, end).trim();
        if (line) yield line;
        end = nl;
      }
      leftover = chunk.subarray(0, end);
      if (pos === 0 && leftover.length > 0) {
        // 已到文件头：剩余即第一行（可能末尾无换行）
        const line = leftover.toString('utf-8').trim();
        if (line) yield line;
        leftover = Buffer.alloc(0);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 从文件尾部反向读取最多 maxLines 行（JSONL），避免整文件读入内存。
 * 按字节以 \n 切行（多字节 UTF-8 字符不会被块边界截断），返回正序行数组。
 * 用于"取最后一条消息 / 最后一轮"的快速路径（会话列表预览）。
 */
export function readTailLines(filePath: string, maxLines: number): string[] {
  const lines: string[] = [];
  for (const line of iterLinesBackward(filePath)) {
    lines.push(line);
    if (lines.length >= maxLines) break;
  }
  lines.reverse();
  return lines;
}

// ============================================================
// 不可变归档文件的轮次索引（.tidx）
//
// 归档文件（archive/history_N.jsonl、before_archive.jsonl）落盘后不再变动
// （归档重建写入不相交区间；idleArchive 整文件改名），可安全建立
// "轮次 → 字节偏移"索引：深 offset 分页时直接 seek 到窗口对应字节区间，
// 不再顺序扫过前面所有轮次的字节。
//
// 语义要点（与 readTurnWindow 反向扫描路径严格一致）：
//   · 索引仅描述"轮界"（每条 viewer 消息开启新轮；文件头可能为孤儿轮）；
//   · 每轮记录起点 viewer 消息的 message_id —— 跨文件 message_id 去重
//     （保留较新）可能吞掉某轮的 viewer 行，计数需感知 seen 集合；
//   · messages.jsonl（可变、被归档水位压小）永不建索引，始终反向扫描。
//
// 失效校验：(size, mtimeMs, viewerId) 三元组匹配即信任；不匹配重建。
// 由此惰性构建是安全的：无需触碰归档写路径，也自动覆盖存量归档。
// ============================================================

/** 单轮的索引条目：轮首行字节偏移 + 轮首 viewer 消息标识 */
interface TurnIndexEntry {
  /** 轮首行字节偏移（entry[0] 恒为 0 —— 文件头，可能为无 viewer 的孤儿轮） */
  off: number;
  /** 轮首 viewer 消息的 message_id（无 id / 孤儿轮为 null） */
  vid: string | null;
  /** 该轮是否以 viewer 行开启（0 = 孤儿轮） */
  vw: 0 | 1;
}

/** 不可变文件的轮次索引（持久化为 <file>.tidx，JSON） */
interface TurnIndex {
  version: 1;
  viewerId: string;
  /** 建索引时的文件 size / mtimeMs（校验用） */
  size: number;
  mtimeMs: number;
  /** 轮次条目（时间升序：turns[0] 最旧，末项最新） */
  turns: TurnIndexEntry[];
}

/** 进程内索引缓存（文件不可变 + stat 校验，缓存永不过期） */
const turnIndexCache = new Map<string, TurnIndex>();

/** 解析单行（损坏行返回 null；仅取 agent_id/message_id，无需归一化全文） */
function parseLineMeta(line: string): { agent_id?: string; message_id?: string } | null {
  try { return JSON.parse(line); } catch { return null; }
}

/** 进行中的后台索引构建（file::viewer → Promise；完成/失败后自移除） */
const inflightBuilds = new Map<string, Promise<TurnIndex | null>>();

/**
 * 异步构建轮次索引：分块读 + 块间让出事件循环（setImmediate）。
 * 同步版曾把 40MB 归档的 ~200ms 构建（全文件读+逐行 parse）压在一次
 * 事件循环 tick 里——期间所有 WS 收发/流式推送冻结，表现为"偶发卡在
 * 加载历史"。异步化后构建与查询流量并发，触发构建的查询本身走扫描
 * 路径返回（见 turnIndexOf），不等待构建完成。
 * 构建期间文件被改动（违反不可变假设）：stat 快照校验会使下次查询
 * 视为失效并重建，脏索引不会被使用。
 */
async function buildTurnIndexAsync(
  filePath: string, viewerId: string, stat: fs.Stats,
): Promise<TurnIndex | null> {
  const turns: TurnIndexEntry[] = [];
  const CHUNK = 256 * 1024;
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
    const size = stat.size;
    let pos = 0;
    let lineStart = 0;
    let pending = Buffer.alloc(0);
    let first = true;
    while (pos < size) {
      const readSize = Math.min(CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(readSize);
      fs.readSync(fd, buf, 0, readSize, pos);
      pending = Buffer.concat([pending, buf]);
      let searchFrom = 0;
      let nl: number;
      while ((nl = pending.indexOf(0x0a, searchFrom)) !== -1) {
        const line = pending.toString('utf-8', searchFrom, nl).trim();
        if (line) {
          const m = parseLineMeta(line);
          if (first) {
            first = false;
            const isViewer = !!m && m.agent_id === viewerId;
            turns.push({ off: 0, vid: isViewer ? (m!.message_id ?? null) : null, vw: isViewer ? 1 : 0 });
            if (isViewer) { lineStart += nl - searchFrom + 1; searchFrom = nl + 1; continue; }
          }
          if (m && m.agent_id === viewerId) {
            turns.push({ off: lineStart, vid: m.message_id ?? null, vw: 1 });
          }
        }
        lineStart += nl - searchFrom + 1;
        searchFrom = nl + 1;
      }
      pending = pending.subarray(searchFrom);
      pos += readSize;
      await yieldLoop(); // 块间让出：其他 IO/WS 帧得以前进
    }
    if (pending.length > 0) {
      const line = pending.toString('utf-8').trim();
      if (line) {
        const m = parseLineMeta(line);
        if (first) {
          const isViewer = !!m && m.agent_id === viewerId;
          turns.push({ off: 0, vid: isViewer ? (m!.message_id ?? null) : null, vw: isViewer ? 1 : 0 });
        } else if (m && m.agent_id === viewerId) {
          turns.push({ off: lineStart, vid: m.message_id ?? null, vw: 1 });
        }
      }
    }
    return { version: 1, viewerId, size: stat.size, mtimeMs: stat.mtimeMs, turns };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 取不可变文件的轮次索引（同步、永不阻塞）：
 *   内存缓存 → 磁盘 .tidx（校验通过）→ 返回 null 并踢出后台异步构建。
 * 返回 null = 暂无可用索引（文件不存在，或构建进行中/刚触发）——
 * 调用方（readTurnWindow）以反向扫描路径兜底，本次查询不受构建影响；
 * 构建完成后（原子落盘 .tidx + 内存缓存）后续查询自动走索引。
 * 磁盘持久化失败（只读目录等）不致命：内存索引仍生效，下次进程重建。
 */
function turnIndexOf(filePath: string, viewerId: string): TurnIndex | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const abs = path.resolve(filePath);
  const key = `${abs}::${viewerId}`;
  const cached = turnIndexCache.get(key);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;

  const idxPath = `${abs}.tidx`;
  try {
    const raw = JSON.parse(fs.readFileSync(idxPath, 'utf-8')) as TurnIndex;
    if (raw?.version === 1 && raw.viewerId === viewerId
      && raw.size === stat.size && raw.mtimeMs === stat.mtimeMs) {
      turnIndexCache.set(key, raw);
      return raw;
    }
  } catch { /* 无索引/损坏/版本不符 → 后台重建 */ }

  // 后台异步构建（去重：同文件同 viewer 只构建一次）
  if (!inflightBuilds.has(key)) {
    const p = buildTurnIndexAsync(filePath, viewerId, stat)
      .then((built) => {
        if (built) {
          try {
            const tmp = `${idxPath}.tmp-${process.pid}-${Date.now()}`;
            fs.writeFileSync(tmp, JSON.stringify(built), 'utf-8');
            fs.renameSync(tmp, idxPath);
          } catch { /* 持久化失败：内存索引仍可用 */ }
          turnIndexCache.set(key, built);
        }
        return built;
      })
      .finally(() => { inflightBuilds.delete(key); });
    inflightBuilds.set(key, p);
  }
  return null;
}

/** 测试钩子：等待所有进行中的后台索引构建完成 */
export function pendingTurnIndexBuilds(): Promise<unknown> {
  return Promise.all([...inflightBuilds.values()]);
}

/** 测试钩子：清空内存索引缓存（含进行中构建的登记） */
export function clearTurnIndexCacheForTests(): void {
  turnIndexCache.clear();
}

/** 读取 [start, end) 字节区间的行（trim、去空行；时间正序） */
function readRangeLines(filePath: string, start: number, end: number): string[] {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(end, size) - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

/** 读文件最后一行的时间戳（交错校正的文件级快速跳过判据；无/失败返回 null） */
function lastLineTs(filePath: string): string | null {
  try {
    const lines = readTailLines(filePath, 1);
    if (lines.length === 0) return null;
    return (parseLineMeta(lines[0]) as { timestamp?: string } | null)?.timestamp ?? null;
  } catch {
    return null;
  }
}


/**
 * 旧架构会话读取（历史数据兼容 fallback）。
 * 旧存储为 canonical 排序嵌套路径：sessions/<lo>/<hi>/messages.jsonl
 * （lo/hi = [a,b].sort()，字母序），并可能含 archive/history_N.jsonl 归档文件
 * （编号越大越旧，history_1 最新）。合并顺序 = archive/history_N → … →
 * archive/history_1 → messages.jsonl（时间升序），跨文件按 message_id 去重
 * （保留较新出现），与旧 message-query 语义一致。
 */
function readLegacySession(wsRoot: string, a: string, b: string): PersistedMessage[] {
  const [lo, hi] = [a, b].sort();
  const dir = path.join(wsRoot, 'sessions', lo, hi);
  const mainFile = path.join(dir, 'messages.jsonl');
  if (!fs.existsSync(mainFile)) return [];

  const allLines: string[] = [];
  const archiveDir = path.join(dir, 'archive');
  if (fs.existsSync(archiveDir)) {
    const archiveFiles = fs
      .readdirSync(archiveDir)
      .filter((f) => /^history_\d+\.jsonl$/.test(f))
      .sort((x, y) => {
        const nx = parseInt(x.match(/^history_(\d+)\.jsonl$/)![1], 10);
        const ny = parseInt(y.match(/^history_(\d+)\.jsonl$/)![1], 10);
        return nx - ny; // 升序：history_1, history_2, ...
      });
    for (const f of archiveFiles) {
      allLines.push(...readJsonlLines(path.join(archiveDir, f)));
    }
  }
  allLines.push(...readJsonlLines(mainFile));

  // 跨文件去重（保留较新出现），再翻转为时间升序
  const seen = new Set<string>();
  const out: PersistedMessage[] = [];
  for (let i = allLines.length - 1; i >= 0; i--) {
    try {
      const m = normalizeApiMessage(JSON.parse(allLines[i]) as Record<string, any>);
      if (m.message_id) {
        if (seen.has(m.message_id)) continue;
        seen.add(m.message_id);
      }
      out.push(m);
    } catch { /* skip malformed */ }
  }
  out.reverse();
  return out;
}

/** 归档实现（L5 装配注入：agent-session archive；缺省降级） */
export type ArchiveFn = (agentId: string, counterpart: string) => Promise<void> | void;

/**
 * 会话数据文件列表（时间新旧序，newest → oldest）：
 *   messages.jsonl → before_archive.jsonl → archive/history_N.jsonl（N 降序，越大越新）。
 * 与全量读取路径（readDialogHistory 语义）的文件时间序互为镜像。
 * 注意：调用方需保证 messages.jsonl 存在（与旧全量路径"主文件缺失即空会话"一致）。
 */
function dialogDataFilesNewestFirst(wsRoot: string, dialogId: string): string[] {
  const dir = path.join(wsRoot, 'sessions', dialogId);
  const files: string[] = [path.join(dir, 'messages.jsonl')];
  const before = path.join(dir, 'before_archive.jsonl');
  if (fs.existsSync(before)) files.push(before);
  const archiveDir = path.join(dir, 'archive');
  if (fs.existsSync(archiveDir)) {
    const archives = fs
      .readdirSync(archiveDir)
      .filter((f) => /^history_\d+\.jsonl$/.test(f))
      .map((f) => ({ f, n: parseInt(f.match(/^history_(\d+)\.jsonl$/)![1], 10) }))
      .sort((a, b) => b.n - a.n); // 编号越大越新 → 降序
    files.push(...archives.map((x) => path.join(archiveDir, x.f)));
  }
  return files;
}

/**
 * 轮次窗口分页（历史查询主路径）：从数据文件尾部反向推进，只读取需要的行。
 *
 * 语义与"全量读取 + splitTurns + 最新在前分页"完全一致：
 *   · 轮次 = viewer 消息链（每条 viewer 消息开启新轮；首部无 viewer 的消息
 *     归入最旧的孤儿轮）；轮可跨文件边界（归档切割点可落在 viewer 消息之后，
 *     其回复留在新文件头部 —— 反向推进时它们先于 viewer 消息到达，计数
 *     语义天然把它们划入同一轮）；
 *   · 跨文件 message_id 去重：保留较新出现（先见者胜，与全量路径"保留较新"
 *     等价；去重先于轮次计数，重复 viewer 消息不会二次开轮）；
 *   · 窗口内按 timestamp 稳定排序（seq = 反转后的时间顺序），乱序兜底。
 *
 * 两条读取路径：
 *   · messages.jsonl（可变，被归档水位压小）→ 反向逐行扫描；
 *   · 不可变归档文件 → .tidx 轮次索引直接 seek 到窗口字节区间（见上节）；
 *     索引缺失/校验失败时自动构建；构建失败退回扫描。
 *
 * 性能：主文件读取 O(窗口) ；深 offset 翻进归档时，字节读取仅限窗口对应
 * 区间（不再扫过前面所有轮次），解析 O(offset+limit 轮)。
 */
/** 交错校正的内层停止标记（symbol 身份唯一，用于中断单文件扫描） */
const STOP = Symbol('turnWindowStop');

/** 收集条目：消息 + 排序键（fileRank：旧文件小 = 全量路径 concat 序；seq：收集插入序；naive：phase-1 朴素轮号） */
interface CollectItem { m: PersistedMessage; fileRank: number; seq: number; naive: number }

/** phase-1 在单个文件上的回扫到达点（phase-2 交错校正从该点继续，不重扫已处理行） */
type Reach = { kind: 'lines'; n: number } | { kind: 'byte'; off: number };

/** 交错校正的过采样轮数：收集比窗口多 N 轮，保证水位线 T0 覆盖重排后窗口 */
const TURN_OVERSCAN = 5;

export function readTurnWindow(
  wsRoot: string,
  dialogId: string,
  viewerId: string,
  offset: number,
  limit: number,
  opts?: { noIndex?: boolean },
): PersistedMessage[] {
  const files = dialogDataFilesNewestFirst(wsRoot, dialogId);
  const lastIdx = offset + limit - 1 + TURN_OVERSCAN; // 收集上界（含过采样）
  const collected: CollectItem[] = []; // 反时间序累积
  const seen = new Set<string>();
  const reach = new Map<string, Reach>();
  let seq = 0;
  let viewerCount = 0;
  let stopped = false;
  /** 子集最新一条消息的朴素轮号（新序，0=最新轮）——重排后局部轮号→全局轮号的锚点 */
  let naiveTop: number | null = null;

  const push = (m: PersistedMessage, fileRank: number, naive: number): void => {
    if (naiveTop === null) naiveTop = naive;
    collected.push({ m, fileRank, seq: seq++, naive });
  };

  /** 原子去重标记：未见过的消息标记并返回 true（重复出现返回 false） */
  const markSeen = (m: PersistedMessage): boolean => {
    if (!m.message_id) return true;
    if (seen.has(m.message_id)) return false;
    seen.add(m.message_id);
    return true;
  };

  /** 反向逐行扫描单个文件（可变主文件 / 索引不可用时的回退）。
   *  收集全部扫过的消息（含比窗口新的轮次）——重排后切轮需要连续前缀，
   *  否则轮号会整体偏移（解析开销不变，仅多持引用）。 */
  const scanBackward = (file: string, fileRank: number): void => {
    let n = 0;
    scan: for (const line of iterLinesBackward(file)) {
      let m: PersistedMessage;
      try {
        m = normalizeApiMessage(JSON.parse(line) as Record<string, any>);
      } catch { n++; continue; /* 忽略损坏行 */ }
      // 跨文件去重（保留较新）：先于轮次计数，重复 viewer 消息不会二次开轮。
      // 无论是否在窗口内都标记 seen——比窗口新的消息也可能在旧文件里有
      // 重复副本，不标记会让副本在窗口区被二次开轮。
      if (!markSeen(m)) { n++; continue; }
      const isViewer = m.agent_id === viewerId;
      if (isViewer) viewerCount++;
      const turnIdx = isViewer ? viewerCount - 1 : viewerCount;
      if (turnIdx > lastIdx) { stopped = true; break scan; } // 更旧的行全在窗口外
      push(m, fileRank, turnIdx);
      n++;
    }
    reach.set(file, { kind: 'lines', n }); // 已回扫 n 行（phase-2 从第 n+1 行继续）
  };

  for (let i = 0; i < files.length && !stopped; i++) {
    const file = files[i];
    const fileRank = files.length - i; // 旧文件小（与全量路径 concat 序一致）
    // messages.jsonl 可变（尾部追加/删除/归档重建）→ 永不索引，始终扫描
    const idx = i === 0 || opts?.noIndex ? null : turnIndexOf(file, viewerId);
    if (!idx) {
      scanBackward(file, fileRank);
      continue;
    }

    // ── 索引路径：按轮 seek ──
    // 全局轮号 g（新序，0 = 最新）：进入本文件时 = 已数得的 viewer 数；
    // 本文件内自最新轮（turns 末项）向旧推进，g 随有效 viewer 行递增。
    // 注意：连续收集（不跳过 offset 之前的轮次）——重排后切轮要求子集是
    // 从数据流顶端开始的连续前缀，中间的空洞会让轮号换算错位
    //（索引的价值在 seek 到窗口起点，收集量 = offset+limit+过采样 轮）。
    let g = viewerCount;
    let lowestReadOff: number | null = null;
    for (let j = idx.turns.length - 1; j >= 0; j--) {
      const e = idx.turns[j];
      if (g > lastIdx) { stopped = true; break; } // 本轮及更旧全在窗口外
      // 先判"该轮 viewer 行是否被跨文件去重吞掉"（seen 尚未收录本文件内容）
      const countsViewer = e.vw === 1 && (e.vid === null || !seen.has(e.vid));
      {
        // 轮 j 的字节区间 = [turns[j].off, 下一轮（更新）起点 ?? 文件尾)
        const end = j + 1 < idx.turns.length ? idx.turns[j + 1].off : idx.size;
        const lines = readRangeLines(file, e.off, end);
        if (lines.length > 0 && (lowestReadOff === null || e.off < lowestReadOff)) lowestReadOff = e.off;
        // 区间内倒序处理（新→旧）：先见者胜的去重 + 反时间序累积
        for (let k = lines.length - 1; k >= 0; k--) {
          try {
            const m = normalizeApiMessage(JSON.parse(lines[k]) as Record<string, any>);
            if (markSeen(m)) push(m, fileRank, g);
          } catch { /* 忽略损坏行 */ }
        }
      }
      if (countsViewer) {
        if (e.vid !== null) seen.add(e.vid);
        g++;
      }
    }
    viewerCount = g;
    reach.set(file, lowestReadOff !== null ? { kind: 'byte', off: lowestReadOff } : { kind: 'lines', n: 0 });
  }

  if (collected.length === 0) return [];

  // ── 交错校正（真实数据存在跨文件时间戳倒置）──
  // 归档重建可能在轮次中间切割（viewer 消息在旧文件、其回复在新文件头），
  // 且历史重复归档使文件时间区间重叠：按文件序推进会漏掉交错过来的消息。
  // 校正：T0 = 已收集消息的最旧时间戳；对每个文件从 phase-1 到达点继续向
  // 前补收 ts > T0 的消息（首条 ts ≤ T0 即停——文件内升序；整文件最新
  // ts ≤ T0 则跳过，一次小尾读即可判定）。无倒置数据零补收。
  const t0 = collected.reduce(
    (min, it) => ((it.m.timestamp ?? '') < min ? (it.m.timestamp ?? '') : min),
    collected[0].m.timestamp ?? '',
  );
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileRank = files.length - i;
    const lastTs = lastLineTs(file);
    if (lastTs && lastTs <= t0) continue; // 该文件整体早于水位线 → 不可能交错
    const r = reach.get(file) ?? { kind: 'lines' as const, n: 0 };
    const ingest = (m: PersistedMessage): void => {
      const ts = m.timestamp ?? '';
      if (ts && ts <= t0) throw STOP; // 文件内升序：该行及更早不再交错
      if (markSeen(m)) push(m, fileRank, -1); // 补收消息无朴素轮号（-1；按排序重切）
    };
    try {
      if (r.kind === 'byte') {
        for (const line of iterLinesBackward(file, r.off)) {
          let m: PersistedMessage;
          try { m = normalizeApiMessage(JSON.parse(line) as Record<string, any>); } catch { continue; }
          ingest(m);
        }
      } else {
        let skip = r.n;
        for (const line of iterLinesBackward(file)) {
          if (skip > 0) { skip--; continue; } // phase-1 已处理过的行
          let m: PersistedMessage;
          try { m = normalizeApiMessage(JSON.parse(line) as Record<string, any>); } catch { continue; }
          ingest(m);
        }
      }
    } catch (e) {
      if (e !== STOP) throw e; // 真异常上抛；停止标记仅中断本文件扫描
    }
  }

  // ── 重排：timestamp 稳定排序。tiebreak 复刻全量路径 concat 序：
  //    ① fileRank 升序（旧归档文件在前，主文件最后）；
  //    ② 同文件同时间戳 → 文件内位置正序 = 收集插入序的倒序（收集为反时间序）。
  collected.sort((a, b) =>
    (a.m.timestamp ?? '').localeCompare(b.m.timestamp ?? '') ||
    a.fileRank - b.fileRank ||
    b.seq - a.seq,
  );

  // ── 重切轮 + 全局轮号锚定取窗 ──
  // 收集子集未必从数据流最末端开始（索引路径跳过了 offset 之前的轮次），
  // 子集内重切的局部轮号需要锚定换算：全局新序轮号 = 局部新序轮号 + naiveTop
  //（naiveTop = 子集最新消息的朴素轮号 = 子集上方被跳过的轮数）。
  const sorted = collected.map((it) => it.m);
  const localTurns = splitTurns(sorted, viewerId); // 时间正序
  const T = localTurns.length;
  const top = naiveTop ?? 0;
  // 全局窗口 [offset, offset+limit)（新序）→ 局部（时间正序）区间：
  //   局部新序号 = T-1-i（i 为时间正序下标）→ 全局 = T-1-i+top
  //   → i ∈ (T-1+top-offset-limit, T-1+top-offset]
  const hi = T - 1 + top - offset + 1; // 不含
  const lo = hi - limit;
  if (hi <= 0) return [];
  return localTurns.slice(Math.max(0, lo), Math.max(0, hi)).flat();
}

/**
 * 尾部快速读取窗口（会话列表"最后一条消息"预览用，覆盖一轮消息的典型长度；
 * 窗口内未找到 viewer 消息时（超长 agent 连续输出）整体作为尾部返回，预览仍正确）。
 */
const LAST_TURN_TAIL_LINES = 500;

/**
 * 快速读取"最后一个轮次"（query limit=1 & offset=0 专用；按会话键，chat~/single~ 通用）。
 *
 * 与 readDialogHistory 语义对齐：主文件 messages.jsonl 是时间最新文件
 * （归档重建后仅保留近期消息，新消息追加在尾部），最后一个轮次必然落在其尾部；
 * 仅当主文件为空时才回退读 before_archive.jsonl 尾部。窗口内最后一条 viewer
 * 消息即轮次起点，其后（含其）即最后一轮。
 */
function readLastTurnByDialog(wsRoot: string, dialogId: string, viewerId: string): PersistedMessage[] {
  const dir = path.join(wsRoot, 'sessions', dialogId);
  const mainFile = path.join(dir, 'messages.jsonl');
  if (!fs.existsSync(mainFile)) return [];

  let lines = readTailLines(mainFile, LAST_TURN_TAIL_LINES);
  if (lines.length === 0) {
    const before = path.join(dir, 'before_archive.jsonl');
    if (fs.existsSync(before)) lines = readTailLines(before, LAST_TURN_TAIL_LINES);
  }
  if (lines.length === 0) return [];

  const turn: PersistedMessage[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let m: PersistedMessage;
    try { m = normalizeApiMessage(JSON.parse(lines[i]) as Record<string, any>); } catch { continue; }
    turn.push(m);
    if (m.agent_id === viewerId) break; // 轮次起点（viewer 消息）
  }
  turn.reverse();
  return turn;
}

/**
 * 按轮次(user 链)切分会话消息：
 * 每条 viewer 消息开启一个新轮次，其余消息(agent 回复/tool 调用等)归入当前轮。
 * 返回轮次数组（时间正序；每轮 = [viewer 消息, ...后续消息]）。
 * 会话开头若无 viewer 消息（如 Agent 自主/定时任务记录），则形成最早的"孤儿轮次"。
 */
function splitTurns(msgs: PersistedMessage[], viewerId: string): PersistedMessage[][] {
  const turns: PersistedMessage[][] = [];
  let cur: PersistedMessage[] = [];
  for (const m of msgs) {
    if (m.agent_id === viewerId) {
      if (cur.length) turns.push(cur);
      cur = [m];
    } else {
      cur.push(m);
    }
  }
  if (cur.length) turns.push(cur);
  return turns;
}

export interface HistoryServiceOptions {
  /** 工作区根（缺省 workspaceRoot()） */
  wsRoot?: string;
  /** 归档实现（L5 注入；未注入时 requestArchive 降级跳过） */
  archive?: ArchiveFn;
}

export class HistoryService {
  private wsRoot: string;
  private archiveFn?: ArchiveFn;

  constructor(options: HistoryServiceOptions = {}) {
    this.wsRoot = options.wsRoot ?? workspaceRoot();
    this.archiveFn = options.archive;
  }

  /**
   * 消息查询（读历史）。
   * 优先读新架构路径 <ws>/sessions/chat~<lo>~<hi>/（含归档：
   * messages.jsonl + before_archive.jsonl + archive/history_N.jsonl）；
   * 新路径不存在时回退旧架构 canonical 路径 <ws>/sessions/<lo>/<hi>/（含 archive 合并）。
   *
   * 分页按**轮次（user 链）**：每条 viewer 消息开启一个新轮次（含其后的 agent 回复/tool），
   * 最新在前分页（limit = 轮数，offset = 已跳过的轮数），返回正序消息。
   */
  async query(filter: {
    from: string;
    to: string;
    limit?: number;
    offset?: number;
  }): Promise<PersistedMessage[]> {
    // 防御：调用方配置缺 viewerId 等场景避免 path.join 收到 undefined
    if (typeof filter.from !== 'string' || typeof filter.to !== 'string') return [];
    const limit = Math.max(1, filter.limit ?? 20);
    const offset = Math.max(0, filter.offset ?? 0);

    const flatFile = sessionFile(this.wsRoot, filter.from, filter.to);

    // 快速路径：只取最后一轮（limit=1 & offset=0）→ 只读主文件尾部，
    // 避免整文件读取 + 全量排序 + 去重。agent.list 每次进页面会对每个 agent
    // 触发一次，会话文件很大时是页面卡顿主因。旧架构 legacy 路径仍走全量读取。
    if (limit === 1 && offset === 0 && fs.existsSync(flatFile)) {
      return readLastTurnByDialog(this.wsRoot, chatDialogKey(filter.from, filter.to), filter.from).map((m) =>
        m.message_id ? m : { ...m, message_id: stableMessageIdOf(chatDialogKey(filter.from, filter.to), m) },
      );
    }

    // 新架构路径：轮次窗口反向扫描（只读需要的尾部字节，不再全量读取/解析）
    if (fs.existsSync(flatFile)) {
      return readTurnWindow(this.wsRoot, chatDialogKey(filter.from, filter.to), filter.from, offset, limit)
        .map((m) => {
          if (m.message_id) return m;
          return { ...m, message_id: stableMessageIdOf(chatDialogKey(filter.from, filter.to), m) };
        }) as PersistedMessage[];
    }

    // 旧架构 legacy 路径：仍走全量读取 + 轮次分页
    const msgs = readLegacySession(this.wsRoot, filter.from, filter.to);
    if (msgs.length === 0) return [];

    const turns = splitTurns(msgs, filter.from);
    turns.reverse(); // 最新轮在前 → 分页
    const page = turns.slice(offset, offset + limit);
    page.reverse(); // 恢复正序
    // 兼容旧数据：无 message_id 的消息补稳定 id（基于会话+时间戳+内容 hash），
    // 供前端 persistedMsgId 标记 / 去重 / 消息删除使用（新写入已由 saveSession 生成）。
    return page.flat().map((m) => {
      if (m.message_id) return m;
      return { ...m, message_id: stableMessageIdOf(chatDialogKey(filter.from, filter.to), m) };
    }) as PersistedMessage[];
  }

  /**
   * 按会话键查询（独立会话 single~<sid> 专用；无 legacy 回退——single 是新键形态）。
   * 分页语义与 query 一致：按轮次（viewer 消息链），最新在前，返回正序消息。
   */
  async queryDialog(
    dialogId: string,
    filter: { viewerId: string; limit?: number; offset?: number },
  ): Promise<PersistedMessage[]> {
    const limit = Math.max(1, filter.limit ?? 20);
    const offset = Math.max(0, filter.offset ?? 0);

    const flatFile = dialogSessionFile(this.wsRoot, dialogId);
    if (!fs.existsSync(flatFile)) return [];

    if (limit === 1 && offset === 0) {
      return readLastTurnByDialog(this.wsRoot, dialogId, filter.viewerId).map((m) =>
        m.message_id ? m : { ...m, message_id: stableMessageIdOf(dialogId, m) },
      );
    }

    return readTurnWindow(this.wsRoot, dialogId, filter.viewerId, offset, limit).map((m) =>
      m.message_id ? m : { ...m, message_id: stableMessageIdOf(dialogId, m) },
    ) as PersistedMessage[];
  }

  /** 触发归档（1:1 会话）—— 委托 L5 注入的归档实现；未注入时降级 */
  async requestArchive(agentId: string, counterpart: string): Promise<void> {
    if (this.archiveFn) {
      await this.archiveFn(agentId, counterpart);
      return;
    }
    log.warn(`requestArchive 未注入归档实现（${agentId} → ${counterpart}），跳过`);
  }

  /** 空闲归档（后台定时） */
  async idleArchive(agent: string, counterpart: string): Promise<void> {
    await this.requestArchive(agent, counterpart);
  }

  /** 从 jsonl 删除消息（按 message_id 匹配；兼容旧 canonical 路径） */
  async deleteFromJSONL(agentId: string, counterpart: string, messageId: string): Promise<boolean> {
    const flatFile = sessionFile(this.wsRoot, agentId, counterpart);
    const legacyFile = (() => {
      const [lo, hi] = [agentId, counterpart].sort();
      return path.join(this.wsRoot, 'sessions', lo, hi, 'messages.jsonl');
    })();
    const file = fs.existsSync(flatFile) ? flatFile : (fs.existsSync(legacyFile) ? legacyFile : '');
    if (!file) return false;

    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    let removed = false;
    const kept = lines.filter((line) => {
      try {
        const m = JSON.parse(line);
        const isMatch = m.message_id === messageId || m.id === messageId;
        if (isMatch) removed = true;
        return !isMatch;
      } catch {
        return true;
      }
    });
    if (removed) {
      fs.writeFileSync(file, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf-8');
      log.info(`已删除消息 ${messageId}（${agentId} → ${counterpart}）`);
    }
    return removed;
  }
}
