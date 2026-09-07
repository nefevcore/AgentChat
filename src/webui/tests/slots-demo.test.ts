// @vitest-environment jsdom
// ============================================================
// webui/tests/slots-demo.test.ts —— S0 demo 装配单测（M27 §2-S0 验收）
//
// 装配面（node 语义）+ mount 面（jsdom）：root 由 slot 装配、出厂占据 +
// 封印防线、插件贡献就位、vueRenderer install boot-once、真渲染出
// 同轴合并结果（浏览器冒烟的机械替代）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createClient, clientPlugin } from 'ac-client-runtime';
import { SlotCoreError } from 'ac-client-slots';
import { assembleSlotsDemo, mountSlotsDemo } from '../src/runtime/slots-demo.ts';

describe('slots-demo 装配（S0 验收面）', () => {
  it('root 由 slot 装配：出厂占据 + 封印后动态抢占被拒', async () => {
    const ctx = await createClient();
    await assembleSlotsDemo(ctx);
    expect(ctx.slots.snapshot().factorySealed).toBe(true);
    expect(ctx.slots.entries('root').map((e) => e.id)).toEqual(['demo-layout.app-frame']);
    const evil = ctx.plugin(clientPlugin({
      name: 'demo-evil',
      inject: ['slots'],
      apply(c) {
        expect(() => c.slots.register('root', { id: 'evil', component: { render: () => null } })).toThrowError(
          SlotCoreError,
        );
      },
    }));
    await evil;
    await evil.dispose();
  });

  it('声明账本含 root 与两个 seat；工具条三贡献 + 页脚状态行就位', async () => {
    const ctx = await createClient();
    await assembleSlotsDemo(ctx);
    const keys = ctx.slots.snapshot().declarations.map((d) => d.key);
    expect(keys).toContain('root');
    expect(keys).toContain('demo:toolbar');
    expect(keys).toContain('demo:status');
    const toolbar = ctx.slots.entries('demo:toolbar').map((e) => e.id);
    expect(toolbar).toEqual(['demo-greeter.btn-early', 'demo-greeter.btn-late', 'demo-greeter.unload']);
    expect(ctx.slots.entries('demo:status').map((e) => e.id)).toEqual(['demo-greeter.status']);
  });

  it('渲染器 install boot-once：demo 装配后二次安装被拒', async () => {
    const ctx = await createClient();
    await assembleSlotsDemo(ctx);
    expect(ctx.slots.installedRenderer?.framework).toBe('vue');
    expect(() => ctx.slots.install({ framework: 'dup', render: () => [] })).toThrowError(/boot-once/);
  });

  it('mount 面：root 由 slot 装配渲染，宿主内置项与插件贡献同轴落位', async () => {
    const root = document.createElement('div');
    root.id = 'app-mount-check';
    document.body.appendChild(root);
    await mountSlotsDemo('#app-mount-check');
    const buttons = [...root.querySelectorAll('button')].map((b) => b.textContent ?? '');
    // 同轴合并：插件(20) → 宿主(50) → 插件尾钮(120) → 卸载钮(200)
    expect(buttons[0]).toContain('order 20');
    expect(buttons[1]).toContain('宿主内置钮');
    expect(buttons[2]).toContain('order 120');
    expect(buttons[3]).toContain('卸载');
    expect(root.querySelector('.demo-status')?.textContent).toContain('demo-greeter');
  });
});
