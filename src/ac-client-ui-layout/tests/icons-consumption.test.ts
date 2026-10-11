// ============================================================
// ac-client-ui-layout/tests/icons-consumption.test.ts —— 图标
// 消费面源码锁（cr-332 归一的防再漂移）。
//
// ActivityBar/MobileMoreSheet 的图标此前是 5 处内联 SVG（「检查更新」
// 两处口径已走散：info 圆 i 形 vs refresh-cw）——归一到 kit Icon 后，
// 本文件锁源码面不再回退内联。图标名的解析有效性由 webui 既有测试
// 天然守卫（挂载 ActivityBar 即解析 ~icons 虚拟模块，未注册名当场炸
// ——kit icons.ts 不进包入口，深路径 import 违 R3/M29 P0-2 裁决）。
// node 环境（fs 直读，零组件渲染）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('图标消费 · 源码面锁', () => {
  it('ActivityBar/MobileMoreSheet 不再残留内联 <svg（kit Icon 归一不回退）', () => {
    for (const f of ['ActivityBar.vue', 'MobileMoreSheet.vue'] as const) {
      const p = fileURLToPath(new URL(`../client/${f}`, import.meta.url));
      const src = readFileSync(p, 'utf8');
      expect(src.includes('<svg'), f).toBe(false);
    }
  });

  it('「检查更新」图标名单源 badge-check（两组件一致，防再走散）', () => {
    const bar = readFileSync(fileURLToPath(new URL('../client/ActivityBar.vue', import.meta.url)), 'utf8');
    const sheet = readFileSync(fileURLToPath(new URL('../client/MobileMoreSheet.vue', import.meta.url)), 'utf8');
    expect(bar).toContain('badge-check');
    expect(sheet).toContain('badge-check');
    expect(bar).not.toContain('refresh-cw');
    expect(sheet).not.toContain("name=\"info\"");
  });
});
