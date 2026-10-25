// ============================================================
// ac-ledger 单测（M3.3 验收）：requestId 幂等 / 头行与 seq / journal /
// settlement / inbox durable / viewer 投影 / 壳死账本在
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LedgerWriter, sessionDir } from '../src/writer.ts';
import { readLedger, readJournal, replayView, stepsOfRun, orphanRunsOf, anchorableRuns, trajectoryOfRun, resumeContextOfRun, UNCOMMITTED_TOOL_ERROR } from '../src/reader.ts';

const ROOT = path.join('preview', 'sandbox', 'test-ledger-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const uuid = '0192aaaa-bbbb-7ccc-8ddd-eeeeffff0001';

function mk(agentId: string): LedgerWriter {
  const dir = sessionDir(ROOT, agentId, uuid);
  return new LedgerWriter(dir, { participants: [agentId, 'user'], kind: 'user' });
}

describe('落账面（A2 落账即确认）', () => {
  it('首建：头行（participants/kind）+ 首行落账 + seq 单调', async () => {
    const w = mk('alpha');
    expect(await w.deliver({
      role: 'agent', content: '你好', agent_id: 'user', requestId: 'r1', uuid,
    })).toBe(true);
    const { header, rows } = readLedger(sessionDir(ROOT, 'alpha', uuid));
    expect(header).toMatchObject({ type: 'session-header', participants: ['alpha', 'user'], kind: 'user' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content: '你好', agent_id: 'user', requestId: 'r1', seq: 1 });
    // seq 只给消息行（头行不进 seq 域——与现状 ac-session 同构）
  });

  it('requestId 幂等：同键重发短路（deduped 不重复写行）', async () => {
    const w = mk('beta');
    await w.deliver({ role: 'agent', content: '一次', agent_id: 'user', requestId: 'r1', uuid });
    expect(await w.deliver({ role: 'agent', content: '重复', agent_id: 'user', requestId: 'r1', uuid })).toBe(false);
    const { rows } = readLedger(sessionDir(ROOT, 'beta', uuid));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('一次');
  });
});

describe('journal 面', () => {
  it('步行/注入行落 partials.jsonl，行序 = 消息数组实际序', async () => {
    const w = mk('gamma');
    await w.journal({ type: 'journal-step', run: 'run1', step: 1, content: '想', reasoning: '…' });
    await w.journal({ type: 'journal-inject', run: 'run1', content: '注入', requestId: 'r9' });
    await w.journal({ type: 'journal-step', run: 'run1', step: 2, content: '答' });
    const j = readJournal(sessionDir(ROOT, 'gamma', uuid));
    expect(j.map((l) => l.type)).toEqual(['journal-step', 'journal-inject', 'journal-step']);
    expect(j[0]).toMatchObject({ run: 'run1', step: 1 });
  });

  // steps 投影（cr-587 history 带出）：journal 分列 toolCalls/toolResults →
  // 主线 steps[].toolCalls[].result 内联合并；无 settled 行 = partial。
  // cr-596：after-step 先于工具执行（步行 toolResults 恒空），结果以
  // journal-tool-result 补行到达——按 toolCallId 覆盖；已收束 run 无补行
  // 存量（结果从未落盘）合成空成功，不留「永恒运行中」假在途态。
  it('stepsOfRun：补行覆盖合并 / 存量合成 / settled 判 partial / 空步行 null / 注入行不入', async () => {
    const w = mk('gamma');
    await w.journal({
      type: 'journal-step', run: 'runA', step: 1, content: '想', reasoning: '思考中',
      toolCalls: [
        { id: 'c1', name: 'read', arguments: '{"path":"a"}' },
        { id: 'c2', name: 'math', arguments: '{}' },
        { id: 'c4', name: 'pwsh', arguments: '{}' },
      ],
    });
    await w.journal({ type: 'journal-tool-result', run: 'runA', toolCallId: 'c2', result: { ok: false, error: '炸了' } });
    await w.journal({ type: 'journal-tool-result', run: 'runA', toolCallId: 'run9#7', result: { ok: true, output: '子调用' } });
    await w.journal({ type: 'journal-inject', run: 'runA', content: '插话' });
    await w.journal({ type: 'journal-step', run: 'runB', step: 1, content: '中断步', toolCalls: [{ id: 'c3', name: 'write', arguments: '{}' }] });
    await w.journal({ type: 'journal-settled', run: 'runA', finish: 'ok' });
    const j = readJournal(sessionDir(ROOT, 'gamma', uuid));

    const a = stepsOfRun(j, 'runA')!;
    expect(a.partial).toBe(false);
    expect(a.steps).toEqual([{
      content: '想',
      reasoning: '思考中',
      toolCalls: [
        // 存量步行无补行也无 toolResults（settled）→ 合成空成功
        { id: 'c1', name: 'read', arguments: '{"path":"a"}', result: { ok: true } },
        // 补行按 toolCallId 覆盖（子调用 <run>#<seq> 形同路）
        { id: 'c2', name: 'math', arguments: '{}', result: { ok: false, error: '炸了' } },
        // 无人认领的补行 toolCallId 不进步（run_code 子调用另有宿主卡承接）
        { id: 'c4', name: 'pwsh', arguments: '{}', result: { ok: true } },
      ],
    }]); // 注入行不进步（steps = 模型步序）

    const b = stepsOfRun(j, 'runB')!;
    expect(b.partial).toBe(true); // 无 settled 行 = 中断/未收束
    expect(b.steps[0]!.toolCalls).toEqual([{ id: 'c3', name: 'write', arguments: '{}', result: null }]); // 未收束 = 真在途（null）

    expect(stepsOfRun(j, 'run-不存在')).toBeNull();
    expect(stepsOfRun([], 'runA')).toBeNull();
  });

  it('cr-596 接线：tool/after-execute → journal-tool-result 补行落盘（含 run_code 子调用 id 形）', async () => {
    const { Context } = await import('@agentchat/cordis');
    const { makeLedgerRow } = await import('../src/service.ts');
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'omega' }));
    await fiber;
    try {
      // 模拟 loop 时序：after-step 步行先落（结果未到）→ 工具执行 → 补行
      await (ctx.ledger as unknown as { journalStep(uuid: string, run: string, step: unknown): Promise<void> })
        .journalStep(uuid, 'run-t', { index: 0, text: '想', toolCalls: [{ id: 'call_a', name: 'pwsh', arguments: '{}' }, { id: 'run-t#1', name: 'run_code', arguments: '{}' }], toolResults: [] });
      ctx.emit('tool/after-execute', { name: 'pwsh', agentId: 'omega', conversationId: uuid, runId: 'run-t', toolCallId: 'call_a' }, { ok: true, output: { command: 'echo' } });
      await new Promise((r) => setTimeout(r, 50)); // fire-and-forget 落盘
      ctx.emit('tool/after-execute', { name: 'read', agentId: 'omega', conversationId: uuid, runId: 'run-t', toolCallId: 'run-t#1' }, { ok: false, error: '路径不存在' });
      await new Promise((r) => setTimeout(r, 50));
      // 子调用档案（cr-597）：runCodeSubcall 携带名/参，读侧注入宿主卡后平铺
      ctx.emit('tool/after-execute', { name: 'read', args: { path: 'a.ts' }, runCodeSubcall: true, agentId: 'omega', conversationId: uuid, runId: 'run-t', toolCallId: 'call_a#1' }, { ok: true, output: { path: 'a.ts' } });
      await new Promise((r) => setTimeout(r, 50));
      // 身份缺席（宿主直调无 runId）不落
      ctx.emit('tool/after-execute', { name: 'read', agentId: 'omega', conversationId: uuid, toolCallId: 'call_x' }, { ok: true });
      await new Promise((r) => setTimeout(r, 50));
      const j = readJournal(sessionDir(ROOT, 'omega', uuid));
      const sups = j.filter((l) => l.type === 'journal-tool-result');
      expect(sups).toHaveLength(3);
      expect(sups[0]).toMatchObject({ run: 'run-t', toolCallId: 'call_a', result: { ok: true, output: { command: 'echo' } } });
      expect(sups[1]).toMatchObject({ run: 'run-t', toolCallId: 'run-t#1', result: { ok: false, error: '路径不存在' } });
      expect(sups[2]).toMatchObject({ run: 'run-t', toolCallId: 'call_a#1', subcall: true, name: 'read', arguments: '{"path":"a.ts"}', result: { ok: true, output: { path: 'a.ts' } } });
      // 读侧合并：补行覆盖进 steps 投影 + 子调用平铺宿主卡后
      const p = stepsOfRun(j, 'run-t')!;
      expect(p.steps[0]!.toolCalls).toEqual([
        { id: 'call_a', name: 'pwsh', arguments: '{}', result: { ok: true, output: { command: 'echo' } } },
        { id: 'call_a#1', name: 'read', arguments: '{"path":"a.ts"}', result: { ok: true, output: { path: 'a.ts' } }, subcall: true },
        { id: 'run-t#1', name: 'run_code', arguments: '{}', result: { ok: false, error: '路径不存在' } },
      ]);
    } finally {
      await fiber.dispose();
    }
  });
});

