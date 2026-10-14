// ============================================================
// 回放口径镜像交叉锁定（cr-424）：ac-archive-core replayTokensOf
// 自称"镜像 history() 注入形状"——两侧手工镜像（ac-session 拥有注入
// 真形，估算器住纯库）。本测试用同份记录语料逐行对照可见性：
//   replayTokensOf(r, viewer) === 0  ⇒ 该行内容不出现于 history() 注入
//   replayTokensOf(r, viewer) > 0    ⇒ 行内容（或轨迹末步内容）出现
// 轨迹展开一行产多行 LlmMessage，按内容出现性判定不受展开影响。
// 体积口径由 ac-archive-core 包内测试锁定，此处只锁可见性同构。
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Context } from '@agentchat/cordis';
import * as sessionRow from 'ac-session';
import { replayTokensOf, estimateReplayTokens } from 'ac-archive-core';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-parity-'));
}

async function boot(root: string) {
  const ctx = new Context();
  const fiber = ctx.plugin(sessionRow, { root });
  await fiber;
  for (let i = 0; i < 1000; i++) {
    if ((ctx as unknown as Record<string, unknown>).session) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  return { ctx, fiber };
}

/** 覆盖全部可见性分支的记录语料（与真实落盘行同构；content 唯一可作出现性锚） */
const CORPUS: Array<Record<string, unknown>> = [
  { role: 'agent', content: '用户提问', agent_id: 'user', message_id: 'm1', seq: 1 },
  { role: 'agent', content: '助手答', agent_id: 'a', message_id: 'm2', seq: 2 },
  // 空 content + 轨迹（viewer 自有 = 中断/max-steps 收束行；行 content 空、内容在末步）
  { role: 'agent', content: '', agent_id: 'a', message_id: 'm3', seq: 3, steps: [
    { content: '步一', toolCalls: [{ id: 'c1', name: 'bash', arguments: '{}', result: 'ok' }] },
    { content: '轨迹终' },
  ] },
  // partial 悬空（工具执行中进程死亡）——全视角不回放
  { role: 'agent', content: '中断残留', agent_id: 'a', message_id: 'm4', seq: 4, partial: true, steps: [
    { content: 's', toolCalls: [{ id: 'c2', name: 'bash', arguments: '{}', result: null }] },
  ] },
  { role: 'event', content: '发给 b 的 hint', agent_id: 'b', message_id: 'm5', seq: 5 },
  // context 双来源 × 双投递目标（cr-424 修复锚：估算器此前只滤 event）
  { role: 'context', source: 'skill', content: '给 a 的技能正文', agent_id: 'a', message_id: 'm6', seq: 6 },
  { role: 'context', source: 'skill', content: '给 b 的技能正文', agent_id: 'b', message_id: 'm7', seq: 7 },
  { role: 'context', source: 'event', content: '机制通知', message_id: 'm8', seq: 8 },
  { role: 'event', content: '广播 hint', message_id: 'm9', seq: 9 },
  { role: 'agent', content: '   ', agent_id: 'b', message_id: 'm10', seq: 10, steps: [{ content: 'b 的轨迹' }] },
];

function seed(root: string, conv: string): void {
  const file = path.join(root, 'sessions', conv, 'messages.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session-header', version: 1, createdAt: new Date(0).toISOString() }),
    ...CORPUS.map((r) => JSON.stringify(r)),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
}

/** 行的主内容锚：轨迹行（replaySteps 形态）= 末步 content，否则行 content */
function mainAnchor(r: Record<string, unknown>): string {
  const steps = Array.isArray(r.steps) ? (r.steps as Array<{ content?: unknown }>) : [];
  if (r.role === 'agent' && !String(r.content ?? '').trim() && steps.length > 0) {
    return String(steps[steps.length - 1].content ?? '');
  }
  return String(r.content ?? '');
}

describe('ac-session history() × ac-archive-core replayTokensOf 镜像锁定（cr-424）', () => {
  for (const viewer of ['a', 'b', undefined] as const) {
    it(`逐行可见性同构：estimator 判 0 的行不注入、判 >0 的行注入（viewer=${viewer ?? '匿名'}）`, async () => {
      const root = tmpRoot();
      const { ctx } = await boot(root);
      seed(root, 'a~b');
      const records = await ctx.session.records('a~b');
      const rows = await ctx.session.history('a~b', viewer !== undefined ? { viewer } : {});
      const injected = rows.map((m) => String(m.content ?? ''));
      for (let i = 0; i < CORPUS.length; i++) {
        const anchor = mainAnchor(CORPUS[i]);
        const est = replayTokensOf(records[i] as never, viewer);
        if (est === 0) {
          expect(injected).not.toContain(anchor);
        } else {
          expect(injected).toContain(anchor);
        }
      }
      // 会话合计与逐行一致（同 viewer 口径）
      const total = estimateReplayTokens(records, viewer);
      expect(total).toBe(records.reduce((n, r) => n + replayTokensOf(r, viewer), 0));
    });
  }

  it('context 行视点过滤：给 b 的技能注入不进 a 的注入形状——修复锚（cr-424 前估算器计入对端）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    seed(root, 'a~b');
    const forA = await ctx.session.history('a~b', { viewer: 'a' });
    expect(forA.map((m) => String(m.content ?? ''))).not.toContain('给 b 的技能正文');
    const records = await ctx.session.records('a~b');
    const ctxRow = records.find((r) => r.message_id === 'm7') as never;
    expect(replayTokensOf(ctxRow, 'a')).toBe(0);
    expect(replayTokensOf(ctxRow, 'b')).toBeGreaterThan(0);
  });
});
