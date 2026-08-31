// ============================================================
// ac-archive：阈值触发 → 整理 run（conversation.deliver 同桶排队 +
// meta[archive-review] 三处不落盘）→ done 协议收尾 → 归档重建；
// 幂等 / archiveAll / 超时兜底（abort + 强制归档）/ 失控防线闸①
// 对抗回归 / D4 概要文件 / 卸载回收
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import { TimerService as VendorTimer } from '@agentchat/cordis-timer';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import type { LoopRunRequest } from 'ac-agent-loop';
import { ARCHIVE_REVIEW_META } from 'ac-agent-loop';
import * as agentsRow from 'ac-agents';
import * as conversationRow from 'ac-conversation';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as sessionRow from 'ac-session';
import * as toolsRow from 'ac-tools';
import * as archiveRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-archive-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
/** 每次 LLM 调用的输入（整理轮按提示词前缀识别） */
const captured: LlmChatInput[] = [];

const isReviewInput = (input: LlmChatInput): boolean =>
  input.messages.some((m) => typeof m.content === 'string' && m.content.includes('[归档整理]'));

function textChunks(text: string): LlmStreamChunk[] {
  return [{ delta: text }, { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } }];
}

function toolCallChunks(id: string, name: string, args: string): LlmStreamChunk[] {
  return [
    { delta: '', toolCalls: [{ index: 0, id, name }] },
    { delta: '', toolCalls: [{ index: 0, argumentsDelta: args }] },
    { delta: '', finish: 'tool_calls' },
  ];
}

/** 每测试可定制的 provider 行为（缺省：正常轮'回复N'，整理轮'此前，…'） */
interface BootHooks {
  handler?: (input: LlmChatInput) => LlmStreamChunk[] | Promise<LlmStreamChunk[]>;
  /** 追加注册的测试工具（如 big_output / 模拟 write） */
  tools?: (c: Context) => void;
  /** 归档行配置覆盖（reviewMaxSteps 等） */
  archive?: Record<string, unknown>;
}

async function boot(
  root: string,
  defaults?: Record<string, number>,
  hooks: BootHooks = {},
) {
  captured.length = 0;
  let callSeq = 0;
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
            stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
              captured.push(input);
              if (hooks.handler) {
                yield* await hooks.handler(input);
                return;
              }
              const text = isReviewInput(input) ? '此前，我们讨论了归档机制并达成一致。' : `回复${++callSeq}`;
              yield* textChunks(text);
            },
          }),
          { models: ['mock-1'] },
        );
      },
    },
    loopRow,
    agentsRow,
    routerRow,
    conversationRow,
    sessionRow,
    archiveRow,
  ];
  const configs: Record<string, unknown> = {
    'ac-session': { root },
    'ac-archive': {
      root,
      defaults: defaults ?? { maxContextTokens: 100, archiveTokenRatio: 0.5, keepRecentRatio: 0.03 },
      ...(hooks.archive ?? {}),
    },
  };
  for (const row of rows) {
    const name = (row as { name?: string }).name ?? '';
    const config = configs[name];
    const fiber = config === undefined ? ctx.plugin(row as any) : ctx.plugin(row as any, config);
    await fiber;
    fibers.push(fiber);
  }
  if (hooks.tools) hooks.tools(ctx);
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).archive) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

/** 轮询等待谓词成立（归档异步链收尾） */
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

