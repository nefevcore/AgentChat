// ============================================================
// unread.ts —— 未读计数器（cr-1157 计数器方案）
//
// 未读 = 独立事件计数（hint 语义，不与账本行对账）：事件到达 +1，
// webui take 全量清零 / markRead 定向清。cr-1146/1150/1151 的读位
// 权威源与位置锚派生已被 cr-1157 裁决取代——计数器是唯一事实源，
// 不存在第二源可走散；错计不致命（消息本体永远落账，徽章只是提示）。
// 旧 version 1 读位数据作废（读为空表，不迁移）。
//
// 归位纯库（零 cordis）：meta 域 JSON 单文件范式——文件形状校验、
// 损坏留档、原子写（tmp+rename 重试）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renameWithRetry } from 'ac-plugin-core';

/** 计数器条目：n = 待消费计数；lastTs/lastKey = 诊断面（最近一次事件），不参与判定 */
export interface UnreadEntry {
  n: number;
  lastTs: number;
  lastKey?: string;
}

/** 盘上形态（meta/unread.json）：{ version: 2, entries: { [conversationId]: UnreadEntry } } */
interface UnreadFile {
  version: 2;
  entries: Record<string, UnreadEntry>;
}

function fileOf(dataRoot: string): string {
  return path.join(dataRoot, 'meta', 'unread.json');
}

function isEntry(v: unknown): v is UnreadEntry {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const e = v as { n?: unknown; lastTs?: unknown; lastKey?: unknown };
  if (typeof e.n !== 'number' || !Number.isInteger(e.n) || e.n < 0) return false;
  if (typeof e.lastTs !== 'number' || !Number.isFinite(e.lastTs) || e.lastTs <= 0) return false;
  if (e.lastKey !== undefined && (typeof e.lastKey !== 'string' || e.lastKey === '')) return false;
  return true;
}

function isConversationId(v: string): boolean {
  // 会话键词表：对桶 a~b / 群 gid / single uuid——禁路径分隔与 ..（键域
  // 收窄防脏数据扩散；与 cr-1146 读位键同款口径）
  return v !== '' && !v.includes('/') && !v.includes('\\') && !v.includes('..');
}

/** 损坏留档（workspaces.json 同款防线——防后续写口以空表覆写唯一副本） */
function archiveCorrupt(file: string): void {
  try { fs.renameSync(file, file + '.corrupt'); } catch { /* 留档失败不阻塞 */ }
}

/** 读取（version ≠ 2 / 损坏 = 空表——旧读位文件语义作废，静默换血） */
function read(dataRoot: string): Record<string, UnreadEntry> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(fileOf(dataRoot), 'utf-8'));
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
      try { archiveCorrupt(fileOf(dataRoot)); } catch { /* 缺席 */ }
    }
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || (raw as { version?: unknown }).version !== 2) {
    // version 1（cr-1146 读位）/ 异形 = 旧语义作废：留档后从零计
    archiveCorrupt(fileOf(dataRoot));
    return {};
  }
  const entries = (raw as { entries?: unknown }).entries;
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    archiveCorrupt(fileOf(dataRoot));
    return {};
  }
  const out: Record<string, UnreadEntry> = {};
  for (const [k, v] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof k === 'string' && isConversationId(k) && isEntry(v)) out[k] = v;
  }
  return out;
}

function write(dataRoot: string, entries: Record<string, UnreadEntry>): void {
  const file = fileOf(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true }); // meta/ 首写物化
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 2, entries } as UnreadFile, null, 2) + '\n', 'utf-8');
  renameWithRetry(tmp, file);
}

export function readUnread(dataRoot: string): Record<string, UnreadEntry> {
  return read(dataRoot);
}

//（cr-1157：未读轴键归一判据不住本包——前端行需同源消费而本包带 Node 依赖，
//  判据落 ac-wire-format/src/unread-axis.ts。）

/**
 * 事件计数 +1（源挂点写口）。幂等：同 key 重复事件（邮局 at-least-once
 * 重投 / tap 重连重放）不双计——key 缺席时不做幂等（源挂点尽量给键；
 * 无键事件罕见，宁可多计不漏计——hint 语义）。+1 即写盘（事件频率 =
 * run 收束级，很低；原子写成本可承受，crash 不丢已收计数）。
 */
export function bumpUnread(dataRoot: string, conversationId: string, key: string | undefined, ts?: number): UnreadEntry {
  if (!isConversationId(conversationId)) throw new Error('会话键非法：' + conversationId);
  const entries = read(dataRoot);
  const prev = entries[conversationId] as UnreadEntry | undefined;
  const now = ts ?? Date.now();
  if (prev !== undefined && key !== undefined && prev.lastKey === key) {
    return prev; // 幂等：最近一次事件同键——重复投递不双计
  }
  const next: UnreadEntry = { n: (prev?.n ?? 0) + 1, lastTs: now, ...(key !== undefined ? { lastKey: key } : {}) };
  entries[conversationId] = next;
  write(dataRoot, entries);
  return next;
}

/**
 * 全量取走并清零（webui 对齐 RPC 用）：返回 {conv: {n, lastTs}}，落盘空表。
 * 多端吞没语义：一端 take 即全局清（cr-1157 裁决接受）。
 */
export function takeUnread(dataRoot: string): Record<string, { n: number; lastTs: number }> {
  const entries = read(dataRoot);
  const out: Record<string, { n: number; lastTs: number }> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (v.n > 0) out[k] = { n: v.n, lastTs: v.lastTs };
  }
  write(dataRoot, {});
  return out;
}

/** 定向清零（点开会话即清——徽章即时消，不等同步周期） */
export function clearUnread(dataRoot: string, conversationId: string): void {
  if (!isConversationId(conversationId)) throw new Error('会话键非法：' + conversationId);
  const entries = read(dataRoot);
  const prev = entries[conversationId] as UnreadEntry | undefined;
  if (prev === undefined || prev.n === 0) return;
  delete entries[conversationId];
  write(dataRoot, entries);
}
