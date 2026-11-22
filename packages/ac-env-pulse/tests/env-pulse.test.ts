// ============================================================
// ac-env-pulse/tests —— 环境脉搏注入行测试（cr-1182 批3）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as toolsRow from 'ac-tools';
import * as envPulseRow from '../src/index';
import { appendSystemEvent } from 'ac-system-events';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];
const recorded: Array<{ id: string; agent: string; content: string; source: string }> = [];

function scriptedProvider() {
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      yield { delta: 'ok' };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

async function boot(ctx: Context, rows: unknown[], options?: Record<string, unknown>) {
  const fibers: Fiber[] = [];
  for (const row of rows) {
    const fiber = options === undefined ? ctx.plugin(row as any) : ctx.plugin(row as any, options);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return fibers;
}

function standardRows() {
  return [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] });
      },
    },
    agentsRow,
    loopRow,
  ];
}

// cr-1251：recordContext 双写退役——落账面 = 订阅 inject-consumed 收集（模拟 ledger）
function sessionStubRow() {
  return {
    name: 'session-stub',
    apply(c: Context) {
      c.provide('session', {});
      c.on('loop/inject-consumed', (agent, conversationId, _runId, consumed) => {
        for (const it of consumed) recorded.push({ id: conversationId ?? '', agent: agent ?? '', content: String(it.message.content), source: it.meta.injectSource });
      });
    },
  };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

function freshRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-ep-'));
}

describe('env-pulse 注入链', () => {
  it('首 run：只初始化水位、不注历史、不注入', async () => {
    captured.length = 0;
    recorded.length = 0;
    const root = freshRoot();
    appendSystemEvent(root, 'host-boot', { pid: 1 });
    appendSystemEvent(root, 'shell-start', { pid: 2 }, '__standard__');
    const ctx = new Context();
    await boot(ctx, [...standardRows(), sessionStubRow(), envPulseRow], { root });
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(recorded).toHaveLength(0);
    const anchor = path.join(root, 'files', '__standard__', 'env-pulse', '.anchors.json');
    expect(JSON.parse(fs.readFileSync(anchor, 'utf-8'))).toEqual({ c1: 2 });
  });

  it('delta 事件 → [系统状态] 注入（落账 + user 行）+ 水位推进', async () => {
    captured.length = 0;
    recorded.length = 0;
    const root = freshRoot();
    const ctx = new Context();
    await boot(ctx, [...standardRows(), sessionStubRow(), envPulseRow], { root });
    // 首 run 初始化水位
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c2',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // 事件增量
    appendSystemEvent(root, 'host-boot', { pid: 100 });
    appendSystemEvent(root, 'rowset-changed', { summary: '新增行 foo' });
    captured.length = 0;
    recorded.length = 0;
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c2',
      messages: [{ role: 'user', content: 'again' }],
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].source).toBe('system-event');
    expect(recorded[0].content).toContain('宿主重启完成');
    expect(recorded[0].content).toContain('行集变化：新增行 foo');
    const last = captured[0].messages.at(-1);
    expect(String(last?.content)).toContain('[系统状态]');
    expect(String(last?.content)).toContain('宿主重启完成');
    // 水位推进
    const anchor = path.join(root, 'files', '__standard__', 'env-pulse', '.anchors.json');
    expect((JSON.parse(fs.readFileSync(anchor, 'utf-8')) as Record<string, number>).c2).toBe(2);
  });

  it('cr-1233 dryRun（previewSystemPrompt 干跑）→ 不初始化水位、后续真实 run 照常收 delta', async () => {
    captured.length = 0;
    recorded.length = 0;
    const root = freshRoot();
    appendSystemEvent(root, 'host-boot', { pid: 1 });
    const ctx = new Context();
    await boot(ctx, [...standardRows(), sessionStubRow(), envPulseRow], { root });
    // 干跑（预览形态：无消息 + dryRun）——不得初始化水位
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c-dry',
      messages: [], dryRun: true,
    });
    expect(recorded).toHaveLength(0);
    const anchor = path.join(root, 'files', '__standard__', 'env-pulse', '.anchors.json');
    expect(fs.existsSync(anchor)).toBe(false);
    // 真实 run 到来：首注语义照常（水位初始化，不注历史）——预览没吃掉水位
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c-dry',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(recorded).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(anchor, 'utf-8'))).toEqual({ 'c-dry': 1 });
  });

  it('无增量 → 不注入', async () => {
    captured.length = 0;
    recorded.length = 0;
    const root = freshRoot();
    const ctx = new Context();
    await boot(ctx, [...standardRows(), sessionStubRow(), envPulseRow], { root });
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c3',
      messages: [{ role: 'user', content: 'hi' }],
    });
    captured.length = 0;
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c3',
      messages: [{ role: 'user', content: 'again' }],
    });
    expect(recorded).toHaveLength(0);
    const last = captured[0].messages.at(-1);
    expect(String(last?.content)).toBe('again');
  });

  it('会话各自水位独立（c4 已注、c5 首注只初始化）', async () => {
    captured.length = 0;
    recorded.length = 0;
    const root = freshRoot();
    appendSystemEvent(root, 'host-boot', { pid: 1 });
    const ctx = new Context();
    await boot(ctx, [...standardRows(), sessionStubRow(), envPulseRow], { root });
    // c4 首注初始化（seq 1）
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // 新事件
    appendSystemEvent(root, 'shell-start', { pid: 9 }, '__standard__');
    recorded.length = 0;
    captured.length = 0;
    // c5 首注：只初始化（水位 = 2），不注 delta
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c5',
      messages: [{ role: 'user', content: 'first' }],
    });
    expect(recorded).toHaveLength(0);
    // c4 二注：注 delta（seq 2）
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c4',
      messages: [{ role: 'user', content: 'second' }],
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].content).toContain('你的 Agent 壳重启');
  });

  it('conversationId 缺省 → 不注入（水位不动）', async () => {
    recorded.length = 0;
    const root = freshRoot();
    appendSystemEvent(root, 'host-boot', { pid: 1 });
    const ctx = new Context();
    await boot(ctx, [...standardRows(), sessionStubRow(), envPulseRow], { root });
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', messages: [{ role: 'user', content: 'hi' }],
    });
    expect(recorded).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'files', '__standard__', 'env-pulse'))).toBe(false);
  });

  it('session 行未装 → 不注入', async () => {
    captured.length = 0;
    recorded.length = 0;
    const root = freshRoot();
    appendSystemEvent(root, 'host-boot', { pid: 1 });
    const ctx = new Context();
    await boot(ctx, [...standardRows(), envPulseRow], { root });
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(recorded).toHaveLength(0);
  });
});
