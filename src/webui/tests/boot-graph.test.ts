// @vitest-environment jsdom
// ============================================================
// webui/tests/boot-graph.test.ts —— S3 boot graph 装载器验收
//
// 行卸载 → 不在图 → 前端消费面消失（D19 语义的装载器侧证据）+
// vite 静态映射接线。bootTree 真树 HTTP 面见 boot-graph-http.test.ts
//（node 环境——jsdom 的 URL 垫片与 node:url 不兼容）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { rowClientLoaders } from '../src/runtime/virtual-row-clients';
import { runviewClientPlugin } from 'ac-client-ui-runview/client';
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
    const boot = await bootWebuiRuntime();
    const ctx = boot.ctx;
    await ctx.plugin({
      name: 'test-rpc-stub',
      apply(c: ClientContext) {
        c.provide('rpc', {
          call<T>(_method: string, _params?: unknown): Promise<T> {
            return Promise.reject(new Error('stub offline'));
          },
        });
      },
    });
    const fiber = await ctx.plugin(runviewClientPlugin);
    expect(ctx.runs).toBeDefined();
    expect(ctx.runs.snapshot.value).toBeNull(); // rpc stub 离线 → 空态
    await fiber.dispose();
    expect((ctx as { runs?: unknown }).runs).toBeUndefined();
  });

  it('热通道：webui/boot-graph-changed 帧 → debounce 重拉 diff → 行 client 装载/回收（可摘除性 D19）', async () => {
    const boot = await bootWebuiRuntime();
    const ctx = boot.ctx;
    // rpc 桩：call 离线空态；onEvent 捕获订阅者（宿主帧注入面）
    let wire: ((type: string, args: unknown[]) => void) | null = null;
    await ctx.plugin({
      name: 'test-rpc-stub',
      apply(c: ClientContext) {
        c.provide('rpc', {
          call<T>(_method: string, _params?: unknown): Promise<T> {
            return Promise.reject(new Error('stub offline'));
          },
          onEvent(h: (type: string, args: unknown[]) => void) {
            wire = h;
            return () => { wire = null; };
          },
        });
      },
    });
    // tracking:dock-widget 席位（真 boot 归 conversation 基础件——直构等价账本）
    ctx.slots.declare({ key: 'tracking:dock-widget', kind: 'list' });
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
      expect(ctx.slots.entries('tracking:dock-widget').map((e) => e.id)).toContain('todo');

      // 宿主行卸载（yml patch 热通道）→ graph 收缩 → 帧通知 → debounce 重拉
      graph = { clients: [] };
      wire!('webui/boot-graph-changed', ['ui-todo']);
      await new Promise((r) => setTimeout(r, 500)); // debounce 300ms + 余量
      expect(ctx.slots.entries('tool-card:result-view').map((e) => e.id)).not.toContain('todo');
      expect(ctx.slots.entries('tracking:dock-widget').map((e) => e.id)).not.toContain('todo');

      // 重装 → 帧通知 → 装载回来（幂等 diff，不重复装载）
      graph = { clients: [{ name: 'ui-todo', entry: '/@fs/ac-client-ui-todo/client/index.ts', platform: 'web' }] };
      wire!('webui/boot-graph-changed', ['ui-todo']);
      await new Promise((r) => setTimeout(r, 500));
      expect(ctx.slots.entries('tool-card:result-view').map((e) => e.id)).toContain('todo');
    } finally {
      delete rowClientLoaders['ui-todo'];
      globalThis.fetch = realFetch;
    }
  });
});

void (clientPlugin);
