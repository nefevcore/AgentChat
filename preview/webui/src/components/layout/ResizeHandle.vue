<script setup lang="ts">
// ============================================================
// components/layout/ResizeHandle.vue —— 可复用拖拽分隔条
//
// kind='list'  ：列表面板右缘（右移变宽）
// kind='workspace'：工作区面板左缘（右移变窄，方向相反）
// 拖拽逻辑统一在 stores/ui.ts（resizing 状态驱动 active 样式）。
// ============================================================

import { useUiStore } from '../../stores/ui';

const props = defineProps<{
  kind: 'list' | 'workspace';
}>();

const ui = useUiStore();

function onStart(e: MouseEvent) {
  ui.startResize(props.kind, e);
}
</script>

<template>
  <div
    class="resize-handle"
    :class="{ active: ui.resizing }"
    @mousedown="onStart"
  />
</template>

<style scoped>
.resize-handle {
  width: 3px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.15s;
  flex-shrink: 0;
}
.resize-handle:hover, .resize-handle.active {
  background: var(--color-primary, #6366f1);
}
</style>
