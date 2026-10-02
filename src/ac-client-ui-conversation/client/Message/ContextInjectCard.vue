<!-- ContextInjectCard.vue -->
<script setup lang="ts">
// ============================================================
// 注入卡（2026-09-26 注入卡）：context 注入行（source:skill 等）的工具卡
// 样式渲染——label 收起行 + 展开体（注入体原文纯文本，限高滚动）。
// 落实 skill-injection-and-storage-vocab 裁决 #3 的 label 条形态
// （原「二期」欠账）。
// cr-125（P1）：label 行 + 左竖线 + 限高视口整体归位 kit CollapseRow
// （指南 R5——工具卡/思考区/注入卡同构归一；aria-expanded/aria-controls/
// aria-live=off 与「回到底部」由壳自带，本组件只供文案与正文）。
// 挂位：TurnDisplayItem chain-body 头/尾（随链栏折叠）或 TranscriptList
// 独立降级位——本组件无位置假设，数据即 InjectCard。
// ============================================================
import { ref } from 'vue';
import { CollapseRow } from '@agentchat/webui-kit';
import type { InjectCard } from '../types.ts';

const props = defineProps<{ card: InjectCard }>();

// 默认折叠（与工具卡一致：仅用户点击展开）；直播行（content 缺席）
// 不可展开——settlement 重拉权威行后展开体自然在场。
// CollapseRow 是受控形态（open prop + toggle 事件）：canExpand 为假时
// toggle 不写回，展开态恒不成立（与迁移前「点击无反应」等价）。
const isExpanded = ref(false);
const canExpand = () => !!props.card.content;
const toggle = () => { if (canExpand()) isExpanded.value = !isExpanded.value; };
</script>

<template>
  <CollapseRow
    class="inject-card"
    :title="card.label"
    :open="isExpanded"
    @toggle="toggle"
  >
    <pre v-if="card.content" class="inject-text">{{ card.content }}</pre>
  </CollapseRow>
</template>

<style scoped>
/* 卡片根：占位与链体内其余卡同宽（无独立背景——链内嵌卡不浮面）；
   标签行/左竖线/限高视口由 CollapseRow 提供 */
.inject-card {
  min-width: 0;
  width: 100%;
}

/* 展开体正文：排版住本处，限高与滚动归 CollapseRow 视口 */
.inject-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  color: var(--text-2);
}
</style>
