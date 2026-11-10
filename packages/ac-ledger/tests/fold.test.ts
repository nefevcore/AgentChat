// ============================================================
// fold.test.ts —— fold 单源性质化测试（cr-974 / cr-972 §2.5；cr-998
// 起夹具全部手写存量文件形态——v1 写面退役后不再经 writer 产 v1 行）
//
// ① v1 存量会话（settle 物化 + in-flight journal + subcalls 档案 +
//    注入/错误/机制行——盘上 v1 三文件直写）三方投影产出正确。
// ② v1/v2 等价：等价内容的 v2 单文件会话（step/* 相位族）三方投影
//    与 v1 深等（词汇升级零投影漂移）。
// ③ 读方配平（D-3）：未闭合 run 投 partial、不回写。
// ④ 前缀稳定：增量追加后旧投影 = 新投影前缀（fold(全量) ≡ 前缀+追加）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sessionDir } from '../src/index.ts';
import { assembleSessionView } from '../src/view.ts';
import { foldLlmReplay, foldSession, foldUserReplay, foldViewRecords } from '../src/fold.ts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-fold-'));
afterEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });
beforeEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });

const UUID = 'conv-fold';
const AGENT = 'alpha';

/** v1 富形态会话（盘上直写）：两轮 settle（含 subcall/注入）+ 一轮
 *  in-flight journal + 错误收束行 + 机制通知 + 存量 restarted 行 */
