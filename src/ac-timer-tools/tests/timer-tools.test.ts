// ============================================================
// ac-timer-tools：timer 工具 set/list/disable（映射 ctx.timers）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import { TimerService as VendorTimer } from '@agentchat/cordis-timer';
import * as agentsRow from 'ac-agents';
import * as agentStoreRow from 'ac-agent-store';
import * as configRow from 'ac-config';
import * as conversationRow from 'ac-conversation';
import * as routerRow from 'ac-router';
import * as loopRow from 'ac-agent-loop';
import * as llmRow from 'ac-llm';
import * as toolsRow from 'ac-tools';
import * as timersRow from 'ac-timer';
import * as timerToolsRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-timer-tools-'));
  tmps.push(dir);
  return dir;
}

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: unknown[] = [
    VendorTimer,
    toolsRow,
    llmRow,
    loopRow,
    agentsRow,
    agentStoreRow,
    configRow,
    routerRow,
    conversationRow,
    timersRow,
    timerToolsRow,
  ];
  const configs: Record<string, unknown> = {
    'ac-agent-store': { root },
    'ac-config': { root },
    'ac-timer': { root },
  };
  for (const row of rows) {
    const name = (row as { name?: string }).name ?? '';
    const fiber =
      configs[name] === undefined ? ctx.plugin(row as any) : ctx.plugin(row as any, configs[name]);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).timers && (ctx as any).tools) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  ctx.agents.register({ id: 'a', model: 'mock-1' });
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

describe('ac-timer-tools：timer 工具三 action', () => {
  it('set → list → disable 全链（条目落 agent-store；disable 后 enabled=false）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const call = { agentId: 'a', conversationId: 'a' };

    const set = await ctx.tools.execute({
      name: 'timer',
      args: { action: 'set', id: 't1', mode: 'delay', delay: '1h', hint: '该干活了 {{time}}' },
      ...call,
    });
    expect(set.ok).toBe(true);
    expect(ctx.timers.entries('a')).toMatchObject([{ id: 't1', mode: 'delay', hint: '该干活了 {{time}}' }]);

    const list = await ctx.tools.execute({ name: 'timer', args: { action: 'list' }, ...call });
    expect(list.ok).toBe(true);
    expect((list.output as { entries: Array<{ id: string }> }).entries[0].id).toBe('t1');

    const disable = await ctx.tools.execute({
      name: 'timer',
      args: { action: 'disable', id: 't1' },
      ...call,
    });
    expect(disable.ok).toBe(true);
    // disable 后内存清单为空（ac-timer 只保 enabled 条目）；store 留存禁用条目
    expect(ctx.timers.entries('a')).toHaveLength(0);
    const stored = ctx.agentStore.readEntry<{ entries: Array<{ id: string; enabled: boolean }> }>('a', 'timer');
    expect(stored?.entries[0]).toMatchObject({ id: 't1', enabled: false });
  });

  it('set 更新同 id 覆盖；缺 hint 拒绝；未知 action 报错', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const call = { agentId: 'a', conversationId: 'a' };
    await ctx.tools.execute({
      name: 'timer',
      args: { action: 'set', id: 't9', mode: 'time', time: '08:00', hint: '晨报' },
      ...call,
    });
    await ctx.tools.execute({
      name: 'timer',
      args: { action: 'set', id: 't9', mode: 'workday', time: '09:30', hint: '工作日提醒' },
      ...call,
    });
    expect(ctx.timers.entries('a')).toHaveLength(1);
    expect(ctx.timers.entries('a')[0]).toMatchObject({ mode: 'workday', time: '09:30' });

    const noHint = await ctx.tools.execute({
      name: 'timer',
      args: { action: 'set', mode: 'delay' },
      ...call,
    });
    expect(noHint.ok).toBe(false);
    const bad = await ctx.tools.execute({ name: 'timer', args: { action: 'zap' }, ...call });
    expect(bad.ok).toBe(false);
  });

  it('无执行身份拒绝', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await ctx.tools.execute({ name: 'timer', args: { action: 'list' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('执行身份');
  });
});
