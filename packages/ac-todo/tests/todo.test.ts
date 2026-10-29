// ============================================================
// packages/ac-todo/tests/todo.test.ts —— todo 工具验收
//
// 后端行全链路（UI 行装配面见 ac-client-ui-todo/tests）：
// · write 整表全量重写 / read 查看（经 ctx.tools.execute 真注册面）
// · action 缺省推定（带 todos = write——程序化直传漏 action 实测高频）
// · 桶隔离（conversationId ?? agentId——桶互不串扰）
// · 域校验（非数组 / 空条目 / 非法 status / 上限 / 缺身份）
// · agentStore 落盘形状；卸载级联回收工具
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import * as toolsRow from 'ac-tools';
import * as todoRow from '../src/index.ts';

/** 内存 agentStore 桩（接口对齐 ac-retired-types 墓碑面） */
class MemoryAgentStore extends Service {
  private data = new Map<string, unknown>();
  constructor(ctx: Context) { super(ctx, 'agentStore'); }
  readEntry<T>(id: string, key: string): T | undefined {
    return this.data.get(id + '::' + key) as T | undefined;
  }
  saveEntry(id: string, key: string, value: unknown): void {
    this.data.set(id + '::' + key, value);
  }
}

interface TodoOut { count?: number; todos?: Array<{ content: string; status: string }>; message?: string }
interface ExecRes extends ToolResult { output?: TodoOut }

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(): Promise<Context> {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, MemoryAgentStore, todoRow]) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return ctx;
}

