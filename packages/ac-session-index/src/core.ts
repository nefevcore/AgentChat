// ============================================================
// core.ts —— 会话指针索引纯库（cr-973 Phase 1 第一刀，2026-11-09）
//
// 零 cordis 依赖、零语义：只记「行在哪」（conv/domain/seq/byte_offset/
// line_len + 身份键），内容永远按字节区间回源 jsonl 读——索引是纯缓存，
// 可全量重建（方案 §0.2「指针索引只指真源」红线）。DB = node:sqlite 内建
// DatabaseSync（宿主单写者，WAL）。
// cr-1138 聚合读面（sessionMeta/sessionByDay）：records 表行内元数据列
// （role/agent_id/run/ts）的 SQL 统计——不引入第二事实源（真源仍是 jsonl，
// 索引可重建即聚合自愈）；「零语义」指不做内容解释，行内元数据列本就
// 为定位/判别而索引，统计是其只读投影。
//
//（cr-1157：cr-1151 未读谓词列与 SQL 派生面已随计数器方案整体退役——
//  未读不再从索引派生，见 ac-core-utils/unread.ts。）
//
// 增量协议（files 表 size/mtimeMs/consumed 三键对账，方案 §1.1）：
//   · 无行 / size < consumed / mtimeMs 倒退 / size 变小（compact 重写）
//     → 全量重建该文件（DELETE 后整读重插）；
//   · size > consumed → 增量：只读 [consumed, size) 切片，逐完整行消费
//     （撕裂尾行不入账、consumed 不越过切片最后一个换行——等补齐换行
//     再入账；坏 JSON 行跳过但照常消费）。
//
// 枚举 = ac-ledger conversationDirs(includeJournalOnly) 同形（viewer 域
// 在前 + agents/* readdir 序）——本包禁 import ac-ledger（索引层零依赖），
// 本地实现；指纹公式与 view.ts historyView 逐字节同形（跨互认）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** 刷新回执：本次入账行数 + 全量重建的文件路径集 */
export interface RefreshReport {
  appended: number;
  rebuilt: string[];
}

/** 会话三源文件（每域同形——方案 §1.1 读面输入） */
interface FileShape {
  file: string;
  kind: 'records' | 'journal' | 'subcalls';
}
const FILE_SHAPES: FileShape[] = [
  { file: 'messages.jsonl', kind: 'records' },
  { file: path.join('journal', 'partials.jsonl'), kind: 'journal' },
  { file: 'subcalls.jsonl', kind: 'subcalls' },
];

/** est_tokens/入账口径版本（cr-1160 P4）：语义演进时升版本——版本不符 →
 *  整库弃重建（纯缓存语义）。v1 = 行级文本面（content/text/arguments/result
 *  JSON，subcall 结果不计）；v2 = 追加「compaction 事件族一律不入 records」
 *  聚合白名单（旧三连 start/summary/end 曾污染 sessionMeta.total）+
 *  旧三连摘要长度经 summary→end 回填；v3 = 旧三连 boundary_seq 回落修正
 *  （boundarySeq ≤0 视为无效 → 取 end 行自身 seq，cr-974 原语义）；
 *  v4 = compactions 增 summary_tokens 列 + activeContextTokens 计入摘要头
 *  （与 estimateReplayTokens 的 opts.summary 同口径）。 */
const EST_TOKENS_VERSION = '4';

/** cr-1185 名册小表行（会话列表预览——IM thread 表形态）：发言口径
 *  末行身份/时标/正文摘录 + 活动口径末时标，refreshConversation 事务外
 *  同源重算（records 聚合 + 末发言行指针 seek 回源取正文——索引仍是
 *  纯缓存，roster 行可全量重建）。群行由成员流（g-<gid>~<member>，词法
 *  上是 pair）在 rosterSnapshot 读面折叠聚合——gid 本身无账本目录。 */
export interface RosterRow {
  key: string;
  kind: SessionKind;
  /** 发言口径末行时标（ISO；null = 无发言行） */
  lastSpeechAt: string | null;
  /** 末发言者（账本原形：入站用户行 = agent_id 'user'） */
  lastAgent: string | null;
  lastRole: string | null;
  /** 末发言正文摘录（截 120 字符；seek 回源派生） */
  lastText: string | null;
  /** 活动口径末时标（ISO——含 step/run-end 等机制行，排序浮顶用） */
  lastAt: string | null;
  speech: number;
  total: number;
  /** 发言行数（cr-1185 批3：runs/snapshot messageCount 换源口径——
   *  数值从 replay 投影行数变为 SQL 发言行数，语义更准但会变） */
  messageCount: number;
}

/** journal 行类型判别（readJournal 同款：只认四种已知判别行，未知 type 安全忽略） */
const JOURNAL_TYPES = ['journal-step', 'journal-inject', 'journal-tool-result', 'journal-settled'];
function journalLineType(text: string): string | null {
  const t = text.trimStart();
  for (const ty of JOURNAL_TYPES) {
    if (t.startsWith('{"type":"' + ty + '"')) return ty;
  }
  return null;
}

/** 文本 token 估算（ac-text-budget 同口径：CJK 0.6 / 其他 0.3） */
function estimateTextTokens(s: string | null | undefined): number {
  if (typeof s !== 'string' || s === '') return 0;
  let t = 0;
  for (const ch of s) t += ch.charCodeAt(0) > 0x2e7f ? 0.6 : 0.3;
  return Math.ceil(t);
}

function isSafeId(id: string): boolean {
  return id !== '' && !id.includes('/') && !id.includes('\\') && !id.includes('..');
}

/** 某会话的全部源目录（域目录存在即算——仅 journal 的域也在列；
 *  cr-998 viewer 域退役——枚举只剩 agents/* readdir 序，与
 *  conversationDirs 同形） */
function sessionDirs(dataRoot: string, convId: string): string[] {
  if (!isSafeId(convId)) throw new Error('conversationId "' + convId + '" 非法（禁路径分隔 / ..）');
  const out: string[] = [];
  const exists = (dir: string): boolean => fs.existsSync(dir);
  let agents: fs.Dirent[] = [];
  try { agents = fs.readdirSync(path.join(dataRoot, 'agents'), { withFileTypes: true }); } catch { /* 无 agents 域 */ }
  for (const a of agents) {
    if (!a.isDirectory()) continue;
    const dir = path.join(dataRoot, 'agents', a.name, 'sessions', convId);
    if (exists(dir)) out.push(dir);
  }
  return out;
}

/** 域名（目录结构倒推：…/sessions/<conv> → …/<domain>/sessions/<conv>） */
function domainOf(dir: string): string {
  return path.basename(path.dirname(path.dirname(dir)));
}

