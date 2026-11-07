// @vitest-environment jsdom
// ============================================================
// boot.test.ts —— 壳 v3 装配序列验收（cr-933 重写：旧 bootUiClient
// 装载序列随 cutover 退役，本测锁定 boot-v3 面）
//
// ① createClient → ② 骨架 3 件 in-bundle（依赖序装载 + 服务可解析）→
// ③ sealFactory（出厂封印后 root 动态注册恒入低优层）→ ④ wire 装载
//（模块表物化 → ctx.plugin；坏行逐条隔离不毁表面）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Wire } from 'ac-webui-core';
import { bootUiClientV3 } from '../client/boot-v3.ts';

function wireOf(rows: Wire['rows']): Wire {
  return { rev: 'test', rows, seeds: {}, warnings: [] };
}

function row(id: string, over: Partial<Wire['rows'][number]> = {}): Wire['rows'][number] {
  return { id, version: '1.0.0', entry: '/ui-asset/' + id + '/r1/index.js', seats: [], isolated: false, ...over };
}

describe('webui-v3 · 壳装配序列（boot-v3）', () => {
  it('空 wire：骨架 3 件装载，服务可解析，root 席位出厂占用，拓扑契约词汇就绪', async () => {
    setActivePinia(createPinia());
    const { ctx, channel } = await bootUiClientV3({ fetchWire: async () => wireOf([]) });
    expect(channel.size).toBe(0);
    expect(ctx.theme).toBeDefined();
    expect(ctx.vueRenderer).toBeDefined();
    expect(ctx.slots.entries('root').length).toBe(1); // AppFrame 出厂层
    expect(ctx.slots.declOf('main')).toBeDefined();
    expect(ctx.slots.declOf('activity-bar')).toBeDefined();
    expect(ctx.slots.declOf('overlay')).toBeDefined();
  });

  it('出厂封印：sealFactory 后 root 动态注册恒入低优层（single 选举出厂恒胜）', async () => {
    setActivePinia(createPinia());
    const { ctx } = await bootUiClientV3({ fetchWire: async () => wireOf([]) });
    const TestComp = { render: () => null };
    ctx.slots.register('root', { id: 'late-attacker', component: TestComp as never, order: -1 });
    expect(ctx.slots.entries('root').length).toBe(2);
    expect(ctx.slots.single('root')?.id).toBe('webui-base-layout.app-frame');
  });

  it('wire 行物化 → ctx.plugin；坏行逐条隔离不毁表面；isolated/纯样式行跳过', async () => {
    setActivePinia(createPinia());
    // 真 factory bundle（经 loadScript 注入 eval——与构建器产物同形）
    const okBundle = 'globalThis.__ModuleLoader__.load({ id: "ok-row", factory: (require) => '
      + '{ const module = { exports: {} }; module.exports = { default: { name: "ok-row", apply() {} } }; '
      + 'return module.exports; } });';
    const { ctx, channel } = await bootUiClientV3({
      fetchWire: async () => wireOf([
        row('ok-row'),
        row('boom-row'),
        row('iso-row', { isolated: true }),
        row('style-row', { entry: undefined, styles: ['style.css'] }),
      ]),
      loadScript: async (url) => {
        if (url.includes('boom-row')) throw new Error('network down');
        (0, eval)(okBundle);
      },
    });
    expect(channel.get('ok-row')).toBe('ok');
    expect(channel.get('boom-row')).toBe('err');
    expect(channel.has('iso-row')).toBe(false); // isolated 档延后（无消费行）
    expect(channel.has('style-row')).toBe(false); // 纯样式行不走物化
    expect(ctx.slots.declOf('main')).toBeDefined(); // 表面存活（骨架未受坏行影响）
  });

  it('reload：wire/graph 差分行重物化（新行装载、未变行零动作）', async () => {
    setActivePinia(createPinia());
    let bundleV2 = false;
    const bundle = (name: string) => 'globalThis.__ModuleLoader__.load({ id: ' + JSON.stringify(name)
      + ', factory: () => ({ default: { name: ' + JSON.stringify(name + (bundleV2 ? ':v2' : '')) + ', apply() {} } }) });';
    let current = wireOf([row('dyn-row')]);
    const { channel, reload, modules } = await bootUiClientV3({
      fetchWire: async () => current,
      loadScript: async (url) => { (0, eval)(bundle(url.split('/')[2]!)); },
    });
    expect(channel.get('dyn-row')).toBe('ok');
    const first = await modules.import('dyn-row') as { default?: { name?: string } };
    expect(first.default?.name).toBe('dyn-row');

    bundleV2 = true;
    current = wireOf([row('dyn-row', { entry: '/ui-asset/dyn-row/r2/index.js' }), row('extra-row')]);
    await reload();
    expect(channel.get('extra-row')).toBe('ok');
    const second = await modules.import('dyn-row') as { default?: { name?: string } };
    expect(second.default?.name).toBe('dyn-row:v2'); // rev 变化行失效重物化
  });
});
