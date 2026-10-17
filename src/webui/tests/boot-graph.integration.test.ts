// @vitest-environment jsdom
// ============================================================
// webui/tests/boot-graph.test.ts —— S3 boot graph 装载器验收
//
// 行卸载 → 不在图 → 前端消费面消失（D19 语义的装载器侧证据）+
// vite 静态映射接线。bootTree 真树 HTTP 面见 boot-graph-http.test.ts
//（node 环境——jsdom 的 URL 垫片与 node:url 不兼容）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { clientPlugin } from 'ac-client-runtime';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { makeRpcStub } from './lib/rpcStub';
import { rowClientLoaders } from '../src/runtime/virtual-row-clients';
import { runviewClientPlugin } from 'ac-client-ui-runview/client';
import { rosterClientPlugin } from 'ac-client-ui-agents/client';
import { applyBootGraph } from '../src/runtime/bootGraph';

describe('S3 · boot graph 装载器（静态映射 + 行装载）', () => {
  it('静态映射接线：virtual:row-clients 经 rowClientLoaders 可注入（测试注入口）', () => {
    // vite 插件在生产生成映射；vitest 下映射是可注入口（本用例验证形态）
    expect(typeof rowClientLoaders).toBe('object');
    rowClientLoaders['test-row'] = () => Promise.resolve({ default: runviewClientPlugin });
    expect(typeof rowClientLoaders['test-row']).toBe('function');
    delete rowClientLoaders['test-row'];
  });

  it('行 client 经 ctx.plugin 装载（rpc 契约面 + slots）→ ctx.runs 就位', async () => {
    const stub = makeRpcStub();
    const boot = await bootWebuiRuntime(stub.impl);
    const ctx = boot.ctx;
    const fiber = await ctx.plugin(runviewClientPlugin);
    expect(ctx.runs).toBeDefined();
    // 装载即启动轮询（rail 徽章数据源常驻）——stub 空对象 {} 合成空视图
    //（running: []）；refresh 异步在飞，等它落定再断言
    for (let i = 0; i < 50 && !ctx.runs.snapshot.value; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(ctx.runs.snapshot.value?.running).toEqual([]);
    await fiber.dispose();
    expect((ctx as { runs?: unknown }).runs).toBeUndefined();
  });

  it('热通道：webui/boot-graph-changed 帧 → debounce 重拉 diff → 行 client 装载/回收（可摘除性 D19）', async () => {
    // rpc 桩：call 离线空态；onEvent 捕获订阅者（宿主帧注入面）
    const stub = makeRpcStub();
    const boot = await bootWebuiRuntime(stub.impl);
    const ctx = boot.ctx;
    // conversation:dock-widget 席位（真 boot 归 conversation 基础件——直构等价账本）
    ctx.slots.declare({ key: 'conversation:dock-widget', kind: 'list' });
    // fetch 桩：宿主 boot graph 面可控（M27.1：todo 前端行派生名 ui-todo）
    let graph: { clients: Array<{ name: string; entry: string; platform: 'web' }> } = {
      clients: [{ name: 'ui-todo', entry: '/@fs/ac-client-ui-todo/client/index.ts', platform: 'web' }],
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, json: async () => graph } as Response)) as typeof fetch;
    rowClientLoaders['ui-todo'] = () => import('ac-client-ui-todo/client');
    try {
      await applyBootGraph(); // 首图：ui-todo 行装载
      expect(ctx.slots.entries('tool-card:result-view').map((e) => e.id)).toContain('todo');
      expect(ctx.slots.entries('conversation:dock-widget').map((e) => e.id)).toContain('todo');

      // 宿主行卸载（yml patch 热通道）→ graph 收缩 → 帧通知 → debounce 重拉
      graph = { clients: [] };
      stub.emit('webui/boot-graph-changed', 'ui-todo');
      await new Promise((r) => setTimeout(r, 500)); // debounce 300ms + 余量
      expect(ctx.slots.entries('tool-card:result-view').map((e) => e.id)).not.toContain('todo');
      expect(ctx.slots.entries('conversation:dock-widget').map((e) => e.id)).not.toContain('todo');

      // 重装 → 帧通知 → 装载回来（幂等 diff，不重复装载）
      graph = { clients: [{ name: 'ui-todo', entry: '/@fs/ac-client-ui-todo/client/index.ts', platform: 'web' }] };
      stub.emit('webui/boot-graph-changed', 'ui-todo');
      await new Promise((r) => setTimeout(r, 500));
      expect(ctx.slots.entries('tool-card:result-view').map((e) => e.id)).toContain('todo');
    } finally {
      delete rowClientLoaders['ui-todo'];
      globalThis.fetch = realFetch;
    }
  });
});

