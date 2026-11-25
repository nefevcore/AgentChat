// ============================================================
// cr946-projection.test.ts —— 会话投影顺序三修（cr-946）读写面回归锁
//
// ① textBeforeTools 落盘链路：LoopStepRecord → journalStep → journal-step
//    → projectStep/segmentizeRun → settle 物化段行（cr-804 曾修、后被重构
//    整体回退：账本层零引用 → 所有历史步只剩「工具在前、正文在后」）。
// ② 机制通知行读面投影：壳自身合成的催办信（重启「已重启」）按机制行
//    （context+event、无 run 锚）投为事件分隔符；存量「按入站 user 行落账」
//    形态同样按机制行投影（账本 append-only，不改写历史）。
// ③ agent 域账本 seq：两个 writer 实例交替写同一文件 → seq 严格单调不重号
//    （cr-973 起 viewer 账本退役——多写者形态回归锁平移到 agent 域文件，
//    种子行改为 agent 域 LedgerWriter 直落并带显式递增时间戳）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assembleSessionView } from '../src/view.ts';
import { readJournal, readLedger, stepsOfRun } from '../src/index.ts';
import { LedgerWriter, sessionDir } from '../src/writer.ts';

const ROOT = path.join('sandbox', 'test-ledger-cr946-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('cr-946 ① 相位序落盘链路（cr-974 v2：textBeforeTools 字段退役——相位序由事件行序承载）', () => {
  it('journalStep 按相位序落 step/* 行（reasoning 先行、正文先于调用）→ fold 投影推导 textBeforeTools；settle run-end 后读面仍带标记', async () => {
    const { Context } = await import('@agentchat/cordis');
    const { makeLedgerRow } = await import('../src/service.ts');
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'alpha' }));
    await fiber;
    try {
      const svc = ctx.ledger as unknown as {
        journalStep(uuid: string, run: string, step: unknown): Promise<void>;
        settleRun(uuid: string, participants: string[], kind: string, row: Record<string, unknown>, runId: string, finish: string): Promise<void>;
      };
      const uid = 'alpha~user';
      await svc.journalStep(uid, 'run-p', {
        index: 0,
        stepId: 'run-p:0',
        text: '先口述再调工具：',
        textBeforeTools: true,
        reasoning: '想',
        reasoningMs: 13000,
        toolCalls: [{ id: 'c1', name: 'run_code', arguments: '{}' }],
        toolResults: [],
      });
      const dir = sessionDir(ROOT, 'alpha', uid);
      // 相位行序 = 步内序（reasoning → content → tool-call；行内无
      // textBeforeTools——该字段退役，序即语义）
      const rows = readLedger(dir).rows as unknown as Array<Record<string, unknown>>;
      const phases = rows.filter((r) => typeof r.type === 'string' && String(r.type).startsWith('step/'));
      expect(phases.map((r) => r.type)).toEqual(['step/reasoning', 'step/content', 'step/tool-call']);
      expect(phases.every((r) => !('textBeforeTools' in r))).toBe(true);
      // settle = message 行 + run-end（无物化段行）；读面组装（fold）仍带标记
      await svc.settleRun(uid, ['alpha', 'user'], 'user', {
        role: 'agent', content: '终稿', agent_id: 'alpha', requestId: 'reply-p', uuid: uid, run: 'run-p',
      }, 'run-p', 'ok');
      expect(readLedger(dir).rows.some((r) => r.source === 'segment')).toBe(false);
      const view = assembleSessionView(ROOT, uid).find((r) => Array.isArray(r.steps));
      expect((view!.steps as Array<{ textBeforeTools?: boolean }>)[0]!.textBeforeTools).toBe(true);
    } finally {
      await fiber.dispose();
    }
  });
});

