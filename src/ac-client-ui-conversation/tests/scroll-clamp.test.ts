// ============================================================
// scroll-clamp.test.ts —— 内容高度变化帧的方向判定豁免（2026-12 切换停中修复）
// 序列复现：贴底 → 历史合并/组件重建（scrollHeight 塌缩，scrollTop 被钳制）
// → scroll 事件不得误判为用户上翻（否则自动跟随被杀 + 上翻分帧把视口钉在会话中部）。
// ============================================================
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createApp, h, ref, defineComponent, onMounted } from 'vue';
import { useChatShell } from '../client/useChatShell.ts';

describe('useChatShell 内容高度变化豁免', () => {
  it('scrollHeight 变化帧（DOM 重建钳制）→ 不置 isUserScrolledUp；同高上滚 → 正常置位', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let shell!: ReturnType<typeof useChatShell>;
    let box!: HTMLElement;
    const Host = defineComponent({
      setup() {
        const container = ref<HTMLElement>();
        shell = useChatShell({
          container,
          onTopThreshold: () => {},
          signal: () => [0, 0] as const,
        });
        onMounted(() => { box = container.value!; });
        return () => h('div', { ref: container, style: 'height:100px;overflow:auto' });
      },
    });
    const app = createApp(Host);
    app.mount(root);

    // jsdom 无布局：scrollHeight 是只读 getter——defineProperty 覆写模拟
    const setHeight = (v: number) => Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => v });
    // 帧1：用户滚到底（同高 2000）
    setHeight(2000);
    box.scrollTop = 1900;
    shell.onScroll();
    expect(shell.isUserScrolledUp.value).toBe(false);

    // 帧2：内容塌缩（历史重建）——scrollHeight 500，scrollTop 被钳到 400（max）
    setHeight(500);
    box.scrollTop = 400;
    shell.onScroll();
    // 豁免：高度变化帧不判方向 → 仍 false（修复前：400 < 1900-1 误判 true）
    expect(shell.isUserScrolledUp.value).toBe(false);

    // 帧3：同高（500）真用户上滚 400 → 100
    box.scrollTop = 100;
    shell.onScroll();
    expect(shell.isUserScrolledUp.value).toBe(true); // 真上翻仍正确识别

    app.unmount();
    root.remove();
  });
});