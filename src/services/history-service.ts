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
//   · markMemoryReviewNeeded 按本服务 wsRoot 直接写标记文件（与 L3 hooks/memory
//     同格式，但尊重注入的工作区根）。
//
// 依赖方向：services → plugins/core（允许）；Node fs/path。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { workspaceRoot } from '@plugins/builtin/tools/shared';
import { chatDialogKey, counterpartOfDialog } from '@plugins/builtin/paths';
import { createLogger } from '@core/logger';
import type { PersistedMessage } from '@shared/types';

const log = createLogger('[services:history]');

export type { PersistedMessage } from '@shared/types';

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
    const limit = Math.max(1, filter.limit ?? 20);
    const offset = Math.max(0, filter.offset ?? 0);

    const flatFile = sessionFile(this.wsRoot, filter.from, filter.to);
    const msgs = fs.existsSync(flatFile)
      ? readSessionHistory(this.wsRoot, filter.from, filter.to)
      : readLegacySession(this.wsRoot, filter.from, filter.to);
    if (msgs.length === 0) return [];

    const turns = splitTurns(msgs, filter.from);
    turns.reverse(); // 最新轮在前 → 分页
    const page = turns.slice(offset, offset + limit);
    page.reverse(); // 恢复正序
    return page.flat() as PersistedMessage[];
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

  /** 标记记忆需审查（集中管理：files/<agentId>/memory/<counterpart>.memory_review_needed） */
  async markMemoryReviewNeeded(agentId: string, counterpart: string): Promise<void> {
    const cp = counterpartOfDialog(chatDialogKey(agentId, counterpart), agentId);
    const filePath = path.join(this.wsRoot, 'files', agentId, 'memory', `${cp}.memory_review_needed`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      dialogId: chatDialogKey(agentId, counterpart),
      markedAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
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
