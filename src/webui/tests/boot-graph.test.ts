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
import { runviewClientPlugin } from 'ac-client-runview/client';

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
});

void (clientPlugin);
