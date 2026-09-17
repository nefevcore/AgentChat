// ============================================================
// ac-ask-questions：ask_questions 工具（归一化/等待/超时）+ late-reply 唤醒
// （自 ac-durable-interaction 拆出——2026-09-17 核/工具行分离）
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

describe('ask_questions 工具（write-ahead + 事件等待 + late-reply 对账键）', () => {
  it('选项对象形态归一：{label,description} → "label —— description"；垃圾项丢弃（2026-09-15 [object Object] 反馈回归）', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const pending = exec(ctx, {
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
    await new Promise((r) => setTimeout(r, 100));
    const open = ctx.durableInteraction.listOpen({ key: 'norm' })[0];
    const qs = (open!.payload as { questions: Array<{ options: string[] }> }).questions;
    expect(qs[0].options).toEqual(['方案A —— 最快', '纯字符串选项', '只有标签']);
    ctx.durableInteraction.reply(open!.id, ['方案A —— 最快']);
    const r = await pending;
    expect(r.ok).toBe(true);
  });

  it('事件驱动回答：reply 后工具唤醒并拿到 answers；correlationId=toolCallId', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const pending = exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: '选哪个？', options: ['A', 'B'] }] },
      agentId: 'helper',
      conversationId: 'helper',
      toolCallId: 'call-42',
    });
    // 等待 opened 落盘
    await new Promise((r) => setTimeout(r, 100));
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    expect(open).toMatchObject({ kind: 'ask_questions', correlationId: 'call-42', owner: 'helper' });
    ctx.durableInteraction.reply(open.id, ['A']);
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(r.output.answers).toEqual(['A']);
    expect(r.output.interaction_id).toBe(open.id);
  });

  it('超时：close(timeout) + 可读错误', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const r = await exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: 'q', options: ['x'] }], timeout_ms: 120 },
      agentId: 'a',
      conversationId: 'a',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('超时');
    expect(ctx.durableInteraction.listOpen()).toHaveLength(0); // 已 close
  });

  it('signal 中止：close(aborted)', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const controller = new AbortController();
    const pending = exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: 'q', options: ['x'] }] },
      agentId: 'a',
      conversationId: 'a',
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('中止');
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
    const pending = exec(ctx, {
      name: 'ask_questions',
      args: {
        questions: [
          { question: '多选哪些？', options: ['A', 'B', 'C'], multi: true },
          { question: '单选哪个？', options: ['x', 'y'], multi: false },
          { question: '缺省单选', options: ['m', 'n'] },
        ],
      },
      agentId: 'helper',
      conversationId: 'helper',
    });
    await new Promise((r) => setTimeout(r, 100));
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    const qs = (open.payload as { questions: Array<{ multi?: boolean }> }).questions;
    expect(qs[0].multi).toBe(true);
    expect(qs[1].multi).toBeUndefined();
    expect(qs[2].multi).toBeUndefined();
    // 多选题答案为数组——原样落账透传（Agent 侧数组呈现）
    ctx.durableInteraction.reply(open.id, { answers: [['A', 'C'], 'x', 'm'] });
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(r.output.answers).toEqual({ answers: [['A', 'C'], 'x', 'm'] });
  });

  it('嵌套题形归一（2026-09-16 事故 5cb5b75c 回归）：options 里嵌 {question, options} → 上提为独立题', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const pending = exec(ctx, {
      name: 'ask_questions',
      // 事故原始入参：options 数组里塞的是完整题结构（内层才见真选项）
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
    await new Promise((r) => setTimeout(r, 100));
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    const qs = (open.payload as { questions: Array<{ question: string; options: string[] }> }).questions;
    // 上提后：内层题成为独立一题，外层 question 被子题取代（外层无 own options）
    expect(qs).toEqual([{
      question: '按我的方案修（删3重复+补4漏记）然后继续 commit→tag→push',
      options: ['按方案修，一气呢到底', '先出修正稿给我过目，确认后再 commit', '只删重复不补新条目（最小改动）'],
    }]);
    ctx.durableInteraction.reply(open.id, ['按方案修，一气呢到底']);
    const r = await pending;
    expect(r.ok).toBe(true);
  });

  it('映射形选项归一（2026-09-17 事故 35c642be 回归）：{"选项全文": "内部代称"} 单键对象 → 取键为选项文本', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const pending = exec(ctx, {
      name: 'ask_questions',
      // 事故原始入参（节选）：选项是单键对象，键即给用户看的全文（值是模型代称）
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
    await new Promise((r) => setTimeout(r, 100));
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    const qs = (open.payload as { questions: Array<{ question: string; options: string[] }> }).questions;
    expect(qs[0].options).toEqual([
      'P1+P2 全做（含后端补 action 字段）——一次到位，改动约 2 文件+测试（推荐）',
      '仅 P1（误判/loading/死代码/徽章）——不动后端，纯前端修复',
      '先只改后端 output 结构，前端下一步再动',
      '只要这份分析报告，暂不改代码',
    ]);
    expect(qs[1].options).toEqual(['是——卡片 ID 可点击进入详情', '否——保持纯展示，联动后续再说']);
    ctx.durableInteraction.reply(open.id, { answers: ['P1+P2 全做（含后端补 action 字段）——一次到位，改动约 2 文件+测试（推荐）', '是——卡片 ID 可点击进入详情'] });
    const r = await pending;
    expect(r.ok).toBe(true);
  });

  it('映射形兼容显式 label 形：{label, description} 优先于取键，混合数组各归其位', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const pending = exec(ctx, {
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
    await new Promise((r) => setTimeout(r, 100));
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    const qs = (open.payload as { questions: Array<{ options: string[] }> }).questions;
    expect(qs[0].options).toEqual(['显式标签 —— 优先解析', '纯映射选项', '普通字符串']);
    ctx.durableInteraction.reply(open.id, ['普通字符串']);
    const r = await pending;
    expect(r.ok).toBe(true);
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
    expect(r.error!.length).toBeGreaterThan(30); // 不再是一句孤零零的规则文本
  });

  it('同题重复选项去重（模型生成端重复无信息量）', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    const pending = exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: '选哪个？', options: ['A', 'A', 'A ', 'B'] }] },
      agentId: 'helper',
      conversationId: 'helper',
    });
    await new Promise((r) => setTimeout(r, 100));
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    const qs = (open.payload as { questions: Array<{ options: string[] }> }).questions;
    expect(qs[0].options).toEqual(['A', 'B']);
    ctx.durableInteraction.reply(open.id, ['A']);
    const r = await pending;
    expect(r.ok).toBe(true);
  });
});

