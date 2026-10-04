// @vitest-environment jsdom
// ============================================================
// webui/tests/kit-tooltip.test.ts —— kit Tooltip 形态回归（cr-210）
// 迁移背景：全前端按钮类原生 title 批量迁 kit Tooltip（截断/信息提示类保留
// 原生 title）。本测试锁组件的三种几何形态与可达性契约（内嵌控件不设 title）。
// ============================================================
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { Tooltip, IconAction } from '@agentchat/webui-kit';

async function mountTip(props: Record<string, unknown>, childLabel = '测试动作') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({
    render: () => h(Tooltip, props, () => h(IconAction, { icon: 'copy', label: childLabel })),
  });
  app.mount(host);
  await nextTick();
  return { host, tip: () => host.querySelector('.ui-tip') as HTMLElement, button: () => host.querySelector('button') as HTMLButtonElement };
}

describe('kit Tooltip 形态（cr-210）', () => {
  it('缺省 = top + 居中；内嵌 IconAction 经 suppressTitle 兜底不双显（title 属性归组件方裁决）', async () => {
    const { tip, button } = await mountTip({ text: '提示文案' });
    expect(tip().className).toContain('ui-tip--top');
    expect(tip().className).not.toContain('ui-tip--start');
    expect(tip().getAttribute('data-tip')).toBe('提示文案');
    expect(button().getAttribute('aria-label')).toBe('测试动作');
  });

  it('placement=bottom → 朝下类（top/bottom 两形态——侧向形态经 cr-211 回退：CSS 气泡困在祖先 stacking context，边缘场景被遮挡）', async () => {
    const { tip } = await mountTip({ text: '朝下', placement: 'bottom' });
    expect(tip().className).toContain('ui-tip--bottom');
    expect(tip().className).not.toContain('ui-tip--start');
  });

  it('text 缺省 = data-tip 缺席（::after content 空，不显形）', async () => {
    const { tip } = await mountTip({});
    expect(tip().getAttribute('data-tip')).toBeNull();
  });

  it('键盘可达走 :has(:focus-visible)，鼠标点击聚焦不常显（cr-221 驻留根修）', async () => {
    // jsdom 不注入 SFC 样式也不实现 :focus-visible 匹配——锁源文件样式行防退化
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../webui-kit/src/base/Tooltip.vue'), 'utf8');
    const css = src.slice(src.indexOf('<style'), src.indexOf('</style>'));
    expect(css).toContain('.ui-tip:has(:focus-visible)::after');
    expect(css).not.toContain(':focus-within');
  });
});
