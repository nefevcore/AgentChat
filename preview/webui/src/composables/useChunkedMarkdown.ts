// ============================================================
// composables/useChunkedMarkdown.ts —— 流式 markdown 分块渲染
//
// 解决"流式输出每帧全量重渲染全部内容"的 O(n²) 卡顿：
//   - 已提交前缀：仅当其跨越安全边界增长时重渲染（HTML 缓存复用）；
//   - 待提交尾部：HTML 转义后以纯文本显示（几乎零成本）；
//   - 同一帧内多次 update 只渲染一次（rAF 合并）。
// 流式结束时调用 flush() 全量渲染一次，保证最终输出正确。
// ============================================================

import { ref, onBeforeUnmount } from 'vue';
import { splitStreamingContent } from '@/utils/streamingMarkdown';

export function useChunkedMarkdown(renderFn: (content: string) => string) {
  /** 已提交前缀渲染后的 HTML */
  const html = ref('');
  /** 待提交尾部（原始文本，模板中直接插值，Vue 自动转义） */
  const pendingText = ref('');
  let committed = '';
  let frame = 0;
  let latestContent = '';
  let latestStreaming = false;

  function renderNow(content: string, streaming: boolean) {
    if (!streaming) {
      // 流式结束 / 历史消息：一次性全量渲染，保证最终正确
      if (committed !== content) {
        committed = content;
        html.value = renderFn(content);
      }
      pendingText.value = '';
      return;
    }
    const { committed: c, pending } = splitStreamingContent(content);
    if (c !== committed) {
      committed = c;
      html.value = renderFn(c);
    }
    pendingText.value = pending;
  }

  /** 内容变化时调用（内部 rAF 合并到同一帧，且总是使用最新内容） */
  function update(content: string, streaming: boolean) {
    latestContent = content;
    latestStreaming = streaming;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderNow(latestContent, latestStreaming);
    });
  }

  /** 立即强制渲染（流式结束时保证最终态正确） */
  function flush(content: string) {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    renderNow(content, false);
  }

  onBeforeUnmount(() => {
    if (frame) cancelAnimationFrame(frame);
  });

  return { html, pendingText, update, flush };
}
