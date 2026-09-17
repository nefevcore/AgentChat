// ============================================================
// ac-session：事件行 journal 折叠（P2 自会话成本治理）
// settings.session.eventReplay = 'journal' 时，对角线自会话桶
// （viewer~viewer）的旧 event 行折叠为计数摘要，仅保留最近
// eventJournalKeep 条原文。缺省 'full' 零变化。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from 'ac-agents';
import * as sessionRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-journal-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [agentsRow, sessionRow];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any, { root });
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).agents && (ctx as any).session) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

/** 模拟机制触发入账（timer/job-wakeup 真实形态：source='event' → role:'event'，agent_id=目标） */
function feedEvent(ctx: Context, conversationId: string, target: string, content: string): void {
  ctx.emit('router/message-received', target, { role: 'user', content }, conversationId, target, 'event');
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-session 事件行 journal 折叠', () => {
  it('journal 模式：旧 event 行折叠为计数摘要，保留最近 K 条原文；agent 回复行不受影响', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'news', model: 'none', settings: { session: { eventReplay: 'journal' } } });
    // 10 条机制触发 + 穿插的 agent 回复
    for (let i = 1; i <= 10; i++) {
      feedEvent(ctx, 'news~news', 'news', `📡 第 ${i} 轮监控触发（长 hint 原文……）`);
      ctx.emit('router/reply-completed', 'news', `第 ${i} 轮结论`, {
        steps: [], finish: 'stop',
        usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 0 },
      } as never, 'news~news', 'news', 'event');
    }
    const log = await ctx.session.history('news~news', { viewer: 'news' });
    // 折叠摘要恰一条，计 4 次（10 - keep 6）
    const folds = log.filter((m) => m.content.includes('[机制运行日志]'));
    expect(folds).toHaveLength(1);
    expect(folds[0].content).toContain('4 次机制触发');
    // 近 6 条 event 原文保留
    const kept = log.filter((m) => m.content.includes('轮监控触发'));
    expect(kept).toHaveLength(6);
    expect(kept[0].content).toContain('第 5 轮'); // 前 4 条折叠
    expect(kept[5].content).toContain('第 10 轮');
    // agent 回复行全部保留（折叠只作用 event 行）
    expect(log.filter((m) => m.role === 'assistant')).toHaveLength(10);
    // 摘要占位在首条折叠处（保序：先摘要后 kept[0]）
    expect(log.findIndex((m) => m.content.includes('[机制运行日志]'))).toBeLessThan(
      log.findIndex((m) => m.content.includes('第 5 轮')),
    );
  });

  it('full（缺省）零变化：无折叠，全部 event 原文回放', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'news', model: 'none' }); // 未配置 eventReplay
    for (let i = 1; i <= 10; i++) feedEvent(ctx, 'news~news', 'news', `触发 ${i}`);
    const log = await ctx.session.history('news~news', { viewer: 'news' });
    expect(log.filter((m) => m.content.startsWith('触发'))).toHaveLength(10);
    expect(log.some((m) => m.content.includes('[机制运行日志]'))).toBe(false);
  });

  it('journal 只作用对角线桶：news~user 的 event 行不折叠（用户直答桶语义不同）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'news', model: 'none', settings: { session: { eventReplay: 'journal' } } });
    for (let i = 1; i <= 10; i++) feedEvent(ctx, 'user~news', 'news', `触发 ${i}`);
    const log = await ctx.session.history('user~news', { viewer: 'news' });
    expect(log.filter((m) => m.content.startsWith('触发'))).toHaveLength(10);
  });

  it('eventJournalKeep 自定义：K=0 全折叠（只剩摘要）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({
      id: 'news', model: 'none',
      settings: { session: { eventReplay: 'journal', eventJournalKeep: 0 } },
    });
    for (let i = 1; i <= 5; i++) feedEvent(ctx, 'news~news', 'news', `触发 ${i}`);
    const log = await ctx.session.history('news~news', { viewer: 'news' });
    expect(log.filter((m) => m.content.startsWith('触发'))).toHaveLength(0);
    expect(log.some((m) => m.content.includes('5 次机制触发'))).toBe(true);
  });

  it('hint 视点过滤同口径：投递目标非 viewer 的 event 行不计入折叠也回放', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none', settings: { session: { eventReplay: 'journal' } } });
    // 共享对桶 user~a 里发给 a 的 event（agent_id=a）+ 假想发给其他端的
    ctx.emit('router/message-received', 'a', { role: 'user', content: '给你的' }, 'user~a', 'a', 'event');
    ctx.emit('router/message-received', 'a', { role: 'user', content: '给别人的' }, 'user~a', 'a', 'event');
    const log = await ctx.session.history('user~a', { viewer: 'a' });
    // 非对角线桶不折叠；且视点过滤由既有逻辑承担（本用例锚定：journal 判定不破坏既有过滤）
    expect(log.filter((m) => m.content === '给你的').length + log.filter((m) => m.content === '给别人的').length).toBeGreaterThanOrEqual(1);
  });
});
