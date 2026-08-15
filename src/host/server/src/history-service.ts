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
import { stableMessageIdOf } from '@agentchat/agent-session';
import type { PersistedMessage } from '@agentchat/protocol';
const log = createLogger('[services:history]');

export type { PersistedMessage } from '@agentchat/protocol';

/** 1:1 会话文件：<ws>/sessions/chat~<lo>~<hi>/messages.jsonl（lo/hi 排序保证唯一） */
function sessionFile(wsRoot: string, from: string, to: string): string {
  return path.join(wsRoot, 'sessions', chatDialogKey(from, to), 'messages.jsonl');
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
 * 从文件尾部反向读取最多 maxLines 行（JSONL），避免整文件读入内存。
 * 按字节以 \n 切行（多字节 UTF-8 字符不会被块边界截断），返回正序行数组。
 * 用于"取最后一条消息 / 最后一轮"的快速路径（会话列表预览）。
 */
export function readTailLines(filePath: string, maxLines: number): string[] {
  const CHUNK = 64 * 1024; // 64KB 反向分块
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const lines: string[] = [];
    let pos = size;
    let leftover = Buffer.alloc(0); // 尚未以 \n 结尾的前缀字节（向前累积）
    while (pos > 0 && lines.length < maxLines) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, pos);
      // 当前块在前（更早字节）、遗留在后（更晚字节）→ 时间正序拼接
      const chunk = Buffer.concat([buf, leftover]);
      let end = chunk.length;
      // 从尾部向前切出完整行
      while (lines.length < maxLines) {
        const nl = chunk.lastIndexOf(0x0a, end - 1);
        if (nl === -1) break;
        const line = chunk.toString('utf-8', nl + 1, end).trim();
        if (line) lines.push(line);
        end = nl;
        if (end === 0) break;
      }
      leftover = chunk.subarray(0, end);
      if (pos === 0 && leftover.length > 0) {
        // 已到文件头：剩余即第一行（可能末尾无换行）
        const line = leftover.toString('utf-8').trim();
        if (line && lines.length < maxLines) lines.push(line);
        leftover = Buffer.alloc(0);
      }
    }
    lines.reverse();
    return lines;
  } finally {
    fs.closeSync(fd);
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
      const m = JSON.parse(allLines[i]) as PersistedMessage;
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
 * 读新架构会话完整历史：
 *   sessions/chat~<lo>~<hi>/messages.jsonl（最新活跃）
 *   + before_archive.jsonl（归档前快照）
 *   + archive/history_N.jsonl（编号越大越新）
 * 全部按 timestamp 稳定排序（同时间保持文件内顺序），并按 message_id 去重（保留较新的出现）。
 */
function readSessionHistory(wsRoot: string, from: string, to: string): PersistedMessage[] {
  const dir = path.join(wsRoot, 'sessions', chatDialogKey(from, to));
  const mainFile = path.join(dir, 'messages.jsonl');
  if (!fs.existsSync(mainFile)) return [];

  const files: string[] = [];
  const archiveDir = path.join(dir, 'archive');
  if (fs.existsSync(archiveDir)) {
    const archives = fs
      .readdirSync(archiveDir)
      .filter((f) => /^history_\d+\.jsonl$/.test(f))
      .sort((x, y) => {
        const nx = parseInt(x.match(/^history_(\d+)\.jsonl$/)![1], 10);
        const ny = parseInt(y.match(/^history_(\d+)\.jsonl$/)![1], 10);
        return nx - ny; // 编号升序（仅作为同时间戳时的基础顺序）
      });
    files.push(...archives.map((f) => path.join(archiveDir, f)));
  }
  const before = path.join(dir, 'before_archive.jsonl');
  if (fs.existsSync(before)) files.push(before);
  files.push(mainFile);

  const items: { m: PersistedMessage; seq: number }[] = [];
  let seq = 0;
  for (const f of files) {
    for (const line of readJsonlLines(f)) {
      try { items.push({ m: JSON.parse(line) as PersistedMessage, seq: seq++ }); } catch { seq++; /* skip malformed */ }
    }
  }
  // timestamp 稳定排序：同时间戳保持文件内 seq 顺序（避免 ReAct 同秒轨迹乱序）
  items.sort((a, b) => (a.m.timestamp ?? '').localeCompare(b.m.timestamp ?? '') || a.seq - b.seq);
  // message_id 去重：保留较新的出现
  const seen = new Set<string>();
  const out: PersistedMessage[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i].m;
    if (m.message_id) {
      if (seen.has(m.message_id)) continue;
      seen.add(m.message_id);
    }
    out.push(m);
  }
  out.reverse();
  return out;
}

/**
 * 尾部快速读取窗口（会话列表"最后一条消息"预览用，覆盖一轮消息的典型长度；
 * 窗口内未找到 viewer 消息时（超长 agent 连续输出）整体作为尾部返回，预览仍正确）。
 */
const LAST_TURN_TAIL_LINES = 500;

/**
 * 快速读取"最后一个轮次"（query limit=1 & offset=0 专用）。
 *
 * 与 readSessionHistory 语义对齐：主文件 messages.jsonl 是时间最新文件
 * （归档重建后仅保留近期消息，新消息追加在尾部），最后一个轮次必然落在其尾部；
 * 仅当主文件为空时才回退读 before_archive.jsonl 尾部。窗口内最后一条 viewer
 * 消息即轮次起点，其后（含其）即最后一轮。
 */
function readLastTurn(wsRoot: string, from: string, to: string, viewerId: string): PersistedMessage[] {
  const dir = path.join(wsRoot, 'sessions', chatDialogKey(from, to));
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
    try { m = JSON.parse(lines[i]) as PersistedMessage; } catch { continue; }
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
      return readLastTurn(this.wsRoot, filter.from, filter.to, filter.from).map((m) =>
        m.message_id ? m : { ...m, message_id: stableMessageIdOf(chatDialogKey(filter.from, filter.to), m) },
      );
    }

    const msgs = fs.existsSync(flatFile)
      ? readSessionHistory(this.wsRoot, filter.from, filter.to)
      : readLegacySession(this.wsRoot, filter.from, filter.to);
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
