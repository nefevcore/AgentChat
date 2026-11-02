<!-- ============================================================
  ac-client-ui-renderer/client/CodeCard.vue —— 代码卡（cr-765 批次A §1.3，
  #17A/#17B/#17C 契约面）
  以 ToolResultRunCode 程序段形态为蓝本：卡头（标题 + 语言徽记 + 行数
  + hash + 控件锚点）+ 代码视口（hljs 高亮 + 横滚/折行两态）。
  - controls slot：右侧控件锚点——布局/顺序/间距归本卡，业务只声明
    「有哪些钮」（#17B）；
  - wrap 开关常驻 controls 首位（#17C）：阅读方式开关优先于动作钮；
    状态经 localStorage 持久化（消费方传 wrap prop 作单卡覆盖初值）。
  ============================================================ -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useMarkdown } from './useMarkdown.ts';
import ScrollableViewport from './ScrollableViewport.vue';
import { Icon } from '@agentchat/webui-kit';
import { fenceOf } from './codeFence.ts';

const props = withDefaults(defineProps<{
  /** 代码原文 */
  code?: string;
  /** 语言（hljs 名；缺省按文本渲染） */
  lang?: string;
  /** 卡头标题（如 program.ts / return / 文件路径） */
  title?: string;
  /** 程序体哈希（run_code 卡头 #xxx） */
  hash?: string;
  /** 卡头补充 meta（read 卡的 L 范围/版本/字节数等——与行数并列显示） */
  metaText?: string;
  /** 折行初值（单卡覆盖；缺省读全局偏好） */
  wrap?: boolean;
  /** 行号（缺省关——run_code 程序体无行号，read 卡有） */
  lineNumbers?: boolean;
  /** 行号起始（read 卡范围读取 L12-L30） */
  startLine?: number;
}>(), { code: '', lang: '', title: '', hash: '', metaText: '', wrap: undefined, lineNumbers: false, startLine: 1 });

const WRAP_KEY = 'agentchat.codeWrap';
/** 全局折行偏好（uiStore 同款 localStorage 键式——一次选择对所有代码卡生效） */
function readGlobalWrap(): boolean {
  // 缺省开（测试反馈 #2：长行折行读全 > 横滚找内容）；显式存过 '0' 才关
  try { return localStorage.getItem(WRAP_KEY) !== '0'; } catch { return true; }
}
const globalWrap = ref(readGlobalWrap());
const wrapOn = computed(() => props.wrap ?? globalWrap.value);
function toggleWrap() {
  globalWrap.value = !globalWrap.value;
  try { localStorage.setItem(WRAP_KEY, globalWrap.value ? '1' : '0'); } catch { /* ignore */ }
}

const { render } = useMarkdown();
const lines = computed(() => props.code ? props.code.split('\n') : [] as string[]);
const lineCount = computed(() => lines.value.length);
const rendered = computed(() => {
  if (!props.code) return '';
  return render(`${fenceOf(props.code)}${props.lang || 'text'}\n${props.code}\n${fenceOf(props.code)}`);
});

/** 复制钮（三处代码卡共通动作——归骨架） */
const copyState = ref<'idle' | 'copied'>('idle');
let copyTimer: ReturnType<typeof setTimeout> | null = null;
onBeforeUnmount(() => { if (copyTimer) clearTimeout(copyTimer); });
async function copyCode() {
  try {
    await navigator.clipboard.writeText(props.code);
    copyState.value = 'copied';
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyState.value = 'idle'; }, 2000);
  } catch { /* ignore */ }
}
</script>

