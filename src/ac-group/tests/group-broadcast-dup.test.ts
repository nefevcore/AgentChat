// ============================================================
// 回归测试：群播报「重复投递」修复（cr-295，2026-10 真实事故）
//
// 事故：news Agent 群播后，空闲成员 run 的 LLM 上下文里同一消息
// 逐字出现两遍（nana/tester/neko 台账连续多日记录「同内容到达两次」）；
// 落盘层查重恒零重复（成员流只有 post 扇出的投影行一份）。
//
// 根因：send 的 hint 信封携带 <msg> 全文，而投影行已先由 post 扇出
// 进成员流——空闲成员 run 的上下文 = [history(末尾=投影行), hint(全文)]，
// 逐字双份（上下文双份、落盘单条，每发必现）。
//
// 修复（双形态）：deliver 新增 wakeNotice——busy steer 注入活跃 run
//（快照看不到新入账行）投原文；直接开 run / 链跑消费（history 重派生
// 可见投影行）投瘦通知。本测试锁定三种形态的信封唯一性。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as conversationRow from 'ac-conversation';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as sessionRow from 'ac-session';
import * as toolsRow from 'ac-tools';
import * as groupRow from '../src/index';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  for (let i = 0; i < ms && !(await cond()); i += 5) await sleep(5);
  if (!(await cond())) throw new Error('waitFor 超时');
}

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-group-dup-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];
/** 手动放行门：每次 LLM 调用挂起直到 release */
let releaseGates: () => void = () => {};

function gatedProvider() {
  const gates: Array<() => void> = [];
  releaseGates = () => gates.splice(0).forEach((r) => r());
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      await new Promise<void>((r) => gates.push(r));
      yield { delta: '收到' };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

async function boot(root: string) {
  captured.length = 0;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', gatedProvider(), { models: ['mock-1'] });
      },
    },
    loopRow,
    agentsRow,
    routerRow,
    sessionRow,
    conversationRow,
    groupRow,
  ];
  for (const row of rows) {
    const isSession = sessionRow === (row as any);
    const config = isSession ? { root } : groupRow === (row as any) ? { root } : undefined;
    const fiber = ctx.plugin(row as any, config);
    await fiber;
    fibers.push(fiber);
  }
  ctx.agents.register({ id: 'news', model: 'mock-1' });
  ctx.agents.register({ id: 'nana', model: 'mock-1' });
  ctx.agents.register({ id: 'tester', model: 'mock-1' });
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('群播报重复投递修复（cr-295）', () => {
  it('空闲成员：上下文恰一份投影行 + 信封末位为瘦通知（不再逐字双份）', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.group.create({ id: 'g', name: '愉快玩耍', members: ['news', 'nana', 'tester'] });

    // news 群播（成员均空闲 → 直开 run，投瘦通知形态）
    const p = ctx.group.send('g', 'news', '🌅 早间简报 · 10-07｜热搜 TOP5', { settle: true });
    await waitFor(() => captured.length >= 2); // nana 与 tester 的 run 已开
    releaseGates();
    await p;

    // nana 的 run 上下文：消息数组 = [history..., 信封末位]
    const input = captured.find((i) =>
      i.messages.some((m) => String(m.content).includes('群聊唤醒'))
    )!;
    expect(input).toBeDefined();
    const contents = input.messages.map((m) => String(m.content));
    // 投影行恰一份（<msg> 包装原文在上下文里）
    const projectionCount = contents.filter((c) => c.includes('早间简报')).length;
    expect(projectionCount).toBe(1);
    // 信封末位 = 瘦通知（不含播报正文——正文已在上下文投影行里）
    expect(String(input.messages.at(-1)!.content)).toContain('群聊唤醒');
    expect(String(input.messages.at(-1)!.content)).not.toContain('早间简报');
  });

  it('busy 成员：steer 注入投原文（快照看不到新入账行，原文唯一载体）', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.group.create({ id: 'g', name: '愉快玩耍', members: ['news', 'nana'] });

    // nana 先忙起来（长 run 挂起）
    void ctx.conversation.deliver('nana', 'nana 在忙旧事', { conversationId: 'g~nana' }).catch(() => undefined);
    await waitFor(() => captured.length >= 1);

    // news 群播 → nana busy → steer 注入（pending 到下一步）
    const sending = ctx.group.send('g', 'news', '午间速递', { settle: true });
    releaseGates(); // 当前步放行 → loop 收 steer 注入开下一步
    await waitFor(() => captured.length >= 2);
    releaseGates();
    await sending;

    // steer 消费步：注入的是 <msg> 原文（含正文——唯一内容载体）
    const steerStep = captured.filter((i) =>
      i.messages.some((m) => String(m.content).includes('午间速递'))
    ).at(-1)!;
    expect(steerStep).toBeDefined();
    const contents = steerStep.messages.map((m) => String(m.content));
    expect(contents.filter((c) => c.includes('午间速递')).length).toBe(1); // steer 注入恰一份（无投影行叠加——快照不含新入账行）
  });

  it('busy 成员 next-turn 链跑：消费轮投瘦通知 + 轮间重派生可见投影行', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.group.create({ id: 'g', name: '愉快玩耍', members: ['news', 'nana'] });

    // nana 先忙起来（长 run 挂起）
    const busy = ctx.conversation.deliver('nana', 'nana 在忙旧事', {
      conversationId: 'g~nana',
      lane: 'next-turn',
      timeoutMs: 10_000,
    });
    // 注：lane next-turn 空闲时直接消费——先等 run 开启
    await waitFor(() => captured.length >= 1);

    // news 群播 → nana busy → hint 入 next-turn 队列（lane next-turn 模拟）
    const queued = await ctx.conversation.deliver('nana',
      '<msg from="news">晚间榜单</msg>\n\n[当前时间] 2026-10-07 20:00 周三', {
      sender: 'news',
      source: 'agent',
      conversationId: 'g~nana',
      lane: 'next-turn',
      wakeNotice: '[群聊唤醒] news（愉快玩耍）发送了新消息——内容见上方历史最新一条。',
    });
    expect(queued.kind).toBe('queued');

    // 放行首轮 → 链跑消费（轮间重派生 + 瘦通知）
    releaseGates();
    await waitFor(() => captured.length >= 2);
    releaseGates();
    await busy.catch(() => undefined);

    const chainStep = captured.filter((i) =>
      i.messages.some((m) => String(m.content).includes('群聊唤醒'))
    ).at(-1)!;
    expect(chainStep).toBeDefined();
    const contents = chainStep.messages.map((m) => String(m.content));
    // 瘦通知恰一份；原文不入信封（真实链路原文由 post 扇出的投影行承载，
    // 链跑轮 history 重派生可见——第一例已锁定该形态）
    expect(contents.filter((c) => c.includes('群聊唤醒')).length).toBe(1);
    expect(contents.filter((c) => c.includes('晚间榜单')).length).toBe(0);
  });
});
