// ============================================================
// ac-ledger/tests/c3-synthetic-finality.test.ts —— C3 合成收尾：
// 中断 run 的 settlement 把无结果调用物化为确定性终态
//（TOOL_NOT_STARTED / TOOL_OUTCOME_UNKNOWN——对齐 DSH repair 思想）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LedgerWriter, sessionDir } from '../src/writer.ts';
import { readJournal, stepsOfRun } from '../src/reader.ts';

const ROOT = path.join('sandbox', 'test-c3-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const uuid = '0192aaaa-bbbb-7ccc-8ddd-eeeeffff0c3';

describe('C3：中断 run 的合成收尾', () => {
  it('interrupted：aborted 步合成 TOOL_NOT_STARTED，完整步合成 TOOL_OUTCOME_UNKNOWN', async () => {
    const dir = sessionDir(ROOT, 'alpha', uuid);
    const w = new LedgerWriter(dir, { participants: ['alpha', 'user'], kind: 'user' });
    await w.journal({
      type: 'journal-step', run: 'run1', step: 0, content: '', reasoning: '思考',
      toolCalls: [{ id: 'c-full', name: 'read', arguments: '{}' }],
      // 结果补行缺席（中断窗口）
    });
    await w.journal({
      type: 'journal-step', run: 'run1', step: 1, content: '部分正文', aborted: true,
      toolCalls: [{ id: 'c-abort', name: 'write', arguments: '{"path":"x"' }], // 参数截断
    });
    await w.journal({ type: 'journal-settled', run: 'run1', finish: 'interrupted' });
    const p = stepsOfRun(readJournal(dir), 'run1')!;
    expect(p.partial).toBe(false);
    const full = p.steps[0].toolCalls![0];
    expect(full.result).toEqual({ ok: false, error: 'TOOL_OUTCOME_UNKNOWN' });
    const aborted = p.steps[1].toolCalls![0];
    expect(aborted.result).toEqual({ ok: false, error: 'TOOL_NOT_STARTED' });
  });

  it('ok 收束：无结果存量步行仍合成空成功（现状保持）', async () => {
    const dir = sessionDir(ROOT, 'beta', uuid);
    const w = new LedgerWriter(dir, { participants: ['beta', 'user'], kind: 'user' });
    await w.journal({
      type: 'journal-step', run: 'run1', step: 0, content: '',
      toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
    });
    await w.journal({ type: 'journal-settled', run: 'run1', finish: 'ok' });
    const p = stepsOfRun(readJournal(dir), 'run1')!;
    expect(p.steps[0].toolCalls![0].result).toEqual({ ok: true });
  });

  it('结果补行在场：真实结果优先（合成不覆盖）', async () => {
    const dir = sessionDir(ROOT, 'gamma', uuid);
    const w = new LedgerWriter(dir, { participants: ['gamma', 'user'], kind: 'user' });
    await w.journal({
      type: 'journal-step', run: 'run1', step: 0, content: '',
      toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
    });
    await w.journal({ type: 'journal-tool-result', run: 'run1', toolCallId: 'c1', result: { ok: true, output: 'DATA' } });
    await w.journal({ type: 'journal-settled', run: 'run1', finish: 'interrupted' });
    const p = stepsOfRun(readJournal(dir), 'run1')!;
    expect(p.steps[0].toolCalls![0].result).toEqual({ ok: true, output: 'DATA' });
  });
});
