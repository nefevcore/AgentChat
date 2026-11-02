<!-- ============================================================
  ac-client-ui-renderer/client/MarkdownCard.vue —— markdown 渲染卡
  （cr-765 批次A §1.3）
  思考正文 / 注入正文 / 助手正文的统一渲染体：useMarkdown 管线
  （AssistantMessage 思考卡同款）+ 小字号档（12px 正文 / 标题降档）。
  - rawToggle：卡头「原文」切换——注入体是给模型看的原文，评审与
    排障需要逐字节可复制的纯文本；默认渲染态（Q2 定案）。
  - streaming：流式/直播态——已提交前缀渲染 + 尾部纯文本追加
    （思考卡策略，未完成尾部不进 markdown 管线防闪烁）。
  markdown-body 样式由宿主 app 注入（AssistantMessage 同款约定）。
  ============================================================ -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMarkdown } from './useMarkdown.ts';
import ScrollableViewport from './ScrollableViewport.vue';

const props = withDefaults(defineProps<{
  /** markdown 原文 */
  text?: string;
  /** 流式态：按行解析稳定前缀 + 尾块纯文本直渲 */
  streaming?: boolean;
  /** 卡头「原文/渲染」切换钮（默认关——思考卡等无此诉求） */
  rawToggle?: boolean;
  /** 初始态（rawToggle 开时——消费方持久化的偏好；缺省渲染态） */
  initialRaw?: boolean;
  /** 小字号档（默认开：卡内正文 12px；气泡正文可关） */
  sm?: boolean;
}>(), { text: '', streaming: false, rawToggle: false, initialRaw: false, sm: true });

const emit = defineEmits<{ (e: 'toggle-raw', raw: boolean): void }>();

const { render } = useMarkdown();
/** 原文态（默认渲染；rawToggle 开时可用）——由消费方经 toggle-raw 持久化 */
const showRaw = ref(props.initialRaw);

/** 流式切分：稳定前缀进 markdown 管线，尾部（最后一个闭合 fence 之后、
 *  或尾部开着的半截 fence 整体）纯文本直渲——未完成段不进管线防闪烁。 */
const streamSplit = computed<{ prefix: string; tail: string }>(() => {
  if (!props.streaming) return { prefix: props.text, tail: '' };
  const lines = props.text.split('\n');
  // 单遍扫描：lastClosed = 最后一个闭合 fence 尾行+1；openStart = 当前未闭合 fence 首行
  let lastClosed = 0;
  let openStart = -1;
  let mark = '';
  for (const [i, line] of lines.entries()) {
    const m = /^\s*(```|~~~)/.exec(line);
    if (!m) continue;
    if (openStart >= 0) {
      if (line.trimStart().startsWith(mark)) { openStart = -1; lastClosed = i + 1; }
    } else {
      openStart = i;
      mark = m[1]!;
    }
  }
  const cut = openStart >= 0 ? openStart : lastClosed;
  return { prefix: lines.slice(0, cut).join('\n'), tail: lines.slice(cut).join('\n') };
});

const html = computed(() => render(streamSplit.value.prefix));
</script>

<template>
  <div class="markdown-card" :class="{ sm }">
    <div v-if="rawToggle" class="mc-raw-toggle">
      <button type="button" class="mc-toggle-btn" :class="{ on: showRaw }" @click="showRaw = !showRaw; emit('toggle-raw', showRaw)">
        {{ showRaw ? '渲染' : '原文' }}
      </button>
    </div>
    <ScrollableViewport v-if="!showRaw">
      <div class="markdown-body mc-body" v-html="html" />
      <span v-if="streamSplit.tail" class="mc-tail">{{ streamSplit.tail }}</span>
    </ScrollableViewport>
    <ScrollableViewport v-else>
      <pre class="mc-raw"><code>{{ text }}</code></pre>
    </ScrollableViewport>
  </div>
</template>

<style scoped>
.markdown-card { min-width: 0; font-size: 13px; }
.markdown-card.sm .mc-body { font-size: 12px; }
.mc-body :deep(h1), .mc-body :deep(h2), .mc-body :deep(h3) { font-size: 1em; }
.mc-raw-toggle { display: flex; justify-content: flex-end; }
.mc-toggle-btn {
  border: none; background: transparent; color: var(--text-3);
  font-size: var(--fs-2xs); cursor: pointer; padding: 2px 6px; border-radius: var(--r-sm);
}
.mc-toggle-btn:hover { color: var(--text-1); background: var(--bg-hover); }
.mc-toggle-btn.on { color: var(--primary-strong); }
.mc-tail { color: var(--text-2); white-space: pre-wrap; word-break: break-word; }
.mc-raw {
  margin: 0; font-size: 12px; line-height: 1.7; white-space: pre-wrap; word-break: break-word;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace; color: var(--text-2);
}
</style>