<template>
  <div class="code-card" :class="{ wrap: wrapOn }">
    <div class="cc-head">
      <span class="cc-title">{{ title }}</span>
      <span class="cc-meta">
        <span v-if="lang" class="ui-badge kind cc-lang">{{ lang }}</span>
        <span class="cc-dim">{{ lineCount }} 行</span>
        <span v-if="metaText" class="cc-dim">{{ metaText }}</span>
        <span v-if="hash" class="cc-dim cc-hash" :title="`程序体哈希 ${hash}（全文在宿主日志按哈希回捞）`">#{{ hash }}</span>
      </span>
      <span class="cc-controls" @click.stop>
        <button type="button" class="cc-btn" :class="{ on: wrapOn }" :title="wrapOn ? '切换单行 + 横向滚动' : '切换自动换行'" @click="toggleWrap">
          <Icon :name="wrapOn ? 'wrap-text' : 'arrow-right'" :size="12" />
          <span>{{ wrapOn ? '不换行' : '自动换行' }}</span>
        </button>
        <slot name="controls" />
        <button class="cc-btn" :class="{ copied: copyState === 'copied' }" :title="copyState === 'copied' ? '已复制' : '复制代码'" @click="copyCode">
          <Icon :name="copyState === 'copied' ? 'check' : 'copy'" :size="12" />
          <span>{{ copyState === 'copied' ? '已复制' : '复制' }}</span>
        </button>
      </span>
    </div>
    <div class="cc-body">
      <!-- 自定义体（diff 卡等非 hljs 渲染形态——#17A 差异化插槽） -->
      <slot v-if="$slots.default" />
      <!-- 反馈 #7：行号列与代码同容器——横向滚动条恒贴卡右缘（行号 flex 独列时
           滚动容器会被挤到中间位）。行号 sticky 左锚：横滚时行号恒可见 -->
      <div v-else class="cc-scroll">
        <div v-if="lineNumbers" class="cc-lines">
          <span v-for="(l, i) in lines" :key="i" class="cc-ln">{{ i + startLine }}</span>
        </div>
        <div class="cc-code" v-html="rendered" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.code-card {
  background: var(--bg-surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  min-width: 0;
}
.cc-head {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-inset);
  font-size: 11px; user-select: none;
}
.cc-title { font-weight: 600; color: var(--text-2); font-family: var(--font-mono); }
.cc-meta { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cc-lang { font-weight: 600; }
.cc-dim { color: var(--text-3); font-size: 10.5px; }
.cc-hash { font-family: var(--font-mono); cursor: help; }
.cc-controls { margin-left: auto; display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
.cc-btn {
  display: inline-flex; align-items: center; gap: 4px;
  border: none; background: transparent; color: var(--text-3);
  font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 4px;
  transition: all 0.15s; flex-shrink: 0;
}
.cc-btn:hover { color: var(--text-1); background: var(--bg-hover); }
.cc-btn.copied { color: var(--ok); }
/* 按下态常亮（阅读方式开关与一次性动作钮的区分——#17C） */
.cc-btn.on { color: var(--primary-strong); background: var(--bg-hover); }
.cc-body { display: flex; min-width: 0; }
/* 差异化插槽体也是 flex item（width:auto = min-content 收缩）——授予撑满+收缩，
   diff 卡等自定义体才能填满卡身宽 */
.cc-body > :slotted(*) { flex: 1; min-width: 0; }
/* 滚动容器（行号+代码一体）——反馈 #7：滚动条贴卡右缘；限高 = 会话卡统一上限 */
.cc-scroll {
  display: flex; min-width: 0; flex: 1;
  overflow-x: auto;
  overflow-y: auto;
  max-height: var(--card-viewport-max);
  scrollbar-width: thin; scrollbar-color: var(--scroll-thumb) transparent;
}
.cc-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.cc-scroll::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: var(--r-full); }
.cc-scroll::-webkit-scrollbar-thumb:hover { background: var(--scroll-thumb-hover); }
/* 行号列 sticky 左锚：横滚恒可见，不随内容滚走 */
.cc-lines { position: sticky; left: 0; background: var(--bg-surface); z-index: 1; }
/* 行号列：不参与折行（flex-shrink 0），折行时行号不错位 */
.cc-lines {
  display: flex; flex-direction: column; flex-shrink: 0;
  padding: 8px 0 8px 10px;
  color: var(--text-3); font-family: var(--font-mono); font-size: 12px; line-height: 1.6;
  text-align: right; user-select: none;
  border-right: 1px solid var(--line);
  margin-right: 8px;
}
.cc-ln { min-width: 2.5ch; }
/* 滚动条 = 全局标准（8px + --scroll-thumb 令牌）——显式声明防消费方细滚动条残留 */
/* cc-code 撑开内容宽（滚动归 cc-scroll） */
.cc-code { flex: 1; min-width: 0; }
/* 折行态：代码 pre 走 pre-wrap；行号列已隔离不受影响 */
.code-card.wrap .cc-code { overflow-x: hidden; }
.code-card.wrap .cc-code :deep(pre) { white-space: pre-wrap; word-break: break-word; }
/* 嵌套代码块按卡内规格覆盖（markdown.css 全挂 .markdown-body 前缀，本上下文不命中——
   ToolResultRunCode 同款处置） */
.cc-code :deep(.md-code-block) { margin: 0; border: none; border-radius: 0; background: transparent; min-width: 0; }
.cc-code :deep(.md-code-block-banner) { display: none; }
.cc-code :deep(pre) { margin: 0; padding: 8px 12px; font-size: 12px; line-height: 1.6; }
.cc-code :deep(code) { font-family: var(--font-mono); }
</style>