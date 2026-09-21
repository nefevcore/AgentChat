// ============================================================
// ac-group 群记忆收敛（2026-10）：记忆属主生命周期 + 属主整理轮转
//（[群归档整理] run → 语义概要覆写 + compact 重建 + pending 收口）
// + 超时兜底机械回退 + 无属主现状对照（共享注入锚用例在 memory.test.ts）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import { TimerService as VendorTimer } from '@agentchat/cordis-timer';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import { ARCHIVE_REVIEW_META } from 'ac-agent-loop';
import * as agentsRow from 'ac-agents';
import * as conversationRow from 'ac-conversation';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as sessionRow from 'ac-session';
import * as toolsRow from 'ac-tools';
import * as groupRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-group-memory-'));
  tmps.push(dir);
  return dir;
}

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

function textChunks(text: string): LlmStreamChunk[] {
  return [{ delta: text }, { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } }];
}

function toolCallChunks(id: string, name: string): LlmStreamChunk[] {
  return [
    { delta: '', toolCalls: [{ index: 0, id, name }] },
    { delta: '', toolCalls: [{ index: 0, argumentsDelta: '{}' }] },
    { delta: '', finish: 'tool_calls' },
  ];
}

const isReviewInput = (input: LlmChatInput): boolean =>
  input.messages.some((m) => typeof m.content === 'string' && m.content.includes('[群归档整理]'));

interface BootOpts {
  /** 整理轮 provider 行为（write 回调直接落盘模拟 write 工具；缺省 = 亲写概要后收束） */
  reviewHandler?: (input: LlmChatInput, write: (rel: string, content: string) => void) => LlmStreamChunk[];
  group?: Record<string, unknown>;
}

async function boot(root: string, opts: BootOpts = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<{ name?: string; inject?: string[]; apply?: (c: Context) => void }> = [
    VendorTimer as unknown as { name?: string },
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
              if (isReviewInput(input)) {
                // 模拟 write 工具落点（无 workspace 行 → 相对路径按 files/<owner> 解析，
                // 与 anchorOutput/ownerSummaryFile 的回落基准一致）
                const write = (rel: string, content: string) => {
                  const file = path.join(root, 'files', 'a', rel);
                  fs.mkdirSync(path.dirname(file), { recursive: true });
                  fs.writeFileSync(file, content, 'utf-8');
                };
                if (opts.reviewHandler !== undefined) {
                  yield* opts.reviewHandler(input, write);
                  return;
                }
                write('summary/g.md', '此前，属主整理的群语义概要。');
                yield* textChunks('整理完成');
                return;
              }
              yield* textChunks('群回复');
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
    const name = (row as { name?: string }).name;
    const config =
      name === 'ac-group'
        ? { root, archiveTokens: 50, keepTokens: 5, ...(opts.group ?? {}) }
        : name === 'ac-session'
          ? { root }
          : undefined;
    const fiber = config === undefined ? ctx.plugin(row as any) : ctx.plugin(row as any, config);
    await fiber;
    fibers.push(fiber);
  }
  ctx.agents.register({ id: 'a', model: 'mock-1' });
  ctx.agents.register({ id: 'b', model: 'mock-1' });
  ctx.agents.register({ id: 'c', model: 'mock-1' }); // 已注册但非群成员
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).group && (ctx as any).conversation) break;
    await new Promise((r) => setTimeout(r, 1));
  }
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

async function disposeAll() {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
}

