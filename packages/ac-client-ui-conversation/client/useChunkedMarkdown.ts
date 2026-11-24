// ============================================================
// client/useChunkedMarkdown.ts —— 流式 markdown 分块渲染（M27.2-2 视图半边自 webui composables/ 迁入）
//
// 解决"流式输出每帧全量重渲染全部内容"的 O(n²) 卡顿：
//   - 已提交前缀：仅当其跨越安全边界增长时重渲染（HTML 缓存复用）；
//   - 待提交尾部：HTML 转义后以纯文本显示（几乎零成本）；
//   - 同一帧内多次 update 只渲染一次（rAF 合并）。
// 流式结束时调用 flush() 全量渲染一次，保证最终输出正确。
//
// idle-commit（2026-09-13 反馈修正）：流式态下 delta 断流 ≥ IDLE_COMMIT_MS
// 且存在待提交尾部时，把全部内容整体提交渲染——ask_questions 等工具
// 挂起窗口 d.streaming 恒真（run 级信号覆盖工具执行期），末段文本会
// 一直停在转义纯文本态直到 run 收束，等待时长 = 用户阅读作答时长；
// 静止即提交让挂起期间也有完整 markdown 观感。守卫：committed 前缀与
// 全量内容一致（无增量）时不触发，避免静止期反复全量渲染。
// ============================================================

import { ref, watch, onBeforeUnmount } from 'vue';
import { splitStreamingContent } from './streamingMarkdown.ts';
import { markActivity, noteCommit, scheduleFrame, whenIdle } from './frameScheduler.ts';

import { hljsLanguageVersion, hljsLastRegistered } from 'ac-client-ui-renderer/client/hljs-languages.ts';
import { katexVersion } from 'ac-client-ui-renderer/client/markdownMath.ts';

/** 流式 delta 静止多久后把待提交尾部并入渲染（ms） */
const IDLE_COMMIT_MS = 600;

export function useChunkedMarkdown(renderFn: (content: string) => string) {
  /** 已提交前缀渲染后的 HTML */
  const html = ref('');
  /** 待提交尾部（原始文本，模板中直接插值，Vue 自动转义） */
  const pendingText = ref('');
  let committed = '';
  /** 本 hook 在调度器 commit 阶段是否已有登记任务（同帧多次 update 合并） */
  let scheduled = false;
  /** 静默提交订阅取消函数（P4-2：判据升调度器级——不再自持 setTimeout） */
  let idleCancel: (() => void) | null = null;
  let latestContent = '';
  let latestStreaming = false;

  function clearIdleTimer() {
    if (idleCancel) {
      idleCancel();
      idleCancel = null;
    }
  }

  function renderNow(content: string, streaming: boolean) {
    if (!streaming) {
      // 流式结束 / 历史消息：一次性全量渲染，保证最终正确
      clearIdleTimer();
      if (committed !== content) {
        committed = content;
        html.value = renderFn(content);
        noteCommit();
      }
      pendingText.value = '';
      return;
    }
    const { committed: c, pending } = splitStreamingContent(content);
    if (c !== committed) {
      committed = c;
      html.value = renderFn(c);
      noteCommit();
    }
    pendingText.value = pending;
    // 静止提交（P4-2 cr-1287）：有未并入的尾部 → 向调度器订阅静默判据
    //（活动时钟由 markActivity 单点维护——与 feed ingest / 滚动共享
    // 「本帧是否还在流」的判定，不再各自 setTimeout 各算各的静止）。
    // 无增量（committed === latestContent）时不订阅，避免静止期空转渲染。
    clearIdleTimer();
    if (pending) {
      idleCancel = whenIdle(IDLE_COMMIT_MS, () => {
        idleCancel = null;
        if (latestStreaming && latestContent && latestContent !== committed) {
          committed = latestContent;
          html.value = renderFn(latestContent);
          pendingText.value = '';
          noteCommit(true);
        }
      });
    }
  }

  /** 内容变化时调用（登记到调度器 commit 阶段：同帧多次 update 合并一次
   *  渲染，且总是使用最新内容；P4-2 cr-1287 起与 ingest/scroll 同帧有序） */
  function update(content: string, streaming: boolean) {
    latestContent = content;
    latestStreaming = streaming;
    markActivity();
    if (scheduled) return;
    scheduled = true;
    scheduleFrame('commit', () => {
      scheduled = false;
      renderNow(latestContent, latestStreaming);
    });
  }

  /** 立即强制渲染（流式结束时保证最终态正确） */
  function flush(content: string) {
    scheduled = false; // 未执行的 commit 登记失效（本轮内容已由下方全量渲染覆盖）
    clearIdleTimer();
    renderNow(content, false);
  }

  // 冷门语言异步注册完成 → 已提交 HTML 里的代码块需重新高亮（补齐）。
  // 相关性闸：仅当本内容可能含该语言时才重渲染——一次注册不得触发
  // 页内全部消息的全量 markdown 重跑（历史页动辄数十条）。
  watch(hljsLanguageVersion, () => {
    if (!latestContent) return;
    const names = hljsLastRegistered.value;
    const relevant = names.length === 0
      || names.some((n) => latestContent.includes('```' + n) || latestContent.includes('language-' + n));
    if (!relevant) return;
    committed = ''; // 清缓存：强制走重渲染路径（内容未变也要重跑）
    renderNow(latestContent, latestStreaming);
  });

  // 数学引擎懒装配完成 → 已提交 HTML 里的公式需重新渲染（仅含 $ 的内容
  // 重跑；无公式消息零成本）。
  watch(katexVersion, () => {
    if (!latestContent || !latestContent.includes('$')) return;
    committed = '';
    renderNow(latestContent, latestStreaming);
  });

  onBeforeUnmount(() => {
    clearIdleTimer();
  });

  return { html, pendingText, update, flush };
}
