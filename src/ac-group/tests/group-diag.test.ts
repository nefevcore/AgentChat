// ============================================================
// 诊断测试（2026-09-13 事故，根因 2：视图 stale 后不重派生）
//
// usage 数据（事故日）：nana 的 run 是多个独立短 run（14:17:55 /
// 14:18:06 / 14:19:00 …每个 1-2 步收束）。本测试验证独立 run 间
// 的视图复用链路：post 已入本体 + markViewsStale 后，成员下一次
// startRun（新 run，非链跑）的上下文应含自己的发言（historyFor
// 派生 / contextFor stale 重派生）。
//
// 注意：本测试曾用于区分两种候选根因（回执缺失 vs 视图不重派生）。
// 回执方案已评估并放弃（与视图重派生功能重叠 + 回声 run 开销），
// 本测试锁定的是视图重派生这条主修复链路。
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

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-group-diag-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];

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
        c.llm.register(
          'mock',
          () => ({
            stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
              captured.push(input);
              yield { delta: '收到' };
              yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
            },
          }),
          { models: ['mock-1'] },
        );
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

describe('独立 run 间视图复用诊断（2026-09-13）', () => {
  it('nana 发言后 peer 再发言：nana 第二个独立 run 的种子应含 own 发言（historyFor 派生）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.group.create({ id: 'g', name: '测试群', members: ['nana', 'peer'] });

    // run 1：peer 发言 → nana 空闲开 run（视图建立：不含任何 nana 发言）
    await ctx.group.send('g', 'peer', 'peer 第一句', { settle: true });
    expect(
      captured.some((i) => i.messages.some((m) => String(m.content).includes('peer 第一句'))),
    ).toBe(true);

    // nana 自己 send_group 发言（post：入本体 + markViewsStale）
    await ctx.group.post('g', 'nana', 'nana 的总结 v1');
    // 本体验证：事实行已存在
    const body = await ctx.group.records('g', 50);
    expect(body.some((m) => m.from === 'nana' && m.content === 'nana 的总结 v1')).toBe(true);

    // run 2：peer 再发言 → nana 空闲开新 run
    await ctx.group.send('g', 'peer', 'peer 第二句', { settle: true });
    // ★ 主断言：含"peer 第二句"的 run（nana 的第二个独立 run）上下文
    // 应含 nana 自己的 v1 发言（assistant 角色，own 原文）
    const run2 = captured.filter((i) =>
      i.messages.some((m) => String(m.content).includes('peer 第二句')),
    );
    expect(run2.length).toBeGreaterThanOrEqual(1);
    const seesOwn = run2.some((i) =>
      i.messages.some(
        (m) => m.role === 'assistant' && String(m.content).includes('nana 的总结 v1'),
      ),
    );
    expect(seesOwn).toBe(true);
  });
});
