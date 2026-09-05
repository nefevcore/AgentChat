// ============================================================
// ac-timer：5 模式排程 / 一次性归档 / 机制任务直调 / 停机补偿 /
// workday 门控 / 条目持久化（agent-store）/ 卸载回收
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import { TimerService as VendorTimer } from '@agentchat/cordis-timer';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as agentStoreRow from 'ac-agent-store';
import * as configRow from 'ac-config';
import * as conversationRow from 'ac-conversation';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as toolsRow from 'ac-tools';
import * as timersRow from '../src/index.ts';
import { GLOBAL_TIMER_OWNER } from '../src/service.ts';
import type { TimerEntry } from 'ac-timer-core';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-timer-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
/** router/message-received 捕获（[content, conversationId]） */
const received: Array<{ content: string; conversationId: string }> = [];

/** 机制任务 mock：ctx.archive */
let archiveCalls = 0;

class FakeArchiveService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'archive');
  }
  archiveAll(): Promise<string[]> {
    archiveCalls++;
    return Promise.resolve(['a']);
  }
}

async function boot(root: string, config: Record<string, unknown> = {}) {
  received.length = 0;
  archiveCalls = 0;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [
    VendorTimer as unknown as Record<string, unknown>,
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
              yield { delta: '定时回复' };
              yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
            },
          }),
          { models: ['mock-1'] },
        );
      },
    },
    loopRow,
    agentsRow,
    agentStoreRow,
    configRow,
    routerRow,
    conversationRow,
    FakeArchiveService as unknown as Record<string, unknown>,
    timersRow,
  ];
  const configs: Record<string, unknown> = {
    'ac-agent-store': { root },
    'ac-config': { root },
    'ac-timer': { root, heartbeatMs: 40, ...config },
  };
  for (const row of rows) {
    const name = (row as { name?: string }).name ?? '';
    const fiber =
      configs[name] === undefined ? ctx.plugin(row as any) : ctx.plugin(row as any, configs[name]);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 2000; i++) {
    if ((ctx as any).timers) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  ctx.agents.register({ id: 'a', model: 'mock-1' });
  ctx.on('router/message-received', (_agentId, message, conversationId) => {
    received.push({ content: message.content, conversationId });
  });
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

async function until(pred: () => boolean, ms = 5000): Promise<void> {
  for (let i = 0; i < ms; i += 10) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('等待超时');
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-timer 排程与触发', () => {
  it('delay 条目到期 → conversation.deliver(sender:event) → 事件链照常（session 记账通道可见）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.timers.save('a', [
      { id: 't1', enabled: true, mode: 'delay', delay: '40ms', hint: '该干活了 {{time}}', repeatCount: 3 },
    ]);
    await until(() => received.length > 0);
    // Agent 自触发 → 自会话键 a~a（与 user 1v1 桶分离，M18 前端反馈 #2）
    expect(received[0].conversationId).toBe('a~a');
    expect(received[0].content).toContain('该干活了');
    // 状态文件已持久化排程态（delay 恢复依据）
    await until(() => {
      const state = JSON.parse(fs.readFileSync(path.join(root, 'timer', 'state.json'), 'utf-8'));
      return state['a/t1']?.startedAt !== undefined;
    });
    expect(ctx.timers.entries('a')).toHaveLength(1);
  });

  it('一次性条目完成后归档：条目从 store 摘除 + timer-archive 记录', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.timers.save('a', [{ id: 'once', enabled: true, mode: 'delay', delay: '30ms', hint: '一次', repeatCount: 1 }]);
    await until(() => received.length > 0);
    await until(() => (ctx.agentStore.readEntry<{ entries: TimerEntry[] }>('a', 'timer')?.entries ?? []).every((e) => e.id !== 'once'));
    const archive = ctx.agentStore.readEntry<Array<{ id: string; status: string; executedCount: number }>>('a', 'timer-archive');
    expect(archive).toMatchObject([{ id: 'once', status: 'completed', executedCount: 1 }]);
    // 内存缓存同步摘除（src 教训：只改磁盘不同步缓存 → 条目复活循环归档）
    expect(ctx.timers.entries('a').find((e) => e.id === 'once')).toBeUndefined();
  });

  it('机制任务直调：entry.task=archive-all → ctx.archive.archiveAll()（不过 LLM）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.timers.save('a', [
      { id: 'm1', enabled: true, mode: 'delay', delay: '30ms', hint: '', task: 'archive-all' },
    ]);
    await until(() => archiveCalls > 0);
    expect(received).toEqual([]); // 不走 LLM / 不产生会话消息
    expect(ctx.timers.entries('a')).toHaveLength(1); // 机制任务条目不归档（无限期）
  });

  it("全局 '*' 广播排除预设与虚拟 Agent：不产生 __standard__ 自会话桶", async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'b', model: 'mock-1' });
    ctx.agents.register({ id: 'user', virtual: true });
    ctx.agents.register({ id: '__standard__', model: 'mock-1', preset: true }); // 预设（独立会话路由目标）
    ctx.timers.save(GLOBAL_TIMER_OWNER, [
      { id: 'g1', enabled: true, mode: 'delay', delay: '30ms', hint: '全局唤醒', target: '*' },
    ]);
    await until(() => received.length > 0);
    // 命中常规 Agent 的自会话桶；预设/虚拟端点被 '*' 过滤
    const convs = new Set(received.map((r) => r.conversationId));
    expect(convs.has('a~a')).toBe(true);
    expect(convs.has('b~b')).toBe(true);
    expect(convs.has('__standard__~__standard__')).toBe(false);
    expect(fs.existsSync(path.join(root, 'sessions', '__standard__~__standard__'))).toBe(false);
  });

  it('save 全量覆盖 + 重排：清单更新即生效（旧条目停、新条目起）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.timers.save('a', [{ id: 'old', enabled: true, mode: 'delay', delay: '40ms', hint: '旧条目' }]);
    await until(() => received.length > 0);
    expect(received[0].content).toBe('旧条目');
    // 全量覆盖：旧条目消失，新条目 40ms 后触发
    ctx.timers.save('a', [{ id: 'new', enabled: true, mode: 'delay', delay: '40ms', hint: '新条目' }]);
    await until(() => received.some((r) => r.content === '新条目'));
    expect(ctx.timers.entries('a').map((e) => e.id)).toEqual(['new']);
    // store 持久化形态（ADR-5：不写 config.json，走 agentStore entry）
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'agents', 'a', 'timer.json'), 'utf-8'));
    expect(stored.entries.map((e: TimerEntry) => e.id)).toEqual(['new']);
  });

  it('停机补偿：过期 delay 状态 + 旧心跳 → 构造即补触发', async () => {
    const root = tmpRoot();
    const now = Date.now();
    // 预置：agent-store 条目 + 过期状态（10 分钟前心跳、11 分钟前已到期的 delay）
    fs.mkdirSync(path.join(root, 'agents', 'a'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'agents', 'a', 'timer.json'),
      JSON.stringify({
        entries: [{ id: 'd1', enabled: true, mode: 'delay', delay: '1m', hint: '补偿我' }],
      }),
      'utf-8',
    );
    fs.mkdirSync(path.join(root, 'timer'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'timer', 'state.json'),
      JSON.stringify({
        _heartbeat: { lastTriggeredAt: new Date(now - 10 * 60_000).toISOString() },
        'a/d1': {
          startedAt: new Date(now - 11 * 60_000).toISOString(),
          totalDelayMs: 60_000,
          executedCount: 0,
        },
      }),
      'utf-8',
    );
    await boot(root);
    await until(() => received.length > 0);
    expect(received[0].content).toBe('补偿我');
  });

  it('卸载回收：dispose 后不再触发（叠官方 cordis-timer 的 fiber 归属）', async () => {
    const root = tmpRoot();
    const { ctx, fibers } = await boot(root);
    ctx.timers.save('a', [{ id: 'r1', enabled: true, mode: 'delay', delay: '60ms', hint: '重复' }]);
    await until(() => received.length > 0);
    const timersFiber = fibers.at(-1)!;
    await timersFiber.dispose();
    const count = received.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(received.length).toBe(count); // 卸载后排程全停
    expect((ctx as any).timers).toBeUndefined();
  });

  it('per-Agent 时区分层：settings.timers.timezone 覆盖行基线（记账时间戳随 owner 时区）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root); // 行基线缺省 Asia/Shanghai
    ctx.agents.register({
      id: 'utc-agent',
      model: 'mock-1',
      settings: { timers: { timezone: 'UTC' } },
    });
    ctx.timers.save('utc-agent', [
      { id: 'tz1', enabled: true, mode: 'delay', delay: '10m', hint: 'x' },
    ]);
    ctx.timers.save('a', [
      { id: 'tz2', enabled: true, mode: 'delay', delay: '10m', hint: 'x' },
    ]);
    // delay 排程即写 startedAt（owner 生效时区）——state.json 落盘即验证
    const state = JSON.parse(fs.readFileSync(path.join(root, 'timer', 'state.json'), 'utf-8')) as Record<string, { startedAt?: string }>;
    expect(state['utc-agent/tz1']?.startedAt).toMatch(/\+00:00$/); // 差异层 UTC
    expect(state['a/tz2']?.startedAt).toMatch(/\+08:00$/); // 无差异层 → 行基线上海
  });
});
