// @vitest-environment jsdom
// ============================================================
// webui/tests/kit-select-z.test.ts —— kit Select 弹层 z 序（cr-184 回归）
//
// 根因复盘：Select 弹层 Teleport 到 body 后 z-index 写死 1100，被
// z≥1200 的 Modal（PoolManager 编辑弹窗等）整层压住——弹窗内下拉
// 「点击无弹层」。修复 = 打开时扫触发器祖先链取最大 z-index（内联
// 与 CSS 类均覆盖，getComputedStyle），弹层盖过宿主所在层。
//
// 覆盖：
//   · 弹窗内（祖先 z 1200）打开 → 弹层 z > 1200（盖过弹窗）
//   · 平层页面（无定位祖先）→ 维持缺省 1100（高于面板 overlay 1000）
//   · 多层嵌套取最大（1200 容器内的 1300 子容器 → 1300+）
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { Select } from '@agentchat/webui-kit';

const OPTS = [
  { value: '', label: '选择提供方…', disabled: true },
  { value: 'deepseek', label: 'DeepSeek 官方' },
  { value: 'zai', label: '智谱 GLM 开放平台' },
];

async function mountSelectIn(host: HTMLElement, zIndex?: number) {
  if (zIndex !== undefined) host.style.zIndex = String(zIndex);
  host.innerHTML = '<div class="mount-point"></div>';
  const app = createApp({
    render: () => h(Select, { options: OPTS, modelValue: 'zai', 'onUpdate:modelValue': () => {} }),
  });
  const el = host.querySelector('.mount-point')!;
  app.mount(el);
  await nextTick();
  return { app, trigger: () => host.querySelector('.ui-sel-trigger') as HTMLButtonElement };
}

describe('kit Select 弹层 z 序随宿主层自适应（cr-184）', () => {
  it('弹窗内打开 → 弹层 z 高于宿主 Modal 层', async () => {
    const modal = document.createElement('div');
    modal.style.position = 'fixed';
    modal.style.zIndex = '1200';
    document.body.appendChild(modal);
    const { trigger } = await mountSelectIn(modal);
    trigger().click();
    await nextTick();
    await nextTick();
    const menu = document.querySelector('.ui-dd-menu') as HTMLElement | null;
    expect(menu).toBeTruthy();
    expect(Number(menu!.style.zIndex)).toBeGreaterThan(1200);
    document.body.removeChild(modal);
  });

  it('平层页面 → 缺省 1100（高于面板 overlay 1000）', async () => {
    const { trigger } = await mountSelectIn(document.body);
    trigger().click();
    await nextTick();
    await nextTick();
    const menu = document.querySelector('.ui-dd-menu') as HTMLElement | null;
    expect(menu).toBeTruthy();
    expect(menu!.style.zIndex).toBe('1100');
    // 清场：卸载并移除弹层 DOM（Teleport 目标残留会跨用例污染）
    document.querySelectorAll('.ui-dd-menu').forEach((m) => m.remove());
  });

  it('多层嵌套取最大（1200 内的 1300 子容器 → 1300）', async () => {
    const outer = document.createElement('div');
    outer.style.position = 'fixed';
    outer.style.zIndex = '1200';
    const inner = document.createElement('div');
    inner.style.position = 'fixed';
    inner.style.zIndex = '1300';
    outer.appendChild(inner);
    document.body.appendChild(outer);
    const { trigger } = await mountSelectIn(inner);
    trigger().click();
    await nextTick();
    await nextTick();
    const menu = document.querySelector('.ui-dd-menu') as HTMLElement | null;
    expect(menu).toBeTruthy();
    expect(Number(menu!.style.zIndex)).toBeGreaterThan(1300);
    document.body.removeChild(outer);
  });
});
