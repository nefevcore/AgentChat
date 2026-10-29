// ============================================================
// view.test.ts —— 会话读面视图组装单测（cr-768）：lite 投影语义 +
// 零变异纪律（cr-55 病理防复发）+ 视图指纹（短路判据）+ 组装投影面。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assembleSessionView, historyView } from '../src/view.ts';
import { UserLedger } from '../src/user.ts';
import { sessionDir } from '../src/writer.ts';

const ROOT = path.join('sandbox', 'test-ledger-view-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const LONG = 'x'.repeat(5 * 1024);
const BIG = { blob: 'y'.repeat(10 * 1024) };

/** 种一个会话：viewer 终稿行（run 键）+ agent 域 journal（含超长步） */
function seed(conv: string): void {
  const userLedger = new UserLedger(ROOT, conv, ['user']);
  void userLedger.writeThrough({ agentId: 'alpha', content: '终稿', uuid: conv, run: 'run-1', requestId: 'rq-1' });
  const journalFile = path.join(sessionDir(ROOT, 'alpha', conv), 'journal', 'partials.jsonl');
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  fs.writeFileSync(journalFile, [
    JSON.stringify({ type: 'journal-step', run: 'run-1', step: 1, content: '想', reasoning: LONG, toolCalls: [{ id: 'c1', name: 'read', arguments: LONG }], toolResults: [{ ok: true, output: BIG }] }),
    JSON.stringify({ type: 'journal-settled', run: 'run-1', finish: 'ok' }),
  ].join('\n') + '\n', 'utf-8');
}

describe('lite 视图投影（cr-768 回填 cr-54/55）', () => {
  it('超长 reasoning/arguments 截断为摘要，result 换 truncated 摘要对象', () => {
    seed('lite-1');
    const out = assembleSessionView(ROOT, 'lite-1', { view: 'lite' });
    const step = (out.find((r) => Array.isArray(r.steps))!.steps as Array<{ reasoning?: string; toolCalls?: Array<{ arguments: string; result: unknown; resultTruncated?: boolean }> }>)[0]!;
    expect(step.reasoning).toMatch(/^x{2048}…\[\+3072B 截断\]$/);
    expect(step.toolCalls![0]!.arguments).toMatch(/^x{2048}…\[\+3072B 截断\]$/);
    expect(step.toolCalls![0]!.resultTruncated).toBe(true);
    expect(step.toolCalls![0]!.result).toMatchObject({ truncated: true });
  });

  it('零变异：lite 投影后磁盘原文重读不变（浅拷贝纪律——cr-55 病理防复发）', () => {
    seed('lite-2');
    const before = fs.readFileSync(path.join(sessionDir(ROOT, 'alpha', 'lite-2'), 'journal', 'partials.jsonl'), 'utf-8');
    assembleSessionView(ROOT, 'lite-2', { view: 'lite' });
    const after = fs.readFileSync(path.join(sessionDir(ROOT, 'alpha', 'lite-2'), 'journal', 'partials.jsonl'), 'utf-8');
    expect(after).toBe(before);
    // 同批 full 视图（不带 lite）不受 lite 投影污染——两视图行内容互不干扰
    const full = assembleSessionView(ROOT, 'lite-2');
    const step = (full.find((r) => Array.isArray(r.steps))!.steps as Array<{ reasoning?: string }>)[0]!;
    expect(step.reasoning).toBe(LONG);
  });

  it('短字段原样直通（低于阈值不截断——语义等价）', () => {
    seed('lite-3');
    const jf = path.join(sessionDir(ROOT, 'alpha', 'lite-3'), 'journal', 'partials.jsonl');
    fs.writeFileSync(jf, [
      JSON.stringify({ type: 'journal-step', run: 'run-1', step: 1, content: '想', reasoning: '短思考', toolCalls: [{ id: 'c9', name: 'read', arguments: '{}' }], toolResults: [{ ok: true, output: '小结果' }] }),
      JSON.stringify({ type: 'journal-settled', run: 'run-1', finish: 'ok' }),
    ].join('\n') + '\n', 'utf-8');
    const out = assembleSessionView(ROOT, 'lite-3', { view: 'lite' });
    const step = (out.find((r) => Array.isArray(r.steps))!.steps as Array<{ reasoning?: string; toolCalls?: Array<{ arguments: string; result: unknown; resultTruncated?: boolean }> }>)[0]!;
    expect(step.reasoning).toBe('短思考');
    expect(step.toolCalls![0]!.arguments).toBe('{}');
    expect(step.toolCalls![0]!.result).toEqual({ ok: true, output: '小结果' });
    expect(step.toolCalls![0]!.resultTruncated).toBeUndefined();
  });
});

describe('historyView 视图指纹（cr-768 回填 2026-09-19 短路判据）', () => {
  it('文件未变 → 指纹不变；追加行 → 指纹变', async () => {
    seed('fp-1');
    const v1 = historyView(ROOT, 'fp-1');
    expect(v1.fingerprint).not.toBe('');
    expect(v1.domains).toEqual(['alpha']);
    expect(historyView(ROOT, 'fp-1').fingerprint).toBe(v1.fingerprint);
    // 追加终稿行（viewer 域变化）→ 指纹必变（viewer 账本是 replay 输入——
    // 指纹必须盖住；await 等队列落盘后 stat）
    const ul = new UserLedger(ROOT, 'fp-1', ['user']);
    await ul.writeThrough({ agentId: 'alpha', content: '第二稿', uuid: 'fp-1', run: 'run-2', requestId: 'rq-2' });
    expect(historyView(ROOT, 'fp-1').fingerprint).not.toBe(v1.fingerprint);
  });

  it('agent 域 journal 追加 → 指纹变（跨域复合——单 viewer 指纹盖不住的窗口）', () => {
    seed('fp-2');
    const v1 = historyView(ROOT, 'fp-2');
    const jf = path.join(sessionDir(ROOT, 'alpha', 'fp-2'), 'journal', 'partials.jsonl');
    fs.appendFileSync(jf, JSON.stringify({ type: 'journal-step', run: 'run-1', step: 2, content: '补步' }) + '\n', 'utf-8');
    expect(historyView(ROOT, 'fp-2').fingerprint).not.toBe(v1.fingerprint);
  });
});

describe('assembleSessionView 组装投影面（行为等价锁定）', () => {
  it('peer 行带 steps + 注入行归口 + 盲区 run 投出', () => {
    seed('asm-1');
    // 盲区 run：journal 有步无 viewer 终稿行
    const jf = path.join(sessionDir(ROOT, 'alpha', 'asm-1'), 'journal', 'partials.jsonl');
    fs.appendFileSync(jf, [
      JSON.stringify({ type: 'journal-step', run: 'orphan-1', step: 1, content: '孤儿步' }),
    ].join('\n') + '\n', 'utf-8');
    const out = assembleSessionView(ROOT, 'asm-1');
    const peer = out.find((r) => r.role === 'assistant' && r.content === '终稿');
    expect(peer).toBeDefined();
    expect(peer!.run).toBe('run-1');
    expect((peer!.steps as unknown[]).length).toBe(1);
    expect(peer!.partial).toBeUndefined();
    const orphan = out.find((r) => r.run === 'orphan-1');
    expect(orphan).toBeDefined();
    expect(orphan!.partial).toBe(true);
    expect(orphan!.agent_id).toBe('alpha');
  });
});