describe('孤儿 run 收口 + 孤儿扫描（cr-628）', () => {
  it('anchorableRuns（cr-631/632 链接制）：已锚出局；消息 run 判别（run-<requestId> 有入站行）入选；机制 run / 无步行不算', () => {
    const lines = [
      { type: 'journal-step', run: 'run-send-1', step: 1, content: 'a', seq: 1 }, // 消息 run，已锚
      { type: 'journal-step', run: 'run-send-2', step: 1, content: 'b', seq: 2 }, // 消息 run，未锚 → 入选
      { type: 'journal-step', run: 'review-x', step: 1, content: 'c', seq: 3 }, // 机制 run 词形 → 排除
      { type: 'journal-tool-result', run: 'run-send-3', toolCallId: 'c1', result: { ok: true }, seq: 4 }, // 无步行
    ] as never[];
    const viewer = [
      { role: 'agent', content: '', agent_id: 'x', source: 'run:run-send-1', uuid: 'u', message_id: 'm1', timestamp: 't', seq: 1 },
    ] as never[];
    const ledgerRows = [
      { role: 'agent', content: '问1', agent_id: 'user', requestId: 'send-1', uuid: 'u', message_id: 'm2', timestamp: 't', seq: 2 },
      { role: 'agent', content: '问2', agent_id: 'user', requestId: 'send-2', uuid: 'u', message_id: 'm3', timestamp: 't', seq: 3 },
    ] as never[];
    expect(anchorableRuns(lines, viewer, ledgerRows)).toEqual(['run-send-2']);
  });

  it('orphanRunsOf：有步行/注入无 settled 的 run 报孤儿；settled / 仅补行不算', () => {
    const lines = [
      { type: 'journal-step', run: 'runA', step: 1, content: 'a', seq: 1 },
      { type: 'journal-settled', run: 'runB', finish: 'ok', seq: 2 },
      { type: 'journal-step', run: 'runB', step: 1, content: 'b', seq: 3 },
      { type: 'journal-inject', run: 'runC', content: '插', seq: 4 },
      { type: 'journal-tool-result', run: 'runD', toolCallId: 'c1', result: { ok: true }, seq: 5 },
    ] as never[];
    expect(orphanRunsOf(lines)).toEqual(['runA', 'runC']); // runD 仅补行不算（无步行锚）
  });

  it('recoverOrphanRuns：补 journal-settled(interrupted)；已收束 run 不动；幂等', async () => {
    const { Context } = await import('@agentchat/cordis');
    const { makeLedgerRow } = await import('../src/service.ts');
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'orphan-1' }));
    await fiber;
    try {
      const svc = ctx.ledger as unknown as {
        journalStep(uuid: string, run: string, step: unknown): Promise<void>;
        settleMechanismFor(uuid: string, run: string, finish: string): Promise<void>;
        recoverOrphanRuns(): Promise<number>;
      };
      await svc.journalStep(uuid, 'run-x', { index: 0, text: '死于中途', toolCalls: [], toolResults: [] });
      await svc.journalStep(uuid, 'run-y', { index: 0, text: '已收束', toolCalls: [], toolResults: [] });
      await svc.settleMechanismFor(uuid, 'run-y', 'ok');
      expect(await svc.recoverOrphanRuns()).toBe(1);
      const j = readJournal(sessionDir(ROOT, 'orphan-1', uuid));
      expect(j).toContainEqual(expect.objectContaining({ type: 'journal-settled', run: 'run-x', finish: 'interrupted' }));
      // 幂等：二扫零收口
      expect(await svc.recoverOrphanRuns()).toBe(0);
      // stepsOfRun 不再报在途
      expect(stepsOfRun(j, 'run-x')!.partial).toBe(false);
    } finally {
      await fiber.dispose();
    }
  });
});

