// ============================================================
// core.ts —— 会话指针索引纯库（cr-973 Phase 1 第一刀，2026-11-09）
//
// 零 cordis 依赖、零语义：只记「行在哪」（conv/domain/seq/byte_offset/
// line_len + 身份键），内容永远按字节区间回源 jsonl 读——索引是纯缓存，
// 可全量重建（方案 §0.2「指针索引只指真源」红线）。DB = node:sqlite 内建
// DatabaseSync（宿主单写者，WAL）。
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
 *  viewer 在前 + agents/* readdir 序，与 conversationDirs 同形） */
function sessionDirs(dataRoot: string, convId: string): string[] {
  if (!isSafeId(convId)) throw new Error('conversationId "' + convId + '" 非法（禁路径分隔 / ..）');
  const out: string[] = [];
  const exists = (dir: string): boolean => fs.existsSync(dir);
  const viewerDir = path.join(dataRoot, 'viewer', 'sessions', convId);
  if (exists(viewerDir)) out.push(viewerDir);
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
    // 旧 schema 落库 = 纯缓存过期 → 整库弃重建（files 一并清，refresh 自愈）
    const cols = (this.db.prepare('PRAGMA table_info(records)').all() as Array<{ name?: unknown }>).map((c) => c.name);
    if (cols.length > 0 && !cols.includes('type')) {
      this.db.exec('DROP TABLE IF EXISTS records; DROP TABLE IF EXISTS journal_lines; DROP TABLE IF EXISTS subcalls; DROP TABLE IF EXISTS files;');
    }
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS files (' +
        'path TEXT PRIMARY KEY, conv TEXT NOT NULL, consumed INTEGER NOT NULL, ' +
        'size INTEGER NOT NULL, mtimeMs REAL NOT NULL); ' +
      'CREATE TABLE IF NOT EXISTS records (' +
        'conv TEXT, domain TEXT, seq INTEGER, byte_offset INTEGER, line_len INTEGER, ' +
        'role TEXT, agent_id TEXT, run TEXT, request_id TEXT, message_id TEXT, ts TEXT, ' +
        'type TEXT, tool_call_id TEXT); ' +
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
      this.stmt(
        'INSERT INTO records (conv, domain, seq, byte_offset, line_len, role, agent_id, run, request_id, message_id, ts, type, tool_call_id) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(conv, domain, num(row.seq), byteOffset, lineLen, str(row.role), str(row.agent_id), str(row.run), str(row.requestId), str(row.message_id), str(row.timestamp), str(row.type), str(row.toolCallId));
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