/** 会话键词法分类（cr-1138，与前端 routeDialog 词法闸同源口径）：
 *  'g-' 前缀 = 群键；含 '~' = 对桶（agent⇄agent / gid~member 成员流 /
 *  a~a 自会话）；uuid 形 = 独立会话；其余（裸 agentId 历史桶等）= other。 */
export type SessionKind = 'pair' | 'single' | 'group' | 'other';
export function sessionKindOf(key: string): SessionKind {
  if (key.startsWith('g-')) return 'group';
  if (key.includes('~')) return 'pair';
  if (SESSION_UUID_RE.test(key)) return 'single';
  return 'other';
}
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 会话元数据聚合（cr-1138——records 表 SQL 统计，零盘读）。
 *
 *  时间维度双口径（v1/v2 行形态差异迫使区分，消费面各取所需）：
 *   · 活动口径（firstAt/lastAt/activeDays）= 全部记录行（含 step/run-end/
 *     inject）——健康仪表板、activity 窗口、「这个会话最近有没有动」；
 *   · 发言口径（firstSpeechAt/lastSpeechAt/speechDays）= user/agent 发言行
 *     且正文不空的语义面——diving「沉默天数」、「有没有在对话」。
 *   两者不可互替：Agent 跑了长 run 但没发言 = 活动在场、发言缺席。
 *
 *  total/speech 跨域合计：agent⇄agent 对桶两侧域各记一份时为镜像近似
 *  （时序维度不受影响）；日口径 = UTC。 */
export interface SessionMeta {
  key: string;
  kind: SessionKind;
  /** 持有该会话记录的 agent 域（镜像对桶 >1） */
  domains: string[];
  /** records 行数（含 context/inject/step 等非发行） */
  total: number;
  /** user/agent 发言行数（diving「有对话」口径） */
  speech: number;
  /** distinct run 数 */
  runs: number;
  /** 全行最早/最晚时标（ISO，活动口径） */
  firstAt: string | null;
  lastAt: string | null;
  /** 有任意记录行的 UTC 日数（活动口径） */
  activeDays: number;
  /** 发言行最早/最晚时标（ISO，发言口径——diving 沉默天数取 lastSpeechAt） */
  firstSpeechAt: string | null;
  lastSpeechAt: string | null;
  /** 有发言的 UTC 日数（发言口径） */
  speechDays: number;
  /** 末发言行的角色/归属（roster 预览权威化数据源——发言口径，非活动末行） */
  lastRole: string | null;
  lastAgent: string | null;
  /** 末活动行型（step/run-end/inject/message…；健康仪表板） */
  lastType: string | null;
}

/** 压缩代边界（cr-1160）：boundarySeq ≤ 0 视为无有效边界 → 回落事件自身
 *  seq（存量老 writer 显式写 0 的现场形态；与 ac-ledger events-v2 同判）。 */
function boundaryOf(row: Record<string, unknown>, rowType: string): number | null {
  const declared = num(row.boundarySeq);
  if (declared !== null && declared > 0) return declared;
  return rowType === 'compaction/end' ? num(row.seq) : declared;
}

/** 行内字段安全取值（撕裂/异形行容错——缺席 = NULL） */
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 会话指针索引（宿主单写者）。构造即建库（mkdir + WAL + 建表）；
 * 惰性 refresh：读面调 refreshConversation / fingerprintOf 时增量对账。
 */
