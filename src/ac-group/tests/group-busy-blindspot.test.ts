// ============================================================
// 回归测试：busy 成员的"自己发言"盲区修复（2026-09-13 真实事故）
//
// 事故：群员 Agent（nana）的发言真实落进群本体（用户与其他成员
// 都看到，本体 seq=755/757/763 三条总结俱在），但 nana 自己后续
// run 延伸的上下文里看不到自己已发的消息——误以为"没发出去"而
// 重发（seq=763："前面那条好像没发出去，重发一版"）。
//
// 根因（M26 设计的盲区）：
//   · 群成员的上下文视图（ContextView）只在 startRun 时派生一次；
//   · 群 hint 不进视图（isGroupHint 跳过）、群 run 终稿不进视图
//     （M26：send_group 才是发言）——设计如此；
//   · 成员发言的事实行只进群本体，post 的补偿是 markStale——
//     但 stale 只在"下一次 startRun"生效；
//   · busy 成员的后续消息走 next-turn 链跑（lane:'next-turn'——
//     ac-group 的直接输出回执正是此路径）或 steer 注入，链跑轮
//     在同一 startRun 调用内延伸（while 循环），视图快照从不重
//     派生 ⇒ busy 成员在链跑轮里永远看不到自己的新发言。
//
// 修复（方案 A）：startRun 循环顶部检查 view.stale——轮间重派生
// （群桶经可选 group 服务取 historyFor 专用投影，见 contextFor
// 群桶感知分支）。本测试锁定链跑轮间的可见性。
//
// 时序：
//   t0  user 发言 → nana 开 run（门挂起 = 长时间 run）
//   t1  nana 在 run 中 send_group 总结 v1（事实行入本体 + markStale）
//   t2  peer 发言 → nana 忙 → hint 入 next-turn 队列
//   t3  放行 → 当前轮收束 → 链跑消费 peer hint（LLM 调用 #2）
//   ⇒ 链跑轮的上下文应含自己的 v1（assistant 角色，own 原文）。
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
  for (let i = 0; i < ms && !(await cond()); i++) await sleep(5);
  if (!(await cond())) throw new Error('waitFor 超时');
}

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-group-blindspot-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];
/** 手动放行门：每次 LLM 调用挂起直到 release（模拟长 run + 链跑时序） */
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
  ctx.agents.register({ id: 'nana', model: 'mock-1' });
  ctx.agents.register({ id: 'peer', model: 'mock-1' });
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).group && (ctx as any).conversation && (ctx as any).session) break;
    await sleep(1);
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
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('busy 成员自己发言盲区修复（2026-09-13 事故回归）', () => {
  it('链跑轮间重派生：busy 成员在 next-turn 链跑轮里看得到自己已 send_group 的发言', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.group.create({ id: 'g', name: '愉快玩耍', members: ['nana', 'peer'] });

    // t0：user 发言 → nana/peer 各自开 run（LLM 调用挂起 = 持续忙）
    void ctx.group.send('g', 'user', '用户提问').catch(() => undefined);
    await waitFor(() => captured.length >= 2); // 两个成员的 run 都已开

    // t1：nana 在 run 进行中 send_group（真实事故：总结 v1）
    //     ——send_group 工具执行 → post 事实行入本体 + markStale
    //     （nana 是发送者不触发自己；peer 忙 → hint 入 peer 的队列）
    void ctx.group.send('g', 'nana', 'nana 的总结 v1').catch((e) => console.log('DEBUG nana send error:', e));
    await waitFor(async () => {
      const log = await ctx.group.records('g', 100);
      return log.some((m) => m.from === 'nana');
    });

    // 事实核验：本体确有 nana 的发言（用户视角/其他成员视角都能看到）
    const body = await ctx.group.records('g', 50);
    expect(body.some((m) => m.from === 'nana' && m.content.includes('nana 的总结 v1'))).toBe(true);

    // t2：peer 发言 → nana 仍忙 → hint 入 nana 的 next-turn 队列
    //     （deliver busy 分支：lane 缺省 next-step + placement steer，
    //      steer 成功注入活跃 run 末轮；此处验证链跑路径改为显式排队）
    const queued = await ctx.conversation.deliver('nana', 'peer 的新话题', {
      sender: 'peer',
      source: 'agent',
      conversationId: 'g',
      lane: 'next-turn',
    });
    expect(queued.kind).toBe('queued');

    // t3：放行 → nana 首轮收束 → 链跑消费队列（LLM 调用 #3 = nana 的链跑轮）
    releaseGates();
    await waitFor(() => captured.length >= 3);
    releaseGates(); // 链跑轮放行收束

    // —— 主测：nana 的链跑轮上下文应含自己的 v1（own 原文，assistant 角色）
    const chainStep = captured.filter((i) =>
      i.messages.some((m) => String(m.content).includes('peer 的新话题')),
    ).at(-1)!;
    expect(chainStep).toBeDefined();
    const seesOwn = chainStep.messages.some(
      (m) => m.role === 'assistant' && String(m.content).includes('nana 的总结 v1'),
    );
    expect(seesOwn).toBe(true); // 修复前 false（盲区），修复后 true
  });
});
