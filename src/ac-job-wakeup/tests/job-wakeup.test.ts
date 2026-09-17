// ============================================================
// ac-job-wakeup：job/settled → conversation.deliver（source:'event'，
// M19/D2：自会话桶 pairKey(owner, owner)）唤醒 owner；无 owner /
// conversation 未装 = 跳过
// ============================================================
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import { TimerService as VendorTimer } from '@agentchat/cordis-timer';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as conversationRow from 'ac-conversation';
import * as jobsRow from 'ac-jobs';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as toolsRow from 'ac-tools';
import * as wakeupRow from '../src/index.ts';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];
/** 假 conversation：记录投递 */
let delivered: Array<{ agent: string; message: string; sender: string; source?: string; conversationId?: string }> = [];

class FakeConversationService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'conversation');
  }
  deliver(agent: string, message: string, options: { sender?: string; source?: string; conversationId?: string } = {}) {
    delivered.push({
      agent,
      message,
      sender: options.sender ?? 'user',
      ...(options.source !== undefined ? { source: options.source } : {}),
      ...(options.conversationId !== undefined ? { conversationId: options.conversationId } : {}),
    });
    return Promise.resolve({ kind: 'run' as const });
  }
}

async function boot(opts: { withConversation?: boolean } = {}) {
  delivered = [];
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: unknown[] = [
    VendorTimer,
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register(
          'mock',
          () => ({
            stream: async function* (_: LlmChatInput): AsyncIterable<LlmStreamChunk> {
              yield { delta: 'ok' };
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
    jobsRow,
    ...(opts.withConversation === false ? [] : [FakeConversationService]),
    wakeupRow,
  ];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).jobs && (ctx as any).tools) break;
    await new Promise((r) => setTimeout(r, 1));
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
});

/** 立即完成的任务 */
function settleNow(ctx: Context, ownerAgentId?: string, conversationId?: string): void {
  ctx.jobs.start({
    kind: 'bash',
    label: 'echo hi',
    ...(ownerAgentId ? { ownerAgentId } : {}),
    ...(conversationId ? { conversationId } : {}),
    run: () => ({
      cancel: () => {},
      done: Promise.resolve({ status: 'completed' as const, detail: 'exit code: 0' }),
    }),
  });
}

describe('ac-job-wakeup', () => {
  it('有 owner 的任务 settle → deliver(source:event，自会话桶) 通知 owner；无 owner 跳过', async () => {
    const { ctx } = await boot();
    settleNow(ctx, 'a');
    settleNow(ctx); // 无主——不唤醒
    await new Promise((r) => setTimeout(r, 30));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ agent: 'a', sender: 'a', source: 'event', conversationId: 'a~a' });
    expect(delivered[0].message).toContain('[系统通知]');
    expect(delivered[0].message).toContain('完成');
    expect(delivered[0].message).toContain('exit code: 0');
  });

  it('回投发起会话（2026-09-02 反馈 #2）：job.conversationId 优先——a⇋b 里起的任务，通知回 a⇋b 而非 owner 自会话桶', async () => {
    const { ctx } = await boot();
    // b(admin) 在 a⇋b 会话（user~admin）里启动后台任务
    settleNow(ctx, 'admin', 'admin~user');
    await new Promise((r) => setTimeout(r, 30));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      agent: 'admin',
      sender: 'admin',
      source: 'event',
      conversationId: 'admin~user', // 发起会话，不是 admin~admin
    });
  });

  it('conversation 未装（行组合可选）→ 静默跳过不炸', async () => {
    const { ctx } = await boot({ withConversation: false });
    expect(() => settleNow(ctx, 'a')).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toHaveLength(0);
  });

  it('卸载 wakeup 行 → 不再唤醒（订阅即归属）', async () => {
    const { ctx, fibers } = await boot();
    const wakeupFiber = fibers.at(-1)!;
    await wakeupFiber.dispose();
    settleNow(ctx, 'a');
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toHaveLength(0);
  });

  it('合并窗口：同 owner+会话的第二条起暂存，窗口收束补投 digest（2 次唤醒替代 N 次）', async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = await boot();
      settleNow(ctx, 'a'); // 首条：立即投递
      settleNow(ctx, 'a'); // 后续：暂存
      settleNow(ctx, 'a'); // 暂存
      settleNow(ctx, 'b'); // 不同 owner：独立窗口，首条照常投递
      await vi.advanceTimersByTimeAsync(10);
      expect(delivered).toHaveLength(2); // a 首条 + b 首条（无中间投递）
      expect(delivered[0].message).toContain('完成');
      // 窗口收束 → a 的 digest 补投
      await vi.advanceTimersByTimeAsync(5_100);
      expect(delivered).toHaveLength(3);
      const digest = delivered[2];
      expect(digest.agent).toBe('a');
      expect(digest.conversationId).toBe('a~a');
      expect(digest.message).toContain('另有 2 个后台任务收束');
      // digest 之后新 settled → 新窗口首条（不丢通知）
      settleNow(ctx, 'a');
      await vi.advanceTimersByTimeAsync(10);
      expect(delivered).toHaveLength(4);
      expect(delivered[3].message).toContain('[系统通知] 后台任务');
    } finally {
      vi.useRealTimers();
    }
  });

  it('合并窗口按会话分桶：a⇋b 与 a~a 不互相暂存', async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = await boot();
      settleNow(ctx, 'a', 'a~b'); // a 在 a~b 的首条
      settleNow(ctx, 'a');        // a 自会话桶首条（不同键 = 各自立即投）
      await vi.advanceTimersByTimeAsync(10);
      expect(delivered).toHaveLength(2);
      expect(delivered[0].conversationId).toBe('a~b');
      expect(delivered[1].conversationId).toBe('a~a');
      await vi.advanceTimersByTimeAsync(5_100);
      expect(delivered).toHaveLength(2); // 无暂存 → 无 digest
    } finally {
      vi.useRealTimers();
    }
  });
});
