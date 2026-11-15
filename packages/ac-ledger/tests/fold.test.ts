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
    // cr-1101 回放契约：未闭合 run（孤儿）轨迹进 LLM 回放——once 绝不允许
    //（excludeRun 才可排除；不回写不变式由 D-3 用例锁定）
    expect(llm.some((m) => m.content === '进行中')).toBe(true);
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


describe('回放契约（cr-1101 / docs/design/session/replay-contract.md）', () => {
  it('error 行进回放：user 语义位 + wrapper 包裹（曾进入 run 的失败事实不失忆）', () => {
    seedV1();
    const llm = foldLlmReplay(foldSession(ROOT, UUID), AGENT, ROOT, UUID);
    const err = llm.filter((m) => m.content.includes('工具炸了'));
    expect(err).toHaveLength(1);
    expect(err[0]!.role).toBe('user');
    expect(err[0]!.content).toBe('<system-reminder>工具炸了</system-reminder>');
  });

  it('wrapper：非 speech 回放统一包裹；存量烘焙行原样放行（不双壳）', () => {
    seedV1();
    const llm = foldLlmReplay(foldSession(ROOT, UUID), AGENT, ROOT, UUID);
    expect(llm.some((m) => m.content === '<system-reminder>插一句</system-reminder>')).toBe(true);
    expect(llm.some((m) => m.content === '<system-reminder>[会话设置] 已重启</system-reminder>')).toBe(true);
    // 存量烘焙：content 已以 <system-reminder> 开头 → 原样回放（不双壳）
    const dir = sessionDir(ROOT, AGENT, 'conv-baked');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), [
      { type: 'session-header', version: 2, createdAt: 't', participants: [AGENT, 'user'], kind: 'user' },
      { type: 'inject', run: 'run-b', content: '<system-reminder>技能正文</system-reminder>', injectSource: 'skill', ts: 1, seq: 2 },
      { type: 'message', role: 'agent', agent_id: AGENT, content: '终稿', message_id: 'a', requestId: 'a', run: 'run-b', timestamp: '2026-11-09T10:00:10.000Z', seq: 3 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const llm2 = foldLlmReplay(foldSession(ROOT, 'conv-baked'), AGENT, ROOT, 'conv-baked');
    expect(llm2.filter((m) => m.content.includes('技能正文')).map((m) => m.content)).toEqual(['<system-reminder>技能正文</system-reminder>']);
  });

  it('excludeRun：活动 run 轨迹排除（轮间重派生防双喂），其他 run 照常回放', () => {
    seedV1();
    const fold = foldSession(ROOT, UUID);
    const excl = foldLlmReplay(fold, AGENT, ROOT, UUID, undefined, { excludeRun: 'run-3' });
    expect(excl.some((m) => m.content === '进行中')).toBe(false);
    expect(excl.some((m) => m.content === '答一')).toBe(true);
  });

  it('判重 v1 门控：v1 双写遗产兜底保留；v2 跳过（写面幂等是唯一防线）', () => {
    // v1：同 requestId 的入站行 + 注入行 → 入站行不复读（cr-713 兜底）
    const d1 = sessionDir(ROOT, AGENT, 'conv-dup-v1');
    fs.mkdirSync(path.join(d1, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(d1, 'messages.jsonl'), [
      { type: 'session-header', version: 1, createdAt: 't', participants: [AGENT, 'user'], kind: 'user' },
      { role: 'agent', content: 'dup文', agent_id: 'user', requestId: 'dup-1', message_id: 'dup-1', timestamp: '2026-11-09T10:00:01.000Z', seq: 1 },
      { role: 'agent', content: '', agent_id: AGENT, run: 'run-d', source: 'segment', steps: [{ content: '中途', ts: 1 }], message_id: 'seg-d', timestamp: '2026-11-09T10:00:02.000Z', seq: 2 },
      { role: 'agent', content: 'dup文', agent_id: AGENT, run: 'run-d', source: 'inject', requestId: 'dup-1', message_id: 'inj-d', timestamp: '2026-11-09T10:00:03.000Z', seq: 3 },
      { role: 'agent', content: '终稿', agent_id: AGENT, requestId: 'a-d', run: 'run-d', message_id: 'a-d', timestamp: '2026-11-09T10:00:04.000Z', seq: 4 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const llm1 = foldLlmReplay(foldSession(ROOT, 'conv-dup-v1'), AGENT, ROOT, 'conv-dup-v1');
    expect(llm1.filter((m) => m.content.includes('dup文')).map((m) => m.content)).toEqual(['<system-reminder>dup文</system-reminder>']);
    // v2：同形态 → 判重不生效（数据根实证 0 对共存；写面三重幂等唯一防线）
    const d2 = sessionDir(ROOT, AGENT, 'conv-dup-v2');
    fs.mkdirSync(d2, { recursive: true });
    fs.writeFileSync(path.join(d2, 'messages.jsonl'), [
      { type: 'session-header', version: 2, createdAt: 't', participants: [AGENT, 'user'], kind: 'user' },
      { type: 'message', role: 'agent', agent_id: 'user', content: 'dup文', message_id: 'dup-1', requestId: 'dup-1', timestamp: '2026-11-09T10:00:01.000Z', seq: 1 },
      { type: 'inject', run: 'run-d', content: 'dup文', requestId: 'dup-1', ts: 2, seq: 2 },
      { type: 'message', role: 'agent', agent_id: AGENT, content: '终稿', message_id: 'a-d', requestId: 'a-d', run: 'run-d', timestamp: '2026-11-09T10:00:04.000Z', seq: 3 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const llm2 = foldLlmReplay(foldSession(ROOT, 'conv-dup-v2'), AGENT, ROOT, 'conv-dup-v2');
    expect(llm2.filter((m) => m.content === 'dup文')).toHaveLength(1);
    expect(llm2.filter((m) => m.content === '<system-reminder>dup文</system-reminder>')).toHaveLength(1);
  });

  it('孤儿 run 未收束调用合成终态：结果未知（不盲 ok）+ 轨迹整体在场', () => {
    const dir = sessionDir(ROOT, AGENT, 'conv-orph');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), [
      { type: 'session-header', version: 2, createdAt: 't', participants: [AGENT, 'user'], kind: 'user' },
      { type: 'message', role: 'agent', agent_id: 'user', content: '问', message_id: 'q', timestamp: '2026-11-09T10:00:00.000Z', seq: 1 },
      { type: 'step/content', run: 'run-o', step: 0, text: '先说', ts: 1000, seq: 2 },
      { type: 'step/tool-call', run: 'run-o', step: 1, toolCallId: 'c1', name: 'run_code', arguments: '{}', ts: 2000, seq: 3 },
      // c1 无 tool-call-result、无 run-end（硬死窗口）→ 合成结果未知
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const llm = foldLlmReplay(foldSession(ROOT, 'conv-orph'), AGENT, ROOT, 'conv-orph');
    const tool = llm.find((m) => m.role === 'tool');
    expect(tool?.tool_call_id).toBe('c1');
    expect(String(tool?.content)).toContain('请先核查');
    expect(llm.some((m) => m.content === '先说')).toBe(true);
  });
});
});

describe('回放声明注册制（cr-1104）', () => {
  function seedDecl(conv: string, injectSource?: string): void {
    const dir = sessionDir(ROOT, AGENT, conv);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), [
      { type: 'session-header', version: 2, createdAt: 't', participants: [AGENT, 'user'], kind: 'user' },
      { type: 'inject', run: 'run-w', content: '声明注入体', ...(injectSource !== undefined ? { injectSource } : {}), ts: 1, seq: 2 },
      { type: 'message', role: 'agent', agent_id: AGENT, content: '终稿', message_id: 'a', requestId: 'a', run: 'run-w', timestamp: '2026-11-09T10:00:10.000Z', seq: 3 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  }

  it('声明 original → 原文回放；声明 none → 不进回放；未注册 → 缺省 wrapper', () => {
    seedDecl('conv-decl-o', 'ac-demo:notice');
    seedDecl('conv-decl-n', 'ac-demo:ui-only');
    seedDecl('conv-decl-w', 'ac-demo:plain');
    const decls: Record<string, 'original' | 'wrapper' | 'none'> = { 'ac-demo:notice': 'original', 'ac-demo:ui-only': 'none' };
    const replayOf = (w: string) => decls[w];
    const o = foldLlmReplay(foldSession(ROOT, 'conv-decl-o'), AGENT, ROOT, 'conv-decl-o', undefined, { replayOf });
    expect(o.some((m) => m.content === '声明注入体')).toBe(true); // original 裸文
    const n = foldLlmReplay(foldSession(ROOT, 'conv-decl-n'), AGENT, ROOT, 'conv-decl-n', undefined, { replayOf });
    expect(n.some((m) => m.content.includes('声明注入体'))).toBe(false); // none 不进
    const w = foldLlmReplay(foldSession(ROOT, 'conv-decl-w'), AGENT, ROOT, 'conv-decl-w', undefined, { replayOf });
    expect(w.some((m) => m.content === '<system-reminder>声明注入体</system-reminder>')).toBe(true); // 缺省 wrapper
  });
});

describe('context 行全量时间线准入（cr-1106——拆 once 面 #2）', () => {
  it('非 event/error 的 context 行进 LLM 回放:裸文包裹、烘焙 passthrough、none 跳过', () => {
    const dir = sessionDir(ROOT, AGENT, 'conv-admit');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), [
      { type: 'session-header', version: 1, createdAt: 't', participants: [AGENT, 'user'], kind: 'user' },
      { role: 'context', source: 'memory-delta', content: '（记忆时间线 delta）\n记忆基线 seq=3', agent_id: AGENT, message_id: 'm1', timestamp: '2026-11-09T10:00:02.000Z', seq: 2 },
      { role: 'context', source: 'skill', content: '<system-reminder>技能正文</system-reminder>', agent_id: AGENT, message_id: 's1', timestamp: '2026-11-09T10:00:03.000Z', seq: 3 },
      { role: 'context', source: 'ac-demo:ui-only', content: '只进 UI', agent_id: AGENT, message_id: 'n1', timestamp: '2026-11-09T10:00:04.000Z', seq: 4 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const fold = foldSession(ROOT, 'conv-admit');
    const llm = foldLlmReplay(fold, AGENT, ROOT, 'conv-admit', undefined, { replayOf: (w) => (w === 'ac-demo:ui-only' ? 'none' : undefined) });
    // 裸文 context → 包裹;烘焙 → passthrough;none → 缺席(曾全量缺席,现在声明可控)
    expect(llm.some((m) => m.content.includes('记忆基线 seq=3') && m.content.startsWith('<system-reminder>'))).toBe(true);
    expect(llm.some((m) => m.content === '<system-reminder>技能正文</system-reminder>')).toBe(true);
    expect(llm.some((m) => m.content.includes('只进 UI'))).toBe(false);
  });
});

describe('渲染契约切片 A（cr-1109）', () => {
  it('bytes 投影派生:注入卡归口行与尾段直落行带 bytes = content.length', () => {
    seedV1();
    const view = foldViewRecords(foldSession(ROOT, UUID), ROOT, UUID);
    // 注入卡归口行(run 键归口)
    const card = view.find((r) => r.role === 'context' && r.content === '插一句');
    expect(card?.bytes).toBe('插一句'.length);
  });
});

describe('resume 收编（cr-1111 渲染契约切片 C）', () => {
  it('resume 生命周期行:none 档不进 LLM 回放(机制词集确定性生效),视图在场可刷新恢复', () => {
    const dir = sessionDir(ROOT, AGENT, 'conv-resume');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), [
      { type: 'session-header', version: 2, createdAt: 't', participants: [AGENT, 'user'], kind: 'user' },
      { type: 'message', role: 'agent', agent_id: 'user', content: '问', message_id: 'q', timestamp: '2026-11-09T10:00:00.000Z', seq: 1 },
      { type: 'context', role: 'context', source: 'resume', content: '上一轮被中断，已原地续跑', agent_id: AGENT, message_id: 'rz1', timestamp: '2026-11-09T10:00:01.000Z', seq: 2 },
      { type: 'message', role: 'agent', agent_id: AGENT, content: '答', message_id: 'a', requestId: 'a', run: 'run-r', timestamp: '2026-11-09T10:00:10.000Z', seq: 3 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const fold = foldSession(ROOT, 'conv-resume');
    const llm = foldLlmReplay(fold, AGENT, ROOT, 'conv-resume');
    expect(llm.some((m) => m.content.includes('已原地续跑'))).toBe(false); // none——从未进入过模型
    const view = foldViewRecords(fold, ROOT, 'conv-resume');
    const row = view.find((r) => r.source === 'resume');
    expect(row?.bytes).toBe('上一轮被中断，已原地续跑'.length); // 视图在场(label/bytes 数据面)——刷新可恢复
  });
});