export class SessionIndex {
  private db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  constructor(dbFile: string) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec('PRAGMA journal_mode=WAL');
    // cr-974：records 表增事件列（type/tool_call_id——v2 相位/收束行定位）；
    // cr-1138：增 ts_num（统一数字时标——v2 事件行用 ts 数字/epoch，v1 行用
    // timestamp ISO 文本，两代形态不同；聚合的时间/活跃日维度须单一时标列）。
    // cr-1160 P4：增 generation（压缩代）与 est_tokens（行级文本面估算）列 +
    // compactions 表（压缩代清单）——activeContextTokens/threshold 的索引直读面。
    // 旧 schema 落库 = 纯缓存过期 → 整库弃重建（files 一并清，refresh 自愈）
    const cols = (this.db.prepare('PRAGMA table_info(records)').all() as Array<{ name?: unknown }>).map((c) => c.name);
    const cmpCols = (this.db.prepare('PRAGMA table_info(compactions)').all() as Array<{ name?: unknown }>).map((c) => c.name);
    const cmpStale = cmpCols.length > 0 && !cmpCols.includes('summary_tokens');
    if ((cols.length > 0 && (!cols.includes('type') || !cols.includes('ts_num') || !cols.includes('generation'))) || cmpStale) {
      this.db.exec('DROP TABLE IF EXISTS records; DROP TABLE IF EXISTS journal_lines; DROP TABLE IF EXISTS subcalls; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS compactions; DROP TABLE IF EXISTS roster;');
    }
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS files (' +
        'path TEXT PRIMARY KEY, conv TEXT NOT NULL, consumed INTEGER NOT NULL, ' +
        'size INTEGER NOT NULL, mtimeMs REAL NOT NULL); ' +
      'CREATE TABLE IF NOT EXISTS records (' +
        'conv TEXT, domain TEXT, seq INTEGER, byte_offset INTEGER, line_len INTEGER, ' +
        'role TEXT, agent_id TEXT, run TEXT, request_id TEXT, message_id TEXT, ts TEXT, ' +
        'type TEXT, tool_call_id TEXT, ts_num INTEGER, generation INTEGER DEFAULT 0, est_tokens INTEGER); ' +
      'CREATE INDEX IF NOT EXISTS idx_records_conv_domain ON records(conv, domain); ' +
      // cr-1160 P4：压缩代清单（单事件 + 旧三连 end 行；generation 入列序）
      'CREATE TABLE IF NOT EXISTS compactions (' +
        'conv TEXT, domain TEXT, run TEXT, generation INTEGER, boundary_seq INTEGER, end_ts INTEGER, ' +
        'summary_len INTEGER, summary_tokens INTEGER, model TEXT, stats TEXT, seq INTEGER); ' +
      'CREATE INDEX IF NOT EXISTS idx_compactions_conv ON compactions(conv, domain); ' +
      'CREATE TABLE IF NOT EXISTS journal_lines (' +
        'conv TEXT, domain TEXT, seq INTEGER, byte_offset INTEGER, line_len INTEGER, ' +
        'type TEXT, run TEXT, tool_call_id TEXT, ts INTEGER); ' +
      'CREATE INDEX IF NOT EXISTS idx_journal_conv_domain ON journal_lines(conv, domain); ' +
      'CREATE TABLE IF NOT EXISTS subcalls (' +
        'conv TEXT, domain TEXT, run TEXT, tool_call_id TEXT, ' +
        'byte_offset INTEGER, line_len INTEGER); ' +
      // cr-1185：名册小表（每会话一行——files 表 stat 指纹随行，
      // 供缺口对账：fp 不匹配 = records 待增量 + roster 待重算）
      'CREATE TABLE IF NOT EXISTS roster (' +
        'conv TEXT PRIMARY KEY, kind TEXT, last_speech_ms INTEGER, last_agent TEXT, last_role TEXT, ' +
        'last_text TEXT, last_at_ms INTEGER, speech INTEGER, total INTEGER, fp_size INTEGER, fp_mtime REAL); ' +
      // cr-1160：口径版本元表（估算语义演进 → 版本不符整库重建）
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);'
    );
    // 口径版本对账（cr-1160 P4）：est_tokens 估算语义变化 → 已算值陈旧，
    // 纯缓存可用「整库重建」自愈（不迁数据、不猜旧值）。
    const seen = (this.db.prepare("SELECT value FROM meta WHERE key = 'est_tokens_version'").get() as { value?: unknown } | undefined)?.value;
    const hasRows = (this.db.prepare('SELECT 1 AS hit FROM records LIMIT 1').get() as { hit?: unknown } | undefined) !== undefined;
    // 无标记但有账面行 = 本版本前建立（est_tokens 口径未知）→ 同样视为陈旧
    if (seen !== EST_TOKENS_VERSION && (seen !== undefined || hasRows)) {
      this.db.exec('DELETE FROM records; DELETE FROM compactions; DELETE FROM journal_lines; DELETE FROM subcalls; DELETE FROM files; DELETE FROM roster;');
    }
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('est_tokens_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(EST_TOKENS_VERSION);
  }

  /** 预编译语句缓存（实例生命周期内复用） */
  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (s === undefined) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  close(): void {
    this.db.close();
    this.stmts.clear();
  }

  /** 刷新某会话全部域 × 三源文件的指针行（重建/增量对账见文件头）。
   *  cr-1185：尾部同源重算 roster 行（records 聚合 + 末发言正文 seek
   *  回源；stat 指纹随行——rosterGapOf 据此判缺口）。零源目录时**不**落
   *  roster 行（null kind 表示「会话不存在」，清账归 drop）。 */
  refreshConversation(dataRoot: string, convId: string): RefreshReport {
    const report: RefreshReport = { appended: 0, rebuilt: [] };
    const dirs = sessionDirs(dataRoot, convId);
    for (const dir of dirs) {
      const domain = domainOf(dir);
      for (const shape of FILE_SHAPES) {
        const file = path.join(dir, shape.file);
        if (!fs.existsSync(file)) continue;
        this.indexFile(file, shape.kind, convId, domain, report);
      }
    }
    if (dirs.length > 0) this.recomputeRoster(dataRoot, convId);
    return report;
  }

  /** 单文件对账 + 入账（每文件一个事务——崩溃即整体回滚，无半截索引） */
  private indexFile(file: string, kind: FileShape['kind'], conv: string, domain: string, report: RefreshReport): void {
    const st = fs.statSync(file);
    const row = this.stmt('SELECT consumed, size, mtimeMs FROM files WHERE path = ?').get(file) as
      | { consumed: number; size: number; mtimeMs: number }
      | undefined;
    const rebuild = row === undefined || st.size < row.consumed || st.mtimeMs < row.mtimeMs || st.size < row.size;
    let consumed = rebuild ? 0 : row.consumed;
    if (!rebuild && st.size <= consumed) {
      // 无新数据：只刷 stat 锚（mtime 前移不改 consumed）
      this.stmt('UPDATE files SET size = ?, mtimeMs = ? WHERE path = ?').run(st.size, st.mtimeMs, file);
      return;
    }
    const fd = fs.openSync(file, 'r');
    try {
      this.db.exec('BEGIN');
      // 旧三连摘要长度暂存（summary 行 → end 行回填；per-file，重建即清空）
      const summaryLens = new Map<string, number | null>();
      const summaryTokens = new Map<string, number>();
      if (rebuild) {
        const table = kind === 'records' ? 'records' : kind === 'journal' ? 'journal_lines' : 'subcalls';
        this.stmt('DELETE FROM ' + table + ' WHERE conv = ? AND domain = ?').run(conv, domain);
        // 压缩代清单同源重建（否则重建后 compactions 残留旧代 → 代数重复推进）
        if (kind === 'records') this.stmt('DELETE FROM compactions WHERE conv = ? AND domain = ?').run(conv, domain);
        report.rebuilt.push(file);
      }
      const buf = Buffer.alloc(st.size - consumed);
      fs.readSync(fd, buf, 0, buf.length, consumed);
      // 逐完整行消费：line_len 不含换行；尾段无换行 = 撕裂行，不入账、
      // consumed 不前进（留在下次增量补齐）
      let lineStart = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== 0x0a) continue;
        if (this.indexLine(kind, conv, domain, consumed + lineStart, i - lineStart, buf.subarray(lineStart, i).toString('utf-8'), summaryLens, summaryTokens)) report.appended += 1;
        lineStart = i + 1;
      }
      consumed += lineStart;
      this.stmt(
        'INSERT INTO files (path, conv, consumed, size, mtimeMs) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(path) DO UPDATE SET consumed = excluded.consumed, size = excluded.size, mtimeMs = excluded.mtimeMs',
      ).run(file, conv, consumed, st.size, st.mtimeMs);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      fs.closeSync(fd);
    }
  }

  /** roster 行重算（cr-1185——refreshConversation 尾部调用）：records
   *  SQL 聚合身份/时标 + 末发言行指针 seek 回源取正文截断；stat 复合
   *  指纹随行（rosterGapOf 对账燃料）。索引行缺席（records 无行）时按
   *  空会话落全零行——目录在即合法态。 */
  private recomputeRoster(dataRoot: string, convId: string): void {
    const agg = this.stmt(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN role IN ('user','agent') THEN 1 ELSE 0 END) AS speech, " +
        'MAX(ts_num) AS last_at_ms FROM records WHERE conv = ?',
    ).get(convId) as { total: number; speech: number | null; last_at_ms: number | null };
    // 末发言行（含指针与正文口径键——seek 回源用）：ts_num 前提上再要求
    // role 在场，排除「带 role 的脏事件行」；seq DESC 域内稳序。
    const last = this.stmt(
      "SELECT agent_id AS lastAgent, role AS lastRole, ts_num AS lastMs, domain, byte_offset, line_len, seq FROM records " +
        "WHERE conv = ? AND role IN ('user','agent') AND ts_num IS NOT NULL " +
        'ORDER BY ts_num DESC, seq DESC LIMIT 1',
    ).get(convId) as { lastAgent: string | null; lastRole: string | null; lastMs: number; domain: string; byte_offset: number; line_len: number; seq: number } | undefined;
    let lastText: string | null = null;
    if (last !== undefined && last.line_len > 0) {
      // 正文 seek 回源（单行读——指针索引本色：内容不驻索引）
      const file = path.join(dataRoot, 'agents', last.domain, 'sessions', convId, 'messages.jsonl');
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(last.line_len);
          fs.readSync(fd, buf, 0, last.line_len, last.byte_offset);
          const row = JSON.parse(buf.toString('utf-8')) as { content?: unknown; text?: unknown };
          const text = typeof row.content === 'string' ? row.content : typeof row.text === 'string' ? row.text : null;
          if (text !== null && text !== '') lastText = text.slice(0, 120);
        } finally { fs.closeSync(fd); }
      } catch { /* 回源失败 = lastText null（身份/时标不受影响） */ }
    }
    // stat 复合指纹（三源文件——rosterGapOf 对账同公式）
    let fpSize = 0; let fpMtime = 0;
    for (const dir of sessionDirs(dataRoot, convId)) {
      for (const shape of FILE_SHAPES) {
        try {
          const st = fs.statSync(path.join(dir, shape.file));
          fpSize += st.size; fpMtime = Math.max(fpMtime, st.mtimeMs);
        } catch { /* 缺席不参与 */ }
      }
    }
    this.stmt(
      'INSERT INTO roster (conv, kind, last_speech_ms, last_agent, last_role, last_text, last_at_ms, speech, total, fp_size, fp_mtime) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(conv) DO UPDATE SET kind = excluded.kind, last_speech_ms = excluded.last_speech_ms, ' +
        'last_agent = excluded.last_agent, last_role = excluded.last_role, last_text = excluded.last_text, ' +
        'last_at_ms = excluded.last_at_ms, speech = excluded.speech, total = excluded.total, ' +
        'fp_size = excluded.fp_size, fp_mtime = excluded.fp_mtime',
    ).run(convId, sessionKindOf(convId), last?.lastMs ?? null, last?.lastAgent ?? null, last?.lastRole ?? null, lastText, agg.last_at_ms, agg.speech ?? 0, agg.total, fpSize, fpMtime);
  }

  /** 当前行应落的压缩代（cr-1160 P4）：已入账 compactions 的 max+1——
   *  行与压缩事件的相对代序由文件序决定（增量只追加尾部，天然成立）。 */
  private currentGeneration(conv: string, domain: string): number {
    const r = this.stmt('SELECT MAX(generation) AS g FROM compactions WHERE conv = ? AND domain = ?').get(conv, domain) as { g: number | null };
    return (r.g ?? 0) + 1;
  }

  /** 行级文本面 token 估算（cr-1160 P4——ac-text-budget 同口径 CJK 0.6/其他 0.3）：
   *  v1 行 = content；v2 相位行 = text；tool-call = name+arguments；
   *  tool-call-result = result JSON（**subcall 行不计**——与 ac-archive-core
   *  replayTokensOf 的 subcall 过滤同源：run_code 程序内子调用不进回放
   *  注入，实测占体量大头——news~news 现场 1.7M→0.4M）；
   *  compaction 行不计（非会话载荷）；cr-1189 V3：archive-review-request
   *  机制请求行不计（非会话载荷，回放由压缩边界出清）；archive-summary
   *  摘要行计入（Q2 裁定——新代头部事实，与 est_tokens 同源）。 */
  private static estimateRowTokens(row: Record<string, unknown>): number | null {
    const est = estimateTextTokens;
    const type = row.type;
    if (type === 'compaction' || (typeof type === 'string' && type.startsWith('compaction/'))) return null;
    if (type === 'step/reasoning' || type === 'step/content') return est(row.text as string);
    if (type === 'step/tool-call') return est(String(row.name ?? '') + String(row.arguments ?? ''));
    if (type === 'step/tool-call-result') return row.subcall === true ? 0 : est(JSON.stringify(row.result ?? null));
    if (row.source === 'archive-review-request') return null;
    return est(row.content as string);
  }

  /** 单行解析入账（返回是否计入 appended——判别/坏行跳过但已消费） */
  private indexLine(kind: FileShape['kind'], conv: string, domain: string, byteOffset: number, lineLen: number, text: string, summaryLens: Map<string, number | null>, summaryTokens: Map<string, number>): boolean {
    if (text.trim() === '') return false;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      row = parsed as Record<string, unknown>;
    } catch {
      return false; // 坏行：不入账但已消费
    }
    if (kind === 'records') {
      if (row.type === 'session-header') return false; // 头行不是消息行
      // cr-1160 P4：压缩代清单与聚合白名单。**compaction 事件族一律不进
      // records**（聚合白名单：摘要/边界不是会话活动——否则 sessionMeta.total
      // 与 ts_num 活跃度被机制行污染）；它们只进 compactions 表。
      //   单事件 compaction → 一行即一代（摘要/stats/model 随行）；
      //   旧三连 compaction/* → summary 行记摘要长度入 pending，end 行建代
      //   时回填（start 行仅标记；孤 summary 无 end 不建代——与 fold 同判）。
      // generation 推进由 compactions 表代数驱动：建代后 currentGeneration
      // 自然 +1，后续普通行落新一代（无需 end 行进 records 来「消耗」代）。
      const rowType = row.type;
      if (typeof rowType === 'string' && rowType.startsWith('compaction')) {
        const run = str(row.run) ?? '';
        if (rowType === 'compaction/summary') {
          summaryLens.set(run, typeof row.summary === 'string' ? row.summary.length : null);
          if (typeof row.summary === 'string') summaryTokens.set(run, estimateTextTokens(row.summary));
          return false;
        }
        if (rowType === 'compaction/start') return false;
        if (rowType === 'compaction/end' || rowType === 'compaction') {
          const gen = this.currentGeneration(conv, domain);
          const summaryLen = rowType === 'compaction'
            ? (typeof row.summary === 'string' ? (row.summary as string).length : null)
            : (summaryLens.get(run) ?? null);
          const summaryTok = rowType === 'compaction'
            ? (typeof row.summary === 'string' ? estimateTextTokens(row.summary) : null)
            : (summaryTokens.get(run) ?? null);
          this.stmt(
            'INSERT INTO compactions (conv, domain, run, generation, boundary_seq, end_ts, summary_len, summary_tokens, model, stats, seq) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(conv, domain, run, gen, boundaryOf(row, rowType), num(row.ts), summaryLen, summaryTok, str(row.model), rowType === 'compaction' && row.stats !== undefined ? JSON.stringify(row.stats) : null, num(row.seq));
          return false;
        }
        return false; // 未知 compaction/* 词汇安全忽略
      }
      // 时标归一（cr-1138）：v2 事件行（step/* · run-end · inject）只带数字
      // ts（epoch ms）无 role/timestamp；v1 行（含 v2 的 message 发言行）带
      // ISO timestamp。两代并存——ts_num 是聚合的时间维度单源。
      const tsNum = num(row.ts) ?? (typeof row.timestamp === 'string' ? (Date.parse(row.timestamp) || null) : null);
      this.stmt(
        'INSERT INTO records (conv, domain, seq, byte_offset, line_len, role, agent_id, run, request_id, message_id, ts, type, tool_call_id, ts_num, generation, est_tokens) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(conv, domain, num(row.seq), byteOffset, lineLen, str(row.role), str(row.agent_id), str(row.run), str(row.requestId), str(row.message_id), str(row.timestamp), str(row.type), str(row.toolCallId), tsNum, this.currentGeneration(conv, domain), SessionIndex.estimateRowTokens(row));
      return true;
    }
    if (kind === 'journal') {
      const type = journalLineType(text);
      if (type === null) return false; // 未知 type 安全忽略（前向兼容）
      this.stmt(
        'INSERT INTO journal_lines (conv, domain, seq, byte_offset, line_len, type, run, tool_call_id, ts) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(conv, domain, num(row.seq), byteOffset, lineLen, type, str(row.run), type === 'journal-tool-result' ? str(row.toolCallId) : null, num(row.ts));
      return true;
    }
    // subcalls（readSubcalls 同判：只认 journal-tool-result 判别行）
    if (!text.trimStart().startsWith('{"type":"journal-tool-result"')) return false;
    this.stmt(
      'INSERT INTO subcalls (conv, domain, run, tool_call_id, byte_offset, line_len) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(conv, domain, str(row.run), str(row.toolCallId), byteOffset, lineLen);
    return true;
  }

  /** 会话 stat 面入账（cr-980）：三源文件 statSync 与 files 行对账——不读
   *  文件内容（指纹面只吃 stat——runs/snapshot 每拍零盘读的基础）。行缺席
   *  以 consumed=0 落锚（指针面稍后按需增量入账；subcall 定位面因
   *  consumed=0 < size 自然回落全读，无静默陈旧）；size 增长 / mtime 前移
   *  只刷 stat 锚（consumed 不动——增量留给指针面）；size 倒退或 mtime
   *  倒退（compact 重写 / 回灌旧文件）锚与对应指针行一并清——指针面下次
   *  全量重建，不残双份。 */
  refreshStats(dataRoot: string, convId: string): void {
    for (const dir of sessionDirs(dataRoot, convId)) {
      const domain = domainOf(dir);
      for (const shape of FILE_SHAPES) {
        const file = path.join(dir, shape.file);
        let st: fs.Stats;
        try { st = fs.statSync(file); } catch { continue; }
        const row = this.stmt('SELECT consumed, size, mtimeMs FROM files WHERE path = ?').get(file) as
          | { consumed: number; size: number; mtimeMs: number }
          | undefined;
        if (row === undefined) {
          this.stmt('INSERT INTO files (path, conv, consumed, size, mtimeMs) VALUES (?, ?, 0, ?, ?)').run(file, convId, st.size, st.mtimeMs);
        } else if (st.size < row.size || st.mtimeMs < row.mtimeMs) {
          this.stmt('DELETE FROM files WHERE path = ?').run(file);
          const table = shape.kind === 'records' ? 'records' : shape.kind === 'journal' ? 'journal_lines' : 'subcalls';
          this.stmt('DELETE FROM ' + table + ' WHERE conv = ? AND domain = ?').run(convId, domain);
        } else {
          this.stmt('UPDATE files SET size = ?, mtimeMs = ? WHERE path = ?').run(st.size, st.mtimeMs, file);
        }
      }
    }
  }

  /** messages.jsonl 账面（cr-981）：files 表 messages 行按 conv 聚合——与
   *  singles-row ledgerFingerprint 同公式（size 求和、mtime 取最大、跨域
   *  三源文件枚举；零盘 IO）。files 行只源于三源文件枚举，LIKE 后缀
   *  命中面 = messages.jsonl 本身。 */
  messagesCatalog(): Array<{ conv: string; size: number; mtimeMs: number }> {
    return this.stmt(
      "SELECT conv, SUM(size) AS size, MAX(mtimeMs) AS mtimeMs FROM files WHERE path LIKE '%' || ? GROUP BY conv",
    ).all('messages.jsonl') as Array<{ conv: string; size: number; mtimeMs: number }>;
  }

  /** 全目录账面聚合（files 表按 conv 聚合——零盘 IO；新鲜度由调用方
   *  定向 refreshStats + 周期对账维护） */
  catalog(): Array<{ conv: string; size: number; mtimeMs: number }> {
    return this.stmt('SELECT conv, SUM(size) AS size, MAX(mtimeMs) AS mtimeMs FROM files GROUP BY conv').all() as Array<{ conv: string; size: number; mtimeMs: number }>;
  }

  /**
   * 会话元数据聚合（cr-1138）：先 refreshConversation（惰性对账——聚合
   * 新鲜度跟对账协议走），再 records 表 SQL 统计。会话源目录不存在 =
   *  null；存在但零行 = 全零 meta（空会话是合法态）。
   *
   * cr-1142：`refresh: false` = **只读聚合**（不建索引行）。给高频聚合面
   *（runs/snapshot 60s 轮询 + 事件驱动，每拍对多个会话取元数据）用——
   * refresh 会给未入账会话读全文件 + 写 records，冷启动（索引库重建/迁移）
   * 时被高频面隐式触发即等价于全量预热，与 cr-1138「full 才是显式预热、
   * 首次代价高」的裁决相悖。只读模式对未入账会话返回 null（调用方回落
   * 既有读面），索引仍由显式读面（session/meta RPC、historyView）按需建立。
   */
  sessionMeta(dataRoot: string, convId: string, opts: { refresh?: boolean } = {}): SessionMeta | null {
    if (sessionDirs(dataRoot, convId).length === 0) return null;
    if (opts.refresh === false) {
      // 未入账（records 无行）= 索引尚未建立 → null（区别于「空会话」的全零 meta）
      const known = this.stmt('SELECT 1 AS hit FROM records WHERE conv = ? LIMIT 1').get(convId);
      if (known === undefined) return null;
    } else {
      this.refreshConversation(dataRoot, convId);
    }
    // 时标单源 = ts_num（v1 ISO timestamp / v2 数字 ts 归一——见 indexLine）；
    // ISO 输出用 strftime 还原（消费面可 Date.parse 直取）。
    const SPEECH = "role IN ('user', 'agent')";
    const ISO = (col: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ts_num / 1000.0, 'unixepoch')`;
    const DAY = (expr = 'ts_num') => `date(${expr} / 1000, 'unixepoch')`;
    const agg = this.stmt(
      'SELECT COUNT(*) AS total, ' +
      `SUM(CASE WHEN ${SPEECH} THEN 1 ELSE 0 END) AS speech, ` +
      `MIN(${ISO('ts_num')}) AS firstAt, MAX(${ISO('ts_num')}) AS lastAt, ` +
      `COUNT(DISTINCT ${DAY()}) AS activeDays, ` +
      `MIN(CASE WHEN ${SPEECH} THEN ${ISO('ts_num')} END) AS firstSpeechAt, ` +
      `MAX(CASE WHEN ${SPEECH} THEN ${ISO('ts_num')} END) AS lastSpeechAt, ` +
      `COUNT(DISTINCT CASE WHEN ${SPEECH} THEN ${DAY()} END) AS speechDays, ` +
      'COUNT(DISTINCT run) AS runs ' +
      'FROM records WHERE conv = ?',
    ).get(convId) as {
      total: number; speech: number | null; runs: number;
      firstAt: string | null; lastAt: string | null; activeDays: number;
      firstSpeechAt: string | null; lastSpeechAt: string | null; speechDays: number;
    };
    // 末发言者（roster 预览权威化）：发言口径——名单行要的是「最后谁说了话」，
    // 活动口径的末行常是 run-end/step（无 role/agent，真实数据实证）。
    const lastSpeech = this.stmt(
      "SELECT role AS lastRole, agent_id AS lastAgent FROM records " +
      "WHERE conv = ? AND role IN ('user', 'agent') AND ts_num IS NOT NULL " +
      'ORDER BY ts_num DESC, seq DESC LIMIT 1',
    ).get(convId) as { lastRole: string | null; lastAgent: string | null } | undefined;
    // 末活动行型（健康仪表板：最近发生了什么——step/run-end/inject 等）
    const lastType = this.stmt(
      'SELECT type FROM records WHERE conv = ? AND ts_num IS NOT NULL ORDER BY ts_num DESC, seq DESC LIMIT 1',
    ).get(convId) as { type: string | null } | undefined;
    const domains = (this.stmt(
      'SELECT DISTINCT domain FROM records WHERE conv = ? ORDER BY domain',
    ).all(convId) as Array<{ domain: string }>).map((r) => r.domain);
    // COUNT/SUM/COUNT DISTINCT 聚合行恒在场（空表也返回一行）；
    // speech 的 SUM 零命中 = NULL → 归零，其余直接断言非空。
    return {
      key: convId,
      kind: sessionKindOf(convId),
      domains,
      total: agg.total,
      speech: agg.speech ?? 0,
      runs: agg.runs,
      firstAt: agg.firstAt,
      lastAt: agg.lastAt,
      activeDays: agg.activeDays,
      firstSpeechAt: agg.firstSpeechAt,
      lastSpeechAt: agg.lastSpeechAt,
      speechDays: agg.speechDays,
      lastRole: lastSpeech?.lastRole ?? null,
      lastAgent: lastSpeech?.lastAgent ?? null,
      lastType: lastType?.type ?? null,
    };
  }

  /** 会话的**新鲜 stat 复合指纹**（size 求和 + mtime 取最大，跨域三源
   *  文件——与 recomputeRoster 落行 fp 同公式、face-ops 快照指纹源同构）。
   *  会话目录缺席 = null。 */
  private freshFingerprintOf(dataRoot: string, convId: string): { size: number; mtimeMs: number } | null {
    let size = 0;
    let mtimeMs = 0;
    let hit = false;
    for (const dir of sessionDirs(dataRoot, convId)) {
      for (const shape of FILE_SHAPES) {
        try {
          const st = fs.statSync(path.join(dir, shape.file));
          size += st.size; mtimeMs = Math.max(mtimeMs, st.mtimeMs); hit = true;
        } catch { /* 缺席文件不参与 */ }
      }
    }
    return hit ? { size, mtimeMs } : null;
  }

  /** 名册缺口判定（cr-1185；性能修复后单会话原子）：会话目录的新鲜 stat
   *  指纹 vs roster 行随存指纹——不匹配（未入账/陈旧/目录缺席清理孤儿行）
   *  即需 refreshConversation。**有意不做全量版**：千级会话的全量 stat 扫
   *  是秒级同步段，曾在 RPC 路径冻结宿主 ~6s（首批 RPC 全体排队）——全量
   *  对账由调用方（face-ops warmRoster）逐会话分片让出。 */
  rosterGapOf(dataRoot: string, convId: string): boolean {
    const fresh = this.freshFingerprintOf(dataRoot, convId);
    const row = this.db.prepare('SELECT fp_size, fp_mtime FROM roster WHERE conv = ?').get(convId) as { fp_size: number | null; fp_mtime: number | null } | undefined;
    if (fresh === null) return row !== undefined; // 目录已消失 = 孤儿行，需清
    if (row === undefined || row.fp_size === null || row.fp_mtime === null) return true;
    return row.fp_size !== fresh.size || row.fp_mtime !== fresh.mtimeMs;
  }

  /** 全部会话键 + 缺口判定分离视图（分片让出的数据源：调用方逐键调
   *  rosterGapOf 并按时间片让出；本方法自身零 stat——只做目录枚举）。 */
  allConversationIds(dataRoot: string): string[] {
    const out = new Set<string>();
    let agents: fs.Dirent[] = [];
    try { agents = fs.readdirSync(path.join(dataRoot, 'agents'), { withFileTypes: true }); } catch { return []; }
    for (const a of agents) {
      if (!a.isDirectory() || !isSafeId(a.name)) continue;
      let convs: fs.Dirent[] = [];
      try { convs = fs.readdirSync(path.join(dataRoot, 'agents', a.name, 'sessions'), { withFileTypes: true }); } catch { continue; }
      for (const c of convs) if (c.isDirectory() && isSafeId(c.name)) out.add(c.name);
    }
    return [...out];
  }

  /** 名册小表快照（cr-1185——每会话一行零盘读；群行由成员流折叠：kind
   *  折 'group'、last_* 取成员行最大、speech/total 跨成员求和。调用方
   *  （face-ops boot 预热分片对账）填完缺口再取本面。） */
  rosterSnapshot(): RosterRow[] {
    const rows = this.db.prepare(
      'SELECT conv, kind, last_speech_ms, last_agent, last_role, last_text, last_at_ms, speech, total FROM roster',
    ).all() as Array<{ conv: string; kind: string; last_speech_ms: number | null; last_agent: string | null; last_role: string | null; last_text: string | null; last_at_ms: number | null; speech: number | null; total: number | null }>;
    const iso = (ms: number | null): string | null => (ms !== null ? new Date(ms).toISOString() : null);
    const base = new Map<string, RosterRow>();
    for (const r of rows) {
      const kind = (['pair', 'single', 'group', 'other'] as const).includes(r.kind as never) ? (r.kind as SessionKind) : 'other';
      const row: RosterRow = {
        key: r.conv, kind,
        lastSpeechAt: iso(r.last_speech_ms), lastAgent: r.last_agent, lastRole: r.last_role, lastText: r.last_text,
        lastAt: iso(r.last_at_ms), speech: r.speech ?? 0, total: r.total ?? 0,
        messageCount: r.speech ?? 0,
      };
      // 群成员流（g-<gid>~<member>——sessionKindOf 判 group）折叠进 gid 键：
      // last_* 取成员行最大、speech/total 求和——群 lastActivity 因此来自
      // 真实成员账本（修复旧 fetchGroups 以 gid 匹配 conversations 的死键）。
      const m = /^((g-[^~]+)~.+)$/.exec(r.conv);
      if (m !== null && kind === 'group') {
        const gid = m[2]!;
        const prev = base.get(gid);
        if (prev === undefined) base.set(gid, { ...row, key: gid, kind: 'group' });
        else {
          if ((row.lastSpeechAt ?? '') > (prev.lastSpeechAt ?? '')) {
            prev.lastSpeechAt = row.lastSpeechAt; prev.lastAgent = row.lastAgent;
            prev.lastRole = row.lastRole; prev.lastText = row.lastText;
          }
          if ((row.lastAt ?? '') > (prev.lastAt ?? '')) prev.lastAt = row.lastAt;
          prev.speech += row.speech; prev.total += row.total;
        }
        continue;
      }
      base.set(r.conv, row);
    }
    return [...base.values()];
  }

  /** 日聚合（cr-1138）：有 conversationId = 该会话（先 refresh，权威）；
   *  缺省 = 全局（**已索引子集**——索引惰性，未访问过的会话不在内；消费方
   *  必须读 coverage 判断覆盖度，勿把子集当平台全貌）；full = true 显式
   *  预热（枚举全部会话逐个对账，首次代价高——仪表板冷启动场景显式调用，
   *  此后索引增量维护）。day = UTC 日期串。 */
  sessionByDay(
    dataRoot: string,
    convId?: string,
    full = false,
  ): { days: Array<{ day: string; total: number; speech: number }>; coverage: { indexedConversations: number; totalConversations: number } } {
    if (convId !== undefined) this.refreshConversation(dataRoot, convId);
    const allIds = this.allConversationIds(dataRoot);
    if (full) for (const id of allIds) this.refreshConversation(dataRoot, id);
    // 日桶单源 = ts_num（全行活动口径；发言单独计数）——两代行形态通吃
    const base = "SELECT date(ts_num / 1000, 'unixepoch') AS day, COUNT(*) AS total, " +
      "SUM(CASE WHEN role IN ('user', 'agent') THEN 1 ELSE 0 END) AS speech " +
      'FROM records WHERE ts_num IS NOT NULL' + (convId !== undefined ? ' AND conv = ?' : '') +
      ' GROUP BY day ORDER BY day';
    const rows = convId !== undefined ? this.stmt(base).all(convId) : this.stmt(base).all();
    const days = (rows as Array<{ day: string; total: number; speech: number | null }>)
      .map((r) => ({ day: r.day, total: Number(r.total), speech: Number(r.speech ?? 0) }));
    // 覆盖度诚实性（cr-1138）：全局视图是已索引子集——不告诉消费方就会被
    // 当成平台全貌（真实数据实证：未访问会话造成日期空档）。
    const indexed = convId !== undefined
      ? 1
      : Number((this.stmt('SELECT COUNT(DISTINCT conv) AS n FROM records').get() as { n: number }).n);
    return { days, coverage: { indexedConversations: indexed, totalConversations: convId !== undefined ? 1 : allIds.length } };
  }

  /** 压缩代清单（cr-1160 P4——读面前置 refresh）：每代 boundary/endTs/
   *  generation/摘要长度/模型/stats；域内 generation 单调（对桶每域独立
   *  压缩史）。摘要全文回源读 messages.jsonl（compaction 行指针不在
   *  records——单事件行按聚合白名单不入；summary_len 供展示面）。 */
  compactionFactsOf(dataRoot: string, convId: string): Array<{ domain: string; run: string; generation: number; boundarySeq: number; endTs: number; summaryLen: number | null; summaryTokens: number | null; model: string | null; stats: { shadowedRows?: number; estimatedTokens?: number } | null }> {
    this.refreshConversation(dataRoot, convId);
    const rows = this.stmt('SELECT domain, run, generation, boundary_seq, end_ts, summary_len, summary_tokens, model, stats FROM compactions WHERE conv = ? ORDER BY domain, generation').all(convId) as Array<{ domain: string; run: string; generation: number; boundary_seq: number; end_ts: number; summary_len: number | null; summary_tokens: number | null; model: string | null; stats: string | null }>;
    return rows.map((r) => ({
      domain: r.domain, run: r.run, generation: r.generation,
      boundarySeq: r.boundary_seq, endTs: r.end_ts,
      summaryLen: r.summary_len, summaryTokens: r.summary_tokens, model: r.model,
      stats: r.stats !== null ? JSON.parse(r.stats) as { shadowedRows?: number; estimatedTokens?: number } : null,
    }));
  }

  /** P+delta 锚面（cr-1194——TokenGauge idle 态外推数据源）：末次 run
   *  落账末端之后活跃代行的 est 合计。锚 = 末次 run 的账本末端时刻：
   *  P（末步 prompt）覆盖到该 run 最后一行入账为止，之后新落的行才该
   *  入 delta。锚早于任一域最新代 compaction end_ts = 跨代断层（P 属旧代）
   *  → null（调用方回落净估算，下轮 run 收束自然重锚）——取代 cr-1191
   *  P/E 病理界。无带 run 的 records 行（从未跑过 run）= null。 */
  pdeltaAnchorOf(dataRoot: string, convId: string, opts: { refresh?: boolean } = {}): { anchorTs: number; estSince: number } | null {
    if (sessionDirs(dataRoot, convId).length === 0) return null;
    if (opts.refresh === false) {
      const known = this.stmt('SELECT 1 AS hit FROM records WHERE conv = ? LIMIT 1').get(convId);
      if (known === undefined) return null;
    } else {
      this.refreshConversation(dataRoot, convId);
    }
    // 锚 = 末次 run 在 records 的末行时刻（纯 records 自足：journal_lines
    // 对多数会话不入账——实读 1113 个 partials.jsonl，索引侧 journal 行
    // 大面积缺席，不能作判定依据）。末次 run = 按 ts_num 取最新的带 run
    // 行所属 run（run-end/步行都带 run），再取该 run 全行 max ts_num。
    // 方向偏保守：该 run 尾部少量行（run-end 落账等）不计入 delta（宁低估
    // 不重复计——那些行本已含在 P 的末步 prompt 里）。
    const lastRun = this.stmt(
      'SELECT run FROM records WHERE conv = ? AND run IS NOT NULL AND ts_num IS NOT NULL ' +
        'ORDER BY ts_num DESC, seq DESC LIMIT 1',
    ).get(convId) as { run: string | null } | undefined;
    if (lastRun === undefined || lastRun.run === null) return null; // 无 run 行 = P 无依据
    const anchorRow = this.stmt(
      'SELECT MAX(ts_num) AS anchor FROM records WHERE conv = ? AND run = ?',
    ).get(convId, lastRun.run) as { anchor: number | null };
    const anchorTs = anchorRow.anchor;
    if (anchorTs === null) return null;
    // 跨代守卫：锚早于任一域最新代 end_ts（含无 boundary 的滚事件代——
    // cr-1192 小会话形态）即 P 属旧代，外推无意义
    const gens = this.stmt(
      'SELECT domain, MAX(generation) AS gen FROM compactions WHERE conv = ? GROUP BY domain',
    ).all(convId) as Array<{ domain: string; gen: number }>;
    for (const g of gens) {
      const endTs = (this.stmt(
        'SELECT end_ts FROM compactions WHERE conv = ? AND domain = ? AND generation = ?',
      ).get(convId, g.domain, g.gen) as { end_ts: number | null }).end_ts;
      if (endTs !== null && anchorTs <= endTs) return null;
    }
    // delta = 锚后活跃代行 est 合计（est_tokens 白名单单源：机制行 NULL、
    // subcall 0、摘要行计入——cr-1190 Q2；NULL 行 SUM 自动跳过）
    const since = this.stmt(
      'SELECT SUM(est_tokens) AS total FROM records r WHERE r.conv = ? AND r.ts_num > ? AND r.generation = (' +
        "  SELECT MAX(generation) FROM records r2 WHERE r2.conv = r.conv AND r2.domain = r.domain)",
    ).get(convId, anchorTs) as { total: number | null };
    return { anchorTs, estSince: since.total ?? 0 };
  }

  /** 活跃上下文估算合计（cr-1160 P4——阈值/仪表直读面）：每域最新代行的
   *  est_tokens 跨域求和。未入账会话 = null（调用方回落盘读）；旧代行 =
   *  shadowed 不计。 */
  activeContextTokens(dataRoot: string, convId: string, opts: { refresh?: boolean } = {}): number | null {
    if (sessionDirs(dataRoot, convId).length === 0) return null;
    if (opts.refresh === false) {
      const known = this.stmt('SELECT 1 AS hit FROM records WHERE conv = ? LIMIT 1').get(convId);
      if (known === undefined) return null;
    } else {
      this.refreshConversation(dataRoot, convId);
    }
    const row = this.stmt(
      'SELECT SUM(est_tokens) AS total FROM records r WHERE r.conv = ? AND r.generation = (' +
      "  SELECT MAX(generation) FROM records r2 WHERE r2.conv = r.conv AND r2.domain = r.domain)"
    ).get(convId) as { total: number | null };
    // 摘要 system 头计入（cr-1160 第五处修正）：LLM 回放 = [最新可用摘要] +
    // 边界后行——摘要是真实开销，漏计会让「压缩后活跃代只剩 run-end 行」
    // 的会话仪表显示 0%（回落路径 estimateReplayTokens 是含 summary 的，
    // 两路径必须同口径）。回落语义与 foldSummaryOf 一致：从最新代往前找
    // 第一个有摘要的代（summaryOmitted 代跳过）。对桶多域各取一份合计。
    const summaries = this.stmt(
      'SELECT domain, summary_tokens FROM compactions c WHERE c.conv = ? AND c.summary_tokens IS NOT NULL ' +
      'AND c.generation = (SELECT MAX(generation) FROM compactions c2 WHERE c2.conv = c.conv AND c2.domain = c.domain AND c2.summary_tokens IS NOT NULL)',
    ).all(convId) as Array<{ domain: string; summary_tokens: number }>;
    const summaryTotal = summaries.reduce((n, s) => n + s.summary_tokens, 0);
    return (row.total ?? 0) + summaryTotal;
  }

  /** 会话索引行全清（目录已消失——账面与指针行一并回收） */
  drop(convId: string): void {
    this.db.exec('BEGIN');
    try {
      this.stmt('DELETE FROM files WHERE conv = ?').run(convId);
      this.stmt('DELETE FROM records WHERE conv = ?').run(convId);
      this.stmt('DELETE FROM journal_lines WHERE conv = ?').run(convId);
      this.stmt('DELETE FROM subcalls WHERE conv = ?').run(convId);
      this.stmt('DELETE FROM compactions WHERE conv = ?').run(convId);
      this.stmt('DELETE FROM roster WHERE conv = ?').run(convId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 视图指纹（historyView 同公式跨互认）：先 refresh 再按**新鲜 stat**
   *  复合 size:mtimeMs（缺席文件不参与、域序排序归一）。domains 只含
   *  agent 域（viewer 是投影轴不是派生源）。 */
  fingerprintOf(dataRoot: string, convId: string): { fingerprint: string; domains: string[] } {
    this.refreshConversation(dataRoot, convId);
    const domains: string[] = [];
    const parts: string[] = [];
    for (const dir of sessionDirs(dataRoot, convId)) {
      const domain = domainOf(dir);
      if (domain !== 'viewer') domains.push(domain);
      for (const shape of FILE_SHAPES) {
        const file = path.join(dir, shape.file);
        try {
          const st = fs.statSync(file);
          parts.push(file + ':' + st.size + ':' + st.mtimeMs);
        } catch { /* 缺席文件不参与 */ }
      }
    }
    return { fingerprint: parts.sort().join('|'), domains };
  }

  /** 某 run 的子调用行（按指针 seek 回源）：文件缺席 = []（无子调用）；
   *  文件在场但从未入账、或水位落后（追加未入账——防陈旧行静默命中）
   *  = undefined（调用方回落全量读） */
  subcallLines(dataRoot: string, convId: string, domain: string, run: string): Array<Record<string, unknown>> | undefined {
    const file = path.join(dataRoot, 'agents', domain, 'sessions', convId, 'subcalls.jsonl');
    if (!fs.existsSync(file)) return [];
    const known = this.stmt('SELECT consumed FROM files WHERE path = ?').get(file) as { consumed: number } | undefined;
    if (known === undefined) return undefined;
    try {
      if (fs.statSync(file).size > known.consumed) return undefined; // 未入账尾部在途——回落全读
    } catch { return undefined; }
    const rows = this.stmt(
      'SELECT byte_offset, line_len FROM subcalls WHERE conv = ? AND domain = ? AND run = ? ORDER BY byte_offset',
    ).all(convId, domain, run) as Array<{ byte_offset: number; line_len: number }>;
    const out: Array<Record<string, unknown>> = [];
    const fd = fs.openSync(file, 'r');
    try {
      for (const r of rows) {
        const buf = Buffer.alloc(r.line_len);
        fs.readSync(fd, buf, 0, r.line_len, r.byte_offset);
        try {
          out.push(JSON.parse(buf.toString('utf-8')) as Record<string, unknown>);
        } catch { /* 坏行跳过（指针仍前进） */ }
      }
    } finally {
      fs.closeSync(fd);
    }
    return out;
  }
}
