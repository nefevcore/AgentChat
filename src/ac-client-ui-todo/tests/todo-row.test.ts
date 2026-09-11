// ============================================================
// src/ac-client-ui-todo/tests/todo-row.test.ts —— 前端行验收（M27.1）
//
// · 宿主半边：boot graph 声明 + 卸载级联（声明回收 → 前端 todo 消费面
//   消失的服务端证据）。bootTree 全树 HTTP 面见 webui/tests/
//   boot-graph-http.test.ts。
// · client 半边：出场贡献（tool-card:result-view keyed seat id 'todo'
//   + tracking:dock-widget）+ 行卸载级联回收（前端可摘除性证据）。
// · 双向摘除（M27.1 修正核心收益）：卸 UI 行 → 后端行照常装载；
//   卸后端行 → UI 行照常装载（RPC 失败 → null → 三态静默空态）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import * as uiTodoRow from '../src/index.ts';

/** 装载本行（namespace 插件形态——经类型垫片走 ctx.plugin） */
async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(uiTodoRow, undefined);
}

async function boot() {
  const ctx = new Context();
  // webui 服务直构（行内单测不拉整树——webui 服务面足够）
  const { WebUiService } = await import('ac-webui/src/service.ts');
  new WebUiService(ctx);
  return ctx;
}

// ------------------------------------------------------------
// 后端行最小装配（双向摘除用）：ac-todo 后端行的 tools/agentStore
// inject 桩 + 真后端行（跨包深路径仅供测试——运行时两行经 RPC 契约
// 面解耦，互不 import）
// ------------------------------------------------------------

class StubToolsService extends Service {
  constructor(ctx: Context) { super(ctx, 'tools'); }
  register(): () => void { return () => undefined; }
}

class StubAgentStoreService extends Service {
  constructor(ctx: Context) { super(ctx, 'agentStore'); }
}

async function bootWithBackend() {
  const ctx = await boot();
  new StubToolsService(ctx);
  new StubAgentStoreService(ctx);
  const backend = await import('ac-todo/src/index.ts');
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  const backendFiber = await plug(backend, undefined);
  return { ctx, backendFiber };
}

describe('M27.1 · ac-client-ui-todo 宿主半边（boot graph 声明）', () => {
  it('行装载 → ctx.webui boot graph 含 ui-todo 条目（entry 为绝对路径）', async () => {
    const ctx = await boot();
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-todo');
    const def = graph.find((g) => g.name === 'ui-todo')!;
    expect(def.platform).toBe('web');
    expect(def.entry).toMatch(/ac-client-ui-todo[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
  });

  it('可摘除性（D19）：行卸载 → 声明级联回收 → boot graph 收缩 + 变更帧（前端消费面消失的服务端证据）', async () => {
    const ctx = await boot();
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-todo');
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-todo');
    // 热通道通知：装载与回收各发一帧（前端装载器 debounce 重拉）
    expect(changed).toContain('ui-todo');
    expect(changed.filter((n) => n === 'ui-todo').length).toBeGreaterThanOrEqual(2);
    off();
  });
});

describe('M27.1 · 双向摘除（UI 行 ⇄ 后端行独立可摘）', () => {
  it('卸 UI 行 → boot graph 收缩，后端行照常在场（ctx.todos 服务可调）', async () => {
    const { ctx, backendFiber } = await bootWithBackend();
    const uiFiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-todo');
    await uiFiber.dispose(); // 摘 UI 行
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-todo');
    expect(ctx.get('todos')).toBeDefined(); // 后端能力不受牵连（RPC 可调）
    await backendFiber.dispose();
  });

  it('卸后端行 → UI 行照常在场（boot graph 不收缩——RPC 失败空态归前端三态语义）', async () => {
    const { ctx, backendFiber } = await bootWithBackend();
    const uiFiber = await loadRow(ctx);
    await backendFiber.dispose(); // 摘后端行
    expect(ctx.get('todos', false)).toBeUndefined(); // 后端能力同灭
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-todo'); // UI 行不动
    await uiFiber.dispose();
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

describe('M27.1 · ac-client-ui-todo client 半边（出场贡献 + 可摘除性）', () => {
  it('插件装载 → 工具卡 def + dock 卡贡献在场；卸载 → 级联回收', async () => {
    const { createClient } = await import('ac-client-runtime');
    const ctx = await createClient();
    await ctx.plugin(StubRpcService);
    // 席位声明（真 boot 归 hostLedger/conversation 基础件——此处直构等价账本）
    ctx.slots.declare({ key: 'tool-card:result-view', kind: 'list', elect: true });
    ctx.slots.declare({ key: 'conversation:dock-widget', kind: 'list' });

    const { todoClientPlugin } = await import('../client/index.ts');
    const fiber = await ctx.plugin(todoClientPlugin);

    // 工具卡：keyed presentation seat（def 形状对齐 webui 解析契约）
    const card = ctx.slots.entries('tool-card:result-view').find((e) => e.id === 'todo');
    expect(card).toBeDefined();
    expect((card!.meta?.def as { match?: string }).match).toBe('todo');
    // dock 卡：list seat 贡献（order 10 = DSH dock 序 Todo 在前）
    const dock = ctx.slots.entries('conversation:dock-widget').find((e) => e.id === 'todo');
    expect(dock).toBeDefined();
    expect(dock!.order).toBe(10);

    // 可摘除性：插件卸载 → 两贡献一并消失（D19 前端消费面消失）
    await fiber.dispose();
    expect(ctx.slots.entries('tool-card:result-view').map((e) => e.id)).not.toContain('todo');
    expect(ctx.slots.entries('conversation:dock-widget').map((e) => e.id)).not.toContain('todo');
  });

  it('后端不在场（RPC reject）→ fetchTodos null → dock 卡静默空态（三态语义）', async () => {
    const { fetchTodos } = await import('../client/tasks.ts');
    const offline = {
      call(): Promise<never> {
        return Promise.reject(new Error('backend offline'));
      },
    };
    const r = await fetchTodos(offline, 'helper', 'helper~user');
    expect(r).toBeNull(); // 可选能力未装载 / 连接失败：不渲染，不报错
  });
});
