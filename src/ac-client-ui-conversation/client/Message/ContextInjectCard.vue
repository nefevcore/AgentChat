<!-- ContextInjectCard.vue -->
<script setup lang="ts">
// ============================================================
// 注入卡（2026-09-26 注入卡）：context 注入行（source:skill 等）的工具卡
// 样式渲染——label 收起行 + 展开体（注入体原文纯文本，限高滚动）。
// 落实 skill-injection-and-storage-vocab 裁决 #3 的 label 条形态
// （原「二期」欠账）。结构对齐 ToolMessage 卡（图标位 14px + 单行
// 截断 + hover 折叠箭头）；样式全走 token（双主题铁律）。
// 挂位：TurnDisplayItem chain-body 头/尾（随链栏折叠）或 TranscriptList
// 独立降级位——本组件无位置假设，数据即 InjectCard。
// ============================================================
import { ref } from 'vue';
import { Icon } from '@agentchat/webui-kit';
import type { InjectCard } from '../types.ts';

const props = defineProps<{ card: InjectCard }>();

// 默认折叠（与工具卡一致：仅用户点击展开）；直播行（content 缺席）
// 不可展开——settlement 重拉权威行后展开体自然在场
const isExpanded = ref(false);
const rowHover = ref(false);
const canExpand = () => !!props.card.content;
const toggle = () => { if (canExpand()) isExpanded.value = !isExpanded.value; };
</script>

<template>
  <div class="inject-card">
    <div
      class="inject-label"
      :class="{ 'is-actionable': canExpand() }"
      @click="toggle"
      @mouseenter="rowHover = true"
      @mouseleave="rowHover = false"
    >
      <!-- 行首图标位（与工具卡同款交互）：hover 显示折叠箭头，平时注入图标 -->
      <Icon v-if="rowHover && canExpand()" :name="isExpanded ? 'chevron-up' : 'chevron-down'" :size="14" class="inject-label-icon" />
      <Icon v-else name="book-open" :size="14" class="inject-label-icon" />
      <span class="inject-label-name" :title="card.label">{{ card.label }}</span>
    </div>
    <div v-if="isExpanded && card.content" class="inject-body">
      <pre class="inject-text">{{ card.content }}</pre>
    </div>
  </div>
</template>

<style scoped>
/* 卡片根：占位与链体内其余卡同宽（无独立背景——链内嵌卡不浮面） */
.inject-card {
  min-width: 0;
  width: 100%;
}

/* label 行：与 .tool-label 同款节奏（12px/500/次级色/hover 主色） */
.inject-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
  user-select: none;
  padding: 2px 0;
  transition: color 0.15s;
  min-width: 0;
}
.inject-label.is-actionable { cursor: pointer; }
.inject-label.is-actionable:hover { color: var(--color-text-primary); }

.inject-label-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--color-text-secondary);
  transition: opacity 0.12s ease;
}

/* label 文本：单行截断（与 .tool-label-name 同款） */
.inject-label-name {
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 展开体：与 .tool-body 同款竖线节奏；正文限高滚动（--card-viewport-max */
/* 统一令牌——裁决 #3 的 ~40vh 限高落位） */
.inject-body {
  margin-top: 4px;
  margin-left: 7px;
  border-left: 1px solid var(--color-border-secondary);
  padding-left: 14px;
  min-width: 0;
}
.inject-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  color: var(--color-text-secondary);
  max-height: var(--card-viewport-max);
  overflow-y: auto;
  overscroll-behavior: contain;
}
</style>