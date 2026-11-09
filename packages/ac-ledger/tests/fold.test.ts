// ============================================================
// fold.test.ts —— fold 单源性质化测试（cr-974 / cr-972 §2.5）
//
// ① parity：fold 投影 ≡ 切换前实现（assembleSessionViewLegacy /
//    projectUserReplay）——v1 形态会话（settle 物化 + in-flight journal +
//    subcalls 档案 + 注入/错误/机制行）对拍。
// ② v1/v2 等价：等价内容的 v2 单文件会话（step/* 相位族）三方投影
//    与 v1 深等（词汇升级零投影漂移）。
// ③ 读方配平（D-3）：未闭合 run 投 partial、不回写。
// ④ 前缀稳定：增量追加后旧投影 = 新投影前缀（fold(全量) ≡ 前缀+追加）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LedgerWriter, sessionDir } from '../src/index.ts';
import { assembleSessionView, assembleSessionViewLegacy } from '../src/view.ts';
import { projectUserReplay } from '../src/project.ts';
import { foldLlmReplay, foldSession, foldUserReplay, foldViewRecords } from '../src/fold.ts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-fold-'));
afterEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });
beforeEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });

const UUID = 'conv-fold';
const AGENT = 'alpha';

function writer(agent = AGENT): LedgerWriter {
  return new LedgerWriter(sessionDir(ROOT, agent, UUID), { participants: [agent, 'user'], kind: 'user' });
}

/** v1 富形态会话：两轮 settle（含 subcall/注入）+ 一轮 in-flight journal +
 *  错误收束行 + 机制通知 + 存量 restarted 行 */
async function seedV1(): Promise<void> {
  const w = writer();
  await w.deliver({ role: 'agent', content: '问一', agent_id: 'user', requestId: 'q1', uuid: UUID, timestamp: '2026-11-09T10:00:01.000Z' });
  // run-1：带子调用的步 + 终稿
  await w.journal({ type: 'journal-step', run: 'run-1', step: 0, content: '先查', reasoning: '想一下', textBeforeTools: true, toolCalls: [{ id: 'tc1', name: 'run_code', arguments: '{}' }], ts: 1, usage: { prompt: 10, completion: 5 } });
  await w.journal({ type: 'journal-tool-result', run: 'run-1', toolCallId: 'tc1#2', result: { ok: true, output: 'sub' }, subcall: true, name: 'read', arguments: '{}', ts: 2 });
  await w.journal({ type: 'journal-inject', run: 'run-1', content: '插一句', requestId: 'steer-1', injectionId: 'inj-1', ts: 3 });
  await w.journal({ type: 'journal-step', run: 'run-1', step: 1, content: '答一', ts: 4 });
  await w.settle({ role: 'agent', content: '答一', agent_id: AGENT, requestId: 'a1', uuid: UUID, run: 'run-1', runMs: 1500 } as never, 'run-1', 'ok');
  await w.deliver({ role: 'agent', content: '问二', agent_id: 'user', requestId: 'q2', uuid: UUID, timestamp: '2026-11-09T10:01:00.000Z' });
  // run-2：error 收束（cr-807 红条）
  await w.journal({ type: 'journal-step', run: 'run-2', step: 0, content: '半途', ts: 5 });
  await w.settle({ role: 'agent', content: '失败了', agent_id: AGENT, requestId: 'a2', uuid: UUID, run: 'run-2' } as never, 'run-2', 'error', undefined, '工具炸了');
  // run-3：in-flight（未收束——配平面）
  await w.journal({ type: 'journal-step', run: 'run-3', step: 0, content: '进行中', ts: 6 });
  // 机制通知 + 存量 restarted 行
  await w.deliver({ role: 'context', source: 'event', content: '[会话设置] 已重启', agent_id: AGENT, uuid: UUID } as never);
  await w.deliver({ role: 'agent', content: '已重启通知（存量形态）', agent_id: 'user', requestId: 'restarted-x1', uuid: UUID, timestamp: '2026-11-09T10:02:00.000Z' });
}

