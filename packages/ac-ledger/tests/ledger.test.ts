// ============================================================
// ac-ledger 单测（M3.3 验收）：requestId 幂等 / 头行与 seq / journal /
// settlement / inbox durable / viewer 投影 / 壳死账本在
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LedgerWriter, sessionDir } from '../src/writer.ts';
import { readLedger, readJournal, readSubcalls, stepsOfRun, stepsOfLedger } from '../src/reader.ts';
import { foldStepsOf } from '../src/fold.ts';
import { readDomainFacts } from '../src/events-v2.ts';
import { assembleSessionView } from '../src/view.ts';

const ROOT = path.join('sandbox', 'test-ledger-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const uuid = '0192aaaa-bbbb-7ccc-8ddd-eeeeffff0001';

function mk(agentId: string): LedgerWriter {
  const dir = sessionDir(ROOT, agentId, uuid);
  return new LedgerWriter(dir, { participants: [agentId, 'user'], kind: 'user' });
}

describe('cr-974 v2 写面 → 读回恒等（service 全链：相位/结果/注入/收束）', () => {
  it('journalStep/tool 结果事件/inject/settleRun 产出的事件日志经 fold 读回与写入语义恒等', async () => {
    const { Context } = await import('@agentchat/cordis');
    const { makeLedgerRow } = await import('../src/service.ts');
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'v2rw' }));
    await fiber;
    try {
      const svc = ctx.ledger as unknown as {
        deliverRow(u: string, p: string[], k: string, row: Record<string, unknown>): Promise<boolean>;
        journalStep(u: string, run: string, step: unknown): Promise<void>;
        journalInject(u: string, run: string, content: string, requestId?: string): Promise<void>;
        settleRun(u: string, p: string[], k: string, row: Record<string, unknown>, runId: string, finish: string): Promise<void>;
        historyMessagesFor(u: string): Array<{ role: string; content: string; tool_calls?: unknown[] }>;
      };
      const uid = 'user~v2rw';
      await svc.deliverRow(uid, ['v2rw', 'user'], 'user', { role: 'agent', content: '任务', agent_id: 'user', requestId: 'q1', uuid: uid });
      await svc.journalStep(uid, 'run-1', {
        index: 0, stepId: 'run-1:0', text: '先想后查', reasoning: '思考', reasoningMs: 900,
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }], toolResults: [],
        usage: { prompt: 10, completion: 2 }, elapsedMs: 1500,
      });
      ctx.emit('tool/after-execute', { name: 'read', agentId: 'v2rw', conversationId: uid, runId: 'run-1', toolCallId: 'c1' }, { ok: true, output: '内容' }, undefined, 1234);
      await new Promise((r) => setTimeout(r, 50));
      await svc.journalInject(uid, 'run-1', '补充要求', 'steer-9');
      await svc.journalStep(uid, 'run-1', { index: 1, text: '终稿正文', toolCalls: [], toolResults: [] });
      await svc.settleRun(uid, ['v2rw', 'user'], 'user', {
        role: 'agent', content: '终稿正文', agent_id: 'v2rw', requestId: 'reply-1', uuid: uid, run: 'run-1', runMs: 3000,
      }, 'run-1', 'ok');
      // 单文件事件日志：journal/subcalls 零写入；头行 version:2
      const dir = sessionDir(ROOT, 'v2rw', uid);
      expect(readJournal(dir)).toHaveLength(0);
      expect(fs.existsSync(path.join(dir, 'subcalls.jsonl'))).toBe(false);
      expect(readLedger(dir).header).toMatchObject({ version: 2 });
      // LLM 回放（fold）：轨迹 + 注入按事件行序；末步与终稿同文让位
      expect(svc.historyMessagesFor(uid)).toEqual([
        { role: 'user', content: '任务' },
        { role: 'assistant', content: '先想后查', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ ok: true, output: '内容' }) },
        { role: 'user', content: '<system-reminder>补充要求</system-reminder>' }, // cr-1101 wrapper 回放包裹
        { role: 'assistant', content: '终稿正文' },
      ]);
      // webui 视图（fold）：终稿行带 steps（含 reasoning/usage/耗时/相位序）
      const view = assembleSessionView(ROOT, uid);
      const final = view.find((r) => r.run === 'run-1' && Array.isArray(r.steps));
      expect(final).toMatchObject({ role: 'assistant', runMs: 3000 });
      expect((final!.steps as unknown as Array<Record<string, unknown>>)[0]).toMatchObject({
        content: '先想后查', reasoning: '思考', reasoningMs: 900, elapsedMs: 1500,
        usage: { prompt: 10, completion: 2 },
      });
      const tc = ((final!.steps as Array<{ toolCalls?: Array<Record<string, unknown>> }>)[0]!.toolCalls)![0]!;
      expect(tc).toMatchObject({ id: 'c1', name: 'read', result: { ok: true, output: '内容' }, durationMs: 1234 });
      // user 终稿层（cr-973 投影——v2 message 行同构可读）
      const { projectUserReplay } = await import('../src/project.ts');
      expect(projectUserReplay(ROOT, uid).map((r) => r.content)).toEqual(['任务', '终稿正文']);
    } finally {
      await fiber.dispose();
    }
  });
});

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

