// ============================================================
// unread.ts —— 未读读位读写面 + 未读派生纯函数（cr-1146）
//
// 服务端只存读位不存计数（unread-authority-plan 裁决 1）：未读数 =
// 「会话最后事实行 vs 已读水位」的派生值，计数是投影永不落盘。读位
// 是用户会话域事实，住数据分层第二层 meta/unread.json（裁决 2），
// 与 session/settings 同层；写者 = 宿主 web-api 行（session/mark-read），
// 读者 = history 首屏/批量对账响应旁带。
//
// 归位纯库（零 cordis）：与 workspaces.json/groups.json 同款 meta 域
// JSON 单文件范式——文件形状校验、损坏留档、原子写（tmp+rename 重试）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renameWithRetry } from 'ac-plugin-core';

/** 读位（会话键 → 已读水位）：seq = B1 行级锚；messageId = 兜底身份
 *  （存量行无 seq 时判定）；ts = 落定时刻（诊断/审计，不参与判定） */
export interface ReadMark {
  seq?: number;
  messageId?: string;
  ts: number;
}

/** 盘上形态（meta/unread.json）：{ version: 1, entries: { [conversationId]: ReadMark } } */
interface UnreadFile {
  version: 1;
  entries: Record<string, ReadMark>;
}

function fileOf(dataRoot: string): string {
  return path.join(dataRoot, 'meta', 'unread.json');
}

function isMark(v: unknown): v is ReadMark {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const m = v as { seq?: unknown; messageId?: unknown; ts?: unknown };
  if (typeof m.ts !== 'number' || !Number.isFinite(m.ts) || m.ts <= 0) return false;
  if (m.seq !== undefined && (typeof m.seq !== 'number' || !Number.isInteger(m.seq) || m.seq < 0)) return false;
  if (m.messageId !== undefined && (typeof m.messageId !== 'string' || m.messageId === '')) return false;
  return m.seq !== undefined || m.messageId !== undefined;
}

function isConversationId(v: string): boolean {
  // 会话键词表：对桶 a~b / 群 gid / single uuid——禁路径分隔与 ..（读位
  // 键不直接寻址文件，键域收窄防脏数据扩散）
  return v !== '' && !v.includes('/') && !v.includes('\\') && !v.includes('..');
}

/** 损坏留档（workspaces.json 同款防线——防后续写口以空表覆写唯一副本） */
function archiveCorrupt(file: string): void {
  try { fs.renameSync(file, file + '.corrupt'); } catch { /* 留档失败不阻塞 */ }
}

function read(dataRoot: string): Record<string, ReadMark> {
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
    || (raw as { version?: unknown }).version !== 1) {
    archiveCorrupt(fileOf(dataRoot));
    return {};
  }
  const entries = (raw as { entries?: unknown }).entries;
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    archiveCorrupt(fileOf(dataRoot));
    return {};
  }
  const out: Record<string, ReadMark> = {};
  for (const [k, v] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof k === 'string' && isConversationId(k) && isMark(v)) out[k] = v;
  }
  return out;
}

function write(dataRoot: string, entries: Record<string, ReadMark>): void {
  const file = fileOf(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true }); // meta/ 首写物化
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries } as UnreadFile, null, 2) + '\n', 'utf-8');
  renameWithRetry(tmp, file);
}

/** 全量读位读取（批量对账面输入） */
export function readMarks(dataRoot: string): Record<string, ReadMark> {
  return read(dataRoot);
}

/** 单会话读位读取（首屏旁带用）；缺席 = undefined（全量未读） */
export function readMarkOf(dataRoot: string, conversationId: string): ReadMark | undefined {
  return read(dataRoot)[conversationId];
}

/**
 * 水位合并（单调取大——裁决 3：多端并发读，后读覆盖先读、不回退）。
 * seq 在场双方比较 seq（缺席方 = 不可比：旧有 seq 新无 → 旧水位已锚定
 * 行级不回退；旧无新有 → 升格行级锚）；双缺 seq 回落 messageId 恒等
 * 性（同锚 = 幂等；异锚保守 ts 大者胜——推进面不丢）。返回 null = 新
 * 水位不高于旧（幂等短路，调用方免写盘）。
 */
