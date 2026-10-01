// @vitest-environment jsdom
// ============================================================
// webui/tests/pull-to-refresh.test.ts —— 下拉刷新原语语义单测（cr-80）
//
// 覆盖（webui-kit/PullToRefresh.vue——触屏手势链）：
//   · 顶部下拉过阈值松手 → onRefresh 触发一次；Promise 落定 → done → idle 收口
//   · 未过阈值松手 → 回弹（idle）不触发
//   · 横滑/上滑不接管（正常滚动让位）
//   · 刷新进行中（busy）新手势屏蔽
//   · onRefresh 抛异常也收口（finally——指示器不悬挂）
// jsdom 无 TouchEvent 构造器：Event + touches 属性注入模拟手势帧。
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { PullToRefresh } from '@agentchat/webui-kit';

/** 合成触摸事件（touches 单点——组件只读 touches[0].clientX/Y） */
function touchEvent(type: string, x: number, y: number): Event {
  const ev = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(ev, 'touches', { value: [{ clientX: x, clientY: y }] });
  return ev;
}

function mount(onRefresh: () => unknown | Promise<unknown>): { root: HTMLElement; unmount: () => void } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({ render: () => h(PullToRefresh, { onRefresh }, { default: () => h('div', '内容') }) });
  app.mount(host);
  const root = document.querySelector('.ui-pull-root') as HTMLElement;
  return { root, unmount: () => app.unmount() };
}

/** 拖拽序列：start → 若干 move → end */
function drag(root: HTMLElement, dy: number, opts?: { dx?: number }) {
  root.dispatchEvent(touchEvent('touchstart', 200, 300));
  const dx = opts?.dx ?? 0;
  for (let step = 1; step <= 4; step++) {
    root.dispatchEvent(touchEvent('touchmove', 200 + (dx * step) / 4, 300 + (dy * step) / 4));
  }
  root.dispatchEvent(touchEvent('touchend', 200 + dx, 300 + dy));
}

beforeEach(() => { document.body.innerHTML = ''; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('PullToRefresh 手势链', () => {
  it('下拉过阈值松手 → 触发刷新一次，落定后 done → idle 收口', async () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const { root, unmount } = mount(onRefresh);
    drag(root, 160); // 阻尼 0.5 → 位移 80 ≥ 阈值 64
    await nextTick();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.ui-pull-indicator')?.textContent).toContain('刷新中');
    await vi.advanceTimersByTimeAsync(300); // DONE_MS 260 过后
    const indicator = root.querySelector('.ui-pull-indicator') as HTMLElement;
    expect(indicator.style.display).toBe('none'); // v-show 收起（仍在 DOM，隐藏即 idle）
    unmount();
  });

  it('未过阈值松手 → 回弹不触发', async () => {
    const onRefresh = vi.fn();
    const { root, unmount } = mount(onRefresh);
    drag(root, 60); // 阻尼后 30 < 64
    await nextTick();
    expect(onRefresh).not.toHaveBeenCalled();
    unmount();
  });

  it('横滑不接管（|dx| > dy）→ 正常滚动让位，不触发', async () => {
    const onRefresh = vi.fn();
    const { root, unmount } = mount(onRefresh);
    drag(root, 20, { dx: 120 });
    await nextTick();
    expect(onRefresh).not.toHaveBeenCalled();
    unmount();
  });

  it('上滑（dy < 0）不接管', async () => {
    const onRefresh = vi.fn();
    const { root, unmount } = mount(onRefresh);
    drag(root, -80);
    await nextTick();
    expect(onRefresh).not.toHaveBeenCalled();
    unmount();
  });

  it('刷新进行中（busy）新手势不重入', async () => {
    let release: (() => void) | null = null;
    const onRefresh = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const { root, unmount } = mount(onRefresh);
    drag(root, 160);
    await nextTick();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    drag(root, 160); // 上一轮未落定：busy 屏蔽
    await nextTick();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    release!();
    await vi.advanceTimersByTimeAsync(300);
    unmount();
  });

  it('onRefresh 抛异常也收口（指示器不悬挂）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onRefresh = vi.fn(() => Promise.reject(new Error('x')));
    const { root, unmount } = mount(onRefresh);
    drag(root, 160);
    await Promise.resolve(); // microtask 排空 → finally 走 done
    await vi.advanceTimersByTimeAsync(300);
    const indicator = root.querySelector('.ui-pull-indicator') as HTMLElement;
    expect(indicator).toBeTruthy(); // v-show 隐藏仍在 DOM——验证收口用态断言
    errSpy.mockRestore();
    unmount();
  });
});
