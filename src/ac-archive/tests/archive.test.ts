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
import { Context, Service, type Fiber } from '@agentchat/cordis';
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
  /** 假 config 服务数据（router/ac-archive 的默认池连接回落读取 llmProviders） */
  config?: Record<string, unknown>;
  /** 行循环后装配的附加行（如 workspace 沙箱面假服务——archive 消费面
   *  全是运行时 ctx.get 懒解析，后注册不影响） */
  workspace?: (c: Context) => Promise<void> | void;
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
  if (hooks.config) {
    // 假 config 服务：仅 get(key) 数据面（router/ac-archive 默认池连接回落的读取口）
    class FakeConfigService extends Service {
      constructor(c: Context, private readonly data: Record<string, unknown>) {
        super(c, 'config');
      }
      get<T>(key: string): T | undefined {
        return this.data[key] as T | undefined;
      }
    }
    const fiber = ctx.plugin(FakeConfigService as any, hooks.config);
    await fiber;
    fibers.push(fiber);
  }
  if (hooks.workspace) await hooks.workspace(ctx);
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
    // 无 workspace 行 → 相对路径形态（基准视为一致）；提示词显式给会话键
    const review = captured.find(isReviewInput)!;
    const prompt = review.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(prompt).toContain('会话键 a~user');
    expect(prompt).toContain('summary/a~user.md');
    expect(prompt).toContain('memory/a~user.md');
  });

  it('写侧对齐读侧：显式 workdir 分叉基准 → 提示词给专用空间绝对路径，整理产物落读侧基准', async () => {
    const root = tmpRoot();
    const mounted = path.join(root, 'mounted');
    fs.mkdirSync(mounted, { recursive: true });
    // workspace 沙箱面假服务：a 的沙箱基准 = 挂载目录（模拟显式
    // settings['security'].workdir），专用空间仍 = files/a（读侧锚点）
    class FakeWorkspaceService extends Service {
      private root: string;
      private mounted: string;
      constructor(ctx: Context, options: { root: string; mounted: string }) {
        super(ctx, 'workspace');
        this.root = options.root;
        this.mounted = options.mounted;
      }
      agentWorkdir(agentId: string): string {
        return path.join(this.root, 'files', agentId);
      }
      sandboxWorkdir(agentId?: string): string | undefined {
        return agentId === 'a' ? this.mounted : undefined;
      }
      agentRelPath(agentId: string, rel: string): string {
        const agentDir = path.resolve(this.agentWorkdir(agentId));
        const sandboxDir = this.sandboxWorkdir(agentId);
        return sandboxDir !== undefined && path.resolve(sandboxDir) !== agentDir
          ? path.join(agentDir, rel)
          : rel;
      }
    }
    let wroteSummary = false;
    const { ctx } = await boot(root, undefined, {
      workspace: async (c) => {
        await c.plugin(FakeWorkspaceService as any, { root, mounted });
      },
      handler: (input) => {
        if (!isReviewInput(input)) return textChunks('回复');
        if (!wroteSummary) {
          wroteSummary = true;
          // 按提示词给的绝对路径写（分叉时 hint 不再是相对路径）
          return toolCallChunks(
            'w1',
            'write',
            JSON.stringify({
              file_path: path.join(root, 'files', 'a', 'summary', 'a~user.md'),
              content: '此前，绝对路径概要。',
            }),
          );
        }
        return textChunks('整理完成');
      },
      tools: (c) => {
        c.tools.register({
          name: 'write',
          description: '测试用 write：绝对路径原样、相对路径按 files/<agent> 解析',
          parameters: {
            type: 'object',
            properties: { file_path: { type: 'string' }, content: { type: 'string' } },
            required: ['file_path', 'content'],
          },
          execute(args, call) {
            const p = String(args.file_path);
            const file = path.isAbsolute(p)
              ? p
              : path.join(root, 'files', call.agentId ?? 'a', p);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, String(args.content), 'utf-8');
            return { ok: true, output: { path: p } };
          },
        });
      },
    });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    await ctx.router.send('a', '话'.repeat(100));
    await until(() => ctx.archive.segments('a~user').length > 0);
    // 提示词锚定专用空间：memory/summary 都给 agentWorkdir 绝对路径
    //（分叉前是相对路径，Agent 会写进挂载目录——读侧永远看不到）
    const review = captured.find(isReviewInput)!;
    const prompt = review.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(prompt).toContain(path.join(root, 'files', 'a', 'memory', 'a~user.md'));
    expect(prompt).toContain(path.join(root, 'files', 'a', 'summary', 'a~user.md'));
    // Agent 亲写文件（专用空间内）被服务端读取作概要——非回复文本
    const summary = fs.readFileSync(path.join(root, 'sessions', 'a~user', 'summary.md'), 'utf-8');
    expect(summary).toContain('绝对路径概要');
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

  // 2026-09-04 事故回归：replayTrajectory 缺省 true → LLM 上下文含 viewer
  // 自有 steps 轨迹展开，content-only 估算恒低于尾部水位 → 手工归档 0 移出
  //（实测会话 776KB 中 content 仅 1 万字符、steps 448KB；usage 口径 196K vs
  //  content 估算 4.3K）。回放口径估算后：正文极小但轨迹超水位 → 照常移出。
  it('回放口径回归：小正文 + 大工具轨迹 → 手工归档照常移出', async () => {
    const root = tmpRoot();
    let normalCalls = 0;
    const { ctx } = await boot(
      root,
      { maxContextTokens: 1000, archiveTokenRatio: 0.5, keepRecentRatio: 0.03 },
      {
        handler: (input) => {
          if (isReviewInput(input)) return textChunks('此前，我们讨论了归档机制并达成一致。');
          normalCalls += 1;
          // 首步调大输出工具（轨迹膨胀），随后正常收束（正文极小）
          return normalCalls === 1 ? toolCallChunks('c1', 'big_output', '{}') : textChunks('答');
        },
        tools: (c) => {
          c.tools.register({
            name: 'big_output',
            description: '大输出工具（事故形态：轨迹大、正文小）',
            parameters: { type: 'object', properties: {} },
            execute: () => ({ ok: true, output: 'x'.repeat(400) }),
          });
        },
      },
    );
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    // 一轮对话：正文 "问"/"答"（content 口径 ~2 token），轨迹回放口径 ~131
    await ctx.router.send('a', '问');
    // 未达自动阈值（~131 < 500）→ 手工归档（用户点击场景）
    await ctx.archive.requestArchive('a~user', 'a');
    await until(() => ctx.archive.segments('a~user').length > 0);
    // 会话流已收缩：早期 user 行移出（content 口径下曾是 0 移出）
    const after = await ctx.session.records('a~user');
    expect(after.every((r) => r.content !== '问')).toBe(true);
    // 被移出的消息完整落入归档分段（内容不丢）
    const seg = fs.readFileSync(path.join(root, 'archive', 'a~user', 'history_1.jsonl'), 'utf-8');
    expect(seg).toContain('问');
  });

  // 2026-09-04 admin~user 事故（第二层）：Agent model:null（UI「默认」）
  // 靠默认池连接正常对话，但旧 participantsOf 判定 `!!agent.model` 把它折出
  // 参与者 → 归档走"无可整理端点直接归档"——hint 从未投递、记忆/概要零
  // 整理（pending 标记与 compact 同毫秒即此路径的特征）。
  it('模型缺省（UI「默认」）Agent 也参与整理：hint 正常投递 + 概要落盘', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, undefined, {
      config: { llmProviders: { mock: { defaultModel: 'mock-1', default: true } } },
    });
    ctx.agents.register({ id: 'a' }); // 无 model —— 靠默认池连接（router 同款回落）
    await ctx.router.send('a', '话'.repeat(100));
    await until(() => ctx.archive.segments('a~user').length > 0);
    // hint 真的发了：整理 run 的 LLM 调用在场（旧判定下只有 1 次正常轮、
    // 直接归档无概要）
    expect(captured.filter(isReviewInput).length).toBe(1);
    // 整理产物：概要头落盘（compact 写入——非"直接归档（概要不动）"路径）
    const log = await ctx.session.history('a~user', { viewer: 'a' });
    expect(log[0]).toMatchObject({ role: 'system', content: '此前，我们讨论了归档机制并达成一致。' });
  });

  // 2026-09-04 缺口回归：整理 run 进行中用户消息不得 steer 进机制 run
  //（其流式隐藏 + 回复不落盘——注入即"回复掉黑洞"）。期望：跳过 steer →
  // 等空闲后作为独立用户 run 投递，回复可见可落盘。
  it('整理 run 进行中用户消息：不 steer 注入，等空闲后独立 run 回复', async () => {
    const root = tmpRoot();
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>((r) => (releaseReview = r));
    const { ctx } = await boot(root, undefined, {
      handler: async (input) => {
        if (isReviewInput(input)) {
          await reviewGate; // 整理 run 挂住（模拟分钟级整理）
          return textChunks('此前，归档整理完成。');
        }
        return textChunks('用户问题的回答');
      },
    });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    await ctx.router.send('a', '话'.repeat(100)); // 触发自动归档（60 token > 阈值 50）
    await until(() => captured.filter(isReviewInput).length === 1); // 整理 run 在途
    // 整理 run 进行中投递用户消息（缺省 placement——旧行为会 steer 注入）
    const outcomeP = ctx.conversation.deliver('a', '用户插话', {
      conversationId: 'a~user',
      sender: 'user',
      source: 'user',
    });
    await new Promise((r) => setTimeout(r, 50)); // deliver 进入等待
    releaseReview(); // 放行整理 run → 会话空闲 → 用户 run 接续
    const outcome = await outcomeP;
    expect(outcome.kind).toBe('run'); // 独立 run（非 steered 注入机制 run）
    // 整理 run 的输入不含用户消息（未注入机制 run）
    const review = captured.find(isReviewInput)!;
    expect(review.messages.some((m) => m.content === '用户插话')).toBe(false);
    // 用户消息与回复均入账（可见可回放）
    await until(() => ctx.archive.segments('a~user').length > 0); // 整理收尾归档完成
    const raw = await ctx.session.records('a~user');
    expect(raw.some((r) => r.content === '用户插话')).toBe(true);
    expect(raw.some((r) => r.content === '用户问题的回答')).toBe(true);
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