describe('journal 面（v1 存量读——writer 已停写，读面经归一化消费）', () => {
  it('readJournal 解析 v1 存量 partials.jsonl（journal-step/inject 行按行序）', () => {
    const dir = sessionDir(ROOT, 'gamma', uuid);
    fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'journal', 'partials.jsonl'), [
      JSON.stringify({ type: 'journal-step', run: 'run1', step: 1, content: '想', reasoning: '…', seq: 1 }),
      JSON.stringify({ type: 'journal-inject', run: 'run1', content: '注入', requestId: 'r9', seq: 2 }),
      JSON.stringify({ type: 'journal-step', run: 'run1', step: 2, content: '答', seq: 3 }),
    ].join('\n') + '\n', 'utf-8');
    const j = readJournal(dir);
    expect(j.map((l) => l.type)).toEqual(['journal-step', 'journal-inject', 'journal-step']);
    expect(j[0]).toMatchObject({ run: 'run1', step: 1 });
  });

  // steps 投影（cr-587 history 带出）：journal 分列 toolCalls/toolResults →
  // 主线 steps[].toolCalls[].result 内联合并；无 settled 行 = partial。
  // cr-596：after-step 先于工具执行（步行 toolResults 恒空），结果以
  // journal-tool-result 补行到达——按 toolCallId 覆盖；已收束 run 无补行
  // 存量（结果从未落盘）合成空成功，不留「永恒运行中」假在途态。
  it('stepsOfRun：补行覆盖合并 / 存量合成 / settled 判 partial / 空步行 null / 注入行不入', () => {
    const dir = sessionDir(ROOT, 'gamma', uuid);
    fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'journal', 'partials.jsonl'), [
      { type: 'journal-step', run: 'runA', step: 1, content: '想', reasoning: '思考中', ts: 1,
        toolCalls: [
          { id: 'c1', name: 'read', arguments: '{"path":"a"}' },
          { id: 'c2', name: 'math', arguments: '{}' },
          { id: 'c4', name: 'pwsh', arguments: '{}' },
        ], seq: 1 },
      { type: 'journal-tool-result', run: 'runA', toolCallId: 'c2', result: { ok: false, error: '炸了' }, seq: 2 },
      { type: 'journal-tool-result', run: 'runA', toolCallId: 'run9#7', result: { ok: true, output: '子调用' }, seq: 3 },
      { type: 'journal-inject', run: 'runA', content: '插话', seq: 4 },
      { type: 'journal-step', run: 'runB', step: 1, content: '中断步', toolCalls: [{ id: 'c3', name: 'write', arguments: '{}' }], seq: 5 },
      { type: 'journal-settled', run: 'runA', finish: 'ok', seq: 6 },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
    const j = readJournal(dir);

    const a = stepsOfRun(j, 'runA')!;
    expect(a.partial).toBe(false);
    // 步级 ts 由 journal 行盖戳（cr-697）——比对剥 ts/seq 键（B2 起步行 seq 随步透传）
    const strip = (steps: Array<{ ts?: number; seq?: number }>): unknown[] => steps.map(({ ts: _ts, seq: _seq, ...s }) => { void _ts; void _seq; return s; });
    expect(strip(a.steps)).toEqual([{
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
    // 步级 ts 带出（cr-697：journal 行盖戳 → 物化/前端步级时间戳取源）
    expect(a.steps.every((s) => typeof s.ts === 'number')).toBe(true);
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
      // cr-974 v2：结果事件行内联 messages.jsonl（journal/subcalls 停写）
      const dir = sessionDir(ROOT, 'omega', uuid);
      const rows = readLedger(dir).rows as unknown as Array<Record<string, unknown>>;
      const sups = rows.filter((r) => r.type === 'step/tool-call-result');
      expect(sups).toHaveLength(3);
      expect(sups[0]).toMatchObject({ run: 'run-t', toolCallId: 'call_a', result: { ok: true, output: { command: 'echo' } } });
      expect(sups[1]).toMatchObject({ run: 'run-t', toolCallId: 'run-t#1', result: { ok: false, error: '路径不存在' } });
      expect(sups[2]).toMatchObject({ run: 'run-t', toolCallId: 'call_a#1', subcall: true, name: 'read', arguments: '{"path":"a.ts"}', result: { ok: true, output: { path: 'a.ts' } } });
      // 单文件事件日志：journal 零写入
      expect(readJournal(dir).some((l) => l.run === 'run-t')).toBe(false);
      // 读侧合并（fold）：结果事件覆盖进 steps 投影 + 子调用平铺宿主卡后
      const p = foldStepsOf(readDomainFacts(dir, 'omega').runs.get('run-t')!, [])!;
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


describe('cr-772 历史耗时落盘：journal-step 计时字段 + 终稿行 runMs', () => {
  it('journalStep 落 elapsedMs/usage/stepId → stepsOfRun 投影透传；settle 终稿行 runMs 带出', async () => {
    const { Context } = await import('@agentchat/cordis');
    const { makeLedgerRow } = await import('../src/service.ts');
    const root = path.join('sandbox', 'test-ledger-cr772-' + process.pid);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: root, agentId: 'dur' }));
    await fiber;
    try {
      const svc = ctx.ledger as unknown as {
        journalStep(uuid: string, run: string, step: unknown): Promise<void>;
        settleRun(uuid: string, participants: string[], kind: string, row: Record<string, unknown>, runId: string, finish: string): Promise<void>;
      };
      const uid = 'user~dur';
      await svc.journalStep(uid, 'run-d', {
        index: 0, stepId: 'run-d:0', text: '步文', reasoning: '思考',
        toolCalls: [], toolResults: [],
        reasoningMs: 1234, elapsedMs: 5678, usage: { prompt: 10, completion: 20 },
      });
      // fold 投影透传（在途读面）：速率段数据源 + 步身份键——步末计量挂
      // 步内末相位行（cr-974 v2），归一化还原
      const dir = sessionDir(root, 'dur', uid);
      const p = foldStepsOf(readDomainFacts(dir, 'dur').runs.get('run-d')!, [])!;
      expect(p.steps[0]).toMatchObject({ stepId: 'run-d:0', reasoningMs: 1234, elapsedMs: 5678, usage: { prompt: 10, completion: 20 } });
      await svc.settleRun(uid, ['dur', 'user'], 'user', {
        role: 'agent', content: '终稿', agent_id: 'dur', run: 'run-d', runMs: 4242,
      }, 'run-d', 'ok');
      // 终稿 message 行带 runMs（历史链栏「用时」段持久锚）
      const rows = readLedger(dir).rows;
      expect(rows.find((r) => r.run === 'run-d' && (r as unknown as Record<string, unknown>).type === 'message')).toMatchObject({ runMs: 4242 });
    } finally {
      await fiber.dispose();
    }
  });
});
describe('usage 自报 stepCache（cr-714：KV 走势步级粒度）', () => {
  it('after-run 采集步级缓存序列 → settleRun 信封透传 stepCache', async () => {
    const { Context } = await import('@agentchat/cordis');
    const { makeLedgerRow } = await import('../src/service.ts');
    const root = path.join('sandbox', 'test-ledger-stepcache-' + process.pid);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const ctx = new Context();
    const sent: Array<Record<string, unknown>> = [];
    // 邮局出站口打桩：截获 usage 事件信
    const fakePo = {
      listen: async () => {},
      send: async (env: Record<string, unknown>) => { sent.push(env); },
    };
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: root, agentId: 'sga', postOfficeAddress: 'unused' }));
    await fiber;
    try {
      const svc = ctx.ledger as unknown as {
        settleRun(uuid: string, participants: string[], kind: string, row: Record<string, unknown>, runId: string, finish: string): Promise<void>;
        // 测试口：替换邮局出站（构造期惰性连接，此处直接注入桩）
        usageOutbound: { send(env: Record<string, unknown>): Promise<unknown> } | null,
      };
      svc.usageOutbound = fakePo;
      ctx.emit('loop/after-run', { agent: 'sga', model: 'mock', conversationId: 'user~sga', runId: 'run-k1' } as never, {
        steps: [
          { text: '', toolCalls: [], toolResults: [], usage: { prompt: 100, completion: 1, cacheHit: 90, cacheMiss: 10 }, ts: 111 },
          { text: '', toolCalls: [], toolResults: [], usage: { prompt: 110, completion: 1, cacheHit: 80, cacheMiss: 20 }, ts: 222 },
          { text: '', toolCalls: [], toolResults: [] }, // 无计量步不入
        ],
        text: '', finish: 'stop',
        usage: { prompt: 210, completion: 2, promptAccumulated: 210, cacheHit: 170, cacheMiss: 30, steps: 2 },
      } as never);
      await svc.settleRun('user~sga', ['sga', 'user'], 'user', { role: 'agent', content: 'ok', agent_id: 'sga', requestId: 'reply-k1' }, 'run-k1', 'ok');
      await new Promise((res) => setTimeout(res, 50)); // reportUsage fire-and-forget
      expect(sent).toHaveLength(1);
      const payload = sent[0].payload as Record<string, unknown>;
      expect(payload.subject).toBe('usage-run');
      expect(payload.stepCache).toEqual([
        { ts: 111, hit: 90, miss: 10, prompt: 100 },
        { ts: 222, hit: 80, miss: 20, prompt: 110 },
      ]);
    } finally {
      await fiber.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // cr-760/761：after-step 即发步级缓存信（宿主 pending 实时段）——payload 带
  // 本步 prompt（真实上下文体积）；无缓存数据的步不发。
  it('after-step 步级缓存信即发（usage-step 信带 prompt）', async () => {
    const { Context } = await import('@agentchat/cordis');
    const { makeLedgerRow } = await import('../src/service.ts');
    const root = path.join('sandbox', 'test-ledger-step-live-' + process.pid);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const ctx = new Context();
    const sent: Array<Record<string, unknown>> = [];
    const fakePo = { send: async (env: Record<string, unknown>) => { sent.push(env); } };
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: root, agentId: 'live', postOfficeAddress: 'unused' }));
    await fiber;
    try {
      const svc = ctx.ledger as unknown as { usageOutbound: { send(env: Record<string, unknown>): Promise<unknown> } | null };
      svc.usageOutbound = fakePo;
      ctx.emit('loop/after-step', 'live',
        { text: '', toolCalls: [], toolResults: [], index: 0, usage: { prompt: 50_000, completion: 3, cacheHit: 900, cacheMiss: 100 }, ts: 777 } as never,
        { conversationId: 'user~live', runId: 'run-l1' } as never);
      ctx.emit('loop/after-step', 'live',
        { text: '', toolCalls: [], toolResults: [], index: 1 } as never, // 无计量步不发
        { conversationId: 'user~live', runId: 'run-l1' } as never);
      await new Promise((res) => setTimeout(res, 50));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        requestId: 'usage-step-run-l1-0',
        payload: { subject: 'usage-step', agent: 'live', conversationId: 'user~live', runId: 'run-l1', step: 0, ts: 777, hit: 900, miss: 100, prompt: 50_000 },
      });
    } finally {
      await fiber.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('读方配平（D-3——cr-628 孤儿收口已随 cr-974 退役）', () => {
  it('cr-974 D-3 读方配平：未闭合 run 不回写——无 run-end 落盘，fold 投影合成 interrupted（partial）；已收束 run 照常闭合', async () => {
    const { Context } = await import('@agentchat/cordis');
    const { makeLedgerRow } = await import('../src/service.ts');
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'orphan-1' }));
    await fiber;
    try {
      const svc = ctx.ledger as unknown as {
        journalStep(uuid: string, run: string, step: unknown): Promise<void>;
        settleMechanismFor(uuid: string, run: string, finish: string): Promise<void>;
      };
      await svc.journalStep(uuid, 'run-x', { index: 0, text: '死于中途', toolCalls: [], toolResults: [] });
      await svc.journalStep(uuid, 'run-y', { index: 0, text: '已收束', toolCalls: [], toolResults: [] });
      await svc.settleMechanismFor(uuid, 'run-y', 'ok');
      const dir = sessionDir(ROOT, 'orphan-1', uuid);
      const rows = readLedger(dir).rows as unknown as Array<Record<string, unknown>>;
      // 未闭合 run 零回写（append-only 不补写——配平是 fold 的职责）；
      // 已收束 run 有 run-end 标记行
      expect(rows.some((r) => r.type === 'run-end' && r.run === 'run-x')).toBe(false);
      expect(rows).toContainEqual(expect.objectContaining({ type: 'run-end', run: 'run-y', finish: 'completed' }));
      // journal 零写入（v2 单文件事件日志）
      expect(readJournal(dir)).toHaveLength(0);
      // fold 配平：run-x 未闭合 → partial（合成 interrupted）；run-y 闭合
      const facts = readDomainFacts(dir, 'orphan-1');
      const px = foldStepsOf(facts.runs.get('run-x')!, [])!;
      expect(px.partial).toBe(true);
      expect(px.steps[0]).toMatchObject({ content: '死于中途' });
      expect(foldStepsOf(facts.runs.get('run-y')!, [])!.partial).toBe(false);
    } finally {
      await fiber.dispose();
    }
  });
});

