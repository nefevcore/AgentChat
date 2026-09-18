// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-runview.test.ts —— S3 runview client-only 行验收
//
// M27 S3：runview 迁出 webui in-bundle → `ac-client-ui-runview` 行
//（client 半边 = ac-client-ui-runview/client；boot graph 装载的落点模块）。
// rpc 依赖经宿主契约面（本测试用 stub 提供）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { computed } from 'vue';
import { createClient, type Fiber } from 'ac-client-runtime';
import { runviewClientPlugin, RunsClientService } from 'ac-client-ui-runview/client';
import { bootWebuiRuntime } from './lib/webuiBoot';

describe('S3 · runview client 行（ac-client-ui-runview/client：ctx.runs 域投影）', () => {
  it('服务装载（rpc stub）：ctx.runs 可解析；快照签名短路保留对象引用（矩阵零重算防御）', async () => {
    const ctx = await createClient();
    // rpc 宿主面 stub（行 client inject ['rpc','slots']）
    await ctx.plugin({
      name: 'test-rpc-stub',
      apply(c) {
        c.provide('rpc', {
          call<T>(_method: string, _params?: unknown): Promise<T> {
            return Promise.reject(new Error('stub offline'));
          },
        });
      },
    });
    const fiber: Fiber = await ctx.plugin(runviewClientPlugin);
    const svc = ctx.runs;
    expect(svc).toBeDefined();
    expect(svc.snapshot.value).toBeNull();

    // 签名短路：内容相同 → 保留原对象引用，只更新 generatedAt（语义锁定）
    const base = {
      generatedAt: 1, pairs: [{ a: 'u', b: 'x', count: 1 }], groups: [], running: [],
      coverage: { unknownMembers: [] },
    } as never;
    svc.snapshot.value = base;
    const sameContent = { ...base, generatedAt: 2 };
    expect(RunsClientService['signature'](base)).toBe(RunsClientService['signature'](sameContent as never));

    const probe = computed(() => svc.snapshot.value);
    expect(probe.value).toMatchObject({ generatedAt: 1 });
    const seen = probe.value;
    expect(svc.snapshot.value).toBe(seen); // 同一响应式代理（快照未变不换引用）
    await fiber.dispose();
  });

  it('轮询启动与回收：ensurePolling 幂等；fiber dispose → 秒针停走（定时器零泄漏）', async () => {
    const ctx = await createClient();
    await ctx.plugin({
      name: 'test-rpc-stub',
      apply(c) {
        c.provide('rpc', {
          call<T>(_method: string, _params?: unknown): Promise<T> {
            return Promise.reject(new Error('stub offline'));
          },
        });
      },
    });
    const fiber = await ctx.plugin(runviewClientPlugin);
    const svc = ctx.runs;
    svc.ensurePolling();
    svc.ensurePolling(); // 幂等
    const before = svc.now.value;
    await new Promise((r) => setTimeout(r, 1100));
    expect(svc.now.value).toBeGreaterThanOrEqual(before); // tick 在跑

    await fiber.dispose(); // 卸载：轮询 + 秒针一并回收
    expect((ctx as { runs?: unknown }).runs).toBeUndefined();
    const after = svc.now.value;
    await new Promise((r) => setTimeout(r, 1100));
    expect(svc.now.value).toBe(after); // 秒针已停（定时器零残留）
  });

  it('可摘除性（D19/S3）：装载后卸载 → 宿主不残废', async () => {
    const ctx = await createClient();
    await ctx.plugin({
      name: 'test-rpc-stub',
      apply(c) {
        c.provide('rpc', {
          call<T>(_method: string, _params?: unknown): Promise<T> {
            return Promise.reject(new Error('stub offline'));
          },
        });
      },
    });
    const fiber = await ctx.plugin(runviewClientPlugin);
    expect(ctx.runs).toBeDefined();
    await fiber.dispose();
    expect((ctx as { runs?: unknown }).runs).toBeUndefined();
  });

  it('未装载行 client 的 runtime → ctx.runs 不可解析（空态渲染）', async () => {
    const { ctx } = await bootWebuiRuntime(); // 不装 runview 行 client
    expect((ctx as { runs?: unknown }).runs).toBeUndefined();
  });

  it('M28 P0-2 · pair 视角出厂贡献：装载 → main:perspective 含 pair（居 talk 前）；卸载 → 消失', async () => {
    const { ctx } = await bootWebuiRuntime();
    const ids = () => ctx.slots.entries('main:perspective').map((e) => e.id);
    const fiber = await ctx.plugin(runviewClientPlugin);
    expect(ids()).toContain('pair');
    // 选举序：pair(10) 居 talk(20) 之前——激活期间覆盖 talk 的语义锚
    expect(ids().indexOf('pair')).toBeLessThan(ids().indexOf('talk'));
    await fiber.dispose();
    expect(ids()).not.toContain('pair');
  });

  it('M28 P1-3 · 矩阵/面板席位贡献：装载 → main(tracking) + primary-sidebar:domain(tracking)；卸载 → 消失', async () => {
    const { ctx } = await bootWebuiRuntime();
    const fiber = await ctx.plugin(runviewClientPlugin);
    const mainIds = () => ctx.slots.entries('main').map((e) => e.id);
    expect(mainIds()).toContain('webui-domain-runview.matrix');
    // 选举序（2026-11 主区语义纯化）：tracking(50) 居 chat 兜底(100) 之前——
    // 激活期间覆盖 chat 的语义锚（原 main:tracking 专座收编为 main 选举条目）
    expect(mainIds().indexOf('webui-domain-runview.matrix')).toBeLessThan(mainIds().indexOf('webui-base-layout.perspective-host'));
    // 选举席（非外层 primary-sidebar outlet——防与壳叠加渲染；条目 id
    // 2026-11 随 sidebar 行归并改前缀 webui-base-layout）
    expect(ctx.slots.entries('primary-sidebar').map((e) => e.id)).toEqual(['webui-base-layout.primary-sidebar']);
    const panel = ctx.slots.entries('primary-sidebar:domain').find((e) => e.meta?.panel === 'tracking');
    expect(panel?.id).toBe('webui-domain-runview.panel');
    await fiber.dispose();
    expect(mainIds()).not.toContain('webui-domain-runview.matrix');
    expect(ctx.slots.entries('primary-sidebar:domain').find((e) => e.meta?.panel === 'tracking')).toBeUndefined();
  });

  it('tracking aux 选区 rail：纯快照语义——无 badge 供数（徽章退役）；行卸载 → 选区同灭', async () => {
    const { ctx } = await bootWebuiRuntime();
    const fiber = await ctx.plugin(runviewClientPlugin);
    const entry = ctx.slots.entries('aux-sidebar').find((e) => e.id === 'webui-domain-runview.sidebar');
    expect(entry).toBeDefined();
    const def = entry!.meta?.def as { rail?: { badge?: () => number | string | null } };
    // 2026-12 运行态徽章退役：rail 按钮不再展示运行中数字（矩阵/按钮均退化为
    // 快照展示；运行中状态看面板内的「运行中会话」节点）
    expect(def.rail?.badge).toBeUndefined();
    await fiber.dispose();
    expect(ctx.slots.entries('aux-sidebar').find((e) => e.id === 'webui-domain-runview.sidebar')).toBeUndefined();
  });
});
