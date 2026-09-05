// ============================================================
// ac-group 派生视图（M21 步骤 5 / D6+F2+F6①）：
// per-member 播种视角；派生窗钉住（滑窗消除，超阈值显式重派生）；
// hint 投递触发不再重复入账（影子桶只留回复事实行）。
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
import { GROUP_HINT_META } from 'ac-core-utils';
import * as groupRow from '../src/index';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-group-view-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];

function scriptedProvider() {
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      yield { delta: '收到' };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

/** boot(withSession) —— 群持久化 root + 可选 session 行 */
async function boot(root: string, groupOptions: Record<string, unknown> = {}) {
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
        c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] });
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
    let config: Record<string, unknown> | undefined;
    if (isSession) config = { root };
    else if (groupRow === (row as any)) config = { root, ...groupOptions };
    const fiber = ctx.plugin(row as any, config);
    await fiber;
    fibers.push(fiber);
  }
  ctx.agents.register({ id: 'a', model: 'mock-1' });
  ctx.agents.register({ id: 'b', model: 'mock-1' });
  ctx.agents.register({ id: 'c', model: 'mock-1' });
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

describe('群派生视图（M21 步骤 5）', () => {
  it('F2：播种视角 per-member——自己的历史发言以原文（非 <msg> 包装）进自己的首跑种子', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b', 'c'] });
    // b 先发（a/c 首跑，各自的视图建立）——b 自己不跑（post 不触发发送者）
    await ctx.group.send('g', 'b', 'b 的第一句', { settle: true });
    const before = captured.length;
    // c 发言 → b 首跑：种子 = b 视角派生（自己 'b 的第一句' 原文；
    // 旧实现按 targets[0]=a 视角播种——b 自己的话被包成 peer <msg>）
    await ctx.group.send('g', 'c', 'c 的话题', { settle: true });
    // own 原文精确匹配定位 b 的种子（a/c 的种子只有 b 消息的 <msg> 包装版）
    const bRuns = captured.slice(before).filter((input) =>
      input.messages.some((m) => m.content === 'b 的第一句'),
    );
    expect(bRuns).toHaveLength(1); // 仅 b 的种子含 own 原文（per-member 视角）
    // 反证：b 的消息在其他成员的种子里是 <msg> 包装（peer 视角）——
    // send #2 的 targets = a、b（c 是发送者不跑）：a 的种子含包装版
    const peerRuns = captured
      .slice(before)
      .filter((input) => input.messages.some((m) => String(m.content).includes('<msg from="b"')));
    expect(peerRuns.length).toBe(1);
  });

  it('M26：群 run 终稿不入群本体——records/本体桶只有真实发言（send_group 才是发言）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b'] });
    await ctx.group.post('g', 'user', '查一下');
    // 成员 a 的 run 终稿（含工具步）——携带群 hint 投递标记（群 run 恒带；
    // 双保险：groups shelf 亦命中）。契约明示"直接输出文本不会发送到群聊"
    ctx.emit(
      'router/reply-completed',
      'a',
      '查完了',
      {
        steps: [
          {
            index: 0,
            text: '',
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"x"}' }],
            toolResults: [{ ok: true, output: 'hi' }],
          },
          { index: 1, text: '查完了', toolCalls: [], toolResults: [] },
        ],
        finish: 'stop',
        usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 2 },
      } as never,
      'g',
      'user',
      'user',
      { [GROUP_HINT_META]: true },
    );
    // records 不含回复（群内容流 = post 唯一口）
    const recs = await ctx.group.records('g', 10, 0);
    expect(recs.map((r) => r.from)).toEqual(['user']);
    // 本体桶同款（ac-session 入账侧按 hint 标记 / groups shelf 跳过）
    const rows = await ctx.session.records('g');
    expect(rows.map((r) => r.agent_id)).toEqual(['user']);
  });

  it('F6①：hint 投递触发不入账——会话桶只含真实发言行（M26：成员回复也不入本体）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b'] });
    await ctx.group.send('g', 'user', '大家好', { settle: true });
    const records = await ctx.session.records('g');
    expect(records.length).toBeGreaterThan(0);
    // 无 hint 行（事实行在群本体；D11 后 post 直接落本体——用户发言）
    expect(records.filter((r) => r.content.includes('<msg'))).toHaveLength(0);
    expect(records.every((r) => r.role === 'agent')).toBe(true);
    // M26：成员 run 的终稿（"收到"）不入群本体——只有用户发言行
    expect(records.map((r) => r.agent_id)).toEqual(['user']);
  });

  it('D6：派生窗钉住——本体增长不滑窗（前缀稳定）；超阈值才整体重派生一次', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, { loadLimitTokens: 60, rederiveTokens: 120 });
    ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b'] });
    await ctx.group.post('g', 'a', '第一条比较长的消息'.repeat(3));
    await ctx.group.post('g', 'b', '第二条中等长度的消息内容');
    const h1 = await ctx.group.historyFor('g', 'a');
    expect(h1.length).toBeGreaterThan(0);
    const first1 = h1[0].content;
    // 本体增长（新消息短，不触发重派生）：窗口头不动——派生间字节只做尾部追加
    await ctx.group.post('g', 'b', '短消息');
    const h2 = await ctx.group.historyFor('g', 'a');
    expect(h2[0].content).toBe(first1); // 旧实现从尾重算 → 窗口头前滑（首条变化）
    // 追加语义：新事件并入尾块（相邻 peer 合并）或开新块——行数不减、内容可见
    expect(h2.length).toBeGreaterThanOrEqual(h1.length);
    expect(h2.at(-1)!.content).toContain('短消息');
    // 持续增长越过重派生阈值 → 整体重算一次（显式 replace：窗口头前移）
    for (let i = 0; i < 8; i++) {
      await ctx.group.post('g', 'a', `批量消息 ${i}：${'内容'.repeat(12)}`);
      await ctx.group.historyFor('g', 'a'); // 每次吸收（增量 token 累计过阈值）
    }
    const h3 = await ctx.group.historyFor('g', 'a');
    expect(h3[0].content).not.toBe(first1); // 一次显式重派生发生
  });
});
