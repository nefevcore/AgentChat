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

/** journal 行类型判别（readJournal 同款：只认四种已知判别行，未知 type 安全忽略） */
const JOURNAL_TYPES = ['journal-step', 'journal-inject', 'journal-tool-result', 'journal-settled'];
function journalLineType(text: string): string | null {
  const t = text.trimStart();
  for (const ty of JOURNAL_TYPES) {
    if (t.startsWith('{"type":"' + ty + '"')) return ty;
  }
  return null;
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
    // 旧 schema 落库 = 纯缓存过期 → 整库弃重建（files 一并清，refresh 自愈）
    const cols = (this.db.prepare('PRAGMA table_info(records)').all() as Array<{ name?: unknown }>).map((c) => c.name);
    if (cols.length > 0 && (!cols.includes('type') || !cols.includes('ts_num'))) {
      this.db.exec('DROP TABLE IF EXISTS records; DROP TABLE IF EXISTS journal_lines; DROP TABLE IF EXISTS subcalls; DROP TABLE IF EXISTS files;');
    }
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS files (' +
        'path TEXT PRIMARY KEY, conv TEXT NOT NULL, consumed INTEGER NOT NULL, ' +
        'size INTEGER NOT NULL, mtimeMs REAL NOT NULL); ' +
      'CREATE TABLE IF NOT EXISTS records (' +
        'conv TEXT, domain TEXT, seq INTEGER, byte_offset INTEGER, line_len INTEGER, ' +
        'role TEXT, agent_id TEXT, run TEXT, request_id TEXT, message_id TEXT, ts TEXT, ' +
        'type TEXT, tool_call_id TEXT, ts_num INTEGER); ' +
      'CREATE INDEX IF NOT EXISTS idx_records_conv_domain ON records(conv, domain); ' +
      'CREATE TABLE IF NOT EXISTS journal_lines (' +
        'conv TEXT, domain TEXT, seq INTEGER, byte_offset INTEGER, line_len INTEGER, ' +
        'type TEXT, run TEXT, tool_call_id TEXT, ts INTEGER); ' +
      'CREATE INDEX IF NOT EXISTS idx_journal_conv_domain ON journal_lines(conv, domain); ' +
      'CREATE TABLE IF NOT EXISTS subcalls (' +
        'conv TEXT, domain TEXT, run TEXT, tool_call_id TEXT, ' +
        'byte_offset INTEGER, line_len INTEGER);'
    );
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

  /** 刷新某会话全部域 × 三源文件的指针行（重建/增量对账见文件头） */
  refreshConversation(dataRoot: string, convId: string): RefreshReport {
    const report: RefreshReport = { appended: 0, rebuilt: [] };
    for (const dir of sessionDirs(dataRoot, convId)) {
      const domain = domainOf(dir);
      for (const shape of FILE_SHAPES) {
        const file = path.join(dir, shape.file);
        if (!fs.existsSync(file)) continue;
        this.indexFile(file, shape.kind, convId, domain, report);
      }
    }
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
      if (rebuild) {
        const table = kind === 'records' ? 'records' : kind === 'journal' ? 'journal_lines' : 'subcalls';
        this.stmt('DELETE FROM ' + table + ' WHERE conv = ? AND domain = ?').run(conv, domain);
        report.rebuilt.push(file);
      }
      const buf = Buffer.alloc(st.size - consumed);
      fs.readSync(fd, buf, 0, buf.length, consumed);
      // 逐完整行消费：line_len 不含换行；尾段无换行 = 撕裂行，不入账、
      // consumed 不前进（留在下次增量补齐）
      let lineStart = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== 0x0a) continue;
        if (this.indexLine(kind, conv, domain, consumed + lineStart, i - lineStart, buf.subarray(lineStart, i).toString('utf-8'))) report.appended += 1;
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

  /** 单行解析入账（返回是否计入 appended——判别/坏行跳过但已消费） */
  private indexLine(kind: FileShape['kind'], conv: string, domain: string, byteOffset: number, lineLen: number, text: string): boolean {
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
      // 时标归一（cr-1138）：v2 事件行（step/* · run-end · inject）只带数字
      // ts（epoch ms）无 role/timestamp；v1 行（含 v2 的 message 发言行）带
      // ISO timestamp。两代并存——ts_num 是聚合的时间维度单源。
      const tsNum = num(row.ts) ?? (typeof row.timestamp === 'string' ? (Date.parse(row.timestamp) || null) : null);
      this.stmt(
        'INSERT INTO records (conv, domain, seq, byte_offset, line_len, role, agent_id, run, request_id, message_id, ts, type, tool_call_id, ts_num) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(conv, domain, num(row.seq), byteOffset, lineLen, str(row.role), str(row.agent_id), str(row.run), str(row.requestId), str(row.message_id), str(row.timestamp), str(row.type), str(row.toolCallId), tsNum);
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

  /** 会话元数据聚合（cr-1138）：先 refreshConversation（惰性对账——聚合
   *  新鲜度跟对账协议走），再 records 表 SQL 统计。会话源目录不存在 =
   *  null；存在但零行 = 全零 meta（空会话是合法态）。 */
  sessionMeta(dataRoot: string, convId: string): SessionMeta | null {
    if (sessionDirs(dataRoot, convId).length === 0) return null;
    this.refreshConversation(dataRoot, convId);
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

  /** 全量会话键枚举（agents/*\/sessions/* 目录名去重——索引维护面，
   *  非读面：供显式预热/覆盖度统计用） */
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

  /** 会话索引行全清（目录已消失——账面与指针行一并回收） */
  drop(convId: string): void {
    this.db.exec('BEGIN');
    try {
      this.stmt('DELETE FROM files WHERE conv = ?').run(convId);
      this.stmt('DELETE FROM records WHERE conv = ?').run(convId);
      this.stmt('DELETE FROM journal_lines WHERE conv = ?').run(convId);
      this.stmt('DELETE FROM subcalls WHERE conv = ?').run(convId);
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
