// ============================================================
// ac-client-ui-runview：事件驱动刷新（2026-09-19 改造）——
// run 生命周期帧触发 refresh（500ms 去抖，多帧合并）、无关帧不触发、
// 重连（onOpen）即刷
// ============================================================
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createClient } from 'ac-client-runtime';
import { runviewClientPlugin } from 'ac-client-ui-runview/client';

function rpcStub() {
  const eventHooks: Array<(type: string, args: unknown[]) => void> = [];
  const openHooks: Array<() => void> = [];
  const calls: Array<Record<string, unknown> | undefined> = [];
  return {
    onEvent(h: (type: string, args: unknown[]) => void) {
      eventHooks.push(h);
      return () => { const i = eventHooks.indexOf(h); if (i >= 0) eventHooks.splice(i, 1); };
    },
    onOpen(h: () => void) {
      openHooks.push(h);
      return () => { const i = openHooks.indexOf(h); if (i >= 0) openHooks.splice(i, 1); };
    },
    emit(type: string) { for (const h of [...eventHooks]) h(type, []); },
    open() { for (const h of [...openHooks]) h(); },
    call: async (_method: string, params?: unknown) => {
      calls.push(params as Record<string, unknown> | undefined);
      return {
        digest: 'd1', unchanged: false,
        snapshot: { generatedAt: '', running: [], pairs: [], groups: [], runningTotal: 0 },
      };
    },
    calls,
  };
}

describe('runs 事件驱动刷新', () => {
  it('run 生命周期帧触发 refresh（去抖合并：三帧一次拉取）', async () => {
    const ctx = await createClient();
    const stub = rpcStub();
    await ctx.plugin({
      name: 'test-rpc-stub',
      apply(c) { c.provide('rpc', stub); },
    });
    const fiber = await ctx.plugin(runviewClientPlugin);
    const n0 = stub.calls.length;
    stub.emit('loop/run-started');
    stub.emit('loop/after-run');
    stub.emit('loop/after-run');
    await new Promise((r) => setTimeout(r, 800));
    expect(stub.calls.length).toBeGreaterThanOrEqual(n0 + 1);
    expect(stub.calls.length).toBeLessThanOrEqual(n0 + 2); // 去抖窗口内合并
    await fiber.dispose();
  });

  it('无关事件不触发 refresh', async () => {
    const ctx = await createClient();
    const stub = rpcStub();
    await ctx.plugin({ name: 'test-rpc-stub', apply(c) { c.provide('rpc', stub); } });
    const fiber = await ctx.plugin(runviewClientPlugin);
    const n0 = stub.calls.length;
    stub.emit('llm/delta-text');
    stub.emit('tool/after-execute');
    await new Promise((r) => setTimeout(r, 800));
    expect(stub.calls.length).toBe(n0);
    await fiber.dispose();
  });

  it('重连（onOpen）即刷', async () => {
    const ctx = await createClient();
    const stub = rpcStub();
    await ctx.plugin({ name: 'test-rpc-stub', apply(c) { c.provide('rpc', stub); } });
    const fiber = await ctx.plugin(runviewClientPlugin);
    const n0 = stub.calls.length;
    stub.open();
    await new Promise((r) => setTimeout(r, 800));
    expect(stub.calls.length).toBeGreaterThanOrEqual(n0 + 1);
    await fiber.dispose();
  });
});