describe('settlement 两阶段', () => {
  it('收束：终稿行进 messages + journal-settled 标记（finish 词）', async () => {
    const w = mk('delta');
    await w.journal({ type: 'journal-step', run: 'run1', step: 1, content: '步' });
    await w.settle(
      { role: 'agent', content: '终稿回复', agent_id: 'delta', uuid },
      'run1', 'ok',
    );
    const { rows } = readLedger(sessionDir(ROOT, 'delta', uuid));
    expect(rows.at(-1)).toMatchObject({ content: '终稿回复', agent_id: 'delta' });
    const j = readJournal(sessionDir(ROOT, 'delta', uuid));
    expect(j.at(-1)).toMatchObject({ type: 'journal-settled', run: 'run1', finish: 'ok' });
  });
});

// cr-658：轨迹完整性读侧重建（取代 cr-640/653 写侧段行物化——已退役）。
// 「run 做过的推理是会话事实」裁决由 historyMessagesFor / trajectoryOfRun
// 承接：journal 步行重建为 assistant/tool 协议对，写侧不再降维成文本段行。
describe('轨迹读面（cr-658）', () => {
  it('trajectoryOfRun：步行 → assistant{tool_calls} + tool 协议对；注入行 → user', () => {
    const lines = [
      { type: 'journal-step', run: 'run1', step: 0, content: '先看文件', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"p":"a.md"}' }], seq: 1 },
      { type: 'journal-tool-result', run: 'run1', toolCallId: 'c1', result: { ok: true, output: '内容' }, seq: 2 },
      { type: 'journal-inject', run: 'run1', content: '补充要求', seq: 3 },
      { type: 'journal-step', run: 'run1', step: 1, content: '结论', seq: 4 },
      { type: 'journal-settled', run: 'run1', finish: 'ok', seq: 5 },
    ];
    const out = trajectoryOfRun(lines as never[], 'run1');
    expect(out).toEqual([
      { role: 'assistant', content: '先看文件', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":"a.md"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ ok: true, output: '内容' }) },
      { role: 'user', content: '补充要求' },
      { role: 'assistant', content: '结论' },
    ]);
  });

  it('trajectoryOfRun：未提交步剔除（无结果且未收束）；收束后存量缺结果合成空成功；子调用补行不产生消息', () => {
    const uncommitted = [
      { type: 'journal-step', run: 'run2', step: 0, content: '', toolCalls: [{ id: 'c1', name: 'pwsh', arguments: '{}' }], seq: 1 },
    ];
    expect(trajectoryOfRun(uncommitted as never[], 'run2')).toEqual([]); // 无结果未收束 = 整步剔除
    const settledLegacy = [
      { type: 'journal-step', run: 'run3', step: 0, content: '', toolCalls: [{ id: 'c1', name: 'pwsh', arguments: '{}' }], seq: 1 },
      { type: 'journal-settled', run: 'run3', finish: 'interrupted', seq: 2 },
    ];
    expect(trajectoryOfRun(settledLegacy as never[], 'run3')).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'pwsh', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ ok: true }) },
    ]);
    const subcall = [
      { type: 'journal-step', run: 'run4', step: 0, content: '跑程序', toolCalls: [{ id: 'h1', name: 'run_code', arguments: '{}' }], seq: 1 },
      { type: 'journal-tool-result', run: 'run4', toolCallId: 'h1', result: { ok: true }, seq: 2 },
      { type: 'journal-tool-result', run: 'run4', toolCallId: 'h1#1', result: { ok: true }, subcall: true, name: 'read', arguments: '{}', seq: 3 },
    ];
    expect(trajectoryOfRun(subcall as never[], 'run4')).toHaveLength(2); // 宿主对 + 无子调用独立消息
  });

  it('写侧不再物化段行（cr-640/653 退役）：空终稿收束只落空终稿锚行，轨迹归读面', async () => {
    const w = mk('traj-2');
    await w.deliver({ role: 'agent', content: '问', agent_id: 'user', requestId: 'q1', uuid });
    await w.journal({ type: 'journal-step', run: 'run-q1', step: 0, content: '第一步推理' });
    await w.settle(
      { role: 'agent', content: '', agent_id: 'traj-2', requestId: 'reply-q1', uuid, run: 'run-q1' },
      'run-q1', 'interrupted',
    );
    const { rows } = readLedger(sessionDir(ROOT, 'traj-2', uuid));
    expect(rows.map((r) => [r.content, r.agent_id])).toEqual([
      ['问', 'user'],
      ['', 'traj-2'], // 空终稿锚行（run 键联查锚）——不再有段行
    ]);
  });

  it('historyMessagesFor：正常终稿 run 也带轨迹（终稿行前置步行）；存量 seg- 段行过滤防双计', async () => {
    const { Context } = await import('@agentchat/cordis');
    const { makeLedgerRow } = await import('../src/service.ts');
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'traj-3' }));
    await fiber;
    try {
      const svc = ctx.ledger as unknown as {
        deliverRow(uuid2: string, participants: string[], kind: string, row: Record<string, unknown>): Promise<boolean>;
        journalStep(uuid2: string, run: string, step: unknown): Promise<void>;
        settleRun(uuid2: string, participants: string[], kind: string, row: Record<string, unknown>, runId: string, finish: string): Promise<void>;
        historyMessagesFor(uuid2: string): Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }>;
      };
      await svc.deliverRow(uuid, ['traj-3', 'user'], 'user', { role: 'agent', content: '任务', agent_id: 'user', requestId: 'q1', uuid });
      await svc.journalStep(uuid, 'run-q1', { index: 0, text: '先读文档', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }], toolResults: [] });
      // 自然停点末步 = 终稿同文（loop 真实形态）——去重让位终稿行
      await svc.journalStep(uuid, 'run-q1', { index: 1, text: '终稿', toolCalls: [], toolResults: [] });
      // 手写一条存量 seg- 段行（cr-640/653 时代产物）——必须被过滤
      fs.appendFileSync(path.join(sessionDir(ROOT, 'traj-3', uuid), 'messages.jsonl'), JSON.stringify({
        role: 'agent', content: '先读文档', message_id: 'seg-run-q1-1', timestamp: 'T', agent_id: 'traj-3', uuid, run: 'run-q1', seq: 99,
      }) + '\n');
      await svc.settleRun(uuid, ['traj-3', 'user'], 'user', { role: 'agent', content: '终稿', agent_id: 'traj-3', requestId: 'reply-q1', uuid, run: 'run-q1' }, 'run-q1', 'ok');
      const out = svc.historyMessagesFor(uuid);
      expect(out).toEqual([
        { role: 'user', content: '任务' },
        { role: 'assistant', content: '先读文档', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ ok: true }) },
        { role: 'assistant', content: '终稿' },
      ]);
    } finally {
      await fiber.dispose();
    }
  });

  it('recoverOrphanRuns（孤儿收口）：只补 settled，轨迹经读面可见；二扫零重复', async () => {
    const { Context } = await import('@agentchat/cordis');
    const { makeLedgerRow } = await import('../src/service.ts');
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'traj-4' }));
    await fiber;
    try {
      const svc = ctx.ledger as unknown as {
        journalStep(uuid2: string, run: string, step: unknown): Promise<void>;
        recoverOrphanRuns(): Promise<number>;
        historyMessagesFor(uuid2: string): Array<{ role: string; content: string }>;
      };
      await svc.journalStep(uuid, 'run-z', { index: 0, text: '硬死前的推理', toolCalls: [], toolResults: [] });
      expect(await svc.recoverOrphanRuns()).toBe(1);
      // 孤儿 run 无终稿行 = 轨迹不进 historyMessagesFor（无 run 键行锚）——
      // 上下文可见性归 run 键锚定面（cr-631 补投）；收口幂等 + settled 落盘
      expect(await svc.recoverOrphanRuns()).toBe(0);
      const j = readJournal(sessionDir(ROOT, 'traj-4', uuid));
      expect(j).toContainEqual(expect.objectContaining({ type: 'journal-settled', run: 'run-z', finish: 'interrupted' }));
    } finally {
      await fiber.dispose();
    }
  });
});

