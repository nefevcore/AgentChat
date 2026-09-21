// ============================================================
// ac-singles 测试：CRUD · 空白会话唯一性 · 规则 1（有消息锁 Agent）·
// 引用校验（virtual/不存在 Agent、workspace）· 归档/硬删（消息经
// session.clear owning 写口）· singles/updated 事件
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
import * as singlesRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-singles-'));
  tmps.push(dir);
  return dir;
}

/** 短暂停（拉开时间戳——createdAt/mtime 同毫秒会让排序断言不稳定） */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot(root?: string) {
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
    conversationRow,
    sessionRow,
    singlesRow,
  ];
  for (const row of rows) {
    const isRooted = (row as { name?: string }).name === 'ac-singles' || (row as { name?: string }).name === 'ac-session';
    const fiber =
      root !== undefined && isRooted
        ? ctx.plugin(row as any, { root })
        : ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  ctx.agents.register({ id: 'a', model: 'mock-1' });
  ctx.agents.register({ id: 'virtual-endpoint', model: 'mock-1', virtual: true });
  booted.push({ ctx, fibers });
  return { ctx, fibers };
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
  for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

describe('ac-singles：CRUD 与不变量', () => {
  it('创建/读取/列表：session.json 落盘 + 无消息回落 createdAt 降序', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const s1 = ctx.singles.create({ agentId: 'a', title: '会话一' });
    const s2 = ctx.singles.create({ agentId: 'a' });
    expect(s1.status).toBe('active');
    expect(ctx.singles.get(s1.id)?.title).toBe('会话一');
    const list = ctx.singles.listActive();
    expect(list.map((s) => s.id)).toEqual([s2.id, s1.id]);
    // 空会话不带 lastActivity 键（前端回落 createdAt 排序）
    expect(list.every((s) => s.lastActivity === undefined)).toBe(true);
    expect(fs.existsSync(path.join(root, 'singles', s1.id, 'session.json'))).toBe(true);
  });

  it('列表按最近会话时间排序：旧会话新发消息顶到最前 + lastActivity 载荷', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const s1 = ctx.singles.create({ agentId: 'a', title: '旧会话' });
    await sleep(15);
    const s2 = ctx.singles.create({ agentId: 'a', title: '新会话' });
    // 初始序：无消息回落 createdAt 降序
    expect(ctx.singles.listActive().map((s) => s.id)).toEqual([s2.id, s1.id]);
    // 旧会话来了新消息 → 最近会话时间晚于 s2 创建时间，应顶到最前
    await sleep(15);
    await ctx.router.send('a', '旧会话的新消息', { conversationId: s1.id });
    const list = ctx.singles.listActive();
    expect(list.map((s) => s.id)).toEqual([s1.id, s2.id]);
    // lastActivity 载荷：有消息 = ISO 串；空会话不带键
    expect(typeof list[0].lastActivity).toBe('string');
    expect(new Date(list[0].lastActivity!).getTime()).toBeGreaterThan(new Date(s2.createdAt).getTime());
    expect(list[1].lastActivity).toBeUndefined();
  });

  it('引用校验：不存在 / virtual Agent 拒绝', async () => {
    const { ctx } = await boot(tmpRoot());
    expect(() => ctx.singles.create({ agentId: 'nope' })).toThrow(/不存在/);
    expect(() => ctx.singles.create({ agentId: 'virtual-endpoint' })).toThrow(/虚拟/);
  });

  it('空白会话全局唯一：reuse 复用 + create 前清理遗留', async () => {
    const { ctx } = await boot(tmpRoot());
    const empty1 = ctx.singles.create({});
    const reused = ctx.singles.create({ reuse: true });
    expect(reused.id).toBe(empty1.id);
    // 非复用创建 → 旧空白被清理
    const fresh = ctx.singles.create({ agentId: 'a' });
    expect(ctx.singles.get(empty1.id)).toBeNull();
    expect(ctx.singles.get(fresh.id)?.agentId).toBe('a');
  });

  it('规则 1：已有消息的会话禁止更换 Agent（未选 Agent 的会话同样锁定——消息经默认预设路由，src 同款）；模型覆盖 null=清除', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const s = ctx.singles.create({ agentId: 'a', model: 'mock-1' });
    // 消息入账（ac-session 域；conversationId = sid）
    await ctx.router.send('a', '你好', { conversationId: s.id });
    expect(ctx.singles.hasMessages(s.id)).toBe(true);
    expect(() => ctx.singles.update(s.id, { agentId: 'a2' })).toThrow(/不能更换/);
    // 未选 Agent 的会话有消息后同样锁定（前端空 agentId 走默认预设路由）
    const unbound = ctx.singles.create({});
    await ctx.router.send('a', '消息', { conversationId: unbound.id });
    expect(() => ctx.singles.update(unbound.id, { agentId: 'a' })).toThrow(/不能更换/);
    // 模型覆盖可换可清（不属身份锁定）
    expect(ctx.singles.update(s.id, { model: null }).model).toBeUndefined();
  });

  it('workspace 校验与挂载/移出', async () => {
    const { ctx } = await boot(tmpRoot());
    expect(() => ctx.singles.create({ workspaceId: 'ws-404' })).not.toThrow(); // workspace 行未装：放行
    const s = ctx.singles.create({});
    expect(ctx.singles.update(s.id, { workspaceId: 'ws-1' }).workspaceId).toBe('ws-1');
    expect(ctx.singles.update(s.id, { workspaceId: '' }).workspaceId).toBeUndefined();
  });

  it('模型覆盖引用校验（P6）：@ 左段须为已注册 provider；裸名放行', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    // 挂 Agent 的会话（非空白——不被后续 create 的 purgeEmpty 清理）
    const s = ctx.singles.create({ agentId: 'a' });
    // 已注册 provider（mock）→ 通过
    expect(ctx.singles.update(s.id, { model: 'mock@mock-1' }).model).toBe('mock@mock-1');
    // 未注册 provider → 拒绝（可诊断）
    expect(() => ctx.singles.update(s.id, { model: 'ghost@x-1' })).toThrow(/未注册/);
    expect(() => ctx.singles.create({ model: 'ghost@x-1' })).toThrow(/未注册/);
    // 裸模型名 → 放行（旧路由语义）
    expect(ctx.singles.update(s.id, { model: 'mock-1' }).model).toBe('mock-1');
  });

  it('fork：以锚点消息为终点复制出新会话（元数据继承 + 消息切片 + 源不动）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const s = ctx.singles.create({ agentId: 'a', title: '源会话', model: 'mock-1' });
    // 三轮消息（user 入站 + agent 回复）
    await ctx.router.send('a', '第一问', { conversationId: s.id });
    await ctx.router.send('a', '第二问', { conversationId: s.id });
    await ctx.router.send('a', '第三问', { conversationId: s.id });
    const records = await ctx.session.records(s.id);
    expect(records.length).toBeGreaterThanOrEqual(6);
    // 锚点 = 第一问对应的 agent 回复（第 2 行）
    const anchor = records.find((r) => r.role === 'agent' && r.agent_id === 'a')!;
    const forked = await ctx.singles.fork(s.id, anchor.message_id);
    expect(forked.id).not.toBe(s.id);
    expect(forked.agentId).toBe('a');
    expect(forked.title).toBe('源会话（分支）'); // 已具名源 → 剥旧后缀追加（分支的分支不叠名）
    expect(forked.model).toBe('mock-1');
    const forkRecords = await ctx.session.records(forked.id);
    expect(forkRecords.length).toBe(2); // user 第一问 + agent 首答（含锚点行）
    expect(forkRecords.map((r) => r.content)).toEqual(records.slice(0, 2).map((r) => r.content));
    // 源会话不受影响
    expect((await ctx.session.records(s.id)).length).toBe(records.length);
    expect(ctx.singles.get(s.id)?.status).toBe('active');
    // 空锚点 = 全量复制
    const full = await ctx.singles.fork(s.id, '');
    expect((await ctx.session.records(full.id)).length).toBe(records.length);
    // 分支的分支：剥旧后缀再追加，不叠名
    const refork = await ctx.singles.fork(forked.id, '');
    expect(refork.title).toBe('源会话（分支）');
  });

  it('fork：锚点未命中抛错；不存在会话抛错', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const s = ctx.singles.create({ agentId: 'a' });
    await ctx.router.send('a', '你好', { conversationId: s.id });
    await expect(ctx.singles.fork(s.id, 'no-such-message')).rejects.toThrow(/不在会话/);
    await expect(ctx.singles.fork('ghost-session', '')).rejects.toThrow(/不存在/);
  });

  it('归档（软删）保留消息；硬删清元数据 + 消息（session.clear）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const s = ctx.singles.create({ agentId: 'a' });
    await ctx.router.send('a', '你好', { conversationId: s.id });
    expect(ctx.singles.lastActivity(s.id)).toBeGreaterThan(0);

    ctx.singles.archive(s.id);
    expect(ctx.singles.get(s.id)?.status).toBe('archived');
    expect(ctx.singles.listActive().some((x) => x.id === s.id)).toBe(false);
    // 消息住上架路径：sessions/singles/<ws|ungrouped>/<sid>/
    expect(fs.existsSync(path.join(root, 'sessions', 'singles', 'ungrouped', s.id, 'messages.jsonl'))).toBe(true);

    ctx.singles.remove(s.id);
    expect(ctx.singles.get(s.id)).toBeNull();
    expect(fs.existsSync(path.join(root, 'sessions', 'singles', 'ungrouped', s.id))).toBe(false);
  });

  it('会话上架：创建即入 singles/<ws|ungrouped>/<sid>/；换组迁移；老数据同步', async () => {
    const root = tmpRoot();
    {
      const { ctx } = await boot(root);
      // 未分组 → singles/ungrouped/
      const s1 = ctx.singles.create({ agentId: 'a' });
      expect(fs.existsSync(path.join(root, 'sessions', 'singles', 'ungrouped', s1.id))).toBe(true);
      // 挂工作区 → singles/ws-9/
      const s2 = ctx.singles.create({ agentId: 'a', workspaceId: 'ws-9' });
      expect(fs.existsSync(path.join(root, 'sessions', 'singles', 'ws-9', s2.id))).toBe(true);
      // 换组 → 目录迁移
      await ctx.router.send('a', '消息', { conversationId: s1.id });
      ctx.singles.update(s1.id, { workspaceId: 'ws-8' });
      expect(fs.existsSync(path.join(root, 'sessions', 'singles', 'ws-8', s1.id, 'messages.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'sessions', 'singles', 'ungrouped', s1.id))).toBe(false);
      // 寻址不变：stats/lastActivity 走新路径
      expect(ctx.singles.hasMessages(s1.id)).toBe(true);
      // 模拟老数据：手工把一个直存会话目录放回 sessions/（绕过 setShelf）
      const legacy = ctx.singles.create({ agentId: 'a', title: '老数据' });
      const session = (ctx as any).session;
      // 直接在 session 服务层面把目录挪回直存（模拟迁移前布局）
      fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
      fs.cpSync(
        path.join(root, 'sessions', 'singles', 'ungrouped', legacy.id),
        path.join(root, 'sessions', legacy.id),
        { recursive: true },
      );
      fs.rmSync(path.join(root, 'sessions', 'singles', 'ungrouped', legacy.id), { recursive: true, force: true });
      await disposeAll();
    }
    // 重启：首次 list() 触发 ensureShelves → 老数据归位
    const { ctx } = await boot(root);
    const found = ctx.singles.list().find((s) => s.title === '老数据');
    expect(found).toBeDefined();
    expect(fs.existsSync(path.join(root, 'sessions', 'singles', 'ungrouped', found!.id))).toBe(true);
    expect(ctx.session.ids()).toContain(found!.id);
  });

  it('singles/updated 事件：create/update/archive/remove 全通知', async () => {
    const { ctx } = await boot(tmpRoot());
    const seen: string[] = [];
    ctx.on('singles/updated', (_meta, action) => seen.push(action));
    const s = ctx.singles.create({});
    ctx.singles.update(s.id, { title: 't' });
    ctx.singles.archive(s.id);
    ctx.singles.remove(s.id);
    expect(seen).toEqual(['created', 'updated', 'archived', 'removed']);
  });

  it('重启恢复：磁盘元数据重启后可读', async () => {
    const root = tmpRoot();
    {
      const { ctx } = await boot(root);
      ctx.singles.create({ agentId: 'a', title: '重启后见' });
      await disposeAll();
    }
    const { ctx } = await boot(root);
    expect(ctx.singles.listActive().some((s) => s.title === '重启后见')).toBe(true);
  });
});

describe('ac-singles：在途 run 会话不是空白（首 run 进行中被别处新建不得误删）', () => {
  async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return cond();
  }

  it('空白会话首 run 进行中：其他工作区 create 不硬删（purgeEmpty 跳过）、reuse 不复用；收束后消息在账', async () => {
    const root = tmpRoot();
    const ctx = new Context();
    const fibers: Fiber[] = [];
    let releaseRun!: () => void;
    const gate = new Promise<void>((r) => { releaseRun = r; });
    const rows: unknown[] = [
      toolsRow,
      llmRow,
      {
        name: 'mock-provider-gated',
        inject: ['llm'],
        apply(c: Context) {
          c.llm.register(
            'mock',
            () => ({
              // 首 run 挂起至放行（复现"正在运行"窗口）；放行后即答（含标题生成）
              stream: async function* (): AsyncIterable<LlmStreamChunk> {
                await gate;
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
      conversationRow,
      sessionRow,
      singlesRow,
    ];
    for (const row of rows) {
      const isRooted = ['ac-singles', 'ac-session'].includes((row as { name?: string }).name ?? '');
      const fiber = isRooted ? ctx.plugin(row as any, { root }) : ctx.plugin(row as any);
      await fiber;
      fibers.push(fiber);
    }
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    booted.push({ ctx, fibers });

    // 空白新会话（agentId ''——前端「新会话」缺省形态，运行时路由默认预设）
    const s = ctx.singles.create({ workspaceId: 'ws-a' });
    const runP = ctx.conversation.deliver('a', '你好', {
      sender: 'user',
      source: 'user',
      conversationId: s.id,
    });
    runP.catch(() => {}); // 断言失败提前退出时防未处理拒绝
    expect(await waitFor(() => ctx.conversation.listRunning().some((r) => r.conversationId === s.id))).toBe(true);
    // 复现前提：首条用户消息已入账但在途未落盘（纯文本 run 无 checkpoint），
    // 文件口径消息数恒 0——isEmpty 误判的根源
    expect(ctx.session.stats(s.id)?.messageCount ?? 0).toBe(0);

    // 其他工作区「+」新建会话（前端 workspaceId create：无 reuse → purgeEmpty 路径）
    const other = ctx.singles.create({ workspaceId: 'ws-b' });
    expect(ctx.singles.get(other.id)?.workspaceId).toBe('ws-b');
    expect(ctx.singles.get(s.id)).not.toBeNull(); // 修复前：被当空白硬删（元数据+消息流一并清除）

    // 顶部「新增」（reuse 路径）也不得复用（劫持）在跑会话
    expect(ctx.singles.create({ reuse: true }).id).not.toBe(s.id);

    // 放行收束：在途消息落盘，会话记录完好
    releaseRun();
    await runP;
    expect(await waitFor(() => (ctx.session.stats(s.id)?.messageCount ?? 0) > 0)).toBe(true);
    expect(ctx.singles.hasMessages(s.id)).toBe(true);
    expect(ctx.singles.get(s.id)).not.toBeNull();
  });
});

describe('ac-singles：自动标题（loop/run-started → LLM → singles/updated）', () => {
  const LONG_FIRST_MSG = '这是一段超过二十四个字符的首条用户消息用于验证标题生成的回落与LLM路径区分';
  /** run-started 载荷（标题生成挂点）：request 全量，无 result */
  const REQ = (sid: string, extra: Record<string, unknown> = {}) =>
    ({ agent: 'a', model: 'mock-1', conversationId: sid, sender: 'user', messages: [{ role: 'user', content: LONG_FIRST_MSG }], ...extra }) as never;

  async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return cond();
  }

  it('run 开始即生成标题 + singles/updated（前端即时刷新源；不等 run 收束）', async () => {
    const { ctx } = await boot(tmpRoot());
    const s = ctx.singles.create({ agentId: 'a' });
    const actions: string[] = [];
    ctx.on('singles/updated', (_meta, action) => actions.push(action));
    ctx.emit('loop/run-started', REQ(s.id));
    expect(await waitFor(() => Boolean(ctx.singles.get(s.id)?.title))).toBe(true);
    expect(ctx.singles.get(s.id)?.title).toBe('ok'); // mock provider 固定回复 'ok'
    expect(actions).toContain('updated');
  });

  it('标题请求携带思考禁用参数（思考型模型 64 token 预算被 reasoning 独占 → text 恒空的根因修复）', async () => {
    const root = tmpRoot();
    const ctx = new Context();
    const fibers: Fiber[] = [];
    const seenInputs: Record<string, unknown>[] = [];
    const rows: unknown[] = [
      llmRow,
      {
        name: 'mock-provider-inspect',
        inject: ['llm'],
        apply(c: Context) {
          c.llm.register(
            'mock',
            () => ({
              stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
                seenInputs.push(input as Record<string, unknown>);
                yield { delta: 'ok' };
                yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
              },
            }),
            { models: ['mock-1'] },
          );
        },
      },
      singlesRow,
    ];
    for (const row of rows) {
      const fiber =
        (row as { name?: string }).name === 'ac-singles'
          ? ctx.plugin(row as any, { root })
          : ctx.plugin(row as any);
      await fiber;
      fibers.push(fiber);
    }
    booted.push({ ctx, fibers });

    const s = ctx.singles.create({ agentId: 'a' });
    ctx.emit('loop/run-started', REQ(s.id));
    expect(await waitFor(() => Boolean(ctx.singles.get(s.id)?.title))).toBe(true);
    expect(seenInputs.length).toBe(1);
    // 双词汇禁用思考：GLM thinking:{type:'disabled'} + DeepSeek/OpenAI reasoning_effort:'none'
    expect(seenInputs[0]).toMatchObject({ thinking: { type: 'disabled' }, reasoning_effort: 'none' });
    expect(seenInputs[0].max_tokens).toBe(64);
  });

  it('思考参数被端点拒收（OpenAI 严格 400）→ 裸参数重试一次仍出标题', async () => {
    const root = tmpRoot();
    const ctx = new Context();
    const fibers: Fiber[] = [];
    const calls: Record<string, unknown>[] = [];
    const rows: unknown[] = [
      llmRow,
      {
        name: 'mock-provider-400-then-ok',
        inject: ['llm'],
        apply(c: Context) {
          c.llm.register(
            'mock',
            () => ({
              stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
                calls.push(input as Record<string, unknown>);
                // 首次（带思考禁用参数）：模拟 OpenAI 对未知顶层字段的 400
                if ('thinking' in (input as Record<string, unknown>)) {
                  throw new Error('Unrecognized request argument supplied: thinking');
                }
                yield { delta: '裸重试标题' };
                yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
              },
            }),
            { models: ['mock-1'] },
          );
        },
      },
      singlesRow,
    ];
    for (const row of rows) {
      const fiber =
        (row as { name?: string }).name === 'ac-singles'
          ? ctx.plugin(row as any, { root })
          : ctx.plugin(row as any);
      await fiber;
      fibers.push(fiber);
    }
    booted.push({ ctx, fibers });

    const s = ctx.singles.create({ agentId: 'a' });
    ctx.emit('loop/run-started', REQ(s.id));
    expect(await waitFor(() => Boolean(ctx.singles.get(s.id)?.title))).toBe(true);
    expect(calls.length).toBe(2); // 指误重试恰好两次调用
    expect('thinking' in calls[1]).toBe(false); // 重试为裸参数
    expect(ctx.singles.get(s.id)?.title).toBe('裸重试标题');
  });

  it('LLM 失败 → 回落首条消息截断（超长加省略号）', async () => {
    const root = tmpRoot();
    const ctx = new Context();
    const fibers: Fiber[] = [];
    const rows: unknown[] = [
      llmRow,
      {
        name: 'mock-provider-throw',
        inject: ['llm'],
        apply(c: Context) {
          c.llm.register(
            'mock',
            () => ({
              stream: async function* (): AsyncIterable<LlmStreamChunk> {
                throw new Error('boom');
              },
            }),
            { models: ['mock-1'] },
          );
        },
      },
      singlesRow,
    ];
    for (const row of rows) {
      const fiber =
        (row as { name?: string }).name === 'ac-singles'
          ? ctx.plugin(row as any, { root })
          : ctx.plugin(row as any);
      await fiber;
      fibers.push(fiber);
    }
    booted.push({ ctx, fibers });

    const s = ctx.singles.create({ agentId: 'a' });
    ctx.emit('loop/run-started', REQ(s.id));
    expect(await waitFor(() => Boolean(ctx.singles.get(s.id)?.title))).toBe(true);
    const title = ctx.singles.get(s.id)?.title ?? '';
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(25); // 24 字 + 省略号
  });

  it('幂等与门控：已有标题不覆盖 / 机制 run（archive-review）不生成 / 非独立会话桶不触发', async () => {
    const { ctx } = await boot(tmpRoot());
    // 已有标题：不覆盖
    const s1 = ctx.singles.create({ agentId: 'a', title: '手改标题' });
    ctx.emit('loop/run-started', REQ(s1.id));
    // 归档整理 run（机制自会话）：不是用户对话，不生成
    const s2 = ctx.singles.create({ agentId: 'a' });
    ctx.emit('loop/run-started', REQ(s2.id, { meta: { 'archive-review': true } }));
    // 非 singles 会话桶（1v1 = agent id）：不在 singles 目录，不触发
    ctx.emit('loop/run-started', REQ('a'));
    await new Promise((r) => setTimeout(r, 150));
    expect(ctx.singles.get(s1.id)?.title).toBe('手改标题');
    expect(ctx.singles.get(s2.id)?.title).toBeUndefined();
  });

  it('语义变化：run 即使注定 error/interrupted 也已得名（标题概括用户意图，不依赖回答质量）', async () => {
    const { ctx } = await boot(tmpRoot());
    const s = ctx.singles.create({ agentId: 'a' });
    ctx.emit('loop/run-started', REQ(s.id));
    expect(await waitFor(() => Boolean(ctx.singles.get(s.id)?.title))).toBe(true);
    expect(ctx.singles.get(s.id)?.title).toBe('ok');
  });
});
