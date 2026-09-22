// steer-dropped 兜底落账的门控回归：机制 run / 群 hint 的 steer 未消费时
// 不入会话（与 step-started 消费点、after-run 兜底同款 meta 门控）。
// 普通用户的未消费 steer 仍兜底落账（不丢用户事实）。
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import { GROUP_HINT_META } from 'ac-core-utils';
import * as llmRow from 'ac-llm';
import * as toolsRow from 'ac-tools';
import * as loopRow from 'ac-agent-loop';
import * as agentsRow from 'ac-agents';
import * as routerRow from 'ac-router';
import * as sessionRow from 'ac-session';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
let tmp = '';
afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) { if (fiber.uid !== null) await fiber.dispose(); }
  }
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = ''; }
});
async function boot() {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, llmRow, agentsRow, loopRow, routerRow] as unknown[]) {
    const fiber = ctx.plugin(row as never, {} as never); await fiber; fibers.push(fiber);
  }
  { const fiber = ctx.plugin(sessionRow, { root: tmp }); await fiber; fibers.push(fiber); }
  booted.push({ ctx, fibers });
  ctx.agents.register({ id: 'a', model: 'none' });
  return ctx;
}
const msgFile = () => join(tmp, 'sessions', 'a~user', 'messages.jsonl');
const readMsgs = () => (existsSync(msgFile()) ? readFileSync(msgFile(), 'utf-8') : '');
const runStarted = { agent: 'a', conversationId: 'a~user', sender: 'user', source: 'user' } as never;

describe('steer-dropped 兜底落账门控（机制/群 hint 不入会话）', () => {
  it('群 hint 的未消费 steer → dropped 兜底不落账', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-drop-hint-'));
    const ctx = await boot();
    ctx.emit('loop/run-started', runStarted);
    const msg = { role: 'user', content: '群hint未消费内容' } as never;
    ctx.emit('conversation/steered', 'a', msg, 'a~user', 'h1', 'user', 'user', { [GROUP_HINT_META]: true });
    ctx.emit('loop/steer-dropped', 'a', 'a~user', 'h1', [{ message: msg, sender: 'user', source: 'user' }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(readMsgs()).not.toContain('群hint未消费内容');
  });

  it('机制标记（archive review）的未消费 steer → dropped 兜底不落账', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-drop-arch-'));
    const ctx = await boot();
    ctx.emit('loop/run-started', runStarted);
    const msg = { role: 'user', content: '归档整理未消费内容' } as never;
    ctx.emit('conversation/steered', 'a', msg, 'a~user', 'h2', 'user', 'user', { 'archive-review': true });
    ctx.emit('loop/steer-dropped', 'a', 'a~user', 'h2', [{ message: msg, sender: 'user', source: 'user' }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(readMsgs()).not.toContain('归档整理未消费内容');
  });

  it('普通用户的未消费 steer → dropped 兜底照常落账（对照——门控不放走真实事实）', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-drop-user-'));
    const ctx = await boot();
    ctx.emit('loop/run-started', runStarted);
    const msg = { role: 'user', content: '用户中途补充' } as never;
    ctx.emit('conversation/steered', 'a', msg, 'a~user', 'h3', 'user', 'user', undefined);
    ctx.emit('loop/steer-dropped', 'a', 'a~user', 'h3', [{ message: msg, sender: 'user', source: 'user' }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(readMsgs()).toContain('用户中途补充');
  });
});
