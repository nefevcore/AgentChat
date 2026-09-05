// ============================================================
// ac-usage：after-run 记账（双轨聚合）+ 审计流水 + 卸载回收
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import { ARCHIVE_REVIEW_META } from 'ac-agent-loop';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
import * as usageRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-usage-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register(
          'mock',
          () => ({
            stream: async function* (_input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
              yield { delta: '好' };
              yield {
                delta: '',
                finish: 'stop',
                usage: { prompt: 10, completion: 3, total: 13, cacheHit: 6, cacheMiss: 4 },
              };
            },
          }),
          { models: ['mock-1'] },
        );
      },
    },
    loopRow,
    usageRow,
  ];
  for (const row of rows) {
    const fiber = row === usageRow ? ctx.plugin(row as any, { root }) : ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).usage) break;
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
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-usage 双轨记账', () => {
  it('after-run 记账：byAgent/byModel 聚合（累加轨 + 覆盖轨）+ 审计流水落盘', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.agentLoop.run({ agent: 'a', model: 'mock-1', messages: [{ role: 'user', content: 'q' }] });
    await ctx.agentLoop.run({ agent: 'a', model: 'mock-1', messages: [{ role: 'user', content: 'q2' }] });

    const a = ctx.usage.byAgent()['a'];
    expect(a.runs).toBe(2);
    expect(a.steps).toBe(2);
    expect(a.prompt).toBe(20); // 累加轨
    expect(a.completion).toBe(6);
    expect(a.total).toBe(26);
    expect(a.lastContextPrompt).toBe(10); // 覆盖轨（末 run 当次上下文）
    expect(a.cacheHit).toBe(12);
    expect(a.cacheMiss).toBe(8);
    expect(a.lastCacheHit).toBe(6); // 覆盖轨（末 run 缓存命中——不随 run 累加）
    expect(a.lastCacheMiss).toBe(4);

    const m = ctx.usage.byModel()['mock-1'];
    expect(m.runs).toBe(2);

    // 日期 × 模型交叉聚合（「按模型」堆叠图数据源）：同日两 run 同模型合并
    const dm = ctx.usage.byDayModel();
    expect(dm).toHaveLength(1);
    expect(dm[0]).toMatchObject({ model: 'mock-1', runs: 2, prompt: 20 });
    expect(dm[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const totals = ctx.usage.totals();
    expect(totals.runs).toBe(2);
    expect(totals.prompt).toBe(20);

    // 审计流水：<root>/usage/usage-<date>.jsonl，两行
    const files = ctx.usage.auditFiles();
    expect(files).toHaveLength(1);
    const lines = fs
      .readFileSync(path.join(root, 'usage', files[0]), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ agent: 'a', model: 'mock-1', finish: 'stop' });
  });

  it('无 agent 的 run 记入 (anonymous) 桶', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.agentLoop.run({ model: 'mock-1', messages: [{ role: 'user', content: 'q' }] });
    expect(ctx.usage.byAgent()['(anonymous)'].runs).toBe(1);
  });

  it('不落盘（M20）：meta[archive-review] 标记的整理 run 不记账不入流水', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 普通 run 1 次 + 归档整理 run（带标记）1 次 → 只有普通 run 入账
    await ctx.agentLoop.run({
      agent: 'a',
      model: 'mock-1',
      conversationId: 'a~user',
      messages: [{ role: 'user', content: 'q' }],
    });
    await ctx.agentLoop.run({
      agent: 'a',
      model: 'mock-1',
      conversationId: 'a~user',
      sender: 'a',
      source: 'event',
      meta: { [ARCHIVE_REVIEW_META]: true },
      messages: [{ role: 'user', content: '[归档整理] ……' }],
    });
    const a = ctx.usage.byAgent()['a'];
    expect(a.runs).toBe(1); // 整理 run 未记账
    expect(ctx.usage.byConversation()['a~user'].runs).toBe(1); // 桶 lastContextPrompt 未被整理上下文顶掉
    expect(ctx.usage.totals().runs).toBe(1);
    const files = ctx.usage.auditFiles();
    const lines = fs.readFileSync(path.join(root, 'usage', files[0]), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1); // 审计流水无整理行
    expect(lines[0]).not.toContain('归档整理');
  });

  it('订阅即归属：卸载 usage 行 → 记账停止', async () => {
    const root = tmpRoot();
    const { ctx, fibers } = await boot(root);
    const usageFiber = fibers.at(-1)!;
    await usageFiber.dispose();
    await ctx.agentLoop.run({ agent: 'a', model: 'mock-1', messages: [{ role: 'user', content: 'q' }] });
    expect((ctx as any).usage).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'usage'))).toBe(false);
  });
});

