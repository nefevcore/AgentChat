<script setup lang="ts">
// ============================================================
// components/layout/ResizeHandle.vue —— 可复用拖拽分隔条
//
// kind='primary'       ：主侧边栏右缘（右移变宽）
// kind='aux'          ：aux-sidebar 区域左缘（右移变窄，方向相反）
// 拖拽逻辑统一在 stores/ui.ts（resizing 状态驱动 active 样式）。
// ============================================================

import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

const props = defineProps<{
  kind: 'primary' | 'aux';
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
