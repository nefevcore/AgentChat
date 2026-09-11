// @vitest-environment jsdom
// ============================================================
// webui/tests/perspective-election.test.ts —— 视角选举健壮性回归
//
// 事故背景（M30 D4 后显形的 M28 P0.2 潜伏缺陷）：ui-group/ui-singles
// 的视角 def 曾用直接属性访问 ctx.groups / ctx.singleBoard——本件 ctx
// 的 fiber 链上无人 inject 该服务名，属性解析抛
// "cannot get property without inject"。潜伏原因：仅当 pair/talk 均
// 不激活（群/独立会话选中态）才会求值到这两个 def；显形原因：D4 壳
// 宿主条目化后该异常经 EntryErrorBoundary 上抛 → perspective-host
// 退位 → 主区空白。修复 = def 改 ctx.get 可选探测 + 解析面
// safeActive/props 防御（公开席位第三方 def 抛错只失去选举资格）。
// ============================================================
import { describe, it, expect, afterEach, vi } from 'vitest';
import { defineComponent } from 'vue';
import { bootWebuiRuntime } from './lib/webuiBoot';
import type { Fiber } from '@agentchat/cordis';

const C = defineComponent({ render: () => null });
const fibers: Fiber[] = [];

afterEach(async () => {
  for (const f of fibers.splice(0)) await f.dispose();
});

describe('视角选举 · 真实域行 def（ctx.get 可选探测）', () => {
  it('ui-group def：群激活 → group 当选，不抛（事故回归锁）', async () => {
    const { ctx } = await bootWebuiRuntime();
    fibers.push(await ctx.plugin((await import('ac-client-ui-agents/client')).rosterClientPlugin));
    fibers.push(await ctx.plugin((await import('ac-client-ui-group/client')).groupClientPlugin));
    const { activePerspective } = await import('ac-client-ui-layout/client/perspectives.ts');

    // 初始：无群 → talk 当选（group def 的 ctx.get 探测不抛）
    expect(activePerspective()?.id).toBe('talk');

    // 群激活 → talk 失去资格 → group def 求值（修复前此处抛
    // "cannot get property 'groups' without inject"）→ group 当选
    const groups = ctx.get('groups')!;
    groups.activeGroupId.value = 'g1';
    expect(activePerspective()?.id).toBe('group');
    groups.activeGroupId.value = '';
    expect(activePerspective()?.id).toBe('talk');
  });

  it('ui-singles def：谓词与 props 工厂求值不抛（同款潜伏缺陷回归锁）', async () => {
    const { ctx } = await bootWebuiRuntime();
    fibers.push(await ctx.plugin((await import('ac-client-ui-agents/client')).rosterClientPlugin));
    fibers.push(await ctx.plugin((await import('ac-client-ui-singles/client')).singlesClientPlugin));
    const { activePerspective } = await import('ac-client-ui-layout/client/perspectives.ts');

    // activeSingleId 为只读 computed（派生自 feed 活跃分区，离线桩下恒
    // 空）——本用例锁的是"求值不抛"：修复前 def.active() 首次求值即抛
    // "cannot get property 'singleBoard' without inject"
    const def = ctx.slots.entries('main:perspective').find((e) => e.id === 'single')
      ?.meta?.def as { active: () => boolean; props: () => unknown };
    expect(def).toBeDefined();
    expect(() => def.active()).not.toThrow();
    expect(def.active()).toBe(false);
    expect(() => def.props()).not.toThrow();
    expect(activePerspective()?.id).toBe('talk'); // single 未激活 → talk 当选
  });
});

describe('视角选举 · 缺陷 def 防御（公开席位不得被击穿）', () => {
  it('active() 抛错的 def：按未激活跳过 + 警告，选举继续', async () => {
    await bootWebuiRuntime();
    const { registerPerspective, activePerspective } = await import('ac-client-ui-layout/client/perspectives.ts');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 毒 def 排最前（order 5 < pair 10）——第三方缺陷 def 的典型形态
    const off = registerPerspective({
      id: 'poison', label: '毒视角', order: 5, component: C,
      active: () => {
        throw new Error('boom');
      },
    });
    try {
      expect(activePerspective()?.id).toBe('talk'); // 毒 def 被跳过，talk 照常当选
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toContain('poison');
    } finally {
      off();
      warn.mockRestore();
    }
  });
});

describe('视角选举 · 视图级错误边界（M30 §5.1 遗留收口）', () => {
  it('视角组件渲染崩溃 → 就地错误卡（壳条目不退位）；重试可复现；卸载毒视角 → 自愈', async () => {
    const { ctx } = await bootWebuiRuntime();
    const { createApp, defineComponent, h, nextTick } = await import('vue');
    const { CLIENT_CONTEXT_KEY } = await import('ac-client-runtime');
    const { registerPerspective } = await import('ac-client-ui-layout/client/perspectives.ts');
    const PerspectiveHost = (await import('ac-client-ui-layout/client/PerspectiveHost.vue')).default;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 健康视角（order 6）+ 毒视角（order 5 当选；setup 抛错 = 渲染期崩溃）
    const Healthy = defineComponent({ render: () => h('div', {}, '♥healthy♥') });
    const Poison = defineComponent({ setup() { throw new Error('view boom'); } });
    const offHealthy = registerPerspective({ id: 'healthy-view', label: '健康', order: 6, component: Healthy, active: () => true });
    const offPoison = registerPerspective({ id: 'poison-view', label: '毒视图', order: 5, component: Poison, active: () => true });

    const host = createApp({ setup: () => () => h(PerspectiveHost) });
    host.provide(CLIENT_CONTEXT_KEY, ctx);
    const root = document.createElement('div');
    document.body.appendChild(root);
    host.mount(root);
    try {
      await nextTick();
      // ① 毒视角当选即崩 → 边界截停：错误卡在场，壳条目未退位
      expect(root.textContent).toContain('渲染崩溃');
      expect(root.textContent).toContain('poison-view');
      expect(ctx.slots.single('main')?.id).toBe('webui-base-layout.perspective-host');

      // ② 重试：重挂载 → 再崩 → 错误卡仍在（不击穿、不死循环）
      (root.querySelector('.pc-retry') as HTMLElement).click();
      await nextTick();
      expect(root.textContent).toContain('渲染崩溃');
      expect(ctx.slots.single('main')?.id).toBe('webui-base-layout.perspective-host');

      // ③ 卸载毒视角 → 选举回落健康视角 → 崩溃态自愈
      offPoison();
      await nextTick();
      expect(root.textContent).toContain('♥healthy♥');
      expect(root.textContent).not.toContain('渲染崩溃');
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      host.unmount();
      root.remove();
      offHealthy();
      offPoison();
    }
  });
});
