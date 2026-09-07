// ============================================================
// src/ac-todo/tests/todo-row.test.ts —— 行包双半边验收（M27 S3/D19）
//
// · 宿主半边：boot graph 声明 + 卸载级联（声明回收 → 前端 todo 消费面
//   消失的服务端证据）。bootTree 全树 HTTP 面见 webui/tests/
//   boot-graph-http.test.ts。
// · client 半边：出场贡献（tool-card:result-view keyed seat id 'todo'
//   + tracking:dock-widget）+ 行卸载级联回收（前端可摘除性证据）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import * as todoRow from '../src/index.ts';

// ------------------------------------------------------------
// 宿主半边：行装载（tools/agentStore 以最小桩满足 inject——本测试只验
// boot graph 面，不执行工具语义）
// ------------------------------------------------------------

class StubToolsService extends Service {
  constructor(ctx: Context) { super(ctx, 'tools'); }
  register(): () => void { return () => undefined; }
}

class StubAgentStoreService extends Service {
  constructor(ctx: Context) { super(ctx, 'agentStore'); }
}

/** 装载本行（namespace 插件形态——经类型垫片走 ctx.plugin） */
async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(todoRow, undefined);
}

async function boot() {
  const ctx = new Context();
  new StubToolsService(ctx);
  new StubAgentStoreService(ctx);
  // webui 服务直构（行内单测不拉整树——webui 服务面足够）
  const { WebUiService } = await import('ac-webui/src/service.ts');
  new WebUiService(ctx);
  return ctx;
}

describe('S3 · ac-todo 宿主半边（boot graph 声明）', () => {
  it('行装载 → ctx.webui boot graph 含 todo 条目（entry 为绝对路径）', async () => {
    const ctx = await boot();
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('todo');
    const def = graph.find((g) => g.name === 'todo')!;
    expect(def.platform).toBe('web');
    expect(def.entry).toMatch(/ac-todo[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
  });

  it('headless 宿主（无 webui 行）→ ctx.get 探测跳过声明，行装载不炸', async () => {
    const ctx = new Context();
    new StubToolsService(ctx);
    new StubAgentStoreService(ctx);
    const fiber = await loadRow(ctx);
    expect(fiber.uid).not.toBeNull();
    await fiber.dispose();
  });

  it('可摘除性（D19）：行卸载 → 声明级联回收 → boot graph 收缩 + 变更帧（前端消费面消失的服务端证据）', async () => {
    const ctx = await boot();
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('todo');
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('todo');
    // 热通道通知：装载与回收各发一帧（前端装载器 debounce 重拉）
    expect(changed).toContain('todo');
    expect(changed.filter((n) => n === 'todo').length).toBeGreaterThanOrEqual(2);
    off();
  });
});

// ------------------------------------------------------------
// client 半边：出场贡献 + 卸载级联（真客户端运行时）
// ------------------------------------------------------------

class StubRpcService extends Service {
  readonly seen: Array<[string, unknown?]> = [];
  private handlers: Array<(type: string, args: unknown[]) => void> = [];
  constructor(ctx: Context) { super(ctx, 'rpc'); }
  async call<T>(method: string, params?: unknown): Promise<T> {
    this.seen.push([method, params]);
    return {} as T;
  }
  onEvent(handler: (type: string, args: unknown[]) => void): () => void {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }
}

describe('S3 · ac-todo client 半边（出场贡献 + 可摘除性）', () => {
  it('插件装载 → 工具卡 def + dock 卡贡献在场；卸载 → 级联回收', async () => {
    const { createClient } = await import('ac-client-runtime');
    const ctx = await createClient();
    await ctx.plugin(StubRpcService);
    // 席位声明（真 boot 归 hostLedger/conversation 基础件——此处直构等价账本）
    ctx.slots.declare({ key: 'tool-card:result-view', kind: 'list' });
    ctx.slots.declare({ key: 'tracking:dock-widget', kind: 'list' });

    const { todoClientPlugin } = await import('../client/index.ts');
    const fiber = await ctx.plugin(todoClientPlugin);

    // 工具卡：keyed presentation seat（def 形状对齐 webui 解析契约）
    const card = ctx.slots.entries('tool-card:result-view').find((e) => e.id === 'todo');
    expect(card).toBeDefined();
    expect((card!.meta?.def as { match?: string }).match).toBe('todo');
    // dock 卡：list seat 贡献（order 10 = DSH dock 序 Todo 在前）
    const dock = ctx.slots.entries('tracking:dock-widget').find((e) => e.id === 'todo');
    expect(dock).toBeDefined();
    expect(dock!.order).toBe(10);

    // 可摘除性：插件卸载 → 两贡献一并消失（D19 前端消费面消失）
    await fiber.dispose();
    expect(ctx.slots.entries('tool-card:result-view').map((e) => e.id)).not.toContain('todo');
    expect(ctx.slots.entries('tracking:dock-widget').map((e) => e.id)).not.toContain('todo');
  });
});
