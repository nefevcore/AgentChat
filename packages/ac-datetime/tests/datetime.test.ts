// ============================================================
// ac-datetime/tests —— 日期注入（cr-1182 批2 全形态统一 before-run）
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
import * as datetimeRow from '../src/index';
import {
  datetimeLine, timeInfoLine, formatElapsed,
} from '../src/index';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];
/** recordContext 捕获面（session 服务替身） */
const recorded: Array<{ id: string; agent: string; content: string; source: string; label?: string }> = [];

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

/** session 替身行：recordContext 捕获到数组 */
function sessionStubRow() {
  return {
    name: 'session-stub',
    apply(c: Context) {
      c.provide('session', {
        recordContext(id: string, agent: string, content: string, extra: { source: string; label?: string }) {
          recorded.push({ id, agent, content, source: extra.source, ...(extra.label !== undefined ? { label: extra.label } : {}) });
        },
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

describe('纯函数', () => {
  it('datetimeLine：仅日期 + 星期（YYYY-MM-DD 周X）', () => {
    expect(datetimeLine(new Date('2026-08-23T10:00:00Z'), 'UTC')).toBe('[当前时间] 2026-08-23 周日');
    expect(datetimeLine(new Date('2026-01-05T23:59:59Z'), 'UTC')).toBe('[当前时间] 2026-01-05 周一');
  });

  it('时区换算：同一时刻不同 tz 墙上日期不同', () => {
    const t = new Date('2026-08-23T20:00:00Z'); // UTC 20:00 = 上海 8/24 04:00
    expect(datetimeLine(t, 'UTC')).toContain('2026-08-23');
    expect(datetimeLine(t, 'Asia/Shanghai')).toContain('2026-08-24');
  });

  it('timeInfoLine：日期 + 时刻 + 间隔', () => {
    const line = timeInfoLine(new Date('2026-08-23T10:30:00Z'), 'UTC', 25 * 60 * 60 * 1000);
    expect(line).toBe('[当前时间] 2026-08-23 周日 10:30（距上次回复已过 25 小时）');
  });

  it('formatElapsed：分钟/小时组合', () => {
    expect(formatElapsed(30_000)).toBe('1 分钟');
    expect(formatElapsed(5 * 60_000)).toBe('5 分钟');
    expect(formatElapsed(60 * 60_000)).toBe('1 小时');
    expect(formatElapsed(90 * 60_000)).toBe('1 小时 30 分钟');
  });

  it('timeInfoLine 间隔格式：小时整 / 小时+分钟', () => {
    expect(timeInfoLine(new Date('2026-08-23T10:30:00Z'), 'UTC', 60 * 60 * 1000)).toContain('已过 1 小时');
  });
});

describe('行为（before-run 注入链）', () => {
  it('有会话键 + session 在场：日期锚落盘；system 不含日期行', async () => {
    captured.length = 0;
    recorded.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), sessionStubRow(), datetimeRow], undefined);
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const system = String(captured[0].messages[0].content);
    expect(system).toBe('BASE'); // DATETIME 段已移除——system 全静态
    expect(recorded).toHaveLength(1);
    expect(recorded[0].source).toBe('datetime');
    expect(recorded[0].content).toMatch(/^\[当前时间\] \d{4}-\d{2}-\d{2} 周[日一二三四五六]$/);
    expect(recorded[0].id).toBe('c1');
  });

  it('conversationId 缺省（子 Agent / loop 直连）→ 不落盘不注入', async () => {
    captured.length = 0;
    recorded.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), sessionStubRow(), datetimeRow], undefined);
    await ctx.agentLoop.run({ model: 'mock-1', system: 'BASE', messages: [{ role: 'user', content: 'hi' }] });
    expect(recorded).toHaveLength(0);
    const system = String(captured[0].messages[0].content);
    expect(system).toBe('BASE');
  });

  it('session 行未装 → 跳过（防重复注入）', async () => {
    captured.length = 0;
    recorded.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), datetimeRow], undefined);
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c2',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(recorded).toHaveLength(0);
    expect(String(captured[0].messages[0].content)).toBe('BASE');
  });

  it('同日第二 run：状态文件已锚定今日 → 不重复落盘', async () => {
    recorded.length = 0;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-dt-'));
    const anchorFile = path.join(root, 'files', '__standard__', 'datetime', '.day-anchor.json');
    fs.mkdirSync(path.dirname(anchorFile), { recursive: true });
    fs.writeFileSync(anchorFile, JSON.stringify({ c3: datetimeLine(new Date(), 'UTC') }), 'utf-8');
    const ctx = new Context();
    await boot(ctx, [...standardRows(), sessionStubRow(), datetimeRow], { root });
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c3',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(recorded).toHaveLength(0);
  });
});

describe('间隔注入（状态文件基准）', () => {
  it('距上次回复 ≥1h → 时间信息行追加到信封尾', async () => {
    captured.length = 0;
    recorded.length = 0;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-dt-'));
    const stateFile = path.join(root, 'files', '__standard__', 'datetime', '.last-reply.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ lastReplyAt: Date.now() - 2 * 60 * 60 * 1000 }), 'utf-8');
    const ctx = new Context();
    await boot(ctx, [...standardRows(), sessionStubRow(), datetimeRow], { root });
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const last = captured[0].messages.at(-1);
    expect(String(last?.content)).toMatch(/\[当前时间\].*距上次回复已过 2 小时/);
  });

  it('距上次回复 <1h → 不注入时间信息行', async () => {
    captured.length = 0;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-dt-'));
    const stateFile = path.join(root, 'files', '__standard__', 'datetime', '.last-reply.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ lastReplyAt: Date.now() - 5 * 60_000 }), 'utf-8');
    const ctx = new Context();
    await boot(ctx, [...standardRows(), sessionStubRow(), datetimeRow], { root });
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const last = captured[0].messages.at(-1);
    expect(String(last?.content)).toBe('hi'); // 尾部仍是用户消息——未注入
  });

  it('after-run 记录最后回复时刻（状态文件）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-dt-'));
    const ctx = new Context();
    await boot(ctx, [...standardRows(), sessionStubRow(), datetimeRow], { root });
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: '__standard__', conversationId: 'c6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const stateFile = path.join(root, 'files', '__standard__', 'datetime', '.last-reply.json');
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as { lastReplyAt: number };
    expect(raw.lastReplyAt).toBeGreaterThan(Date.now() - 60_000);
  });
});