afterEach(async () => {
  await disposeAll();
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('记忆属主生命周期', () => {
  it('setMemoryOwner：设定/幂等/解除 + 校验 + 事件 + 持久化回读；owner 退群自动解除', async () => {
    const root = tmpRoot();
    {
      const { ctx } = await boot(root);
      ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b'] });
      const events: Array<string | undefined> = [];
      ctx.on('group/memory-owner-set', (_gid, owner) => events.push(owner));
      // 非成员/未注册拒绝
      expect(() => ctx.group.setMemoryOwner('g', 'ghost')).toThrow(/未注册/);
      expect(() => ctx.group.setMemoryOwner('g', 'c')).toThrow(/不是群/);
      // 设定 + 幂等（幂等不重发事件）
      expect(ctx.group.setMemoryOwner('g', 'a').memoryOwner).toBe('a');
      expect(ctx.group.setMemoryOwner('g', 'a').memoryOwner).toBe('a');
      // owner 退群 → 自动解除（member-removed 后随 memory-owner-set undefined）
      ctx.group.leave('g', 'a');
      expect(ctx.group.get('g')?.memoryOwner).toBeUndefined();
      expect(events).toEqual(['a', undefined]);
      // create 支持带属主；非成员属主拒绝
      ctx.group.create({ id: 'g2', name: '书房', members: ['a', 'b'], memoryOwner: 'b' });
      expect(ctx.group.get('g2')?.memoryOwner).toBe('b');
      expect(() => ctx.group.create({ id: 'g3', name: '走廊', members: ['a'], memoryOwner: 'b' })).toThrow(
        /不是群/,
      );
      // 解除（幂等：已无属主再解除 = no-op）
      ctx.group.setMemoryOwner('g2', undefined);
      expect(ctx.group.get('g2')?.memoryOwner).toBeUndefined();
      expect(events).toEqual(['a', undefined, undefined]);
      // 恢复属主供持久化断言
      ctx.group.setMemoryOwner('g2', 'b');
    }
    await disposeAll();
    {
      const { ctx } = await boot(root);
      expect(ctx.group.get('g2')?.memoryOwner).toBe('b'); // group.json 回读
      expect(ctx.group.get('g')?.memoryOwner).toBeUndefined();
    }
  });
});

describe('属主整理轮转（[群归档整理] run → 语义概要 + compact）', () => {
  it('达阈值 → 属主整理 run 亲写概要覆写 summary_N.md → compact 重建 + pending 收口；historyFor 头部为语义概要', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b'], memoryOwner: 'a' });
    for (let i = 0; i < 8; i++) await ctx.group.post('g', 'user', `第${i}条消息内容比较长会占token`);

    const archiveDir = path.join(root, 'groups', 'g', 'archive');
    await until(() => !fs.existsSync(path.join(archiveDir, '.pending.json')));
    // 归档分段 + 语义概要覆写机械摘要（属主亲写文件被服务端读取采纳）
    expect(fs.existsSync(path.join(archiveDir, 'history_1.jsonl'))).toBe(true);
    const summary = fs.readFileSync(path.join(archiveDir, 'summary_1.md'), 'utf-8');
    expect(summary).toContain('属主整理的群语义概要');
    expect(summary).not.toContain('早期摘要');
    // 本体 compact（尾部保留，少于 8 行）
    const bucket = path.join(root, 'sessions', 'groups', 'g', 'messages.jsonl');
    const lines = fs.readFileSync(bucket, 'utf-8').trim().split('\n');
    expect(lines.length - 1).toBeLessThan(8);
    // historyFor 头部 = 语义概要（全体成员的长期记忆入口）
    const history = await ctx.group.historyFor('g', 'b');
    expect(history[0].content).toContain('属主整理的群语义概要');
  });

  it('整理 run 信封：conversationId=群 id、source=event、meta[archive-review]、maxSteps 硬闸；不落盘', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const envelopes: Array<{ agent?: string; conversationId?: string; source?: string; sender?: string; meta?: Record<string, unknown>; maxSteps?: number }> = [];
    ctx.on('loop/run-started', (r) => envelopes.push(r));
    ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b'], memoryOwner: 'a' });
    for (let i = 0; i < 8; i++) await ctx.group.post('g', 'user', `第${i}条消息内容比较长会占token`);
    await until(() => envelopes.some((e) => e.meta?.[ARCHIVE_REVIEW_META] === true));
    const review = envelopes.find((e) => e.meta?.[ARCHIVE_REVIEW_META] === true)!;
    expect(review).toMatchObject({ agent: 'a', conversationId: 'g', source: 'event', sender: 'a' });
    expect(review.maxSteps).toBe(128);
    // 不落盘：整理提示词/回复不入群本体
    const recs = await ctx.group.records('g', 100);
    expect(recs.every((r) => !r.content.includes('[群归档整理]'))).toBe(true);
    expect(recs.every((r) => !r.content.includes('整理完成'))).toBe(true);
    await until(() => !fs.existsSync(path.join(root, 'groups', 'g', 'archive', '.pending.json')));
  });

  it('属主未亲写概要 → 回退整理回复文本作概要（D4 同款回退链）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, {
      reviewHandler: (_input, _write) => textChunks('此前，回复文本形式的概要。'),
    });
    ctx.group.create({ id: 'g', name: '客厅', members: ['a'], memoryOwner: 'a' });
    for (let i = 0; i < 8; i++) await ctx.group.post('g', 'user', `第${i}条消息内容比较长会占token`);
    const archiveDir = path.join(root, 'groups', 'g', 'archive');
    await until(() => !fs.existsSync(path.join(archiveDir, '.pending.json')));
    const summary = fs.readFileSync(path.join(archiveDir, 'summary_1.md'), 'utf-8');
    expect(summary).toContain('回复文本形式的概要');
    expect(summary).not.toContain('早期摘要');
  });

  it('整理 run 未正常收束（max-steps）→ 概要降级保留机械摘要，轮转照常', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, {
      // 对抗：每步都调未注册工具，绝不自然收束 → maxSteps 硬闸截断
      reviewHandler: () => toolCallChunks('c', 'no_such_tool'),
      group: { reviewMaxSteps: 3 },
    });
    ctx.group.create({ id: 'g', name: '客厅', members: ['a'], memoryOwner: 'a' });
    for (let i = 0; i < 8; i++) await ctx.group.post('g', 'user', `第${i}条消息内容比较长会占token`);
    const archiveDir = path.join(root, 'groups', 'g', 'archive');
    await until(() => !fs.existsSync(path.join(archiveDir, '.pending.json')));
    const summary = fs.readFileSync(path.join(archiveDir, 'summary_1.md'), 'utf-8');
    expect(summary).toContain('早期摘要'); // 机械摘要保留（降级）
    // 轮转照常完成（本体已 compact）
    const bucket = path.join(root, 'sessions', 'groups', 'g', 'messages.jsonl');
    expect(fs.readFileSync(bucket, 'utf-8').trim().split('\n').length - 1).toBeLessThan(8);
  });

  it('无属主群维持机械摘要轮转（现状语义不变，无整理漏斗）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.group.create({ id: 'g', name: '客厅', members: ['a'] });
    for (let i = 0; i < 8; i++) await ctx.group.post('g', 'user', `第${i}条消息内容比较长会占token`);
    const archiveDir = path.join(root, 'groups', 'g', 'archive');
    await until(() => fs.existsSync(path.join(archiveDir, 'summary_1.md')));
    const summary = fs.readFileSync(path.join(archiveDir, 'summary_1.md'), 'utf-8');
    expect(summary).toContain('早期摘要'); // 机械产物
    expect(fs.existsSync(path.join(archiveDir, '.pending.json'))).toBe(false); // 无整理漏斗
  });

  it('超时兜底：崩溃残留 pending → 机械回退强制轮转（keepFromSeq 锚保留尾部；概要不动；无 LLM 整理）', async () => {
    const root = tmpRoot();
    // 预置：本体（header + 中性行）+ 群配置（带属主）+ 归档段/机械摘要 + 过期 pending
    const bucketDir = path.join(root, 'sessions', 'groups', 'g');
    fs.mkdirSync(bucketDir, { recursive: true });
    const header = `${JSON.stringify({ type: 'session-header', version: 1, conversationId: 'g' })}\n`;
    const line = (id: string, seq: number) =>
      `${JSON.stringify({ role: 'agent', agent_id: 'user', content: '话'.repeat(40), message_id: id, timestamp: new Date().toISOString(), seq })}\n`;
    fs.writeFileSync(path.join(bucketDir, 'messages.jsonl'), header + line('m1', 1) + line('m2', 2) + line('m3', 3), 'utf-8');
    fs.mkdirSync(path.join(root, 'groups', 'g', 'archive'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'groups', 'g', 'group.json'),
      `${JSON.stringify({ id: 'g', name: '客厅', members: ['a'], memoryOwner: 'a', createdAt: 0 }, null, 2)}\n`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(root, 'groups', 'g', 'archive', 'history_1.jsonl'),
      `${JSON.stringify({ role: 'agent', agent_id: 'user', content: '话'.repeat(40), message_id: 'm0', timestamp: new Date().toISOString(), seq: 0 })}\n`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(root, 'groups', 'g', 'archive', 'summary_1.md'),
      '# 群聊 g 早期摘要（崩溃前的机械回退产物）\n\n- [t] user: …\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(root, 'groups', 'g', 'archive', '.pending.json'),
      JSON.stringify({
        owner: 'a',
        requestedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        index: 1,
        keepFromSeq: 2,
        baselineSeq: 3,
      }),
      'utf-8',
    );
    const { ctx } = await boot(root, { group: { reviewTimeoutMs: 60_000 } });
    await until(() => !fs.existsSync(path.join(root, 'groups', 'g', 'archive', '.pending.json')));
    // 机械回退强制轮转：keepFromSeq=2 → 本体只留 m2/m3 尾部；概要不动（机械原样）
    const lines = fs.readFileSync(path.join(bucketDir, 'messages.jsonl'), 'utf-8').trim().split('\n');
    const ids = lines.slice(1).map((l) => JSON.parse(l).message_id);
    expect(ids).toEqual(['m2', 'm3']);
    expect(fs.readFileSync(path.join(root, 'groups', 'g', 'archive', 'summary_1.md'), 'utf-8')).toContain(
      '崩溃前的机械回退产物',
    );
    // 无整理 run（构造扫描不投递 LLM）
    const recs = await ctx.group.records('g', 100);
    expect(recs.every((r) => !r.content.includes('[群归档整理]'))).toBe(true);
  });
});