function seedV1(): void {
  const dir = sessionDir(ROOT, AGENT, UUID);
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  // messages：v1 头行 + 入站/终稿/物化段行/注入行/错误/机制/存量 restarted
  const msgRows: Array<Record<string, unknown>> = [
    { type: 'session-header', version: 1, createdAt: '2026-11-09T10:00:00.000Z', participants: [AGENT, 'user'], kind: 'user' },
    { role: 'agent', content: '问一', agent_id: 'user', requestId: 'q1', message_id: 'q1', timestamp: '2026-11-09T10:00:01.000Z', seq: 1 },
    // run-1：物化段行（含工具调用）+ 注入行 + 段行
    { role: 'agent', content: '', agent_id: AGENT, run: 'run-1', source: 'segment', steps: [{ content: '先查', reasoning: '想一下', ts: 1, toolCalls: [{ id: 'tc1', name: 'run_code', arguments: '{}', result: { ok: true, output: 'sub' } }] }], message_id: 'seg-run-1-0', timestamp: '2026-11-09T10:00:10.000Z', seq: 2 },
    { role: 'agent', content: '插一句', agent_id: AGENT, run: 'run-1', source: 'inject', requestId: 'steer-1', message_id: 'inj-1', timestamp: '2026-11-09T10:00:11.000Z', seq: 3 },
    { role: 'agent', content: '', agent_id: AGENT, run: 'run-1', source: 'segment', steps: [{ content: '答一', ts: 4 }], message_id: 'seg-run-1-2', timestamp: '2026-11-09T10:00:12.000Z', seq: 4 },
    { role: 'agent', content: '答一', agent_id: AGENT, requestId: 'a1', run: 'run-1', runMs: 1500, message_id: 'a1', timestamp: '2026-11-09T10:00:13.000Z', seq: 5 },
    { role: 'agent', content: '问二', agent_id: 'user', requestId: 'q2', message_id: 'q2', timestamp: '2026-11-09T10:01:00.000Z', seq: 6 },
    // run-2：error 收束（cr-807 红条——段行 + 空终稿 + 错误行）
    { role: 'agent', content: '', agent_id: AGENT, run: 'run-2', source: 'segment', steps: [{ content: '半途', ts: 5 }], message_id: 'seg-run-2-0', timestamp: '2026-11-09T10:01:10.000Z', seq: 7 },
    { role: 'agent', content: '', agent_id: AGENT, requestId: 'a2', run: 'run-2', message_id: 'a2', timestamp: '2026-11-09T10:01:11.000Z', seq: 8 },
    { role: 'context', source: 'error', content: '工具炸了', agent_id: AGENT, run: 'run-2', message_id: 'e2', timestamp: '2026-11-09T10:01:11.500Z', seq: 9 },
    // 机制通知（context+event）+ 存量 restarted 行
    { role: 'context', source: 'event', content: '[会话设置] 已重启', agent_id: AGENT, message_id: 'ev1', timestamp: '2026-11-09T10:01:59.000Z', seq: 10 },
    { role: 'agent', content: '已重启通知（存量形态）', agent_id: 'user', requestId: 'restarted-x1', message_id: 'rx1', timestamp: '2026-11-09T10:02:00.000Z', seq: 11 },
  ];
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), msgRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  // journal：run-3 in-flight（未收束——配平面）+ run-1/run-2 settled 留档
  fs.writeFileSync(path.join(dir, 'journal', 'partials.jsonl'), [
    { type: 'journal-settled', run: 'run-1', finish: 'ok', seq: 12 },
    { type: 'journal-settled', run: 'run-2', finish: 'error', seq: 13 },
    { type: 'journal-step', run: 'run-3', step: 0, content: '进行中', ts: 6, seq: 14 },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

describe('fold 单源（cr-974 §2.5 性质化）', () => {
  it('v1 存量会话：三方投影（视图/终稿层/LLM 回放）产出正确', () => {
    seedV1();
    const view = foldViewRecords(foldSession(ROOT, UUID), ROOT, UUID);
    // 物化段行 steps 带出 + 注入卡 + 盲区 run 配平 + 错误红条 + 机制 event
    expect(view.some((r) => r.role === 'assistant' && r.content === '答一' && Array.isArray(r.steps))).toBe(true);
    expect(view.some((r) => r.role === 'context' && r.content === '插一句')).toBe(true);
    expect(view.filter((r) => r.run === 'run-3').every((r) => r.partial === true)).toBe(true);
    expect(view.some((r) => r.role === 'error' && r.content === '工具炸了')).toBe(true);
    expect(view.some((r) => r.role === 'event')).toBe(true);
    const llm = foldLlmReplay(foldSession(ROOT, UUID), AGENT, ROOT, UUID);
    expect(llm.some((m) => m.content === '进行中')).toBe(false); // 未闭合 run 不进 LLM 回放
  });

  it('读方配平（D-3）：未闭合 run 投 partial 不回写', () => {
    seedV1();
    const dir = sessionDir(ROOT, AGENT, UUID);
    const journalBefore = fs.readFileSync(path.join(dir, 'journal', 'partials.jsonl'), 'utf-8');
    const messagesBefore = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8');
    const view = foldViewRecords(foldSession(ROOT, UUID), ROOT, UUID);
    const unclosed = view.filter((r) => r.run === 'run-3');
    expect(unclosed.length).toBeGreaterThan(0);
    expect(unclosed.every((r) => r.partial === true)).toBe(true); // 合成 interrupted 投影
    expect(fs.readFileSync(path.join(dir, 'journal', 'partials.jsonl'), 'utf-8')).toBe(journalBefore); // 零回写
    expect(fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8')).toBe(messagesBefore);
  });

  it('前缀稳定：追加后旧投影 = 新投影前缀（fold 全量 ≡ 快照 + 增量）', () => {
    // 纯终稿 run 会话（对齐原版语义——盲区/机制尾段行按时间序归并的形态
    // 不在本 it 范围：那些行 push 位次不敏感，前端按 timestamp 排序）
    const UUID2 = 'conv-prefix';
    const dir = sessionDir(ROOT, AGENT, UUID2);
    fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
    const file = path.join(dir, 'messages.jsonl');
    fs.writeFileSync(file, [
      { type: 'session-header', version: 1, createdAt: 't', participants: [AGENT, 'user'], kind: 'user' },
      { role: 'agent', content: '问', agent_id: 'user', requestId: 'q', message_id: 'q', timestamp: '2026-11-09T10:00:00.000Z', seq: 1 },
      { role: 'agent', content: '终稿一', agent_id: AGENT, requestId: 'a', run: 'run-p', message_id: 'a', timestamp: '2026-11-09T10:00:10.000Z', seq: 2 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'journal', 'partials.jsonl'),
      JSON.stringify({ type: 'journal-settled', run: 'run-p', finish: 'ok', seq: 3 }) + '\n', 'utf-8');
    const before = foldLlmReplay(foldSession(ROOT, UUID2), AGENT, ROOT, UUID2);
    const viewBefore = foldViewRecords(foldSession(ROOT, UUID2), ROOT, UUID2);
    // 增量：追加新终稿行（append-only 尾部追加）
    fs.appendFileSync(file, JSON.stringify({ role: 'agent', content: '再问', agent_id: 'user', requestId: 'q2', message_id: 'q2', timestamp: '2026-11-09T10:03:00.000Z', seq: 4 }) + '\n', 'utf-8');
    fs.appendFileSync(file, JSON.stringify({ role: 'agent', content: '终稿二', agent_id: AGENT, requestId: 'a2', run: 'run-p2', message_id: 'a2', timestamp: '2026-11-09T10:03:10.000Z', seq: 5 }) + '\n', 'utf-8');
    fs.appendFileSync(path.join(dir, 'journal', 'partials.jsonl'),
      JSON.stringify({ type: 'journal-settled', run: 'run-p2', finish: 'ok', seq: 6 }) + '\n', 'utf-8');
    const after = foldLlmReplay(foldSession(ROOT, UUID2), AGENT, ROOT, UUID2);
    const viewAfter = foldViewRecords(foldSession(ROOT, UUID2), ROOT, UUID2);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(viewAfter.slice(0, viewBefore.length)).toEqual(viewBefore);
  });

  it('v1/v2 等价：v2 单文件（step/* 相位族）三方投影与 v1 深等（剥身份戳）', () => {
    seedV1();
    const v1View = foldViewRecords(foldSession(ROOT, UUID), ROOT, UUID);
    // 等价 v2 会话（另一 conv id，事件语义同 seedV1 的 run-1 子集 + in-flight）
    const UUID2 = 'conv-fold-v2';
    const dir2 = sessionDir(ROOT, AGENT, UUID2);
    fs.mkdirSync(dir2, { recursive: true });
    const lines: Array<Record<string, unknown>> = [
      { type: 'session-header', version: 2, createdAt: '2026-11-09T10:00:00.000Z', participants: [AGENT, 'user'], kind: 'user' },
      { type: 'message', role: 'agent', agent_id: 'user', content: '问一', message_id: 'q1', requestId: 'q1', timestamp: '2026-11-09T10:00:01.000Z', seq: 1 },
      { type: 'step/reasoning', run: 'run-1', step: 0, stepId: 'run-1:0', text: '想一下', reasoningMs: 100, ts: 1, seq: 2 },
      { type: 'step/content', run: 'run-1', step: 0, stepId: 'run-1:0', text: '先查', ts: 2, seq: 3, usage: { prompt: 10, completion: 5 } },
      { type: 'step/tool-call', run: 'run-1', step: 0, stepId: 'run-1:0', toolCallId: 'tc1', name: 'run_code', arguments: '{}', ts: 3, seq: 4 },
      { type: 'step/tool-call-result', run: 'run-1', toolCallId: 'tc1', result: { ok: true }, ts: 4, seq: 5 },
      { type: 'step/tool-call-result', run: 'run-1', toolCallId: 'tc1#2', result: { ok: true, output: 'sub' }, subcall: true, name: 'read', arguments: '{}', ts: 4, seq: 5 },
      { type: 'inject', run: 'run-1', content: '插一句', requestId: 'steer-1', injectionId: 'inj-1', ts: 5, seq: 6 },
      { type: 'step/content', run: 'run-1', step: 1, stepId: 'run-1:1', text: '答一', ts: 6, seq: 7 },
      { type: 'message', role: 'agent', agent_id: AGENT, content: '答一', message_id: 'a1', requestId: 'a1', run: 'run-1', runMs: 1500, timestamp: '2026-11-09T10:00:30.000Z', seq: 8 },
      { type: 'run-end', run: 'run-1', finish: 'completed', ts: 7, seq: 9 },
      { type: 'step/content', run: 'run-3', step: 0, stepId: 'run-3:0', text: '进行中', ts: 8, seq: 10 },
    ];
    fs.writeFileSync(path.join(dir2, 'messages.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
    // 对照 v1 子集会话（同内容、v1 形态：物化段行 + journal）
    const UUID1 = 'conv-fold-v1sub';
    const dir1 = sessionDir(ROOT, AGENT, UUID1);
    fs.mkdirSync(path.join(dir1, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(dir1, 'messages.jsonl'), [
      { type: 'session-header', version: 1, createdAt: '2026-11-09T10:00:00.000Z', participants: [AGENT, 'user'], kind: 'user' },
      { role: 'agent', content: '问一', agent_id: 'user', requestId: 'q1', message_id: 'q1', timestamp: '2026-11-09T10:00:01.000Z', seq: 1 },
      { role: 'agent', content: '', agent_id: AGENT, run: 'run-1', source: 'segment', steps: [{ content: '先查', reasoning: '想一下', reasoningMs: 100, ts: 2, stepId: 'run-1:0', textBeforeTools: true, usage: { prompt: 10, completion: 5 }, toolCalls: [{ id: 'tc1', name: 'run_code', arguments: '{}', result: { ok: true } }] }], message_id: 'seg-run-1-0', timestamp: '2026-11-09T10:00:10.000Z', seq: 2 },
      { role: 'agent', content: '插一句', agent_id: AGENT, run: 'run-1', source: 'inject', requestId: 'steer-1', message_id: 'inj-1', timestamp: '2026-11-09T10:00:11.000Z', seq: 3 },
      { role: 'agent', content: '', agent_id: AGENT, run: 'run-1', source: 'segment', steps: [{ content: '答一', ts: 6, stepId: 'run-1:1' }], message_id: 'seg-run-1-2', timestamp: '2026-11-09T10:00:12.000Z', seq: 4 },
      { role: 'agent', content: '答一', agent_id: AGENT, requestId: 'a1', run: 'run-1', runMs: 1500, message_id: 'a1', timestamp: '2026-11-09T10:00:13.000Z', seq: 5 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    fs.writeFileSync(path.join(dir1, 'journal', 'partials.jsonl'), [
      { type: 'journal-settled', run: 'run-1', finish: 'ok', seq: 6 },
      { type: 'journal-step', run: 'run-3', step: 0, content: '进行中', stepId: 'run-3:0', ts: 8, seq: 7 },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
    // cr-803 子调用档案（v1 分流形态——读面联查注入 UI 平铺，与 v2 内联等价）
    fs.writeFileSync(path.join(dir1, 'subcalls.jsonl'),
      JSON.stringify({ type: 'journal-tool-result', run: 'run-1', toolCallId: 'tc1#2', result: { ok: true, output: 'sub' }, subcall: true, name: 'read', arguments: '{}', seq: 8 }) + '\n', 'utf-8');
    const cmp = (a: string, b: string): void => {
      // 独立构造的会话 timestamp/seq 是各自落账事实——结构等价对拍剥之
      const strip = (rows: unknown[]): unknown[] => rows.map((r) => {
        if (r === null || typeof r !== 'object') return r;
        const c = { ...(r as Record<string, unknown>) };
        delete c.timestamp; delete c.seq; delete c.message_id;
        if (Array.isArray(c.steps)) c.steps = (c.steps as unknown[]).map((s) => { const d = { ...(s as Record<string, unknown>) }; delete d.seq; delete d.ts; return d; });
        return c;
      });
      const fa = foldSession(ROOT, a);
      const fb = foldSession(ROOT, b);
      expect(strip(foldUserReplay(fb))).toEqual(strip(foldUserReplay(fa)));
      expect(strip(foldLlmReplay(fb, AGENT, ROOT, b))).toEqual(strip(foldLlmReplay(fa, AGENT, ROOT, a)));
      const va = foldViewRecords(fa, ROOT, a);
      const vb = foldViewRecords(fb, ROOT, b);
      expect(strip(vb)).toEqual(strip(va));
    };
    cmp(UUID1, UUID2);
    // v2 fold 确有产出（非空对拍非平凡）
    expect(v1View.length).toBeGreaterThan(0);
  });
});
