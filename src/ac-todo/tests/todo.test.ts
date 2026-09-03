// ============================================================
// ac-todo/tests/todo.test.ts —— 待办清单（工具面 + 会话桶 + 持久化）
//
// · todo 工具 write/read（整表全量重写；空表清空）
// · 校验：非数组/空 content/非法 status/超上限 拒绝；status 缺省 pending
// · 桶键 = conversationId ?? agentId（同 Agent 跨桶隔离）
// · 持久化 agentStore entry 'todo'（重启回读）
// （无 prompt 注入——状态经消息面到达模型，system 恒定；见 src/index.ts）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentStoreRow from 'ac-agent-store';
import * as toolsRow from 'ac-tools';
import * as todoRow from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-todo-'));
  tmps.push(dir);
  return dir;
}

interface BootOpts {
  root?: string;
}

async function boot(opts: BootOpts = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  // 恒用独立数据根（缺省临时目录）——agentStore 落盘隔离，防跨 boot 串桶
  const root = opts.root ?? tmpRoot();
  const rows: Array<[unknown, unknown]> = [
    [toolsRow, undefined],
    [agentStoreRow, { root }],
    [todoRow, undefined],
  ];
  for (const [row, config] of rows) {
    const fiber = config === undefined ? ctx.plugin(row as any) : ctx.plugin(row as any, config);
    await fiber;
    fibers.push(fiber);
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
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-todo 工具面（write/read 整表全量重写）', () => {
  it('write → read 回读；status 缺省 pending；整表替换语义', async () => {
    const { ctx } = await boot();
    const call = { agentId: 'a', conversationId: 'a~user' };

    const w1 = await ctx.tools.execute({
      name: 'todo',
      args: { action: 'write', todos: [
        { content: '梳理需求', status: 'completed' },
        { content: '写实现', status: 'in_progress' },
        { content: '补测试' }, // status 缺省 → pending
      ] },
      ...call,
    });
    expect(w1.ok).toBe(true);
    expect((w1.output as { todos: Array<{ status: string }> }).todos.map((t) => t.status))
      .toEqual(['completed', 'in_progress', 'pending']);

    // 整表替换：旧表 3 条 → 新表 2 条（不是追加）
    const w2 = await ctx.tools.execute({
      name: 'todo',
      args: { action: 'write', todos: [{ content: '收尾', status: 'in_progress' }, { content: '复盘' }] },
      ...call,
    });
    expect((w2.output as { count: number }).count).toBe(2);

    const r = await ctx.tools.execute({ name: 'todo', args: { action: 'read' }, ...call });
    expect(r.ok).toBe(true);
    expect((r.output as { count: number; todos: Array<{ content: string }> }).todos.map((t) => t.content))
      .toEqual(['收尾', '复盘']);

    // 空表 = 清空
    const w3 = await ctx.tools.execute({ name: 'todo', args: { action: 'write', todos: [] }, ...call });
    expect((w3.output as { count: number }).count).toBe(0);
    expect(ctx.todos.list('a', 'a~user')).toEqual([]);
  });

  it('校验拒绝：非数组 / 空 content / 非法 status / 超上限；无身份拒绝', async () => {
    const { ctx } = await boot();
    const call = { agentId: 'a', conversationId: 'a~user' };

    const notArray = await ctx.tools.execute({
      name: 'todo', args: { action: 'write', todos: '不是数组' }, ...call,
    });
    expect(notArray.ok).toBe(false);
    expect(String(notArray.error)).toContain('数组');

    const emptyContent = await ctx.tools.execute({
      name: 'todo', args: { action: 'write', todos: [{ content: '  ' }] }, ...call,
    });
    expect(emptyContent.ok).toBe(false);
    expect(String(emptyContent.error)).toContain('content');

    const badStatus = await ctx.tools.execute({
      name: 'todo', args: { action: 'write', todos: [{ content: 'x', status: 'done' }] }, ...call,
    });
    expect(badStatus.ok).toBe(false);
    expect(String(badStatus.error)).toContain('pending/in_progress/completed');

    const tooMany = await ctx.tools.execute({
      name: 'todo',
      args: { action: 'write', todos: Array.from({ length: 51 }, (_, i) => ({ content: `t${i}` })) },
      ...call,
    });
    expect(tooMany.ok).toBe(false);
    expect(String(tooMany.error)).toContain('上限');

    const missing = await ctx.tools.execute({ name: 'todo', args: { action: 'write' }, ...call });
    expect(missing.ok).toBe(false);

    const noId = await ctx.tools.execute({ name: 'todo', args: { action: 'read' } });
    expect(noId.ok).toBe(false);
    expect(String(noId.error)).toContain('执行身份');
  });

  it('桶隔离：同 Agent 的会话桶与自会话桶互不串扰', async () => {
    const { ctx } = await boot();
    await ctx.tools.execute({
      name: 'todo', args: { action: 'write', todos: [{ content: '和用户的活' }] },
      agentId: 'a', conversationId: 'a~user',
    });
    await ctx.tools.execute({
      name: 'todo', args: { action: 'write', todos: [{ content: '自己的活', status: 'in_progress' }] },
      agentId: 'a', conversationId: 'a~a',
    });
    expect(ctx.todos.list('a', 'a~user').map((t) => t.content)).toEqual(['和用户的活']);
    expect(ctx.todos.list('a', 'a~a')).toEqual([{ content: '自己的活', status: 'in_progress' }]);
  });
});

describe('ac-todo 持久化（agentStore entry "todo"）', () => {
  it('落盘可读；重启（新组合）回读清单连续', async () => {
    const root = tmpRoot();
    const first = await boot({ root });
    first.ctx.todos.write('a', 'a~user', [{ content: '迁移步骤一', status: 'completed' }, { content: '迁移步骤二', status: 'in_progress' }]);
    const entry = first.ctx.agentStore.readEntry<{ buckets: Record<string, { items: unknown[] }> }>('a', 'todo');
    expect(entry?.buckets['a~user']?.items).toHaveLength(2);
    expect(fs.existsSync(path.join(root, 'agents', 'a', 'todo.json'))).toBe(true);

    const second = await boot({ root });
    expect(second.ctx.todos.list('a', 'a~user')).toEqual([
      { content: '迁移步骤一', status: 'completed' },
      { content: '迁移步骤二', status: 'in_progress' },
    ]);
  });
});

describe('ac-todo 行回收（注册即归属）', () => {
  it('摘行 fiber → 工具与服务一并消失（零 dispose 代码）', async () => {
    const { ctx, fibers } = await boot();
    expect(ctx.tools.has('todo')).toBe(true);
    await fibers[fibers.length - 1]!.dispose();
    expect(ctx.tools.has('todo')).toBe(false);
    expect(ctx.todos).toBeUndefined();
  });
});