// cr-658：轨迹完整性读侧重建（取代 cr-640/653 写侧段行物化——已退役）。
// 「run 做过的推理是会话事实」裁决由 historyMessagesFor / trajectoryOfRun
// 承接：journal 步行重建为 assistant/tool 协议对，写侧不再降维成文本段行。
describe('轨迹读面（cr-658——fold 单源）', () => {
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

  it('cr-974 D-3：硬死 run 不回写——无终稿行轨迹不进 LLM 回放（run 键锚定），webui 盲区投影可见（partial）', async () => {
    const { Context } = await import('@agentchat/cordis');
    const { makeLedgerRow } = await import('../src/service.ts');
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'traj-4' }));
    await fiber;
    try {
      const svc = ctx.ledger as unknown as {
        journalStep(uuid2: string, run: string, step: unknown): Promise<void>;
        historyMessagesFor(uuid2: string): Array<{ role: string; content: string }>;
      };
      await svc.journalStep(uuid, 'run-z', { index: 0, text: '硬死前的推理', toolCalls: [], toolResults: [] });
      // cr-1101 回放契约：孤儿 run（settle 前硬死）轨迹进 historyMessagesFor
      //（once 绝不允许）；零回写不变式保持（不补 settled/run-end）
      expect(svc.historyMessagesFor(uuid).some((m) => m.content === '硬死前的推理')).toBe(true);
      const rows = readLedger(sessionDir(ROOT, 'traj-4', uuid)).rows as unknown as Array<Record<string, unknown>>;
      expect(rows.some((r) => r.type === 'run-end' && r.run === 'run-z')).toBe(false);
      // webui 盲区投影：未闭合 run 配平为 partial（读方配平——显示形态归读面）
      const blind = assembleSessionView(ROOT, uuid).find((r) => r.run === 'run-z');
      expect(blind).toMatchObject({ partial: true });
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
// cr-667（A1）：中断 run 原地续跑——resumeStateFor 准入（fold 归一事实）。
describe('续跑读面（cr-667）', () => {
  // cr-766（中止步保真）：aborted 步的部分聚合照常落盘/投影；续跑/轨迹
  // 读侧剔除其 tool_calls（调用从未执行——区别于崩溃窗口的 UNCOMMITTED
  // 合成），部分 content 如实保留（续跑携带面）。
  it('cr-974：续跑准入不再依赖 defer 仲裁——两未闭合 run 均不回写，resumeStateFor 以「无 run-end」各自准入', async () => {
    const { Context } = await import('@agentchat/cordis');
    const { makeLedgerRow } = await import('../src/service.ts');
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'resume-1' }));
    await fiber;
    try {
      const svc = ctx.ledger as unknown as {
        journalStep(uuid: string, run: string, step: unknown): Promise<void>;
        resumeStateFor(uuid: string, runId: string): unknown;
      };
      await svc.journalStep(uuid, 'run-keep', { index: 0, text: '在途续跑', toolCalls: [], toolResults: [] });
      await svc.journalStep(uuid, 'run-drop', { index: 0, text: '普通孤儿', toolCalls: [], toolResults: [] });
      const rows = readLedger(sessionDir(ROOT, 'resume-1', uuid)).rows as unknown as Array<Record<string, unknown>>;
      expect(rows.filter((r) => r.type === 'run-end')).toHaveLength(0); // 零收口
      // 续跑面准入：两 run 均可原地续跑（无 run-end 即准入——defer 仲裁退役）
      for (const run of ['run-keep', 'run-drop']) {
        const st = svc.resumeStateFor(uuid, run);
        expect(typeof st === 'object' && st !== null && 'committedSteps' in (st as Record<string, unknown>)).toBe(true);
      }
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
