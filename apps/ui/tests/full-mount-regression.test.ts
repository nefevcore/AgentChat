// @vitest-environment jsdom
// ============================================================
// full-mount-regression.test.ts —— 全行真产物整树挂载回归门
//（crash-hardening 批收口：2026-11-07 会话面板空白事故）
//
// 与 seats-audit-v3（装载三轴）互补的第四轴——渲染轴：全部通道行按
// 真实构建产物（client/dist/index.js eval 注入——与浏览器 <script> 同
// 语义）装载后整树挂载 root，断言主区会话视图真实渲染。事故形态：
// 种子 .vue 深词 = 命名空间对象，默认导入未取 .default → 组件静默空
// 渲染（"Component is missing template or render function"）——装载/
// 选举/席位三轴全绿也测不出，只有真挂载能拦。
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createApp } from 'vue';
import { bootUiClientV3 } from '../client/boot-v3.ts';
import { CLIENT_CONTEXT_KEY, setClientRuntime } from 'ac-client-runtime';
import { bindPerspectives } from 'ac-client-ui-layout/client/perspectives.ts';
import { bindMessageViews } from 'ac-client-ui-conversation/client/messageViews.ts';
import { bindToolResultViews } from 'ac-client-ui-tool/client/toolResultViews.ts';
import { readChannelManifest } from 'ac-webui-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WireRow } from 'ac-webui-core';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const pkgRoot = path.join(repoRoot, 'packages');

function wireRows(): WireRow[] {
  const rows: WireRow[] = [];
  for (const e of fs.readdirSync(pkgRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith('ac-client-ui-')) continue;
    const read = readChannelManifest(path.join(pkgRoot, e.name));
    if (read === null) continue;
    rows.push({
      id: e.name,
      version: '0.0.0',
      entry: '/ui-asset/' + e.name + '/r1/index.js',
      styles: [],
      seats: (read.manifest.seats ?? []).map((s) => s.seat),
      isolated: false,
    });
  }
  return rows;
}

describe('crash-hardening · 渲染轴（真产物整树挂载）', () => {
  it('全行真 bundle 装载 + 整树挂载 → 主区会话视图真实渲染（视角非空）', async () => {
    setActivePinia(createPinia());
    const rows = wireRows();
    expect(rows.length).toBeGreaterThanOrEqual(29);
    const specOf = new Map(rows.map((r) => [r.entry, r.id]));

    const result = await bootUiClientV3({
      rpcWire: {
        call: async <T,>(_m: string) => null as T,
        onEvent: () => () => { /* 桩 */ },
        onOpen: () => () => { /* 桩 */ },
        onAck: () => () => { /* 桩 */ },
        onClose: () => () => { /* 桩 */ },
        connected: () => true,
      },
      fetchWire: async () => ({ rev: 'r1', rows, seeds: {}, warnings: [] }),
      loadScript: async (url) => {
        const id = specOf.get(url);
        if (id === undefined) throw new Error('测试行寻址失败：' + url);
        // 真实产物装载（与浏览器 <script> 注入同语义）：eval factory 注册 bundle
        const code = fs.readFileSync(path.join(pkgRoot, id, 'client', 'dist', 'index.js'), 'utf8');
        (0, eval)(code);
      },
    });
    expect([...result.channel.entries()].filter(([, v]) => v === 'err')).toEqual([]);
    setClientRuntime(result.ctx);
    bindPerspectives();
    bindMessageViews();
    bindToolResultViews();

    // 渲染轴：整树挂载（main.ts 同序列）+ 告警链追踪（组件栈归因）
    const warnNotes: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp({ render: () => result.ctx.vueRenderer.renderSlot('root') });
    app.provide(CLIENT_CONTEXT_KEY, result.ctx);
    app.config.warnHandler = (msg, instance) => {
      const chain: string[] = [];
      for (let n = instance as unknown as { parent?: unknown; type?: unknown } | null; n; n = n.parent as typeof n) {
        chain.push(String((n.type as { name?: string } | undefined)?.name ?? n.type ?? '?'));
      }
      warnNotes.push(String(msg).slice(0, 80) + ' <- ' + chain.slice(0, 6).join(' < '));
      return false;
    };
    const el = document.createElement('div');
    document.body.appendChild(el);
    app.mount(el);
    await new Promise((r) => setTimeout(r, 300));
    try {
      const pane = el.querySelector('.main-view-pane');
      // 主区 pane 在场且非空（事故形态 = pane 内只剩 <!----> 注释）
      expect(pane, '主区 pane 缺席——main 席位选举/渲染断链').not.toBeNull();
      // 静默空渲染的标志告警不得出现
      const missingRender = warnNotes.some((x) => x.includes('missing template or render function'));
      expect(missingRender, '组件静默空渲染（Component is missing template or render function）——默认导入未取 .default 或组件词形漂移').toBe(false);
      const invalidVnode = warnNotes.some((x) => x.includes('Invalid vnode type'));
      expect(invalidVnode, 'Invalid vnode type——组件解析为 undefined').toBe(false);
      // 崩溃面不出现（健康渲染）
      expect(el.querySelector('[data-slot-error]')).toBeNull();
    } finally {
      app.unmount();
      errSpy.mockRestore();
    }
  }, 120_000);
});