describe('ac-usage byPair（端点对分类）', () => {
  it('user⇄agent（conv=agent）/ agent⇄agent 对键（conv=a~b）/ 迁移行（conv=对方 agent）→ 端点对；群与未知名不进', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // agents 名册（byPair 分类判别用；usage 行不 inject，经 ctx.get 可选解析）
    const agentsFiber = ctx.plugin(agentsRow as any);
    await agentsFiber;
    booted[booted.length - 1].fibers.push(agentsFiber);
    ctx.agents.register({ id: 'alpha', model: 'mock-1' });
    ctx.agents.register({ id: 'beta', model: 'mock-1' });

    // ① user⇄alpha：conversationId 缺省 = agent
    await ctx.agentLoop.run({ agent: 'alpha', model: 'mock-1', messages: [{ role: 'user', content: 'q' }], conversationId: 'alpha' });
    // ② alpha⇄beta 委托（send_agent 对键形态）
    await ctx.agentLoop.run({ agent: 'beta', model: 'mock-1', messages: [{ role: 'user', content: 'q' }], conversationId: 'alpha~beta' });
    // ③ 迁移行：conv = 对方 agent（counterpart 落在 conversationId）
    await ctx.agentLoop.run({ agent: 'beta', model: 'mock-1', messages: [{ role: 'user', content: 'q' }], conversationId: 'alpha' });
    // ④ 群 gid / 未知名（singles sid）：不进端点对
    await ctx.agentLoop.run({ agent: 'alpha', model: 'mock-1', messages: [{ role: 'user', content: 'q' }], conversationId: 'g-111' });
    await ctx.agentLoop.run({ agent: 'alpha', model: 'mock-1', messages: [{ role: 'user', content: 'q' }], conversationId: 'sid-uuid' });

    const pairs = ctx.usage.byPair();
    const userPair = pairs.find((p) => p.a === 'user' && p.b === 'alpha');
    expect(userPair).toBeDefined();
    expect(userPair!.runs).toBe(1); // ①（③ 是 beta↔alpha 不并入 user 弦）
    const ab = pairs.find((p) => (p.a === 'alpha' && p.b === 'beta'));
    expect(ab).toBeDefined();
    expect(ab!.runs).toBe(2); // ②（对键）+ ③（迁移行）合并同一端点对
    // ④ 群/未知名无端点对
    expect(pairs.some((p) => p.a === 'g-111' || p.b === 'g-111')).toBe(false);
    expect(pairs.some((p) => p.a === 'sid-uuid' || p.b === 'sid-uuid')).toBe(false);
    expect(pairs.length).toBe(2);
  });

  it('回放重建 byPair（重启后端点对聚合不丢）', async () => {
    const root = tmpRoot();
    {
      const { ctx } = await boot(root);
      await ctx.agentLoop.run({ agent: 'x', model: 'mock-1', messages: [{ role: 'user', content: 'q' }], conversationId: 'x~y' });
      await ctx.agentLoop.run({ agent: 'x', model: 'mock-1', messages: [{ role: 'user', content: 'q' }], conversationId: 'x' });
      for (const { fibers } of booted.splice(0)) {
        for (const fiber of [...fibers].reverse()) if (fiber.uid !== null) await fiber.dispose();
      }
    }
    const { ctx } = await boot(root);
    const pairs = ctx.usage.byPair();
    expect(pairs.find((p) => p.a === 'user' && p.b === 'x')?.runs).toBe(1);
    // 无 agents 名册（本 boot 未装）：对键仍可分类（不依赖名册）
    expect(pairs.find((p) => (p.a === 'x' && p.b === 'y'))?.runs).toBe(1);
  });
});
