// ============================================================
// ac-session：事件行 journal（读侧折叠已退役，cr-315 方案A）
// eventReplay='journal' 的语义移交 ac-archive 轮数滚动归档
// （maybeRollup：机制行攒 2×keep 触发整理 + 物理剪裁）——history()
// 恒全量投影，不再有折叠摘要行；本文件锚定读侧行为 + 设置读取口。
// 滚动归档端到端行为见 ac-archive/tests/journal-rollup.integration.test.ts。
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

describe('ac-session 事件行 journal（读侧折叠已退役）', () => {
  it('journal 模式：history 恒全量投影——无折叠摘要行，event 原文全部回放（滚动归档归 ac-archive）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'news', model: 'none', settings: { session: { eventReplay: 'journal' } } });
    for (let i = 1; i <= 10; i++) feedEvent(ctx, 'news~news', 'news', `触发 ${i}`);
    const log = await ctx.session.history('news~news', { viewer: 'news' });
    expect(log.filter((m) => m.content.startsWith('触发'))).toHaveLength(10);
    expect(log.some((m) => m.content.includes('[机制运行日志]'))).toBe(false); // 折叠摘要行已退役
  });

  it('设置读取口：eventReplayOf / eventJournalKeepOf（rollup 触发口的配置消费面）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({
      id: 'news', model: 'none',
      settings: { session: { eventReplay: 'journal', eventJournalKeep: 3 } },
    });
    ctx.agents.register({ id: 'other', model: 'none' });
    expect(ctx.session.eventReplayOf('news')).toBe('journal');
    expect(ctx.session.eventJournalKeepOf('news')).toBe(3);
    expect(ctx.session.eventReplayOf('other')).toBe('full');
    expect(ctx.session.eventJournalKeepOf('other')).toBe(6); // 缺省
  });

  it('full（缺省）零变化：全部 event 原文回放', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'news', model: 'none' });
    for (let i = 1; i <= 10; i++) feedEvent(ctx, 'news~news', 'news', `触发 ${i}`);
    const log = await ctx.session.history('news~news', { viewer: 'news' });
    expect(log.filter((m) => m.content.startsWith('触发'))).toHaveLength(10);
  });
});
