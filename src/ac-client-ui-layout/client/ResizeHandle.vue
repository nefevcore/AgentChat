<script setup lang="ts">
// ============================================================
// components/layout/ResizeHandle.vue —— 可复用拖拽分隔条
//
// kind='primary'       ：主侧边栏右缘（右移变宽）
// kind='aux'          ：aux-sidebar 区域左缘（右移变窄，方向相反）
// 拖拽逻辑统一在 stores/ui.ts（resizing 状态驱动 active 样式）。
// 双击 = 还原默认宽度（ui.resetWidth——拖拽归零，与初始缺省同源）。
// ============================================================

import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

const props = defineProps<{
  kind: 'primary' | 'aux';
}>();

const ui = useUiStore();

function onStart(e: MouseEvent) {
  ui.startResize(props.kind, e);
}

function onReset() {
  ui.resetWidth(props.kind);
}
</script>

<template>
  <div
    class="resize-handle"
    :class="{ active: ui.resizing }"
    title="拖动调整宽度，双击还原默认"
    @mousedown="onStart"
    @dblclick="onReset"
  />
</template>

<style scoped>
.resize-handle {
  width: 4px; /* 拖拽热区（可命中宽度——视觉线由 ::before 细线呈现） */
  cursor: col-resize;
  background: transparent;
  position: relative;
  flex-shrink: 0;
}
/* 视觉：1px 细边界线（居中于热区——主区 ⇄ 侧边栏的弱分界，不抢注意力）；
   hover/拖动时加亮为主题色 */
.resize-handle::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 1px;
  transform: translateX(-0.5px);
  background: var(--color-border-secondary, rgba(128, 128, 128, 0.35));
  transition: background 0.15s, width 0.15s;
}
.resize-handle:hover::before, .resize-handle.active::before {
  background: var(--color-primary, #6366f1);
  width: 2px;
}
</style>
