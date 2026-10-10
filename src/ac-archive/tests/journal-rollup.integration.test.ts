// ============================================================
// ac-archive：journal rollup（cr-315 方案A）——eventReplay='journal'
// 的对角线自会话桶按机制行条数触发滚动归档：攒满 2×keep → 整理 run
// （Agent 亲写滚动概要）→ splitForRollup 物理剪裁（保留 keep 条机制行，
// 被剪轮含回复行入归档段）→ compact 重建。上下文恒 ≈ 概要 + keep..2×keep。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import { TimerService as VendorTimer } from '@agentchat/cordis-timer';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as conversationRow from 'ac-conversation';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as sessionRow from 'ac-session';
import * as toolsRow from 'ac-tools';
import * as archiveRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-archive-rollup-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];

const isRollupInput = (input: LlmChatInput): boolean =>
  input.messages.some((m) => typeof m.content === 'string' && m.content.includes('[归档整理]'));

function textChunks(text: string): LlmStreamChunk[] {
  return [{ delta: text }, { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } }];
}

/** 模拟机制触发（timer 真实形态：deliver source='event' → 入账机制行 + run + after-run 检测） */
function feedEvent(ctx: Context, conversationId: string, target: string, content: string): Promise<unknown> {
  return ctx.conversation.deliver(target, { role: 'user', content }, {
    conversationId,
    sender: target, // 自会话语义：机制触发 = 目标自身
    source: 'event',
  });
}

async function boot(root: string, settings?: Record<string, unknown>) {
  captured.length = 0;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [
    VendorTimer as unknown as Record<string, unknown>,
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register(
          'mock',
          () => ({
            stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
              captured.push(input);
              yield* textChunks('此前，监控运行平稳，无重要事件。');
            },
          }),
          { models: ['mock-1'] },
        );
      },
    },
    loopRow,
    agentsRow,
    routerRow,
    conversationRow,
    sessionRow,
    archiveRow,
  ];
  const configs: Record<string, unknown> = {
    'ac-session': { root },
    'ac-archive': { root, defaults: { maxContextTokens: 1_000_000, archiveTokenRatio: 0.5, keepRecentRatio: 0.03 } },
  };
  for (const row of rows) {
    const name = (row as { name?: string }).name ?? '';
    const config = configs[name];
    const fiber = config === undefined ? ctx.plugin(row as any) : ctx.plugin(row as any, config);
    await fiber;
    fibers.push(fiber);
  }
  ctx.agents.register({
    id: 'news',
    model: 'mock-1',
    ...(settings ? { settings } : {}),
  });
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

async function until(pred: () => boolean, ms = 5000): Promise<void> {
  for (let i = 0; i < ms; i += 10) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('等待超时');
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-archive journal rollup（cr-315 方案A）', () => {
  it('端到端：机制行攒满 2×keep 触发滚动归档——整理 run + 物理剪裁 + 概要头', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, { session: { eventReplay: 'journal', eventJournalKeep: 3 } });
    // 5 轮机制触发（攒到 5 < 2×3=6 不触发）。逐轮 await = 真实 timer 形态
    //（每轮间隔远大于 run 时长，会话恒空闲走直落路径）；并发投递会走
    // busy/steer 的 journal 注入路径，物化与 compact 存在微秒级竞态。
    for (let i = 1; i <= 5; i++) await feedEvent(ctx, 'news~news', 'news', `触发 ${i}`);
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.archive.segments('news~news')).toHaveLength(0); // 未触发
    // 第 6 条机制行（= 2×keep）触发
    await feedEvent(ctx, 'news~news', 'news', '触发 6');
    // 机制行 6 条 durable 后 run 收束 → rollup 检测触发；等待分段出现
    //（deliver 返回 = run 收束；检测在 after-run 异步窗口，留足链路预算）
    await until(() => ctx.archive.segments('news~news').length > 0, 20000);



    // 归档分段：被剪轮（触发 1..3 前的区段）已物理移出
    const segFile = path.join(root, 'archive', 'news~news', 'history_1.jsonl');
    expect(fs.existsSync(segFile)).toBe(true);
    // 回放形态：概要头 + 保留区（触发 4..6）——恒有界
    const log = await ctx.session.history('news~news', { viewer: 'news' });
    expect(log[0]).toMatchObject({ role: 'system', content: '此前，监控运行平稳，无重要事件。' });
    const kept = log.filter((m) => typeof m.content === 'string' && m.content.startsWith('触发'));
    expect(kept).toHaveLength(3); // keep=3：触发 4/5/6
    expect(kept.map((m) => m.content)).toEqual(['触发 4', '触发 5', '触发 6']);
    // 整理提示词进过 LLM（对角线文案：不再误称与对方的会话）
    const reviewInput = captured.find(isRollupInput);
    expect(reviewInput).toBeTruthy();
    expect(
      reviewInput!.messages.some((m) => typeof m.content === 'string' && m.content.includes('你的自会话运行日志')),
    ).toBe(true);
  });

  it('非触发轮纯追加（KV 前缀字节保真）：触发后下一轮回放 = 概要 + 保留区 + 尾部新增', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, { session: { eventReplay: 'journal', eventJournalKeep: 3 } });
    for (let i = 1; i <= 6; i++) await feedEvent(ctx, 'news~news', 'news', `触发 ${i}`);
    await until(() => ctx.archive.segments('news~news').length > 0, 20000);

    await new Promise((r) => setTimeout(r, 100));
    const before = await ctx.session.history('news~news', { viewer: 'news' });
    feedEvent(ctx, 'news~news', 'news', '触发 7');
    await new Promise((r) => setTimeout(r, 100));
    const after = await ctx.session.history('news~news', { viewer: 'news' });
    // deliver 形态每轮两行：机制行（触发 7）+ agent 回复行——纯尾部追加
    expect(after.length).toBe(before.length + 2);
    for (let i = 0; i < before.length; i++) {
      expect(JSON.stringify(after[i])).toBe(JSON.stringify(before[i])); // 前缀字节保真
    }
    expect(after[after.length - 2].content).toBe('触发 7');
  });

  it('eventReplay=full（缺省）不受影响：机制行再多也不触发 rollup', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root); // 无 settings
    for (let i = 1; i <= 10; i++) feedEvent(ctx, 'news~news', 'news', `触发 ${i}`);
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.archive.segments('news~news')).toHaveLength(0);
  });

  it('非对角线桶不 rollup：user~news 的机制行再多也不触发（即便 journal 模式）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, { session: { eventReplay: 'journal', eventJournalKeep: 3 } });
    for (let i = 1; i <= 10; i++) feedEvent(ctx, 'user~news', 'news', `触发 ${i}`);
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.archive.segments('user~news')).toHaveLength(0);
  });

  it('token 阈值闸兜底共存：非 journal 的自会话桶超 token 阈值仍走原路径', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root); // eventReplay 缺省 full
    ctx.agents.register({ id: 'big', model: 'mock-1' });
    // 直接投递大消息走 token 路径（阈值 50 万 × 0.5 = 25 万估算超限）——
    // 走 router.send 产生 run，after-run 钩子检测
    await ctx.router.send('big', '话'.repeat(4000)); // ~2400 token > 需调 defaults
    await new Promise((r) => setTimeout(r, 300));
    // 本用例 defaults 阈值 50 万——4000 字不够触发，仅锚定 full 模式不 rollup
    expect(ctx.archive.segments('big~user')).toHaveLength(0);
  });
});