describe('inbox durable', () => {
  it('store/list/clear：投递未消费消息落盘，消费后清', async () => {
    const w = mk('epsilon');
    await w.inboxStore({ requestId: 'r1', payload: { text: 'hi' } });
    await w.inboxStore({ requestId: 'r2', payload: { text: 'yo' } });
    expect(w.inboxList().map((e) => e.requestId).sort()).toEqual(['r1', 'r2']);
    w.inboxClear('r1');
    expect(w.inboxList()).toEqual([{ requestId: 'r2' }]);
    const raw = JSON.parse(fs.readFileSync(
      path.join(sessionDir(ROOT, 'epsilon', uuid), 'inbox', 'r2.json'), 'utf-8'));
    expect(raw).toEqual({ requestId: 'r2', payload: { text: 'yo' } });
  });
});

describe('viewer 投影（行协议内建）', () => {
  it('同账本两侧视角：viewer=alpha 时 alpha 行为 assistant；viewer=user 反转', () => {
    const rows = [
      { role: 'agent' as const, content: '早', message_id: 'm1', timestamp: 'T', agent_id: 'user' },
      { role: 'agent' as const, content: '早！', message_id: 'm2', timestamp: 'T', agent_id: 'alpha' },
    ];
    expect(replayView(rows, 'alpha')).toEqual([
      { role: 'user', content: '早' },
      { role: 'assistant', content: '早！' },
    ]);
    expect(replayView(rows, 'user')).toEqual([
      { role: 'assistant', content: '早' },
      { role: 'user', content: '早！' },
    ]);
  });
});

