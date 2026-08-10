<!-- ListPanel.vue —— 列表面板（插槽：渲染当前视角的 list 组件）
     宽度拖拽调整由本组件统一处理，各视角列表无需重复实现。 -->
<script setup lang="ts">
import { ref, onUnmounted } from 'vue';
import { useUiStore } from '@/stores/ui';
import type { Perspective } from '@/framework/perspectives';

defineProps<{ perspective: Perspective }>();

const ui = useUiStore();
const MIN_LIST = 160;
const MIN_CHAT = 320;

const resizing = ref(false);
let resizeStartX = 0;
let resizeStartW = 0;

function onResizeStart(e: MouseEvent) {
  e.preventDefault();
  resizing.value = true;
  resizeStartX = e.clientX;
  resizeStartW = ui.listWidth;
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeEnd);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}
function onResizeMove(e: MouseEvent) {
  if (!resizing.value) return;
  const delta = e.clientX - resizeStartX;
  const maxWidth = window.innerWidth - 48 - MIN_CHAT;
  ui.listWidth = Math.max(MIN_LIST, Math.min(resizeStartW + delta, maxWidth));
}
function onResizeEnd() {
  resizing.value = false;
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeEnd);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}
onUnmounted(() => {
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeEnd);
});
</script>

<template>
  <div class="list-panel" :style="{ width: ui.listWidth + 'px' }">
    <component :is="perspective.list" :class="{ 'sidebar-mobile-visible': ui.sidebarVisible }" />
    <div class="resize-handle" :class="{ active: resizing }" @mousedown="onResizeStart" />
  </div>
</template>

<style scoped>
.list-panel {
  display: flex;
  flex-shrink: 0;
  overflow: hidden;
}
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
@media (max-width: 768px) {
  .list-panel {
    position: fixed;
    left: 48px;
    top: 0;
    bottom: 0;
    z-index: 120;
  }
  .list-panel :deep(.sidebar-mobile-visible) {
    box-shadow: 2px 0 12px rgba(0, 0, 0, 0.15);
  }
}
</style>
