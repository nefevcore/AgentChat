// ============================================================
// session-index.test.ts —— 指针索引纯库单测（cr-973 Phase 1，2026-11-09）
//
// 覆盖：全量首建（appended 计数 + 指纹跨互认 + 域枚举）/ 增量追加 /
// 截断重写重建（compact 式 tmp+rename）/ 撕裂尾行不消费（补齐换行后
// 增量入账）/ subcallLines 三态（行集 · 文件缺席 [] · 未入账 undefined）/
// 跨打开对账（重开同库 no-op）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionIndex } from '../src/core.ts';

const CONV = 'conv-1';
let root: string;
let dbFile: string;
const openIdx: SessionIndex[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-index-'));
  dbFile = path.join(root, 'index', 'session-index.db');
});
afterEach(() => {
  for (const idx of openIdx.splice(0)) idx.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function newIndex(file?: string): SessionIndex {
  const idx = new SessionIndex(file ?? dbFile);
  openIdx.push(idx);
  return idx;
}

function closeIndex(idx: SessionIndex): void {
  const i = openIdx.indexOf(idx);
  if (i >= 0) openIdx.splice(i, 1);
  idx.close();
}

function sessionDir(domain: string, convId: string): string {
  return domain === 'legacy-viewer'
    ? path.join(root, 'viewer', 'sessions', convId)
    : path.join(root, 'agents', domain, 'sessions', convId);
}

interface SessionLines { messages?: string[]; journal?: string[]; subcalls?: string[] }
function writeSession(domain: string, convId: string, lines: SessionLines): void {
  const dir = sessionDir(domain, convId);
  fs.mkdirSync(dir, { recursive: true });
  if (lines.messages !== undefined) fs.writeFileSync(path.join(dir, 'messages.jsonl'), lines.messages.join('\n') + '\n');
  if (lines.journal !== undefined) {
    fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'journal', 'partials.jsonl'), lines.journal.join('\n') + '\n');
  }
  if (lines.subcalls !== undefined) fs.writeFileSync(path.join(dir, 'subcalls.jsonl'), lines.subcalls.join('\n') + '\n');
}

function append(domain: string, convId: string, rel: string, text: string): void {
  fs.appendFileSync(path.join(sessionDir(domain, convId), rel), text);
}

/** stat 口径指纹独立复算（historyView 同公式——跨互认断言） */
function expectedFingerprint(convId: string): string {
  const parts: string[] = [];
  for (const dir of [sessionDir('alpha', convId), sessionDir('beta', convId)]) {
    for (const rel of ['messages.jsonl', path.join('journal', 'partials.jsonl'), 'subcalls.jsonl']) {
      const file = path.join(dir, rel);
      try { const st = fs.statSync(file); parts.push(file + ':' + st.size + ':' + st.mtimeMs); } catch { /* 缺席不参与 */ }
    }
  }
  return parts.sort().join('|');
}

/** 只读探针（WAL 并发读——直查索引表断言内部行） */
function probe(sql: string, ...params: unknown[]): unknown {
  const db = new DatabaseSync(dbFile);
  try { return db.prepare(sql).get(...params); } finally { db.close(); }
}

const HEADER = JSON.stringify({ type: 'session-header', version: 1, createdAt: '2026-11-09T00:00:00Z', participants: ['alpha', 'user'], kind: 'user' });
const ROW1 = JSON.stringify({ role: 'agent', content: '问', message_id: 'm1', timestamp: '2026-11-09T10:00:00Z', agent_id: 'user', requestId: 'rq-1', uuid: CONV, seq: 1 });
const ROW2 = JSON.stringify({ role: 'agent', content: '答', message_id: 'm2', timestamp: '2026-11-09T10:00:01Z', agent_id: 'alpha', run: 'run-1', seq: 2 });
const J_STEP = JSON.stringify({ type: 'journal-step', run: 'run-1', step: 0, content: '想', seq: 3 });
const J_NOISE = JSON.stringify({ type: 'future-event', run: 'run-1' });
const J_SETTLED = JSON.stringify({ type: 'journal-settled', run: 'run-1', finish: 'ok', seq: 4 });
const SC1 = JSON.stringify({ type: 'journal-tool-result', run: 'run-1', toolCallId: 'tc-1', result: { ok: true }, subcall: true, name: 'probe', seq: 5 });
const SC2 = JSON.stringify({ type: 'journal-tool-result', run: 'run-1', toolCallId: 'tc-2', result: { ok: true }, subcall: true, name: 'probe', seq: 6 });

