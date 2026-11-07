// ============================================================
// module-system.test.ts —— ClientModuleSystem 四支解析序（cr-929 切片①）
//
// ①种子词→壳活实例（单例恒等）②memo（物化一次，副作用仅一次）
// ③wire 行→bundle 到达→注册 ④factory 物化；其余 throw loud。
// bundle 到达注入点 = eval 模拟（factory 注册 bundle 形——与构建器产物同形）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createClientModuleSystem } from '../client/module-system.ts';
import type { WireRow } from 'ac-webui-core';

/** 仿真 bundle 源（与 build-channel v3 产物同形） */
function bundleOf(id: string, body: string): string {
  return 'globalThis.__ModuleLoader__.load({ id: ' + JSON.stringify(id)
    + ', factory: (require) => { const module = { exports: {} };'
    + ' (function (module, exports, require) { ' + body
    + ' })(module, module.exports, require);'
    + ' return \'default\' in module.exports ? module.exports : { default: module.exports }; } });';
}

function makeSystem(rows: Record<string, string>, seeds: Record<string, unknown> = {}) {
  const loadedUrls: string[] = [];
  const rowOf = (id: string): WireRow | undefined =>
    id in rows ? { id, version: '1.0.0', entry: '/ui-asset/' + id + '/r1/index.js', seats: [], isolated: false } : undefined;
  const msys = createClientModuleSystem({
    seeds,
    rowOf,
    loadScript: async (url) => {
      loadedUrls.push(url);
      const id = url.split('/')[2]!;
      (0, eval)(bundleOf(id, rows[id]!));
    },
  });
  return { msys, loadedUrls };
}

describe('ClientModuleSystem 解析序', () => {
  it('① 种子词 → 壳活实例（恒等、不物化、bundle 不拉取）', async () => {
    const seedInstance = { marker: 'vue-live' };
    const { msys, loadedUrls } = makeSystem({ 'ac-client-ui-todo': 'exports.default = { plug: true };' }, { vue: seedInstance });
    await expect(msys.import('vue')).resolves.toBe(seedInstance);
    expect(msys.require('vue')).toBe(seedInstance);
    expect(loadedUrls).toEqual([]);
  });

  it('③→④ wire 行 → bundle 到达 → 注册 → 物化；② memo 恒等 + 副作用仅一次', async () => {
    const g = globalThis as Record<string, unknown>;
    delete g.__se_count__;
    const { msys, loadedUrls } = makeSystem({
      'ac-client-ui-todo': 'globalThis.__se_count__ = (globalThis.__se_count__ ?? 0) + 1; exports.default = { plug: true };',
    });
    const mod1 = await msys.import('ac-client-ui-todo') as { default?: unknown };
    const mod2 = await msys.import('ac-client-ui-todo');
    expect(mod1).toBe(mod2); // memo 恒等
    expect(loadedUrls).toEqual(['/ui-asset/ac-client-ui-todo/r1/index.js']); // 到达仅一次
    expect(g.__se_count__).toBe(1); // 物化一次——模块体副作用仅一次（lazy 契约）
  });

  it('依赖链：消费行 require 依赖行（拓扑序装载后 memo 命中）', async () => {
    const { msys } = makeSystem({
      'dep-row': 'exports.default = { name: "dep" }; exports.hello = 1;',
      'consumer-row': 'const dep = require("dep-row"); exports.default = { got: dep.default.name, via: dep.hello };',
    });
    // 先装载依赖行（拓扑序由壳 boot 承担——本测手工复刻）
    await msys.import('dep-row');
    const mod = await msys.import('consumer-row') as { default: { got: string; via: number } };
    expect(mod.default).toEqual({ got: 'dep', via: 1 });
  });

  it('其余 → throw loud（种子/factory 双缺席——纯度门运行时镜像）', async () => {
    const { msys } = makeSystem({});
    expect(() => msys.require('nowhere')).toThrow(/不可解析/);
    await expect(msys.import('nowhere')).rejects.toThrow(/不可解析/);
  });

  it('同步 require 未装载 wire 行 = throw（防绕过装载支）', async () => {
    const { msys } = makeSystem({ 'late-row': 'exports.default = {};' });
    expect(() => msys.require('late-row')).toThrow(/不可解析/);
  });

  it('invalidate → memo 失效 → 重物化（wire/rebuilt 帧语义）', async () => {
    const { msys } = makeSystem({ 're-row': 'exports.default = { n: (globalThis.__re_n__ = (globalThis.__re_n__ ?? 0) + 1) };' });
    const a = await msys.import('re-row');
    expect((a as { default: { n: number } }).default.n).toBe(1);
    msys.invalidate('re-row');
    const b = await msys.import('re-row');
    expect((b as { default: { n: number } }).default.n).toBe(2);
  });
});
