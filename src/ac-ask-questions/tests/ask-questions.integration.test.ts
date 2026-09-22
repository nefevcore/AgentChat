// ============================================================
// ac-ask-questions：ask_questions 工具（发起体 + loop/run-idle 挂起等待）
// + late-reply 唤醒（run 死后纯 context 行回投）
//
// 2026-02 挂起重构：execute 即返 awaiting 标记；等待语义 =
//   · loop/run-idle 监听器（同 run 续走——本文件 mock loop 不真跑，
//     经「工具层登记 + 事件对账」间接断言）
//   · late-reply（run 死后 deliver 回投——登记表缺席判定）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as diRow from 'ac-durable-interaction';
import * as askRow from '../src/index.ts';

type ExecRes = { ok: boolean; output: any; error?: string; interrupt?: any };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

/** 双行 boot：核（ac-durable-interaction）+ 工具行（ac-ask-questions） */
async function boot(diOptions: Record<string, unknown> = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const [plugin, config] of [
    [toolsRow, undefined],
    [diRow, diOptions],
    [askRow, undefined],
  ] as Array<[unknown, unknown]>) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).tools && (ctx as any).durableInteraction && (ctx as any).tools.has('ask_questions')) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('ask_questions 发起体（write-ahead + 即返 awaiting + context 行）', () => {
  it('选项对象形态归一：{label,description} → "label —— description"；垃圾项丢弃（2026-09-15 [object Object] 反馈回归）', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const r = await exec(ctx, {
      name: 'ask_questions',
      args: {
        questions: [{
          question: '选哪个？',
          options: [
            { label: '方案A', description: '最快' },
            '纯字符串选项',
            null,
            { label: '只有标签' },
            '',
          ],
        }],
      },
      agentId: 'norm',
      conversationId: 'norm',
      toolCallId: 'call-norm',
    });
    expect(r.ok).toBe(true);
    expect(r.output.status).toBe('awaiting_user');
    const open = ctx.durableInteraction.listOpen({ key: 'norm' })[0];
    const qs = (open!.payload as { questions: Array<{ options: string[] }> }).questions;
    expect(qs[0].options).toEqual(['方案A —— 最快', '纯字符串选项', '只有标签']);
  });

  it('发起即返：awaiting 标记 + interaction 落盘 + correlationId=toolCallId；open 保持 pending（等待归 loop）', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const r = await exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: '选哪个？', options: ['A', 'B'] }] },
      agentId: 'helper',
      conversationId: 'helper',
      toolCallId: 'call-42',
    });
    expect(r.ok).toBe(true);
    expect(r.output.status).toBe('awaiting_user');
    expect(r.output.notice).toBeTruthy();
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    expect(open).toMatchObject({ kind: 'ask_questions', correlationId: 'call-42', owner: 'helper', state: 'pending' });
    expect(r.output.interaction_id).toBe(open.id);
  });

  it('context 行落账：session.recordContext 以 source=durable-interaction 调用（run 活跃时由 session 落 journal）', async () => {
    const calls: Array<{ conversationId: string; agentId: string; content: string; extra: Record<string, unknown> }> = [];
    const { Service } = await import('@agentchat/cordis');
    class SessionStub extends (Service as any) {
      constructor(c: any) { super(c, 'session'); }
      recordContext(conversationId: string, agentId: string, content: string, extra: Record<string, unknown>) {
        calls.push({ conversationId, agentId, content, extra });
        return 'msg-x';
      }
    }
    const ctx = new Context();
    const fibers = [
      ctx.plugin(toolsRow as any),
      ctx.plugin(SessionStub as any),
      ctx.plugin(diRow as any, { backend: 'memory' }),
      ctx.plugin(askRow as any),
    ];
    await Promise.all(fibers);
    booted.push({ ctx, fibers });
    for (let i = 0; i < 1000; i++) {
      if ((ctx as any).durableInteraction && (ctx as any).session && (ctx as any).tools?.has('ask_questions')) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    const r = await exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: '选哪个？', options: ['A', 'B'] }] },
      agentId: 'helper',
      conversationId: 'conv-9',
    });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ conversationId: 'conv-9', agentId: 'helper' });
    expect(calls[0].extra).toMatchObject({ source: 'durable-interaction' });
    expect(calls[0].content).toContain('选哪个？');
    expect(calls[0].content).toContain('[用户提问]');
  });

  it('session 缺席降级：不落 context 行但发起照常（组合可选）', async () => {
    const { ctx } = await boot({ backend: 'memory' }); // 无 session 行
    const r = await exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: 'q', options: ['x'] }] },
      agentId: 'a',
      conversationId: 'a',
    });
    expect(r.ok).toBe(true);
    expect(r.output.status).toBe('awaiting_user');
  });

  it('参数校验：空 questions / 无会话上下文', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const noQ = await exec(ctx, { name: 'ask_questions', args: { questions: [] }, conversationId: 'a' });
    expect(noQ.ok).toBe(false);
    const noConv = await exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: 'q', options: ['x'] }] },
    });
    expect(noConv.ok).toBe(false);
    expect(noConv.error).toContain('会话上下文');
  });

  it('multi 归一化：显式 true 进 payload，其余（false/缺省）剔除——旧载荷向后兼容', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const r = await exec(ctx, {
      name: 'ask_questions',
      args: {
        questions: [
          { question: '多选', options: ['m1', 'm2'], multi: true },
          { question: '显式单选', options: ['x', 'y'], multi: false },
          { question: '缺省单选', options: ['m', 'n'] },
        ],
      },
      agentId: 'helper',
      conversationId: 'helper',
    });
    expect(r.ok).toBe(true);
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    const qs = (open.payload as { questions: Array<{ multi?: boolean }> }).questions;
    expect(qs[0].multi).toBe(true);
    expect(qs[1].multi).toBeUndefined();
    expect(qs[2].multi).toBeUndefined();
  });

  it('嵌套题形归一（2026-09-16 事故 5cb5b75c 回归）：options 里嵌 {question, options} → 上提为独立题', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const r = await exec(ctx, {
      name: 'ask_questions',
      args: {
        questions: [{
          question: 'CHANGELOG 0.8.9 节的修正方案，怎么执行？',
          options: [{
            question: '按我的方案修（删3重复+补4漏记）然后继续 commit→tag→push',
            options: ['按方案修，一气呢到底', '先出修正稿给我过目，确认后再 commit', '只删重复不补新条目（最小改动）'],
          }],
        }],
      },
      agentId: 'helper',
      conversationId: 'helper',
    });
    expect(r.ok).toBe(true);
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    const qs = (open.payload as { questions: Array<{ question: string; options: string[] }> }).questions;
    expect(qs).toEqual([{
      question: '按我的方案修（删3重复+补4漏记）然后继续 commit→tag→push',
      options: ['按方案修，一气呢到底', '先出修正稿给我过目，确认后再 commit', '只删重复不补新条目（最小改动）'],
    }]);
  });

  it('映射形选项归一（2026-09-17 事故 35c642be 回归）：{"选项全文": "内部代称"} 单键对象 → 取键为选项文本', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const r = await exec(ctx, {
      name: 'ask_questions',
      args: {
        questions: [
          {
            options: [
              { 'P1+P2 全做（含后端补 action 字段）——一次到位，改动约 2 文件+测试（推荐）': 'P1+P2' },
              { '仅 P1（误判/loading/死代码/徽章）——不动后端，纯前端修复': 'P1only' },
              { '先只改后端 output 结构，前端下一步再动': 'backend-first' },
              { '只要这份分析报告，暂不改代码': 'report-only' },
            ],
            question: '按什么范围动手调整？',
          },
          {
            options: [
              { '是——卡片 ID 可点击进入详情': 'yes' },
              { '否——保持纯展示，联动后续再说': 'no' },
            ],
            question: 'P3 的「卡片点击进入子 Agent 会话视角」要不要顺手做？',
          },
        ],
      },
      agentId: 'helper',
      conversationId: 'helper',
    });
    expect(r.ok).toBe(true);
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    const qs = (open.payload as { questions: Array<{ question: string; options: string[] }> }).questions;
    expect(qs[0].options).toEqual([
      'P1+P2 全做（含后端补 action 字段）——一次到位，改动约 2 文件+测试（推荐）',
      '仅 P1（误判/loading/死代码/徽章）——不动后端，纯前端修复',
      '先只改后端 output 结构，前端下一步再动',
      '只要这份分析报告，暂不改代码',
    ]);
    expect(qs[1].options).toEqual(['是——卡片 ID 可点击进入详情', '否——保持纯展示，联动后续再说']);
  });

  it('映射形兼容显式 label 形：{label, description} 优先于取键，混合数组各归其位', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const r = await exec(ctx, {
      name: 'ask_questions',
      args: {
        questions: [{
          question: '混合选项',
          options: [
            { label: '显式标签', description: '优先解析' },
            { '纯映射选项': 'alias' },
            '普通字符串',
          ],
        }],
      },
      agentId: 'helper',
      conversationId: 'helper',
    });
    expect(r.ok).toBe(true);
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    const qs = (open.payload as { questions: Array<{ options: string[] }> }).questions;
    expect(qs[0].options).toEqual(['显式标签 —— 优先解析', '纯映射选项', '普通字符串']);
  });

  it('全无效时报错回显结构摘要（帮模型一轮自愈）：错误信息含收到的原文', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const r = await exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: '', options: [] }] },
      conversationId: 'a',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('questions 无效');
    expect(r.error).toContain('question');
    expect(r.error!.length).toBeGreaterThan(30);
  });

  it('同题重复选项去重（模型生成端重复无信息量）', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const r = await exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: '选哪个？', options: ['A', 'A', 'A ', 'B'] }] },
      agentId: 'helper',
      conversationId: 'helper',
    });
    expect(r.ok).toBe(true);
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    const qs = (open.payload as { questions: Array<{ options: string[] }> }).questions;
    expect(qs[0].options).toEqual(['A', 'B']);
  });

  it('提权档位留痕（2026-09-12 反馈）：call.elevation 进 payload；无提权无字段', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    await exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: '选哪个？', options: ['A', 'B'] }] },
      agentId: 'helper',
      conversationId: 'helper',
      toolCallId: 'call-elev-1',
      elevation: 'full-access',
    });
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    expect((open.payload as { elevation?: string }).elevation).toBe('full-access');
    await exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: 'q2', options: ['x'] }] },
      agentId: 'helper',
      conversationId: 'helper',
      toolCallId: 'call-elev-2',
    });
    const open2 = ctx.durableInteraction.listOpen({ key: 'helper' }).find((r) => r.correlationId === 'call-elev-2');
    expect((open2!.payload as { elevation?: string }).elevation).toBeUndefined();
  });

  it('deadline 已移除（2026-12）：open 不带 deadline——等待无超时，直到用户回答', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    await exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: 'q', options: ['x'] }], deadline_ms: 5000 }, // 旧参数传入也被忽略
      agentId: 'helper',
      conversationId: 'helper',
    });
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    expect(open.deadline).toBeUndefined(); // 不再落盘（idle 挂起等待，无超时）
  });


});

