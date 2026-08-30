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
  it('创建/读取/列表：session.json 落盘 + createdAt 降序', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const s1 = ctx.singles.create({ agentId: 'a', title: '会话一' });
    const s2 = ctx.singles.create({ agentId: 'a' });
    expect(s1.status).toBe('active');
    expect(ctx.singles.get(s1.id)?.title).toBe('会话一');
    const list = ctx.singles.listActive();
    expect(list.map((s) => s.id)).toEqual([s2.id, s1.id]);
    expect(fs.existsSync(path.join(root, 'singles', s1.id, 'session.json'))).toBe(true);
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

describe('ac-singles：自动标题（loop/after-run → LLM → singles/updated）', () => {
  const LONG_FIRST_MSG = '这是一段超过二十四个字符的首条用户消息用于验证标题生成的回落与LLM路径区分';
  const OK_RESULT = {
    steps: [],
    text: 'ok',
    finish: 'stop',
    usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 1 },
  } as const;

  async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return cond();
  }

  it('首 run 正常收束 → LLM 生成标题 + singles/updated（前端即时刷新源）', async () => {
    const { ctx } = await boot(tmpRoot());
    const s = ctx.singles.create({ agentId: 'a' });
    const actions: string[] = [];
    ctx.on('singles/updated', (_meta, action) => actions.push(action));
    ctx.emit(
      'loop/after-run',
      { agent: 'a', model: 'mock-1', conversationId: s.id, sender: 'user', messages: [{ role: 'user', content: LONG_FIRST_MSG }] },
      OK_RESULT as any,
    );
    expect(await waitFor(() => Boolean(ctx.singles.get(s.id)?.title))).toBe(true);
    expect(ctx.singles.get(s.id)?.title).toBe('ok'); // mock provider 固定回复 'ok'
    expect(actions).toContain('updated');
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
    ctx.emit(
      'loop/after-run',
      { agent: 'a', model: 'mock-1', conversationId: s.id, sender: 'user', messages: [{ role: 'user', content: LONG_FIRST_MSG }] },
      OK_RESULT as any,
    );
    expect(await waitFor(() => Boolean(ctx.singles.get(s.id)?.title))).toBe(true);
    const title = ctx.singles.get(s.id)?.title ?? '';
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(25); // 24 字 + 省略号
  });

  it('幂等与门控：已有标题不覆盖 / error 收束不生成 / 非独立会话桶不触发', async () => {
    const { ctx } = await boot(tmpRoot());
    // 已有标题：不覆盖
    const s1 = ctx.singles.create({ agentId: 'a', title: '手改标题' });
    ctx.emit(
      'loop/after-run',
      { agent: 'a', model: 'mock-1', conversationId: s1.id, sender: 'user', messages: [{ role: 'user', content: '别的消息' }] },
      OK_RESULT as any,
    );
    // error 收束：不生成
    const s2 = ctx.singles.create({ agentId: 'a' });
    ctx.emit(
      'loop/after-run',
      { agent: 'a', model: 'mock-1', conversationId: s2.id, sender: 'user', messages: [{ role: 'user', content: LONG_FIRST_MSG }] },
      { ...OK_RESULT, finish: 'error', error: 'x' } as any,
    );
    // 非 singles 会话桶（1v1 = agent id）：不在 singles 目录，不触发
    ctx.emit(
      'loop/after-run',
      { agent: 'a', model: 'mock-1', conversationId: 'a', sender: 'user', messages: [{ role: 'user', content: LONG_FIRST_MSG }] },
      OK_RESULT as any,
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(ctx.singles.get(s1.id)?.title).toBe('手改标题');
    expect(ctx.singles.get(s2.id)?.title).toBeUndefined();
  });
});
