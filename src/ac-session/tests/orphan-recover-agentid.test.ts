// ============================================================
// 孤儿 run 恢复 agent_id 数据源（cr-45）：journal 行内直存 agentId
// 优先——singles 桶（uuid 键，无 ~）从桶键推导拿到桶键本身 ≠ 运行
// Agent，段行空 content + agent_id 不匹配 viewer → history() 整轮
// 跳过（09-29 回放丢失事故：宿主被 agent 停止重启后 run2 轨迹失忆）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
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
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  }
});

async function boot() {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, llmRow, agentsRow, loopRow, routerRow] as unknown[]) {
    const fiber = ctx.plugin(row as never, {} as never);
    await fiber;
    fibers.push(fiber);
  }
  {
    const fiber = ctx.plugin(sessionRow, { root: tmp });
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return ctx;
}

describe('孤儿 run 恢复段行 agent_id（cr-45：journal 行内 agentId 优先）', () => {
  it('singles 桶（uuid 键）：孤儿恢复物化段行 agent_id = journal 步行 agentId（非桶键），history(viewer=运行 Agent) 可见轨迹', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-orphan-agentid-'));
    const ctx = await boot();
    const conv = 'sid-1234'; // singles 形态桶键：无 ~（旧推导拿到桶键本身）
    const runAgent = '__standard__'; // 真实运行 Agent（singles agentId 空 → 默认预设）
    ctx.emit('router/message-received', runAgent, { role: 'user', content: '继续' }, conv, 'user', 'user');
    ctx.emit('loop/run-started', { agent: runAgent, conversationId: conv, sender: 'user', source: 'user' } as never);
    ctx.emit('loop/after-step', runAgent, {
      index: 0, text: '干活中', reasoning: '思考', ts: Date.now(),
      toolCalls: [{ id: 'call-1', name: 'read', arguments: '{}' }],
      toolResults: [],
    } as never, { conversationId: conv, sender: 'user', source: 'user' });
    await ctx.session.records(conv); // journal 落盘
    // 模拟进程死亡：簿记清空（recoverJournal 只收口非活跃 run）
    for (const k of [...(ctx as any).session ? [] : []]) { void k; }
    const svc = (ctx as any).session as { activeRuns: Map<string, unknown> };
    svc.activeRuns.clear();
    // 新进程 records：触发孤儿恢复物化
    await ctx.session.records(conv);
    // 段行 agent_id 必须是运行 Agent（修复前 = 桶键 'sid-1234'）
    const file = join(tmp, 'sessions', conv, 'messages.jsonl');
    const segLine = readFileSync(file, 'utf-8').split('\n').find((l) => l.includes('"run":"run-'));
    expect(segLine).toBeDefined();
    expect(JSON.parse(segLine!).agent_id).toBe(runAgent);
    // 决定性断言：history(viewer=运行 Agent) 投出该轮轨迹（修复前空 content 段行被跳过）
    const hist = await ctx.session.history(conv, { viewer: runAgent });
    expect(hist.some((m) => m.role === 'assistant' && m.content.includes('干活中'))).toBe(true);
  });

  it('对桶（a~user）：journal agentId 缺席回落桶键推导（行为同旧，不回归）', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-orphan-legacy-'));
    const ctx = await boot();
    const conv = 'a~user';
    ctx.emit('router/message-received', 'a', { role: 'user', content: '帮我' }, conv, 'user', 'user');
    ctx.emit('loop/run-started', { agent: 'a', conversationId: conv, sender: 'user', source: 'user' } as never);
    ctx.emit('loop/after-step', 'a', {
      index: 0, text: '步内容', ts: Date.now(),
      toolCalls: [],
      toolResults: [],
    } as never, { conversationId: conv, sender: 'user', source: 'user' });
    await ctx.session.records(conv);
    const svc = (ctx as any).session as { activeRuns: Map<string, unknown> };
    svc.activeRuns.clear();
    await ctx.session.records(conv);
    const hist = await ctx.session.history(conv, { viewer: 'a' });
    expect(hist.some((m) => m.role === 'assistant' && m.content.includes('步内容'))).toBe(true);
  });
});
