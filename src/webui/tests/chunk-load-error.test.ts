// @vitest-environment jsdom
// ============================================================
// webui/tests/chunk-load-error.test.ts —— 动态 chunk 加载失败
// 不触发 entry 退位（stale bundle 事故回归锚）
//
// 事故链：webui:build 重建 → 旧页面 async loader 404 →
// EntryErrorBoundary → reportEntryError → abdicate 退位 →
// 出厂条目永不重注册 → 主栏永久空白。
// 修复：reportEntryError 识别资源性 import 失败 → 不退位（warn 放行）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { bootWebuiRuntime } from './lib/webuiBoot';

describe('entry 崩溃监督 · 动态 chunk 加载失败不退位', () => {
  it('chunk 404 错误（Failed to fetch dynamically imported module）→ 条目仍在席位', async () => {
    const { ctx } = await bootWebuiRuntime();
    const before = ctx.slots.entries('primary-sidebar').map((e) => e.id);
    expect(before).toContain('webui-base-layout.primary-sidebar');

    // 模拟边界上报：资源性加载失败（浏览器标准措辞）
    const err = new TypeError('Failed to fetch dynamically imported module: "http://127.0.0.1:3830/assets/AgentListHost-CLQcLU7N.js"');
    ctx.slots.reportEntryError('primary-sidebar', ctx.slots.entries('primary-sidebar')[0]!, err);

    // 不退位：条目仍在（刷新后正常加载）
    expect(ctx.slots.entries('primary-sidebar').map((e) => e.id)).toContain('webui-base-layout.primary-sidebar');
  });

  it('Firefox 措辞（Importing a module script failed）同样豁免', async () => {
    const { ctx } = await bootWebuiRuntime();
    const entry = ctx.slots.entries('primary-sidebar')[0]!;
    ctx.slots.reportEntryError('primary-sidebar', entry, new Error('Importing a module script failed.'));
    expect(ctx.slots.entries('primary-sidebar').map((e) => e.id)).toContain('webui-base-layout.primary-sidebar');
  });

  it('真实代码崩溃（非资源性错误）仍退位（原语义保持）', async () => {
    const { ctx } = await bootWebuiRuntime();
    const entry = ctx.slots.entries('primary-sidebar')[0]!;
    ctx.slots.reportEntryError('primary-sidebar', entry, new TypeError('Cannot read properties of undefined'));
    expect(ctx.slots.entries('primary-sidebar').map((e) => e.id)).not.toContain('webui-base-layout.primary-sidebar');
  });
});
