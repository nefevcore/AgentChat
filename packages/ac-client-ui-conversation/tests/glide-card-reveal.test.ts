// ============================================================
// glide-card-reveal.test.ts —— 贴底跟随的增量分流（整卡上屏缓动揭示）
// 复现：贴底驻留时新增整张消息卡片（增量远超流式单帧像素）——修复前贴底段
// 一律 writeScrollTop(target) 瞬跳整卡高度；修复后超 SNAP_ABSORB_MAX 的增量
// 切入缓动段平滑滑下，流式小增量仍直接吸收（视口静止语义不变）。
// ============================================================
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createApp, h, ref, defineComponent, onMounted } from 'vue';
import { useChatShell } from '../client/useChatShell.ts';

function mountShell() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const tail = ref(0);
  let shell!: ReturnType<typeof useChatShell>;
  let box!: HTMLElement;
  const Host = defineComponent({
    setup() {
      const container = ref<HTMLElement>();
      shell = useChatShell({
        container,
        onTopThreshold: () => {},
        signal: () => [1, tail.value] as const,
      });
      onMounted(() => { box = container.value!; });
      return () => h('div', { ref: container, style: 'height:500px;overflow:auto' });
    },
  });
  const app = createApp(Host);
  app.mount(root);
  // jsdom 无布局：scrollHeight/clientHeight 只读 getter——覆写模拟（scroll-clamp 同手法）
  const setHeight = (v: number) => Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => v });
  const setViewport = (v: number) => Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => v });
  return { root, app, box, tail, shell, setHeight, setViewport };
}

// rAF 帧等待：scheduleAutoScroll 一帧 + followTick 至少一帧（jsdom rAF ~16ms/帧）
const frames = (n: number) => new Promise((r) => setTimeout(r, n * 20));

describe('useChatShell 贴底增量分流', () => {
  it('整卡增量（600px）→ 缓动揭示：数百 ms 内未瞬跳到 target', async () => {
    const t = mountShell();
    t.setViewport(500);
    t.setHeight(2000);
    t.box.scrollTop = 1500; // 贴底
    t.shell.onScroll();
    expect(t.shell.isUserScrolledUp.value).toBe(false);
    // 新卡片整块上屏：内容增长 600px
    t.setHeight(2600);
    t.tail.value = 1; // signal 变化 → 自动跟随拉起
    await frames(5); // ~100ms：缓动进行中（GLIDE_TIMEOUT=800 远未到）
    const target = 2600 - 500;
    expect(t.box.scrollTop).toBeGreaterThan(1500); // 已在滑动
    expect(t.box.scrollTop).toBeLessThan(target - 50); // 但未瞬跳贴底（修复前首帧即 = target）
    t.app.unmount(); t.root.remove();
  });

  it('流式小增量（20px）→ 直接吸收：一帧内贴底（视口静止语义不变）', async () => {
    const t = mountShell();
    t.setViewport(500);
    t.setHeight(2000);
    t.box.scrollTop = 1500;
    t.shell.onScroll();
    t.setHeight(2020);
    t.tail.value = 1;
    await frames(3);
    expect(t.box.scrollTop).toBe(1520); // 直接同步（修复前后一致）
    t.app.unmount(); t.root.remove();
  });
});