describe('cr-946 ② 机制通知行读面投影（事件分隔符 + 轮边界）', () => {
  /** 种一段存量对话：用户问 + 两段 run 终稿（agent 域行，显式递增时间戳——投影按 ts 排序） */
  async function seedRuns(conv: string): Promise<void> {
    const w = new LedgerWriter(sessionDir(ROOT, 'alpha', conv), { participants: ['alpha', 'user'], kind: 'user' });
    await w.deliver({ role: 'agent', content: '问', agent_id: 'user', requestId: 'q-1', uuid: conv, timestamp: '2026-11-09T10:00:00.000Z' });
    await w.deliver({ role: 'agent', content: '前一段终稿', agent_id: 'alpha', requestId: 'rq-a', uuid: conv, run: 'run-a', timestamp: '2026-11-09T10:00:01.000Z' });
    await w.deliver({ role: 'agent', content: '后一段终稿', agent_id: 'alpha', requestId: 'rq-b', uuid: conv, run: 'run-b', timestamp: '2026-11-09T10:00:02.000Z' });
  }

  it('新写面（context+event、无 run）：投为 event 行，正文/时间/锚点透传', async () => {
    const conv = 'mech-new';
    await seedRuns(conv);
    const w = new LedgerWriter(sessionDir(ROOT, 'alpha', conv), { participants: ['alpha', 'user'], kind: 'user' });
    await w.deliver({
      role: 'context', source: 'event',
      content: '壳已重启完成（restart_shell 已兑现）：行集与运行时状态已重载。',
      agent_id: 'alpha', requestId: 'restarted-n1', uuid: conv,
    });
    const out = assembleSessionView(ROOT, conv);
    const ev = out.find((r) => r.role === 'event');
    expect(ev).toMatchObject({
      content: '壳已重启完成（restart_shell 已兑现）：行集与运行时状态已重载。',
      agent_id: 'alpha',
      source: 'event',
      message_id: 'restarted-n1',
    });
    expect(typeof ev!.timestamp).toBe('string');
  });

  it('cr-1309：legacy speech 落形经归一工具换写后与现行形态同投（迁移判据）', async () => {
    // 归一工具产物词形（normalize-restarted-rows.mjs）与「新写面」用例同一投影路径
    const conv = 'mech-legacy';
    await seedRuns(conv);
    const w = new LedgerWriter(sessionDir(ROOT, 'alpha', conv), { participants: ['alpha', 'user'], kind: 'user' });
    await w.deliver({
      role: 'context', source: 'event',
      content: '壳已重启完成（归一后形态）',
      agent_id: 'alpha', requestId: 'restarted-legacy-1', uuid: conv,
    });
    const out = assembleSessionView(ROOT, conv);
    const ev = out.find((r) => r.role === 'event');
    expect(ev).toMatchObject({ content: '壳已重启完成（归一后形态）', source: 'event', agent_id: 'alpha' });
  });

  it('负例：普通用户发言/agent 终稿不会被误投为事件行', async () => {
    const conv = 'mech-neg';
    await seedRuns(conv);
    const out = assembleSessionView(ROOT, conv);
    expect(out.some((r) => r.role === 'event')).toBe(false);
  });
});

describe('cr-946 ③ agent 域账本 seq 跨实例单调', () => {
  // cr-973 起 viewer 账本退役、每目录恒单写者（cr-946 的 per-write 尾行
  // 对账形态随之退役）——多写者保护回归锁平移为：跨 writer 实例（每 run
  // 新实例的真实形态）交替落行，seq 经首分配前尾行扫描续接，单调不回退。
  it('逐次新实例交替写同一 agent 域文件 → seq 无重号且严格递增', async () => {
    const conv = 'seq-1';
    const fresh = () => new LedgerWriter(sessionDir(ROOT, 'alpha', conv), { participants: ['alpha', 'user'], kind: 'user' });
    await fresh().deliver({ role: 'agent', content: 'a1', agent_id: 'user', requestId: 'r1', uuid: conv, timestamp: '2026-11-09T10:00:00.000Z' });
    await fresh().deliver({ role: 'agent', content: 'b1', agent_id: 'alpha', requestId: 'r2', uuid: conv, run: 'run-1', timestamp: '2026-11-09T10:00:01.000Z' });
    await fresh().deliver({ role: 'agent', content: 'a2', agent_id: 'user', requestId: 'r3', uuid: conv, timestamp: '2026-11-09T10:00:02.000Z' });
    await fresh().deliver({ role: 'agent', content: 'b2', agent_id: 'alpha', requestId: 'r4', uuid: conv, run: 'run-2', timestamp: '2026-11-09T10:00:03.000Z' });
    const rows = readLedger(sessionDir(ROOT, 'alpha', conv)).rows;
    const seqs = rows.map((r) => r.seq!);
    expect(seqs).toHaveLength(4);
    expect(new Set(seqs).size).toBe(4); // 无重号
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs); // 严格递增
  });
});