describe('late-reply 唤醒（run 已死时的作答回投）', () => {
  async function bootWithConversation(
    running: Array<{ agentId: string; conversationId: string }>,
    deliveries: Array<{ agentId: string; message: string; options: Record<string, unknown> }>,
  ) {
    const { Service } = await import('@agentchat/cordis');
    class ConvStub extends Service {
      constructor(c: Context) {
        super(c, 'conversation');
      }
      listRunning() { return running; }
      deliver(agentId: string, message: string, options: Record<string, unknown>) {
        deliveries.push({ agentId, message, options });
        return Promise.resolve({});
      }
    }
    const ctx = new Context();
    const toolsFiber = ctx.plugin(toolsRow);
    const convFiber = ctx.plugin(ConvStub);
    const diFiber = ctx.plugin(diRow, { backend: 'memory' });
    const askFiber = ctx.plugin(askRow);
    await Promise.all([toolsFiber, convFiber, diFiber, askFiber]);
    for (let i = 0; i < 1000; i++) {
      if ((ctx as unknown as Record<string, unknown>).durableInteraction
        && (ctx as unknown as Record<string, unknown>).conversation
        && (ctx as any).tools?.has('ask_questions')) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    booted.push({ ctx, fibers: [toolsFiber, convFiber, diFiber, askFiber] });
    return ctx;
  }

  it('answered 且该会话无活跃 run → conversation.deliver 回投（sender:event）', async () => {
    const deliveries: Array<{ agentId: string; message: string; options: Record<string, unknown> }> = [];
    const ctx = await bootWithConversation([], deliveries); // 无活跃 run（run 已死——重启后场景）
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

  it('late-reply 先补记后回投：session.backfillToolResult 收到 correlationId 对账的答案（2026-09-15 上下文丢失事故修复）', async () => {
    const deliveries: Array<{ agentId: string; message: string; options: Record<string, unknown> }> = [];
    const backfills: Array<{ conversationId: string; toolCallId: string; result: unknown }> = [];
    const { Service } = await import('@agentchat/cordis');
    class SessionStub extends Service {
      constructor(c: Context) { super(c, 'session'); }
      backfillToolResult(conversationId: string, toolCallId: string, result: unknown) {
        backfills.push({ conversationId, toolCallId, result });
        return Promise.resolve(true);
      }
    }
    class ConvStub extends Service {
      constructor(c: Context) {
        super(c, 'conversation');
      }
      listRunning() { return []; }
      deliver(agentId: string, message: string, options: Record<string, unknown>) {
        deliveries.push({ agentId, message, options });
        return Promise.resolve({});
      }
    }
    const ctx = new Context();
    const fibers = [
      ctx.plugin(toolsRow),
      ctx.plugin(SessionStub),
      ctx.plugin(ConvStub),
      ctx.plugin(diRow, { backend: 'memory' }),
      ctx.plugin(askRow),
    ];
    await Promise.all(fibers);
    booted.push({ ctx, fibers });
    for (let i = 0; i < 1000; i++) {
      if ((ctx as any).durableInteraction && (ctx as any).conversation && (ctx as any).session && (ctx as any).tools?.has('ask_questions')) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    // run 死亡残留形态：open 时带 correlationId（对账锚），reply 触发 late-reply
    const rec = ctx.durableInteraction.open({
      key: 'sid-ctx', kind: 'ask_questions',
      payload: { questions: [{ question: '选哪个？', options: ['A', 'B'] }] },
      owner: 'helper', correlationId: 'call-ctx-1',
    });
    ctx.durableInteraction.reply(rec.id, { answers: ['全部做'] });
    await new Promise((r) => setTimeout(r, 50));
    // 补记先于回投（顺序断言：backfills 非空即已发生；deliveries 也应已发生）
    expect(backfills).toEqual([{
      conversationId: 'sid-ctx',
      toolCallId: 'call-ctx-1',
      result: { ok: true, output: { answers: { answers: ['全部做'] }, questions: [{ question: '选哪个？', options: ['A', 'B'] }], interaction_id: rec.id } },
    }]);
    expect(deliveries).toHaveLength(1);
  });

  it('late-reply 补记失败（session 行未装/无落点）不阻塞回投——唤醒优先，恢复 best-effort', async () => {
    const deliveries: Array<{ agentId: string; message: string; options: Record<string, unknown> }> = [];
    // 不装 SessionStub——session 行缺位的组合（软依赖面）
    const ctx = await bootWithConversation([], deliveries);
    const rec = ctx.durableInteraction.open({
      key: 'sid-nosess', kind: 'ask_questions',
      payload: { questions: [{ question: 'q' }] }, owner: 'helper', correlationId: 'call-x',
    });
    ctx.durableInteraction.reply(rec.id, { answers: ['A'] });
    await new Promise((r) => setTimeout(r, 50));
    expect(deliveries).toHaveLength(1); // 回投照常
  });

  it('run 活跃等待中（正常路径）→ 不回投（工具事件驱动半边自取，防双消费）', async () => {
    const deliveries: Array<{ agentId: string; message: string; options: Record<string, unknown> }> = [];
    const ctx = await bootWithConversation([{ agentId: 'helper', conversationId: 'sid-live' }], deliveries);
    const rec = ctx.durableInteraction.open({
      key: 'sid-live', kind: 'ask_questions',
      payload: { questions: [{ question: 'q' }] }, owner: 'helper',
    });
    ctx.durableInteraction.reply(rec.id, { answers: ['B'] });
    await new Promise((r) => setTimeout(r, 50));
    expect(deliveries).toHaveLength(0);
  });

  it('提权档位留痕与恢复（2026-09-12 反馈：重启后新 run 丢权限→逐工具审批疲劳）', async () => {
    // ① 工具 open 时把 call.elevation 存进 payload（full-access 留痕）
    const { ctx } = await boot({ backend: 'memory' });
    const pending = exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: '选哪个？', options: ['A', 'B'] }] },
      agentId: 'helper',
      conversationId: 'helper',
      toolCallId: 'call-elev-1',
      elevation: 'full-access',
    });
    void pending;
    await new Promise((r) => setTimeout(r, 100));
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    expect((open.payload as { elevation?: string }).elevation).toBe('full-access');

    // ② 无提权的 run → payload 无 elevation 字段
    const p2 = exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: 'q2', options: ['x'] }] },
      agentId: 'helper',
      conversationId: 'helper',
      toolCallId: 'call-elev-2',
    });
    void p2;
    await new Promise((r) => setTimeout(r, 100));
    const open2 = ctx.durableInteraction.listOpen({ key: 'helper' }).find((r) => r.correlationId === 'call-elev-2');
    expect((open2!.payload as { elevation?: string }).elevation).toBeUndefined();

    // ③ late-reply 回投：不显式带档位（提权继承由 ac-conversation deliver
    // 边界的会话水位机制统一承担——本行只回投答案，防双路径漂移）
    const deliveries: Array<{ agentId: string; message: string; options: Record<string, unknown> }> = [];
    const { Service } = await import('@agentchat/cordis');
    class ConvStub extends Service {
      constructor(c: Context) { super(c, 'conversation'); }
      listRunning() { return []; }
      deliver(agentId: string, message: string, options: Record<string, unknown>) {
        deliveries.push({ agentId, message, options });
        return Promise.resolve({});
      }
    }
    const ctx2 = new Context();
    const f1 = ctx2.plugin(toolsRow);
    const f2 = ctx2.plugin(ConvStub);
    const f3 = ctx2.plugin(diRow, { backend: 'memory' });
    const f4 = ctx2.plugin(askRow);
    await Promise.all([f1, f2, f3, f4]);
    booted.push({ ctx: ctx2, fibers: [f1, f2, f3, f4] });
    for (let i = 0; i < 1000; i++) {
      if ((ctx2 as any).durableInteraction && (ctx2 as any).conversation && (ctx2 as any).tools?.has('ask_questions')) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    const rec = ctx2.durableInteraction.open({
      key: 'sid-elev', kind: 'ask_questions',
      payload: { questions: [{ question: 'q' }], elevation: 'full-access' }, owner: 'helper',
    });
    ctx2.durableInteraction.reply(rec.id, { answers: ['A'] });
    await new Promise((r) => setTimeout(r, 50));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.options).toMatchObject({ sender: 'helper', source: 'event', conversationId: 'sid-elev' });
    expect(deliveries[0]!.options.elevation).toBeUndefined(); // 不透传——水位继承归 deliver 边界
  });
});