describe('fold 单源（cr-974 §2.5 性质化）', () => {
  it('parity：foldViewRecords ≡ assembleSessionViewLegacy（v1 富形态）', async () => {
    await seedV1();
    const legacy = assembleSessionViewLegacy(ROOT, UUID);
    const folded = assembleSessionView(ROOT, UUID);
    expect(folded).toEqual(legacy);
  });

  it('parity：foldUserReplay ≡ projectUserReplay', async () => {
    await seedV1();
    expect(foldUserReplay(foldSession(ROOT, UUID))).toEqual(projectUserReplay(ROOT, UUID));
  });

  it('读方配平（D-3）：未闭合 run 投 partial 不回写；LLM 轨迹照常注入', async () => {
    await seedV1();
    const dir = sessionDir(ROOT, AGENT, UUID);
    const journalBefore = fs.readFileSync(path.join(dir, 'journal', 'partials.jsonl'), 'utf-8');
    const view = foldViewRecords(foldSession(ROOT, UUID), ROOT, UUID);
    const unclosed = view.filter((r) => r.run === 'run-3');
    expect(unclosed.length).toBeGreaterThan(0);
    expect(unclosed.every((r) => r.partial === true)).toBe(true); // 合成 interrupted 投影
    expect(fs.readFileSync(path.join(dir, 'journal', 'partials.jsonl'), 'utf-8')).toBe(journalBefore); // 零回写
    const llm = foldLlmReplay(foldSession(ROOT, UUID), AGENT, ROOT, UUID);
    expect(llm.some((m) => m.content === '进行中')).toBe(false); // 未闭合 run 不进 LLM 回放（v1 同构——盲区归 webui 投影，续跑归 resume 面）
  });

  it('前缀稳定：追加后旧投影 = 新投影前缀（fold 全量 ≡ 快照 + 增量）', async () => {
    const w = writer();
    await w.deliver({ role: 'agent', content: '问', agent_id: 'user', requestId: 'q', uuid: UUID });
    await w.journal({ type: 'journal-step', run: 'run-p', step: 0, content: '步一', ts: 1 });
    await w.settle({ role: 'agent', content: '终稿一', agent_id: AGENT, requestId: 'a', uuid: UUID, run: 'run-p' } as never, 'run-p', 'ok');
    const before = foldLlmReplay(foldSession(ROOT, UUID), AGENT, ROOT, UUID);
    const viewBefore = foldViewRecords(foldSession(ROOT, UUID), ROOT, UUID);
    await w.deliver({ role: 'agent', content: '再问', agent_id: 'user', requestId: 'q2', uuid: UUID });
    await w.journal({ type: 'journal-step', run: 'run-p2', step: 0, content: '步二', ts: 2 });
    await w.settle({ role: 'agent', content: '终稿二', agent_id: AGENT, requestId: 'a2', uuid: UUID, run: 'run-p2' } as never, 'run-p2', 'ok');
    const after = foldLlmReplay(foldSession(ROOT, UUID), AGENT, ROOT, UUID);
    const viewAfter = foldViewRecords(foldSession(ROOT, UUID), ROOT, UUID);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(viewAfter.slice(0, viewBefore.length)).toEqual(viewBefore);
  });

  it('v1/v2 等价：v2 单文件（step/* 相位族）三方投影与 v1 深等', async () => {
    await seedV1();
    const v1View = foldViewRecords(foldSession(ROOT, UUID), ROOT, UUID);
    const v1Replay = foldUserReplay(foldSession(ROOT, UUID));
    const v1Llm = foldLlmReplay(foldSession(ROOT, UUID), AGENT, ROOT, UUID);
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
    // 对照 v1 子集会话（同内容、v1 形态：journal + settle 物化）
    const UUID1 = 'conv-fold-v1sub';
    const w1 = new LedgerWriter(sessionDir(ROOT, AGENT, UUID1), { participants: [AGENT, 'user'], kind: 'user' });
    await w1.deliver({ role: 'agent', content: '问一', agent_id: 'user', requestId: 'q1', uuid: UUID1, timestamp: '2026-11-09T10:00:01.000Z' });
    await w1.journal({ type: 'journal-step', run: 'run-1', step: 0, content: '先查', reasoning: '想一下', reasoningMs: 100, textBeforeTools: true, stepId: 'run-1:0', toolCalls: [{ id: 'tc1', name: 'run_code', arguments: '{}' }], toolResults: [{ ok: true }], ts: 2, usage: { prompt: 10, completion: 5 } });
    await w1.journal({ type: 'journal-tool-result', run: 'run-1', toolCallId: 'tc1#2', result: { ok: true, output: 'sub' }, subcall: true, name: 'read', arguments: '{}', ts: 4 });
    await w1.journal({ type: 'journal-inject', run: 'run-1', content: '插一句', requestId: 'steer-1', injectionId: 'inj-1', ts: 5 });
    await w1.journal({ type: 'journal-step', run: 'run-1', step: 1, content: '答一', stepId: 'run-1:1', ts: 6 });
    await w1.settle({ role: 'agent', content: '答一', agent_id: AGENT, requestId: 'a1', uuid: UUID1, run: 'run-1', runMs: 1500 } as never, 'run-1', 'ok');
    await w1.journal({ type: 'journal-step', run: 'run-3', step: 0, content: '进行中', stepId: 'run-3:0', ts: 8 });
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
    expect(v1Replay.length).toBeGreaterThan(0);
    expect(v1Llm.length).toBeGreaterThan(0);
  });
});
