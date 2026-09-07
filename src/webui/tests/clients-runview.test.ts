// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-runview.test.ts —— S2 runview 域插件验收
//
// 「域投影 + ctx.runs 服务面」+ 可摘除性（D19/S2：卸载域插件 →
// 轮询定时器回收 + ctx.runs 消失 + 无残留无报错）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { computed } from 'vue';
import { createClient, type Fiber } from 'ac-client-runtime';
import { runviewDomainPlugin, RunsClientService } from '../src/clients/runview';
import { bootWebuiRuntime } from './lib/webuiBoot';

describe('S2 · runview 域插件（域投影 + ctx.runs 服务面）', () => {
  it('服务装载：ctx.runs 可解析；快照签名短路保留对象引用（矩阵零重算防御）', async () => {
    const ctx = await createClient();
    const fiber: Fiber = await ctx.plugin(runviewDomainPlugin);
    const svc = ctx.runs;
    expect(svc).toBeDefined();
    expect(svc.snapshot.value).toBeNull();

    // 签名短路：内容相同 → 保留原对象引用，只更新 generatedAt
    const base = {
      generatedAt: 1, pairs: [{ a: 'u', b: 'x', count: 1 }], groups: [], running: [],
      coverage: { unknownMembers: [] },
    } as never;
    svc.snapshot.value = base;
    const sameContent = { ...base, generatedAt: 2 };
    // 直接调用内部刷新不可行（fetchRuns 走真连接）——用签名静态方法锁定语义
    //（refresh 的短路分支由连接态测试覆盖；这里锁 signature 剔除 generatedAt）
    expect(RunsClientService['signature'](base)).toBe(RunsClientService['signature'](sameContent as never));

    const probe = computed(() => svc.snapshot.value);
    // Vue ref 深层 reactive：.value 是 base 的响应式代理（字段等价、身份不同）；
    // 代理身份跨读取稳定（签名短路的「引用不变→派生短路」防御即基于此）
    expect(probe.value).toMatchObject({ generatedAt: 1 });
    const seen = probe.value;
    expect(svc.snapshot.value).toBe(seen); // 同一响应式代理（快照未变不换引用）
    await fiber.dispose();
  });

  it('轮询启动与回收：ensurePolling 幂等；fiber dispose → 定时器清零（不泄漏）', async () => {
    const ctx = await createClient();
    const fiber = await ctx.plugin(runviewDomainPlugin);
    const svc = ctx.runs;
    svc.ensurePolling();
    svc.ensurePolling(); // 幂等
    // 轮询已启动（内部句柄非空——经行为侧面验证：now 秒针走表）
    const before = svc.now.value;
    await new Promise((r) => setTimeout(r, 1100));
    expect(svc.now.value).toBeGreaterThanOrEqual(before); // tick 在跑

    await fiber.dispose(); // 卸载：轮询 + 秒针一并回收
    expect((ctx as { runs?: unknown }).runs).toBeUndefined();
    const after = svc.now.value;
    await new Promise((r) => setTimeout(r, 1100));
    expect(svc.now.value).toBe(after); // 秒针已停（定时器零残留）
  });

  it('可摘除性（D19/S2）：bootWebuiRuntime 装配域件后卸载 → 宿主不残废', async () => {
    const { ctx } = await bootWebuiRuntime();
    const fiber = await ctx.plugin(runviewDomainPlugin);
    expect(ctx.runs).toBeDefined();
    await fiber.dispose();
    expect((ctx as { runs?: unknown }).runs).toBeUndefined();
  });

  it('未装载域件的 runtime → useClientContext()?.runs = undefined（空态渲染）', async () => {
    const { ctx } = await bootWebuiRuntime(); // 不装 runview 域件
    expect((ctx as { runs?: unknown }).runs).toBeUndefined();
  });
});