describe('全量首建', () => {
  it('header 跳过、噪声行忽略、指纹与 stat 公式互认、域枚举正确', () => {
    writeSession('alpha', CONV, { messages: [HEADER, ROW1, ROW2] });
    writeSession('beta', CONV, { messages: [HEADER, ROW1, ROW2], journal: [J_STEP, J_NOISE, J_SETTLED], subcalls: [SC1, SC2] });
    const idx = newIndex();
    const r = idx.refreshConversation(root, CONV);
    expect(r.appended).toBe(8); // records 2×2 域 + journal 2（noise 未知 type 忽略）+ subcalls 2
    const fp = idx.fingerprintOf(root, CONV);
    expect(fp.fingerprint).toBe(expectedFingerprint(CONV));
    expect(fp.domains).toEqual(['alpha', 'beta']);
    // 内部行：viewer records 跳过头行；身份键带出
    expect(probe('SELECT COUNT(*) AS c FROM records')).toEqual({ c: 4 });
    expect(probe('SELECT role, agent_id, run, request_id, message_id, ts FROM records WHERE conv = ? AND domain = ? ORDER BY seq DESC', CONV, 'alpha'))
      .toEqual({ role: 'agent', agent_id: 'alpha', run: 'run-1', request_id: null, message_id: 'm2', ts: '2026-11-09T10:00:01Z' });
    expect(probe('SELECT COUNT(*) AS c FROM journal_lines')).toEqual({ c: 2 });
    expect(probe('SELECT tool_call_id FROM subcalls ORDER BY byte_offset')).toEqual({ tool_call_id: 'tc-1' });
  });
});

describe('增量追加', () => {
  it('append 一行 → appended 1、records 增长、指纹翻转', () => {
    writeSession('alpha', CONV, { messages: [HEADER, ROW1] });
    const idx = newIndex();
    idx.refreshConversation(root, CONV);
    const fp0 = idx.fingerprintOf(root, CONV).fingerprint;
    append('alpha', CONV, 'messages.jsonl', ROW2 + '\n');
    const r = idx.refreshConversation(root, CONV);
    expect(r.appended).toBe(1);
    expect(r.rebuilt).toEqual([]);
    expect(probe('SELECT COUNT(*) AS c FROM records')).toEqual({ c: 2 });
    const fp1 = idx.fingerprintOf(root, CONV).fingerprint;
    expect(fp1).not.toBe(fp0);
    expect(fp1).toBe(expectedFingerprint(CONV));
  });
});

describe('截断重写（compact 式 tmp+rename）', () => {
  it('size 变小 → 全量重建，records 与新内容一致', () => {
    writeSession('alpha', CONV, { messages: [HEADER, ROW1, ROW2] });
    const idx = newIndex();
    idx.refreshConversation(root, CONV);
    const file = path.join(sessionDir('alpha', CONV), 'messages.jsonl');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, [HEADER, ROW1].join('\n') + '\n');
    fs.renameSync(tmp, file);
    const r = idx.refreshConversation(root, CONV);
    expect(r.rebuilt).toEqual([file]);
    expect(probe('SELECT COUNT(*) AS c FROM records')).toEqual({ c: 1 });
    expect(probe('SELECT message_id FROM records')).toEqual({ message_id: 'm1' });
  });
});

describe('撕裂尾行', () => {
  it('无换行尾段不消费、不前进；补齐换行后增量入账', () => {
    writeSession('alpha', CONV, { messages: [HEADER, ROW1] });
    const file = path.join(sessionDir('alpha', CONV), 'messages.jsonl');
    const whole = fs.statSync(file);
    const idx = newIndex();
    idx.refreshConversation(root, CONV);
    append('alpha', CONV, 'messages.jsonl', '{"role":"agent","content":"撕裂"');
    const r1 = idx.refreshConversation(root, CONV);
    expect(r1.appended).toBe(0);
    expect(probe('SELECT consumed FROM files WHERE path = ?', file)).toEqual({ consumed: whole.size });
    append('alpha', CONV, 'messages.jsonl', ', "message_id": "m3"}\n');
    const r2 = idx.refreshConversation(root, CONV);
    expect(r2.appended).toBe(1);
    expect(probe('SELECT COUNT(*) AS c FROM records')).toEqual({ c: 2 });
    expect(probe('SELECT message_id FROM records WHERE seq IS NULL')).toEqual({ message_id: 'm3' }); // 补齐行无 seq，按身份键落位
  });
});

describe('subcallLines 三态', () => {
  it('未入账 = undefined；入账后按 run 取行；文件缺席 / 别 run = []', () => {
    writeSession('alpha', CONV, { subcalls: [SC1, SC2] });
    const cold = newIndex(path.join(root, 'index', 'cold.db'));
    expect(cold.subcallLines(root, CONV, 'alpha', 'run-1')).toBeUndefined();
    closeIndex(cold);
    const idx = newIndex();
    idx.refreshConversation(root, CONV);
    const lines = idx.subcallLines(root, CONV, 'alpha', 'run-1');
    expect(lines).toHaveLength(2);
    expect(lines?.[0]).toMatchObject({ type: 'journal-tool-result', run: 'run-1', toolCallId: 'tc-1' });
    expect(lines?.[1]).toMatchObject({ toolCallId: 'tc-2' });
    expect(idx.subcallLines(root, CONV, 'alpha', 'run-2')).toEqual([]);
    expect(idx.subcallLines(root, CONV, 'beta', 'run-1')).toEqual([]);
  });
});

describe('跨打开对账', () => {
  it('同库重开：文件未变 → refresh no-op', () => {
    writeSession('alpha', CONV, { messages: [HEADER, ROW1] });
    const idx1 = newIndex();
    idx1.refreshConversation(root, CONV);
    closeIndex(idx1);
    const idx2 = newIndex();
    const r = idx2.refreshConversation(root, CONV);
    expect(r.appended).toBe(0);
    expect(r.rebuilt).toEqual([]);
  });
});
