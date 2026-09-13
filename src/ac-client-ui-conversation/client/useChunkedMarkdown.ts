// ============================================================
// client/useChunkedMarkdown.ts —— 流式 markdown 分块渲染（M27.2-2 视图半边自 webui composables/ 迁入）
//
// 解决"流式输出每帧全量重渲染全部内容"的 O(n²) 卡顿：
//   - 已提交前缀：仅当其跨越安全边界增长时重渲染（HTML 缓存复用）；
//   - 待提交尾部：HTML 转义后以纯文本显示（几乎零成本）；
//   - 同一帧内多次 update 只渲染一次（rAF 合并）。
// 流式结束时调用 flush() 全量渲染一次，保证最终输出正确。
//
// idle-commit（2026-12 反馈修正）：流式态下 delta 断流 ≥ IDLE_COMMIT_MS
// 且存在待提交尾部时，把全部内容整体提交渲染——ask_questions 等工具
// 挂起窗口 d.streaming 恒真（run 级信号覆盖工具执行期），末段文本会
// 一直停在转义纯文本态直到 run 收束，等待时长 = 用户阅读作答时长；
// 静止即提交让挂起期间也有完整 markdown 观感。守卫：committed 前缀与
// 全量内容一致（无增量）时不触发，避免静止期反复全量渲染。
// ============================================================

import { ref, onBeforeUnmount } from 'vue';
import { splitStreamingContent } from './streamingMarkdown.ts';

/** 流式 delta 静止多久后把待提交尾部并入渲染（ms） */
const IDLE_COMMIT_MS = 600;

export function useChunkedMarkdown(renderFn: (content: string) => string) {
  /** 已提交前缀渲染后的 HTML */
  const html = ref('');
  /** 待提交尾部（原始文本，模板中直接插值，Vue 自动转义） */
  const pendingText = ref('');
  let committed = '';
  let frame = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let latestContent = '';
  let latestStreaming = false;

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function renderNow(content: string, streaming: boolean) {
    if (!streaming) {
      // 流式结束 / 历史消息：一次性全量渲染，保证最终正确
      clearIdleTimer();
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
    // 静止提交：有未并入的尾部且内容已停止增长 → 全量渲染，消除
    // 工具挂起窗口的原始 markdown 纯文本残留（无增量 = 前缀已含全部
    // 内容 → 定时器空转重设，不产生渲染）
    clearIdleTimer();
    if (pending) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (latestStreaming && latestContent && latestContent !== committed) {
          committed = latestContent;
          html.value = renderFn(latestContent);
          pendingText.value = '';
        }
      }, IDLE_COMMIT_MS);
    }
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
    clearIdleTimer();
    renderNow(content, false);
  }

  onBeforeUnmount(() => {
    if (frame) cancelAnimationFrame(frame);
    clearIdleTimer();
  });

  return { html, pendingText, update, flush };
}