function exec(ctx: Context, args: Record<string, unknown>, call: Record<string, unknown> = {}) {
  return ctx.tools.execute({ name: 'todo', args, ...call } as never) as Promise<ExecRes>;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('todo 工具 · write/read 全链路', () => {
  it('write 整表重写 → read 回读一致；message 含进行中计数', async () => {
    const ctx = await boot();
    const w = await exec(ctx, { action: 'write', todos: [
      { content: '写测试', status: 'in_progress' },
      { content: '跑测试', status: 'pending' },
    ] }, { agentId: 'a1', conversationId: 'c1' });
    expect(w.ok).toBe(true);
    expect(w.output?.count).toBe(2);
    expect(w.output?.message).toContain('进行中 1');

    const r = await exec(ctx, { action: 'read' }, { agentId: 'a1', conversationId: 'c1' });
    expect(r.ok).toBe(true);
    expect(r.output?.count).toBe(2);
    expect(r.output?.todos?.[0]).toEqual({ content: '写测试', status: 'in_progress' });
    expect(r.output?.todos?.[1]).toEqual({ content: '跑测试', status: 'pending' });
  });

  it('status 缺省 pending；content trim 归一', async () => {
    const ctx = await boot();
    const w = await exec(ctx, { action: 'write', todos: [{ content: '  任务  ' }] }, { agentId: 'a1' });
    expect(w.ok).toBe(true);
    expect(w.output?.todos?.[0]).toEqual({ content: '任务', status: 'pending' });
  });

  it('空数组 = 清空清单（read 回到 0 条）', async () => {
    const ctx = await boot();
    await exec(ctx, { action: 'write', todos: [{ content: 'x' }] }, { agentId: 'a1', conversationId: 'c1' });
    const w = await exec(ctx, { action: 'write', todos: [] }, { agentId: 'a1', conversationId: 'c1' });
    expect(w.ok).toBe(true);
    expect(w.output?.message).toBe('清单已清空');
    const r = await exec(ctx, { action: 'read' }, { agentId: 'a1', conversationId: 'c1' });
    expect(r.output?.count).toBe(0);
  });

  it('action 缺省推定：带 todos = write，不带 = read', async () => {
    const ctx = await boot();
    const w = await exec(ctx, { todos: [{ content: '缺省 action' }] }, { agentId: 'a1', conversationId: 'c1' });
    expect(w.ok).toBe(true);
    expect(w.output?.count).toBe(1);
    const r = await exec(ctx, {}, { agentId: 'a1', conversationId: 'c1' });
    expect(r.ok).toBe(true);
    expect(r.output?.count).toBe(1);
  });

  it('write 无 todos 参数 → ok:false（域规则违反收敛为错误结果）', async () => {
    const ctx = await boot();
    const r = await exec(ctx, { action: 'write' }, { agentId: 'a1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('todos');
  });

  it('未知 action → 报错（回显非法值）', async () => {
    const ctx = await boot();
    const r = await exec(ctx, { action: 'clear' }, { agentId: 'a1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('clear');
  });
});

describe('todo 工具 · 桶隔离（conversationId ?? agentId）', () => {
  it('同 Agent 不同会话桶互不串扰；无会话键回落 agentId 桶', async () => {
    const ctx = await boot();
    await exec(ctx, { action: 'write', todos: [{ content: '会话一任务' }] }, { agentId: 'a1', conversationId: 'c1' });
    await exec(ctx, { action: 'write', todos: [{ content: '会话二任务' }, { content: '另一条' }] }, { agentId: 'a1', conversationId: 'c2' });
    const r1 = await exec(ctx, { action: 'read' }, { agentId: 'a1', conversationId: 'c1' });
    const r2 = await exec(ctx, { action: 'read' }, { agentId: 'a1', conversationId: 'c2' });
    expect(r1.output?.todos?.map((t) => t.content)).toEqual(['会话一任务']);
    expect(r2.output?.count).toBe(2);
    // 无 conversationId → 回落 agentId 桶（独立于任一会话桶）
    const r3 = await exec(ctx, { action: 'read' }, { agentId: 'a1' });
    expect(r3.output?.count).toBe(0);
  });

  it('不同 Agent 同名会话键不串扰（桶按 agentId × key 归属）', async () => {
    const ctx = await boot();
    await exec(ctx, { action: 'write', todos: [{ content: '甲的任务' }] }, { agentId: 'a1', conversationId: 'shared' });
    await exec(ctx, { action: 'write', todos: [{ content: '乙的任务' }] }, { agentId: 'a2', conversationId: 'shared' });
    const r1 = await exec(ctx, { action: 'read' }, { agentId: 'a1', conversationId: 'shared' });
    const r2 = await exec(ctx, { action: 'read' }, { agentId: 'a2', conversationId: 'shared' });
    expect(r1.output?.todos?.[0]?.content).toBe('甲的任务');
    expect(r2.output?.todos?.[0]?.content).toBe('乙的任务');
  });
});

describe('todo 工具 · 域校验与边界', () => {
  it('todos 非数组 → 报错', async () => {
    const ctx = await boot();
    const r = await exec(ctx, { action: 'write', todos: '不是数组' }, { agentId: 'a1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('数组');
  });

  it('content 空 / 非字符串 → 报错', async () => {
    const ctx = await boot();
    const r1 = await exec(ctx, { action: 'write', todos: [{ content: '   ' }] }, { agentId: 'a1' });
    expect(r1.ok).toBe(false);
    const r2 = await exec(ctx, { action: 'write', todos: [{ content: 123 }] }, { agentId: 'a1' });
    expect(r2.ok).toBe(false);
  });

  it('非法 status → 报错（含非法值回显）', async () => {
    const ctx = await boot();
    const r = await exec(ctx, { action: 'write', todos: [{ content: 'x', status: 'done' }] }, { agentId: 'a1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('done');
  });

  it('超 50 条上限 → 报错', async () => {
    const ctx = await boot();
    const many = Array.from({ length: 51 }, (_, i) => ({ content: 't' + i }));
    const r = await exec(ctx, { action: 'write', todos: many }, { agentId: 'a1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('50');
  });

  it('缺 agentId（宿主直调）→ 拒绝执行', async () => {
    const ctx = await boot();
    const r = await exec(ctx, { action: 'read' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('agentId');
  });
});

describe('todo 工具 · 持久化与卸载', () => {
  it('清单经 agentStore 落盘（entry key todo，桶含 updatedAt）', async () => {
    const ctx = await boot();
    await exec(ctx, { action: 'write', todos: [{ content: '落盘验证' }] }, { agentId: 'a1', conversationId: 'c1' });
    const stored = ctx.agentStore.readEntry<{ version: 1; buckets: Record<string, { items: unknown[]; updatedAt: string }> }>('a1', 'todo');
    expect(stored).toBeDefined();
    expect(stored!.version).toBe(1);
    expect(Object.keys(stored!.buckets)).toContain('c1');
    expect(stored!.buckets['c1']!.items[0]).toEqual({ content: '落盘验证', status: 'pending' });
  });

  it('卸载级联：dispose todo 行 → 工具从注册面消失', async () => {
    const ctx = new Context();
    const fibers: Fiber[] = [];
    for (const row of [toolsRow, MemoryAgentStore, todoRow]) {
      const fiber = ctx.plugin(row as any);
      await fiber;
      fibers.push(fiber);
    }
    expect(ctx.tools.has('todo')).toBe(true);
    await fibers[2].dispose(); // 摘 todo 行
    expect(ctx.tools.has('todo')).toBe(false);
    await fibers[0].dispose();
    await fibers[1].dispose();
  });
});
