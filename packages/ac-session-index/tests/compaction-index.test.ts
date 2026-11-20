// ============================================================
// compaction-index.test.ts —— 压缩回收后的索引对账（cr-974 §2.3/S5）
// 归档重写（shrink）+ compaction 事件追加后：refreshConversation 首刷
// 必须 loud 重建（rebuilt 命中该文件），再刷幂等（零追加零重建）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionIndex } from '../src/core.ts';
import { LedgerWriter, sessionDir } from 'ac-ledger';

const ROOT0 = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cmp-idx-'));
const ROOT = ROOT0;
beforeEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('压缩回收后的索引对账（cr-974）', () => {
  it('归档重写 → 首刷重建、再刷幂等；指纹随重写翻转', async () => {
    const uuid = 'conv-ci';
    const w = new LedgerWriter(sessionDir(ROOT, 'alpha', uuid), { participants: ['alpha', 'user'], kind: 'user' });
    for (let i = 0; i < 6; i++) {
      await w.deliver({ role: 'agent', content: '行' + i, agent_id: i % 2 === 0 ? 'user' : 'alpha', requestId: 'r' + i, uuid });
    }
    const idx = new SessionIndex(path.join(ROOT, 'index', 'session-index.db'));
    try {
      idx.refreshConversation(ROOT, uuid);
      const fp0 = idx.fingerprintOf(ROOT, uuid).fingerprint;
      // 归档重写：前三行搬压缩段（S5 白名单），后三行留主日志
      const rows = fs.readFileSync(path.join(sessionDir(ROOT, 'alpha', uuid), 'messages.jsonl'), 'utf-8')
        .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
      const seqNum = (r: Record<string, unknown>) => Number(r.seq ?? 0);
      const boundary = seqNum(rows.find((r) => r.content === '行2') ?? {});
      await w.compaction('cmp-1', { summary: '此前：前三行已整理。', shadowedSeq: boundary });
      await w.compact({
        archive: rows.filter((r) => seqNum(r) <= boundary),
        keep: rows.filter((r) => seqNum(r) > boundary),
        baselineSeq: Math.max(...rows.map(seqNum)),
        compress: true,
      });
      const rebuild = idx.refreshConversation(ROOT, uuid);
      expect(rebuild.rebuilt.some((f) => f.endsWith('messages.jsonl'))).toBe(true); // shrink → loud 重建
      const steady = idx.refreshConversation(ROOT, uuid);
      expect(steady.appended).toBe(0);
      expect(steady.rebuilt).toEqual([]);
      const fp1 = idx.fingerprintOf(ROOT, uuid).fingerprint;
      expect(fp1).not.toBe(fp0); // 指纹随重写翻转（短路自动失效）
    } finally {
      idx.close();
    }
  });
});
describe('cr-1160 压缩 V2 索引面（generation/est_tokens/compactions）', () => {
  const uuid = 'conv-v2-idx';
  it('单事件入 compactions 表 + 单事件行不进 records 聚合 + 活跃代合计', async () => {
    const w = new LedgerWriter(sessionDir(ROOT, 'alpha', uuid), { participants: ['alpha', 'user'], kind: 'user' });
    await w.deliver({ role: 'agent', content: '第一问', agent_id: 'user', requestId: 'q1', uuid });
    await w.settle({ role: 'agent', content: '第一答', agent_id: 'alpha', requestId: 'a1', uuid, run: 'run-1' } as never, 'run-1', 'ok');
    const dir = sessionDir(ROOT, 'alpha', uuid);
    const rows = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
    const boundary = Number((rows.find((r) => r.content === '第一答') ?? {}).seq ?? 0);
    await w.compaction('cmp-1', { summary: '此前，第一轮。', shadowedSeq: boundary });
    await w.deliver({ role: 'agent', content: '第二问', agent_id: 'user', requestId: 'q2', uuid });
    const idx = new SessionIndex(path.join(ROOT, 'index', 'session-index.db'));
    try {
      idx.refreshConversation(ROOT, uuid);
      // 压缩代清单：一代（单事件），摘要长度在场
      const facts = idx.compactionFactsOf(ROOT, uuid);
      expect(facts.length).toBe(1);
      expect(facts[0]?.generation).toBe(1);
      expect(facts[0]?.summaryLen).toBe('此前，第一轮。'.length);
      // records 全量统计含旧代行（历史事实）+ run-end（含 compaction 随行的机制
      // run-end——进 records 正常）；compaction 单事件行不进（聚合白名单）。
      // 用例一行数 = q1,a1,settle-run-end,q2,cmp-run-end = 5
      const meta = idx.sessionMeta(ROOT, uuid);
      expect(meta).not.toBeNull();
      expect(meta!.total).toBe(5);
      const active = idx.activeContextTokens(ROOT, uuid);
      expect(active).not.toBeNull();
      expect(active!).toBeGreaterThan(0);
    } finally {
      idx.close();
    }
  });

  it('多轮压缩：代推进 + 旧代不计活跃合计', async () => {
    const w = new LedgerWriter(sessionDir(ROOT, 'beta', uuid), { participants: ['beta', 'user'], kind: 'user' });
    await w.deliver({ role: 'agent', content: '问一', agent_id: 'user', requestId: 'q1', uuid });
    await w.settle({ role: 'agent', content: '答一', agent_id: 'beta', requestId: 'a1', uuid, run: 'run-1' } as never, 'run-1', 'ok');
    const dir = sessionDir(ROOT, 'beta', uuid);
    const seqOf = (c: string) => Number((fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8').split('\n').map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } }).find((r) => r.content === c) ?? {}).seq ?? 0);
    await w.compaction('cmp-1', { summary: '此前，一。', shadowedSeq: seqOf('答一') });
    await w.deliver({ role: 'agent', content: '问二', agent_id: 'user', requestId: 'q2', uuid });
    await w.settle({ role: 'agent', content: '答二', agent_id: 'beta', requestId: 'a2', uuid, run: 'run-2' } as never, 'run-2', 'ok');
    await w.compaction('cmp-2', { summary: '此前，二。', shadowedSeq: seqOf('答二') });
    await w.deliver({ role: 'agent', content: '问三', agent_id: 'user', requestId: 'q3', uuid });
    const idx = new SessionIndex(path.join(ROOT, 'index', 'session-index.db'));
    try {
      idx.refreshConversation(ROOT, uuid);
      const facts = idx.compactionFactsOf(ROOT, uuid);
      expect(facts.length).toBe(2);
      expect(facts.map((f) => f.generation)).toEqual([1, 2]);
      // 活跃代（generation=3）：est 合计只含「问三」行——对比全代合计验证过滤生效。
      // sessionMeta 全量统计 = q1,a1,re1,q2,a2,re2,q3 + 两个 cmp run-end = 9
      const meta = idx.sessionMeta(ROOT, uuid);
      expect(meta!.total).toBe(9);
    } finally {
      idx.close();
    }
  });
});
describe('cr-1160 est_tokens 口径同源（subcall 不计）', () => {
  it('run_code 子调用结果行不计入活跃代估算（与 replayTokensOf 同源）', async () => {
    const uuid = 'conv-subcall';
    const w = new LedgerWriter(sessionDir(ROOT, 'gamma', uuid), { participants: ['gamma', 'user'], kind: 'user' });
    await w.deliver({ role: 'agent', content: '查一下', agent_id: 'user', requestId: 'q1', uuid });
    const bigResult = 'x'.repeat(4000);
    await w.appendEvents([
      { type: 'step/content', run: 'run-1', step: 0, text: '好的', ts: Date.now() },
      { type: 'step/tool-call', run: 'run-1', step: 0, toolCallId: 'tc1', name: 'run_code', arguments: '{}', ts: Date.now() },
      // 宿主卡结果（回放计）
      { type: 'step/tool-call-result', run: 'run-1', toolCallId: 'tc1', result: { ok: true, output: '短结果' }, ts: Date.now() },
      // 子调用补行（回放不计——subcall: true）
      { type: 'step/tool-call-result', run: 'run-1', toolCallId: 'tc1#1', subcall: true, name: 'read', arguments: '{}', result: { ok: true, output: bigResult }, ts: Date.now() },
    ]);
    await w.runEnd('run-1', 'completed');
    await w.settle({ role: 'agent', content: '结果如上', agent_id: 'gamma', requestId: 'a1', uuid, run: 'run-1' } as never, 'run-1', 'ok');
    const idx = new SessionIndex(path.join(ROOT, 'index', 'session-index.db'));
    try {
      const active = idx.activeContextTokens(ROOT, uuid);
      expect(active).not.toBeNull();
      // 4KB ASCII 结果若计入 ≈ 1200 token；不计则总量应远小于它
      expect(active!).toBeLessThan(300);
      expect(active!).toBeGreaterThan(0);
    } finally {
      idx.close();
    }
  });
});
describe('cr-1160 旧三连索引面（聚合白名单 + 摘要长度回填）', () => {
  it('compaction/* 三行全不入 records；摘要长度经 summary→end 回填；代数不重复推进', () => {
    const uuid = 'conv-legacy-tri';
    const dir = sessionDir(ROOT, 'alpha', uuid);
    fs.mkdirSync(dir, { recursive: true });
    const ts = Date.parse('2026-11-19T08:30:00.000Z');
    const rows: Array<Record<string, unknown>> = [
      { type: 'session-header', version: 2, createdAt: '2026-11-19T08:00:00.000Z', participants: ['alpha', 'user'], kind: 'user' },
      { type: 'message', role: 'agent', content: '旧问', agent_id: 'user', requestId: 'q1', message_id: 'q1', timestamp: '2026-11-19T08:00:01.000Z', seq: 1 },
      { type: 'compaction/start', run: 'c1', ts, seq: 2 },
      { type: 'compaction/summary', run: 'c1', summary: '此前，旧内容概要。', ts, seq: 3 },
      { type: 'compaction/end', run: 'c1', boundarySeq: 1, ts, seq: 4 },
      { type: 'run-end', run: 'c1', finish: 'completed', ts, seq: 5 },
      { type: 'message', role: 'agent', content: '新问', agent_id: 'user', requestId: 'q2', message_id: 'q2', timestamp: '2026-11-19T09:00:01.000Z', seq: 6 },
    ];
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const idx = new SessionIndex(path.join(ROOT, 'index', 'session-index.db'));
    try {
      idx.refreshConversation(ROOT, uuid);
      const meta = idx.sessionMeta(ROOT, uuid);
      // records = 旧问 + c1 的 run-end + 新问 = 3（compaction 三行不入）
      expect(meta!.total).toBe(3);
      expect(meta!.lastType).toBe('message'); // 末活动行型不被 compaction/end 顶掉
      const facts = idx.compactionFactsOf(ROOT, uuid);
      expect(facts.length).toBe(1);
      expect(facts[0]?.generation).toBe(1);
      expect(facts[0]?.boundarySeq).toBe(1);
      expect(facts[0]?.summaryLen).toBe('此前，旧内容概要。'.length); // summary→end 回填
      // 代数推进：建代后普通行落 gen 2（不因 end 行进 records 而多消耗一代）
      const active = idx.activeContextTokens(ROOT, uuid);
      expect(active).toBeGreaterThan(0);
      expect(active!).toBeLessThan(100); // 只剩「新问」量级
    } finally {
      idx.close();
    }
  });

  it('boundary_seq 回落：end 行缺 boundarySeq → 取自身 seq（cr-974 原语义）', () => {
    const uuid = 'conv-boundary-fallback';
    const dir = sessionDir(ROOT, 'gamma', uuid);
    fs.mkdirSync(dir, { recursive: true });
    const ts = Date.parse('2026-11-19T08:30:00.000Z');
    const rows: Array<Record<string, unknown>> = [
      { type: 'session-header', version: 2, createdAt: '2026-11-19T08:00:00.000Z', participants: ['gamma', 'user'], kind: 'user' },
      { type: 'message', role: 'agent', content: '问', agent_id: 'user', requestId: 'q1', message_id: 'q1', timestamp: '2026-11-19T08:00:01.000Z', seq: 1 },
      { type: 'compaction/start', run: 'c1', ts, seq: 2 },
      { type: 'compaction/summary', run: 'c1', summary: '此前，概要。', ts, seq: 3 },
      // 现场形态：end 行显式写 boundarySeq:0（老 writer 实证——admin~admin 4 代全 0）
      { type: 'compaction/end', run: 'c1', boundarySeq: 0, ts, seq: 42 },
    ];
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const idx = new SessionIndex(path.join(ROOT, 'index', 'session-index.db'));
    try {
      idx.refreshConversation(ROOT, uuid);
      const facts = idx.compactionFactsOf(ROOT, uuid);
      expect(facts.length).toBe(1);
      expect(facts[0]?.boundarySeq).toBe(42); // ≤0 视为无有效边界 → 回落 end 自身 seq
    } finally {
      idx.close();
    }
  });
  it('摘要头计入活跃代（与 estimateReplayTokens 的 opts.summary 同口径）', () => {
    const uuid = 'conv-summary-head';
    const dir = sessionDir(ROOT, 'delta', uuid);
    fs.mkdirSync(dir, { recursive: true });
    const ts = Date.parse('2026-11-19T08:30:00.000Z');
    const summaryText = '此前，' + '概'.repeat(200); // CJK → ~120 token
    const rows: Array<Record<string, unknown>> = [
      { type: 'session-header', version: 2, createdAt: '2026-11-19T08:00:00.000Z', participants: ['delta', 'user'], kind: 'user' },
      { type: 'message', role: 'agent', content: '旧问', agent_id: 'user', requestId: 'q1', message_id: 'q1', timestamp: '2026-11-19T08:00:01.000Z', seq: 1 },
      { type: 'compaction/start', run: 'c1', ts, seq: 2 },
      { type: 'compaction/summary', run: 'c1', summary: summaryText, ts, seq: 3 },
      { type: 'compaction/end', run: 'c1', boundarySeq: 1, ts, seq: 4 },
    ];
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const idx = new SessionIndex(path.join(ROOT, 'index', 'session-index.db'));
    try {
      idx.refreshConversation(ROOT, uuid);
      // 活跃代无行（全被边界滤），但摘要头在场 → 不得为 0
      const active = idx.activeContextTokens(ROOT, uuid);
      expect(active).not.toBeNull();
      expect(active!).toBeGreaterThan(100); // 摘要头 ~120 token
      const facts = idx.compactionFactsOf(ROOT, uuid);
      expect(facts[0]?.summaryTokens).toBeGreaterThan(100);
    } finally {
      idx.close();
    }
  });

  it('重建幂等：refresh 重建后 compactions 不重复建代', () => {
    const uuid = 'conv-rebuild-tri';
    const dir = sessionDir(ROOT, 'beta', uuid);
    fs.mkdirSync(dir, { recursive: true });
    const ts = Date.parse('2026-11-19T08:30:00.000Z');
    const rows: Array<Record<string, unknown>> = [
      { type: 'session-header', version: 2, createdAt: '2026-11-19T08:00:00.000Z', participants: ['beta', 'user'], kind: 'user' },
      { type: 'message', role: 'agent', content: '问', agent_id: 'user', requestId: 'q1', message_id: 'q1', timestamp: '2026-11-19T08:00:01.000Z', seq: 1 },
      { type: 'compaction/start', run: 'c1', ts, seq: 2 },
      { type: 'compaction/summary', run: 'c1', summary: '此前，一。', ts, seq: 3 },
      { type: 'compaction/end', run: 'c1', boundarySeq: 1, ts, seq: 4 },
    ];
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const idx = new SessionIndex(path.join(ROOT, 'index', 'session-index.db'));
    try {
      idx.refreshConversation(ROOT, uuid);
      expect(idx.compactionFactsOf(ROOT, uuid).length).toBe(1);
      // 强制重建：mtime 倒退 → rebuild 分支
      const f = path.join(dir, 'messages.jsonl');
      const past = new Date(Date.now() - 86_400_000);
      fs.utimesSync(f, past, past);
      idx.refreshConversation(ROOT, uuid);
      expect(idx.compactionFactsOf(ROOT, uuid).length).toBe(1); // 不重复建代
    } finally {
      idx.close();
    }
  });
});