describe('壳死账本在（A5）', () => {
  it('writer 丢弃后账本文件完好可读', async () => {
    {
      const w = mk('zeta');
      await w.deliver({ role: 'agent', content: '持久', agent_id: 'user', requestId: 'r1', uuid });
    }
    const { rows } = readLedger(sessionDir(ROOT, 'zeta', uuid));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('持久');
  });
});
// cr-667（A1）：中断 run 原地续跑读面——resumeContextOfRun 纯函数 +
// recoverOrphanRuns defer + pendingInboxRequestIds + resumeStateFor 准入。
describe('续跑读面（cr-667）', () => {
  it('resumeContextOfRun：已提交步原样；未提交调用合成「结果未知」tool 消息；注入行入序；无步行 → null', () => {
    const lines = [
      { type: 'journal-step', run: 'runR', step: 0, content: '先看文件', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }], seq: 1 },
      { type: 'journal-tool-result', run: 'runR', toolCallId: 'c1', result: { ok: true, output: '内容' }, seq: 2 },
      { type: 'journal-inject', run: 'runR', content: '补充要求', seq: 3 },
      { type: 'journal-step', run: 'runR', step: 1, content: '建目录', toolCalls: [{ id: 'c2', name: 'pwsh', arguments: '{}' }], seq: 4 },
      // c2 无结果补行——崩溃窗口（工具执行中壳死）
    ];
    const out = resumeContextOfRun(lines as never[], 'runR')!;
    expect(out.messages).toEqual([
      { role: 'assistant', content: '先看文件', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ ok: true, output: '内容' }) },
      { role: 'user', content: '补充要求' },
      { role: 'assistant', content: '建目录', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'pwsh', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c2', content: JSON.stringify({ ok: false, error: UNCOMMITTED_TOOL_ERROR }) },
    ]);
    expect(out.committedSteps).toBe(1); // 步 0 全提交；步 1 未提交不计
    expect(resumeContextOfRun(lines as never[], 'run-无涉')).toBeNull();
  });

  it('recoverOrphanRuns(defer)：defer 命中 run 不补 settled（留给续跑面）；未命中照旧', async () => {
    const { Context } = await import('@agentchat/cordis');
    const { makeLedgerRow } = await import('../src/service.ts');
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'resume-1' }));
    await fiber;
    try {
      const svc = ctx.ledger as unknown as {
        journalStep(uuid: string, run: string, step: unknown): Promise<void>;
        recoverOrphanRuns(defer?: Set<string>): Promise<number>;
      };
      await svc.journalStep(uuid, 'run-keep', { index: 0, text: '在途续跑', toolCalls: [], toolResults: [] });
      await svc.journalStep(uuid, 'run-drop', { index: 0, text: '普通孤儿', toolCalls: [], toolResults: [] });
      expect(await svc.recoverOrphanRuns(new Set(['keep']))).toBe(1); // 只收口 run-drop
      const j = readJournal(sessionDir(ROOT, 'resume-1', uuid));
      expect(j).toContainEqual(expect.objectContaining({ type: 'journal-settled', run: 'run-drop', finish: 'interrupted' }));
      expect(j).not.toContainEqual(expect.objectContaining({ run: 'run-keep', type: 'journal-settled' }));
    } finally {
      await fiber.dispose();
    }
  });

  it('pendingInboxRequestIds + resumeStateFor 准入：有步行无 settled → 前缀；settled/无步行 → null', async () => {
    const { Context } = await import('@agentchat/cordis');
    const { makeLedgerRow } = await import('../src/service.ts');
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'resume-2' }));
    await fiber;
    try {
      const svc = ctx.ledger as unknown as {
        journalStep(uuid: string, run: string, step: unknown): Promise<void>;
        settleMechanismFor(uuid: string, run: string, finish: string): Promise<void>;
        inboxStore(uuid: string, env: unknown): void;
        resumeStateFor(uuid: string, runId: string): unknown;
        pendingInboxRequestIds(): Set<string>;
      };
      await svc.journalStep(uuid, 'run-a1', { index: 0, text: '中途', toolCalls: [], toolResults: [] });
      await svc.journalStep(uuid, 'run-a2', { index: 0, text: '收束', toolCalls: [], toolResults: [] });
      await svc.settleMechanismFor(uuid, 'run-a2', 'ok');
      svc.inboxStore(uuid, { requestId: 'a1', sender: 'user' });
      svc.inboxStore(uuid, { requestId: 'zz', sender: 'user' });
      expect([...svc.pendingInboxRequestIds()].sort()).toEqual(['a1', 'zz']);
      const st = svc.resumeStateFor(uuid, 'run-a1');
      expect(typeof st === 'object' && st !== null && 'committedSteps' in (st as Record<string, unknown>)).toBe(true);
      expect(svc.resumeStateFor(uuid, 'run-a2')).toBeNull(); // 已 settled
      expect(svc.resumeStateFor(uuid, 'run-无涉')).toBeNull(); // 无步行
    } finally {
      await fiber.dispose();
    }
  });
});