describe('late-reply 唤醒（run 已死时的作答回投——登记表缺席判定）', () => {
  async function bootWithConversation(
    deliveries: Array<{ agentId: string; message: string; options: Record<string, unknown> }>,
  ) {
    const { Service } = await import('@agentchat/cordis');
    class ConvStub extends (Service as any) {
      constructor(c: any) { super(c, 'conversation'); }
      listRunning() { return []; }
      deliver(agentId: string, message: string, options: Record<string, unknown>) {
        deliveries.push({ agentId, message, options });
        return Promise.resolve({});
      }
    }
    const ctx = new Context();
    const fibers = [
      ctx.plugin(toolsRow as any),
      ctx.plugin(ConvStub as any),
      ctx.plugin(diRow as any, { backend: 'memory' }),
      ctx.plugin(askRow as any),
    ];
    await Promise.all(fibers);
    booted.push({ ctx, fibers });
    for (let i = 0; i < 1000; i++) {
      if ((ctx as any).durableInteraction && (ctx as any).conversation && (ctx as any).tools?.has('ask_questions')) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    return ctx;
  }

  it('answered 且登记表缺席（run 已死——重启后场景）→ conversation.deliver 回投（sender:event）', async () => {
    const deliveries: Array<{ agentId: string; message: string; options: Record<string, unknown> }> = [];
    const ctx = await bootWithConversation(deliveries);
    const rec = ctx.durableInteraction.open({
      key: 'sid-late', kind: 'ask_questions',
      payload: { questions: [{ question: '选哪个？' }] }, owner: 'helper',
    });
    ctx.durableInteraction.reply(rec.id, { answers: ['A'] });
    await new Promise((r) => setTimeout(r, 50));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.agentId).toBe('helper');
    expect(deliveries[0]!.options).toMatchObject({ sender: 'helper', source: 'event', conversationId: 'sid-late' });
    expect(deliveries[0]!.message).toContain('选哪个？');
    expect(deliveries[0]!.message).toContain('A');
  });

  it('登记表在场且 agentLoop 行未装（组合可选：无 steer 通道）→ 回落 late-reply deliver', async () => {
    const deliveries: Array<{ agentId: string; message: string; options: Record<string, unknown> }> = [];
    const ctx = await bootWithConversation(deliveries);
    // 发起体路径写入登记表（agentId 在场）；本装配无 loop/agentLoop 行——
    // 挂起不存在，忙步 steer 通道缺席 → 回落 deliver 回投（答案不丢）
    await exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: 'q', options: ['x'] }] },
      agentId: 'helper',
      conversationId: 'sid-live',
    });
    const open = ctx.durableInteraction.listOpen({ key: 'sid-live' })[0];
    ctx.durableInteraction.reply(open.id, { answers: ['B'] });
    await new Promise((r) => setTimeout(r, 50));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.options).toMatchObject({ sender: 'helper', source: 'event', conversationId: 'sid-live' });
  });

  it('approval 等其他 kind 不回投（各有等待方）', async () => {
    const deliveries: Array<{ agentId: string; message: string; options: Record<string, unknown> }> = [];
    const ctx = await bootWithConversation(deliveries);
    const rec = ctx.durableInteraction.open({
      key: 'sid-appr', kind: 'approval',
      payload: {}, owner: 'helper',
    });
    ctx.durableInteraction.reply(rec.id, { approved: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(deliveries).toHaveLength(0);
  });
});
