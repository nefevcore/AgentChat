// ============================================================
// composables/useChatShell.ts —— 会话视图外壳（滚动/自动跟随/回到底部）
//
// 统一 ChatView(direct) 与 GroupChat(group) 的滚动行为：
//   · 方向检测暂停自动跟随（一次上滚即可脱离，无需滚多次）
//   · 双 rAF 滚底 + 按帧合并（流式多 token 只触发一次）
//   · 顶部阈值回调（触发历史加载由调用方按模式实现）
// ============================================================

import { ref, watch, type Ref } from 'vue';

export interface ChatShellOptions {
  /** 消息滚动容器 ref */
  container: Ref<HTMLElement | undefined>;
  /** 滚动到顶部阈值时回调（调用方按 direct/group 触发历史加载） */
  onTopThreshold: () => void;
  /** 数据变化信号：[消息总数, 流式尾部长度]，变化时若非用户上翻则自动滚底 */
  signal: () => readonly [number, number];
}

export function useChatShell(opts: ChatShellOptions) {
  const isUserScrolledUp = ref(false);
  let lastScrollTop = 0;
  let scrollScheduled = false;

  /** 判断滚动条是否接近底部（阈值 80px，容纳流式输出时的高度跳动） */
  function isNearBottom(): boolean {
    const el = opts.container.value;
    if (!el) return true;
    const { scrollTop, scrollHeight, clientHeight } = el;
    return scrollHeight - scrollTop - clientHeight < 80;
  }

  /** 滚动到底部（双重 rAF 确保浏览器完成布局） */
  function scrollToBottom() {
    const el = opts.container.value;
    if (!el) return;
    requestAnimationFrame(() => {
      const c = opts.container.value;
      if (!c) return;
      c.scrollTop = c.scrollHeight;
      lastScrollTop = c.scrollTop;
      requestAnimationFrame(() => {
        const c2 = opts.container.value;
        if (!c2) return;
        c2.scrollTop = c2.scrollHeight;
        lastScrollTop = c2.scrollTop;
      });
    });
  }

  /** 回到底部按钮：滚动并恢复自动跟随 */
  function scrollToBottomAndReset() {
    scrollToBottom();
    isUserScrolledUp.value = false;
  }

  /** 会话切换时重置闭包状态。
   *  isUserScrolledUp / lastScrollTop 跨会话残留的坑：新会话内容不足一屏时
   *  scrollTop 赋值无变化 → 浏览器不派发 scroll 事件 → atBottom 恢复逻辑
   *  永远执行不到 → 流式消息不自动滚底 + 悬浮"回到底部"按钮 + 首次滚动
   *  方向误判（旧实现 ChatView 切换时显式重置，迁移到 DialogView 时丢失）。 */
  function reset() {
    isUserScrolledUp.value = false;
    lastScrollTop = 0;
  }

  /** 用户滚动：方向检测暂停自动跟随；回到底部恢复；顶部触发历史加载 */
  function onScroll() {
    const el = opts.container.value;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const atBottom = scrollHeight - scrollTop - clientHeight < 80;

    // 向上滚动（scrollTop 减小）→ 立即暂停自动跟随；回到底部 → 恢复
    if (scrollTop < lastScrollTop - 1) {
      isUserScrolledUp.value = true;
    } else if (atBottom) {
      isUserScrolledUp.value = false;
    }
    lastScrollTop = scrollTop;

    if (scrollTop <= 50) {
      opts.onTopThreshold();
    }
  }

  /** 自动滚底：按帧合并（同一帧多次流式更新只触发一次滚动） */
  function scheduleAutoScroll() {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      if (!isUserScrolledUp.value) {
        scrollToBottom();
      }
    });
  }

  watch(() => opts.signal(), () => scheduleAutoScroll());

  return {
    isUserScrolledUp,
    isNearBottom,
    scrollToBottom,
    scrollToBottomAndReset,
    reset,
    onScroll,
  };
}