// ============================================================
// 装载契约回归锁（cr-487 事故）：行 client 半边**必须**具 default 出口。
//
// 事故实录：cr-459 精简按「全仓 grep 零消费」判死删除
// ac-client-ui-singles/client 的 `export default`（全仓 10 个消费点全走具名
// singlesClientPlugin，静态 grep 确实零命中），但真正的消费方是 boot graph
// 的动态 import 装载面——loadEntry 只认 mod.default.apply，该行随即被
// 静默跳过（console 一行 warn），sessions 列表面板 / single 视角 /
// header 动作族整片消失。既有测试全部直装具名出口，故全绿放行。
//
// 本锁走真装载器路径（fake fetch 给图 + 真 rowClientLoaders 动态 import），
// 与既有用例「直装 singlesClientPlugin」互补：那条测插件本体，这条测
// 「宿主真能把它装起来」。
// ============================================================
describe('S3 · 行 client 半边 default 装载契约（cr-487 回归锁）', () => {
  it('ui-singles：boot graph 装载路径真装载 → ctx.singleBoard 就位（非静默跳过）', async () => {
    const stub = makeRpcStub();
    const boot = await bootWebuiRuntime(stub.impl);
    const ctx = boot.ctx;
    // 行 inject 前提：singles 行要 roster（fiber 等待，缺则本用例永不落定）
    await ctx.plugin(rosterClientPlugin);
    const graph = {
      clients: [{ name: 'ui-singles', entry: '/@fs/ac-client-ui-singles/client/index.ts', platform: 'web' }],
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, json: async () => graph } as Response)) as typeof fetch;
    const warns: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args); };
    // 真映射 = 真动态 import 该行 client/index.ts——装载器读其 default
    rowClientLoaders['ui-singles'] = () => import('ac-client-ui-singles/client');
    try {
      await applyBootGraph();
      // 缺 default 出口时本断言失败（装载器 warn + 跳过，服务面缺席）
      expect(ctx.singleBoard).toBeDefined();
      expect(warns.filter((a) => String(a[0]).includes('缺省导出插件'))).toEqual([]);
      // 三处贡献面真实落位（席位 = 行存在的证据面）
      expect(ctx.slots.entries('primary-sidebar:domain').map((e) => e.meta?.panel)).toContain('sessions');
      expect(ctx.slots.entries('main:perspective').map((e) => e.id)).toContain('single');
      expect(ctx.slots.entries('conversation:header-widget').map((e) => e.id)).toContain('single-actions');
    } finally {
      console.warn = realWarn;
      // 清装载器账本（loadedRows 模块级常驻）：喂空图 + 变更帧 → 该行 fiber
      // 级联回收，防污染同文件其余用例
      globalThis.fetch = (async () =>
        ({ ok: true, json: async () => ({ clients: [] }) } as Response)) as typeof fetch;
      stub.emit('webui/boot-graph-changed', 'ui-singles');
      await new Promise((r) => setTimeout(r, 500)); // debounce 300ms + 余量
      delete rowClientLoaders['ui-singles'];
      globalThis.fetch = realFetch;
    }
  });
});

void (clientPlugin);