export function mergeMark(existing: ReadMark | undefined, incoming: ReadMark): ReadMark | null {
  if (existing === undefined) return { ...incoming };
  const a = existing.seq;
  const b = incoming.seq;
  if (a !== undefined && b !== undefined) {
    if (b > a) return { ...incoming };
    if (b < a) return null;
    // seq 相等：messageId 不冲突即幂等（ts 取大刷新）；冲突保守取 incoming
    return existing.messageId !== undefined && incoming.messageId !== undefined && existing.messageId !== incoming.messageId
      ? { ...incoming }
      : { seq: a, messageId: incoming.messageId ?? existing.messageId, ts: Math.max(existing.ts, incoming.ts) };
  }
  if (a !== undefined) return null;
  if (b !== undefined) return { ...incoming };
  if (existing.messageId !== undefined && incoming.messageId !== undefined) {
    if (existing.messageId === incoming.messageId) {
      return existing.ts >= incoming.ts ? null : { ...incoming };
    }
    return incoming.ts > existing.ts ? { ...incoming } : null;
  }
  return incoming.ts > existing.ts ? { ...incoming } : null;
}

/**
 * 写口唯一（mark-read RPC 的数据面）：水位单调取大落盘。返回落定后
 * 读位（幂等重复调用返回既有值、水位不变——批 2 测试标准）。
 */
export function markRead(
  dataRoot: string,
  conversationId: string,
  mark: { seq?: number; messageId?: string; ts?: number },
): ReadMark {
  if (!isConversationId(conversationId)) throw new Error('会话键非法：' + conversationId);
  const incoming: ReadMark = {
    ...(mark.seq !== undefined ? { seq: mark.seq } : {}),
    ...(mark.messageId !== undefined ? { messageId: mark.messageId } : {}),
    ts: mark.ts ?? Date.now(),
  };
  if (!isMark(incoming)) throw new Error('读位无效（seq/messageId 至少其一）');
  const entries = read(dataRoot);
  const merged = mergeMark(entries[conversationId], incoming);
  if (merged !== null) {
    entries[conversationId] = merged;
    write(dataRoot, entries);
  }
  return entries[conversationId] ?? incoming;
}

/** 账本行（unreadOf 输入形状——LedgerRow 结构子集） */
export interface UnreadRow {
  role: string;
  agent_id: string;
  content: string;
  message_id: string;
  requestId?: string;
  run?: string;
  source?: string;
  seq?: number;
}

/**
 * 未读事实行谓词：真实发言且非 viewer 入站行（agent_id='user'——「对方
 * 发言才算未读」）。role 词表双认：账本协议 'agent'（LedgerRow）与 webui
 * 投影 'assistant'（ViewRow——session/history 旁带路径直接传投影行集）
 * 是同一事实的两侧词形。段行/注入行/空终稿与 projectUserReplay peer
 * 谓词同排除。
 */
function isFactRow(r: UnreadRow): boolean {
  if (r.role !== 'agent' && r.role !== 'assistant') return false;
  if (r.agent_id === 'user') return false;
  if (r.source === 'segment' || r.source === 'inject') return false;
  if (String(r.content).trim() === '') return false;
  // 无 message_id 行不计（活投影/盲区行——无锚不承载未读事实；cr-1134 同语义）
  if (typeof r.message_id !== 'string' || r.message_id === '') return false;
  if (r.message_id.startsWith('seg-')) return false;
  return true;
}

/**
 * 未读数派生（纯函数——账本事实行新于读位水位的条数）。输入行集由
 * 调用方读取（对桶/single = conversationDirs 各域 readLedger 合并；
 * 群 = 成员流合并——group/history 同键 requestId/message_id 去重，
 * run 单行与 projectUserReplay 谓词同源防跨域重复计数）。
 */
export function unreadOf(rows: UnreadRow[], mark: ReadMark | undefined): number {
  const seen = new Set<string>();
  const runsWithFinal = new Set<string>();
  let count = 0;
  for (const r of rows) {
    if (!isFactRow(r)) continue;
    const key = typeof r.requestId === 'string' && r.requestId !== '' ? r.requestId
      : typeof r.message_id === 'string' && r.message_id !== '' ? r.message_id : undefined;
    if (key !== undefined) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const run = typeof r.run === 'string' && r.run !== '' ? r.run : undefined;
    if (run !== undefined) {
      if (runsWithFinal.has(run)) continue;
      runsWithFinal.add(run);
    }
    if (isNewerThanMark(r, mark)) count++;
  }
  return count;
}

/** 行是否新于读位水位：seq 双在场比 seq；否则 messageId 恒等性（旧数据
 *  回落——已读 = 不计，未读 = 计）；mark 无锚或行无锚 = 计（保守：
 *  无水位即全量未读）。 */
function isNewerThanMark(r: { seq?: number; message_id: string; requestId?: string }, mark: ReadMark | undefined): boolean {
  if (mark === undefined) return true;
  if (mark.seq !== undefined && r.seq !== undefined) return r.seq > mark.seq;
  const anchor = mark.messageId;
  if (anchor !== undefined) return r.message_id !== anchor && r.requestId !== anchor;
  return true;
}
