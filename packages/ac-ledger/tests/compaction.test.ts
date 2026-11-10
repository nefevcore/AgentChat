// ============================================================
// compaction.test.ts —— 压缩事件化 + 归档物理回收（cr-974 §2.3 / S5）
//
// ① 事件回路：writer.compaction → foldSummaryOf → foldLlmReplay 三态
//    （system 头 = 事件摘要；shadowed 前缀不注入）。
// ② webui 视图：compaction 事件 log-only 不渲染。
// ③ 物理回收（S5 白名单唯一重写）：shadowed 前缀整段单流 gzip 落
//    archive/history_N.jsonl.gz（Node 24.18 无 zstdSync——回落 gzip）；
//    主日志保留 header + compaction 事件 + 尾部；解压恒等于归档行。
// ④ 索引一致性：重写后 refreshConversation 触发 shrink 对账重建。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { LedgerWriter, sessionDir } from '../src/index.ts';
import { foldLlmReplay, foldSession, foldSummaryOf, foldViewRecords } from '../src/fold.ts';
// 索引一致性断言住 ac-session-index/tests/compaction-index.test.ts（依赖方向：ledger 不依赖索引包）

const ROOT0 = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-compaction-'));
const ROOT = ROOT0;
beforeEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

const UUID = 'conv-cmp';
const AGENT = 'alpha';

function v2Writer(): LedgerWriter {
  return new LedgerWriter(sessionDir(ROOT, AGENT, UUID), { participants: [AGENT, 'user'], kind: 'user' });
}

async function seed(w: LedgerWriter): Promise<void> {
  await w.deliver({ role: 'agent', content: '旧问', agent_id: 'user', requestId: 'q1', uuid: UUID, timestamp: '2026-11-09T10:00:01.000Z' });
  await w.appendEvents([
    { type: 'step/content', run: 'run-1', step: 0, stepId: 'run-1:0', text: '旧答步', ts: 1 },
  ]);
  await w.runEnd('run-1', 'completed');
  await w.settle({ role: 'agent', content: '旧答', agent_id: AGENT, requestId: 'a1', uuid: UUID, run: 'run-1' } as never, 'run-1', 'ok');
  await w.deliver({ role: 'agent', content: '新问', agent_id: 'user', requestId: 'q2', uuid: UUID, timestamp: '2026-11-09T11:00:01.000Z' });
  await w.settle({ role: 'agent', content: '新答', agent_id: AGENT, requestId: 'a2', uuid: UUID, run: 'run-2' } as never, 'run-2', 'ok');
}

function readRows(dir: string): Array<Record<string, unknown>> {
  return fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8')
    .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('压缩事件化（cr-974 §2.3）', () => {
  it('事件回路：compaction 落账 → summaryOf → LLM 回放 = 事件摘要头 + 边界后行', async () => {
    const w = v2Writer();
    await seed(w);
    const dir = sessionDir(ROOT, AGENT, UUID);
    const rows = readRows(dir);
    const seqOf = (c: string) => rows.find((r) => r.content === c)?.seq as number;
    const oldFinalSeq = seqOf('旧答');
    await w.compaction('cmp-1', '此前：用户问了旧问，Agent 回了旧答。', oldFinalSeq);

    const fold = foldSession(ROOT, UUID);
    const summary = foldSummaryOf(fold);
    expect(summary).not.toBeNull();
    expect(summary!.text).toBe('此前：用户问了旧问，Agent 回了旧答。');
    expect(summary!.boundarySeq).toBe(oldFinalSeq);

    const llm = foldLlmReplay(fold, AGENT, ROOT, UUID);
    expect(llm[0]).toEqual({ role: 'system', content: '此前：用户问了旧问，Agent 回了旧答。' });
    expect(llm.some((m) => m.content === '旧问')).toBe(false); // shadowed 前缀不注入
    expect(llm.some((m) => m.content === '旧答步')).toBe(false);
    expect(llm.some((m) => m.content === '新问')).toBe(true); // 边界后照常
    expect(llm.some((m) => m.content === '新答')).toBe(true);
  });

  it('webui 视图：compaction 事件 log-only（不渲染为记录）', async () => {
    const w = v2Writer();
    await seed(w);
    await w.compaction('cmp-1', '摘要文案', 1);
    const view = foldViewRecords(foldSession(ROOT, UUID), ROOT, UUID);
    expect(view.some((r) => JSON.stringify(r).includes('摘要文案'))).toBe(false);
    expect(view.some((r) => String(r.type ?? '').startsWith('compaction'))).toBe(false);
  });

  it('物理回收（S5）：压缩段 gzip 单流 + 主日志保留 compaction 事件与尾部 + 尾部投影不变 + 索引重建', async () => {
    const w = v2Writer();
    await seed(w);
    const dir = sessionDir(ROOT, AGENT, UUID);
    const rows = readRows(dir);
    const seqNum = (r: Record<string, unknown>) => Number(r.seq ?? 0);
    const seqOf = (c: string) => seqNum(rows.find((r) => r.content === c) ?? {});
    const boundary = seqOf('旧答');
    const baselineSeq = Math.max(...rows.map(seqNum));
    // 语义边界先 durable（编排序），物理回收随后
    await w.compaction('cmp-1', '此前：旧轮已整理。', boundary);
    const archived = rows.filter((r) => seqNum(r) <= boundary);
    const keep = rows.filter((r) => seqNum(r) > boundary);
    const report = await w.compact({ archive: archived, keep, baselineSeq, compress: true });
    expect(report.segment).toBe('history_1.jsonl.gz');

    // 主日志：header + compaction 事件（late-merge 保留）+ 尾部行
    const after = readRows(dir);
    expect(after[0]?.type).toBe('session-header');
    expect(after.some((r) => r.type === 'compaction/summary')).toBe(true);
    expect(after.some((r) => r.type === 'run-end' && r.run === 'cmp-1')).toBe(true);
    expect(after.some((r) => r.content === '旧答')).toBe(false);
    expect(after.some((r) => r.content === '新答')).toBe(true);

    // 压缩段：解压恒等于归档行（整段单流）
    const gz = fs.readFileSync(path.join(dir, 'archive', 'history_1.jsonl.gz'));
    const text = zlib.gunzipSync(gz).toString('utf-8');
    const restored = text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(restored).toEqual(archived);

    // 尾部投影不变（边界后内容三面同源）
    const fold = foldSession(ROOT, UUID);
    const llm = foldLlmReplay(fold, AGENT, ROOT, UUID);
    expect(llm[0]).toEqual({ role: 'system', content: '此前：旧轮已整理。' });
    expect(llm.some((m) => m.content === '新问')).toBe(true);
    expect(llm.some((m) => m.content === '新答')).toBe(true);
    const view = foldViewRecords(fold, ROOT, UUID);
    expect(view.some((r) => r.content === '新答')).toBe(true);
    expect(view.some((r) => r.content === '旧问')).toBe(false);

    // v2 不写 summary.md（摘要即事件）
    expect(fs.existsSync(path.join(dir, 'summary.md'))).toBe(false);
  });
});