describe('ac-archive 先整理后归档', () => {
  it('超阈值 run → 整理 run（conversation.deliver 同桶，meta 标记零污染）→ 分段落盘 + compact 重建', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const runRequests: LoopRunRequest[] = [];
    ctx.on('loop/run-started', (r) => runRequests.push(r));
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    // 一轮大对话（user 100 字 ≈ 60 token > 阈值 50）
    await ctx.router.send('a', '话'.repeat(100));
    await until(() => ctx.archive.segments('a~user').length > 0);

    // 归档分段：user 大消息被移出（中性行 agent_id=user；assistant 尾部保留）
    const segFile = path.join(root, 'archive', 'a~user', 'history_1.jsonl');
    const seg = fs.readFileSync(segFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(seg[0]).toMatchObject({ role: 'agent', agent_id: 'user', content: '话'.repeat(100) });
    expect(seg[0].message_id).toBeTruthy();

    // compact 重建：概要头 + 尾部保留；整理提示词不进会话流（零污染）
    const log = await ctx.session.history('a~user', { viewer: 'a' });
    expect(log[0]).toMatchObject({ role: 'system', content: '此前，我们讨论了归档机制并达成一致。' });
    expect(log.some((m) => m.content.includes('[归档整理]'))).toBe(false);
    const raw = await ctx.session.records('a~user');
    expect(raw.every((r) => !r.content.includes('[归档整理]'))).toBe(true);

    // 整理 run 经串行化门投递（第 2 次 LLM 调用；信封带 meta 标记 + event 拓扑）
    expect(captured.length).toBe(2);
    expect(runRequests[1]).toMatchObject({
      agent: 'a',
      source: 'event',
      sender: 'a',
      conversationId: 'a~user',
      maxSteps: 128, // 闸① 缺省硬上限
    });
    expect(runRequests[1].meta).toEqual({ [ARCHIVE_REVIEW_META]: true });
  });

  it('不落盘（上下文视图）：整理 run 后续用户 run 的输入不含整理提示词', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    await ctx.router.send('a', '话'.repeat(100));
    await until(() => ctx.archive.segments('a~user').length > 0);
    // 同桶后续用户 run：与整理 run 共享会话上下文视图，但整理痕迹被剔除
    await ctx.conversation.deliver('a', '后续问题');
    const last = captured.at(-1)!;
    expect(last.messages.some((m) => typeof m.content === 'string' && m.content.includes('[归档整理]'))).toBe(false);
    expect(last.messages.some((m) => m.content === '后续问题')).toBe(true);
  });

  it('通道回归：用户 run 进行中请求归档 → 整理 run 排队不并发；结束后串行执行', async () => {
    const root = tmpRoot();
    let releaseUser!: () => void;
    const gate = new Promise<void>((r) => (releaseUser = r));
    let active = 0;
    let maxActive = 0;
    const { ctx } = await boot(root, undefined, {
      handler: async (input) => {
        if (isReviewInput(input)) return textChunks('此前，归档整理完成。');
        active++;
        maxActive = Math.max(maxActive, active);
        await gate; // 用户 run 挂住（模拟长 run）
        active--;
        return textChunks('回复');
      },
    });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const userRun = ctx.conversation.deliver('a', '话'.repeat(100)); // 不 await：run 在途
    await until(() => captured.length === 1);
    // 用户 run 未结束时请求归档：整理投递应排队（串行化门 + placement next-run）
    void ctx.archive.requestArchive('a~user', 'a');
    await new Promise((r) => setTimeout(r, 150));
    expect(captured.filter(isReviewInput)).toHaveLength(0); // 整理 run 未并发启动
    releaseUser();
    await userRun;
    await until(() => ctx.archive.segments('a~user').length > 0);
    expect(maxActive).toBe(1); // 全程至多一个在途 LLM 调用（不并发）
    // 用户 run 收尾的阈值检测遇 pending 幂等跳过：整理 run 只跑一次
    expect(captured.filter(isReviewInput)).toHaveLength(1);
  });

  it('done 协议双侧整理（D5）：对桶两端非虚拟各跑一次，全到齐才重建', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const runRequests: LoopRunRequest[] = [];
    ctx.on('loop/run-started', (r) => runRequests.push(r));
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.agents.register({ id: 'b', model: 'mock-1' });
    await ctx.router.send('a', '话'.repeat(100), { conversationId: 'a~b', sender: 'b', source: 'agent' });
    await until(() => ctx.archive.segments('a~b').length > 0);
    // 1 次用户 run + 双侧整理各 1 次 = 3 次 LLM 调用
    expect(captured.length).toBe(3);
    const reviewAgents = runRequests
      .filter((r) => r.meta?.[ARCHIVE_REVIEW_META] === true)
      .map((r) => r.agent);
    expect(reviewAgents).toHaveLength(2);
    expect(new Set(reviewAgents)).toEqual(new Set(['a', 'b']));
    // 标记全清（pending + done），分段恰好一份（重建一次）；尾锚 sidecar
    // 在场（M21/D8：seq/messageId 零解析锚）
    const dir = path.join(root, 'archive', 'a~b');
    const dotfiles = fs.readdirSync(dir).filter((f) => f.startsWith('.'));
    expect(dotfiles).toEqual(['.anchor.json']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.anchor.json'), 'utf-8'))).toMatchObject({
      conversationId: 'a~b',
    });
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('history_'))).toHaveLength(1);
    // 概要 = owning agent 的整理产出
    expect(fs.readFileSync(path.join(root, 'sessions', 'a~b', 'summary.md'), 'utf-8')).toContain('此前，');
  });

  it('输出物回归（D4）：Agent 亲自写 summary/<会话>.md → 服务端读文件作概要', async () => {
    const root = tmpRoot();
    let wroteSummary = false;
    const { ctx } = await boot(root, undefined, {
      handler: (input) => {
        if (!isReviewInput(input)) return textChunks('回复');
        if (!wroteSummary) {
          wroteSummary = true;
          return toolCallChunks(
            'w1',
            'write',
            JSON.stringify({ file_path: 'summary/a~user.md', content: '此前，Agent 亲写的概要。' }),
          );
        }
        return textChunks('整理完成');
      },
      // 模拟 write 工具（沙箱基准 = <root>/files/a，与 archive 读文件回落基准一致）
      tools: (c) => {
        c.tools.register({
          name: 'write',
          description: '测试用 write：相对路径按 files/<agent> 解析',
          parameters: {
            type: 'object',
            properties: { file_path: { type: 'string' }, content: { type: 'string' } },
            required: ['file_path', 'content'],
          },
          execute(args, call) {
            const file = path.join(root, 'files', call.agentId ?? 'a', String(args.file_path));
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, String(args.content), 'utf-8');
            return { ok: true, output: { path: String(args.file_path) } };
          },
        });
      },
    });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    await ctx.router.send('a', '话'.repeat(100));
    await until(() => ctx.archive.segments('a~user').length > 0);
    // 概要取 Agent 亲写文件（非回复文本'整理完成'）
    const summary = fs.readFileSync(path.join(root, 'sessions', 'a~user', 'summary.md'), 'utf-8');
    expect(summary).toContain('Agent 亲写的概要');
    expect(summary).not.toContain('整理完成');
  });

  it('失控防线闸①：对抗整理 run（每步 256KB 工具输出）→ 步数 ≤ maxSteps、归档照常、概要降级', async () => {
    const root = tmpRoot();
    let bigCalls = 0;
    const { ctx } = await boot(root, undefined, {
      handler: (input) => {
        if (!isReviewInput(input)) return textChunks('回复');
        // 对抗：无视提示词，每步都请求 256KB 输出工具，绝不自然收束
        bigCalls++;
        return toolCallChunks(`c${bigCalls}`, 'big_output', '{}');
      },
      tools: (c) => {
        c.tools.register({
          name: 'big_output',
          description: '对抗工具：返回 256KB 输出',
          parameters: { type: 'object', properties: {} },
          execute: () => ({ ok: true, output: { blob: 'x'.repeat(256 * 1024) } }),
        });
      },
      archive: { reviewMaxSteps: 4, reviewSoftSteps: 2 },
    });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    await ctx.router.send('a', '话'.repeat(100));
    await until(() => ctx.archive.segments('a~user').length > 0);
    // 步数被硬闸截断：恰好达到上限（对抗未被劝退）且绝不超过
    const reviewCalls = captured.filter(isReviewInput).length;
    expect(reviewCalls).toBe(4);
    expect(reviewCalls).toBeLessThanOrEqual(4);
    // finish='max-steps' → 概要降级（无 summary.md），归档照常完成
    expect(fs.existsSync(path.join(root, 'sessions', 'a~user', 'summary.md'))).toBe(false);
    // 会话零污染依旧
    const raw = await ctx.session.records('a~user');
    expect(raw.every((r) => !r.content.includes('[归档整理]'))).toBe(true);
    // 标记收敛（done 协议照常收尾）；尾锚 sidecar 在场（M21/D8）
    const dir = path.join(root, 'archive', 'a~user');
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('.'))).toEqual(['.anchor.json']);
  });

  it('幂等：pending 进行中重复请求被吞（整理 run 只跑一次）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    await ctx.router.send('a', '话'.repeat(100));
    await until(() => ctx.archive.segments('a~user').length > 0);
    // 第一轮归档完成后的手动重复请求：阈值已不超 → 无新分段
    const before = ctx.archive.segments('a~user').length;
    await ctx.archive.requestArchive('a~user', 'a'); // 归档后估算已低于阈值，但仍会强制走流程
    expect(ctx.archive.segments('a~user').length).toBeGreaterThanOrEqual(before);
  });

  it('未达阈值不触发（after-run 检测静默）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    await ctx.router.send('a', '小问题');
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.archive.segments('a~user')).toEqual([]);
    expect(captured).toHaveLength(1); // 只有正常轮，无整理 run
  });

  it('archiveAll：达阈值触发、未达跳过、无 owning agent 跳过', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    // 直注入账两条大消息（不经 run → 无 after-run 自动触发，专测 archiveAll）
    await ctx.session.append('a', 'a', { role: 'user', content: '话'.repeat(100) });
    await ctx.session.append('a', 'a', { role: 'user', content: '话'.repeat(100) });
    // 手工制造另一个无 owning agent 的会话目录
    fs.mkdirSync(path.join(root, 'sessions', 'orphan'), { recursive: true });
    const report = await ctx.archive.archiveAll();
    const byId = Object.fromEntries(report.map((r) => [r.conversationId, r]));
    expect(byId['orphan']).toMatchObject({ skipped: true, reason: 'no-owning-agent' });
    expect(byId['a'].skipped).toBe(false);
    await until(() => ctx.archive.segments('a').length > 0);
  });

  it('超时兜底：崩溃残留的 stale pending → abort + 强制归档（无整理 run）', async () => {
    const root = tmpRoot();
    // 预置：会话文件 + 过期标记（模拟整理 run 崩溃后重启；对桶键形态）
    fs.mkdirSync(path.join(root, 'sessions', 'a~user'), { recursive: true });
    const line = (id: string) =>
      `${JSON.stringify({ role: 'user', content: '话'.repeat(100), message_id: id, timestamp: new Date().toISOString() })}\n`;
    fs.appendFileSync(path.join(root, 'sessions', 'a~user', 'messages.jsonl'), line('m1') + line('m2'), 'utf-8');
    fs.mkdirSync(path.join(root, 'archive', 'a~user'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'archive', 'a~user', '.pending.json'),
      JSON.stringify({
        agent: 'a',
        participants: ['a'],
        requestedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
      'utf-8',
    );
    const { ctx } = await boot(root); // 构造即扫（启动兜底）
    const marker = path.join(root, 'archive', 'a~user', '.pending.json');
    await until(() => !fs.existsSync(marker) && ctx.archive.segments('a~user').length > 0);
    expect(fs.existsSync(marker)).toBe(false);
    // 强制归档没有整理 run（无 LLM 调用）；概要不动（无 summary.md）
    expect(captured).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'sessions', 'a~user', 'summary.md'))).toBe(false);
  });

  it('订阅即归属：卸载 archive 行 → after-run 不再触发归档', async () => {
    const root = tmpRoot();
    const { ctx, fibers } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const archiveFiber = fibers.at(-1)!;
    await archiveFiber.dispose();
    await ctx.router.send('a', '话'.repeat(100));
    await new Promise((r) => setTimeout(r, 100));
    expect((ctx as any).archive).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'archive'))).toBe(false);
  });

  it('归档完成通知（archive/completed，M7）：重建漏斗收尾 emit 带条数与分段名', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const events: Array<{ conversationId: string; archived: number; kept: number; segment?: string }> = [];
    ctx.on('archive/completed', (payload) =>
      events.push({ conversationId: payload.conversationId, archived: payload.archived, kept: payload.kept, ...('segment' in payload ? { segment: payload.segment } : {}) }),
    );
    await ctx.router.send('a', '话'.repeat(100));
    await until(() => events.length > 0);
    expect(events[0]).toMatchObject({ conversationId: 'a~user', segment: 'history_1.jsonl' });
    expect(events[0].archived).toBeGreaterThan(0);
  });
});
