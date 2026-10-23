// ============================================================
// history.ts —— 历史读（增量化 + watch + 会话列表索引）
//
// · readLedgerFrom：锚点增量读（JSONL 追加式——尾部追加即增量，
//   锚点 = 上次读到的字节位置；撕裂行不产出、锚点不推进，下次重读）
// · watchLedger：fs.watch 投影面（messages.jsonl 追加事件 → 回调；
//   目录 watch——首建文件与追加都触发；size 增长判定防抖）
// · listSessions：agents/*/sessions/*/ 直读扫描 + header 采样
//   （会话列表 = 文件系统探查，无常驻索引）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LedgerRow, LedgerHeader } from 'ac-ledger';

export interface HistoryResult {
  header: LedgerHeader | null;
  rows: LedgerRow[];
  /** 增量锚点（下次调用 readLedgerFrom 的 anchor） */
  anchor: number;
}

/**
 * 从锚点增量读账本（anchor = 上次返回的 anchor；0 = 全量读）。
 * header 处理：全量读（start=0）时从头解析；增量读时 header 已在
 * 锚点前交付过——返回 null（增量语义只交付新行）。
 */
export function readLedgerFrom(dir: string, anchor: number = 0): HistoryResult {
  const file = path.join(dir, 'messages.jsonl');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return { header: null, rows: [], anchor: 0 };
  }
  // anchor 大于文件现长 = 文件被截断重写 → 从 0 重读（防御读）
  const start = anchor <= text.length ? anchor : 0;
  const chunk = text.slice(start);
  const rows: LedgerRow[] = [];
  let header: LedgerHeader | null = null;
  let end = start;
  for (const line of splitLines(chunk)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.text);
    } catch {
      continue; // 撕裂行跳过
    }
    if ((parsed as { type?: string }).type === 'session-header') {
      header = parsed as LedgerHeader;
      end = start + line.end;
      continue;
    }
    rows.push(parsed as LedgerRow);
    end = start + line.end;
  }
  return { header, rows, anchor: end };
}

interface LineInfo { text: string; end: number }

/** 切行（带行尾偏移——锚点推进用）；最后不完整行不产出 */
function splitLines(chunk: string): LineInfo[] {
  const out: LineInfo[] = [];
  let offset = 0;
  for (;;) {
    const nl = chunk.indexOf('\n', offset);
    if (nl < 0) break;
    out.push({ text: chunk.slice(offset, nl), end: nl + 1 });
    offset = nl + 1;
  }
  return out;
}

// —— watch 投影面 ——

export interface WatchHandle {
  close(): void;
}

/**
 * watch 单个账本目录的 messages.jsonl（追加事件 → 回调）。
 * fs.watch 事件名跨平台不稳定（rename/change/partial）——统一按
 * "有新字节"判定：每次事件读 stat，size 增长才触发（防抖本源）。
 * 目录 watch（非文件 watch——追加写场景下文件 inode 稳定，但目录
 * watch 对首建文件同样触发，会话首行不漏）。
 */
export function watchLedger(dir: string, onChange: () => void): WatchHandle {
  const file = path.join(dir, 'messages.jsonl');
  let lastSize = statSize(file);
  let timer: NodeJS.Timeout | null = null;
  const watcher = fs.watch(dir, { persistent: false }, () => {
    // 事件合并（Windows 高频 partial 事件）
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const size = statSize(file);
      if (size > lastSize) {
        lastSize = size;
        onChange();
      }
    }, 50);
  });
  watcher.on('error', () => watcher.close());
  return { close: () => { if (timer !== null) clearTimeout(timer); watcher.close(); } };
}

function statSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// —— 会话列表索引 ——

export interface SessionEntry {
  agentId: string;
  uuid: string;
  header: LedgerHeader | null;
}

/**
 * 扫描数据根下全部 agent 会话（agents/<id>/sessions/<uuid>/）——header 采样
 * （只读首行）。webui 会话列表 = 文件系统探查，无常驻索引。
 */
export function listSessions(dataRoot: string): SessionEntry[] {
  const agentsDir = path.join(dataRoot, 'agents');
  let agents: fs.Dirent[];
  try {
    agents = fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory());
  } catch {
    return [];
  }
  const out: SessionEntry[] = [];
  for (const agent of agents) {
    const sessions = path.join(agentsDir, agent.name, 'sessions');
    let uuids: fs.Dirent[];
    try {
      uuids = fs.readdirSync(sessions, { withFileTypes: true })
        .filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const u of uuids) {
      const header = readHeaderOnly(path.join(sessions, u.name));
      if (header !== null) out.push({ agentId: agent.name, uuid: u.name, header });
    }
  }
  return out;
}

function readHeaderOnly(dir: string): LedgerHeader | null {
  try {
    const first = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8').split('\n', 1)[0];
    const p = JSON.parse(first);
    if ((p as { type?: string }).type === 'session-header') return p as LedgerHeader;
    return null;
  } catch {
    return null;
  }
}
