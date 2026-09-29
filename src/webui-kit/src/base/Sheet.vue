<!--
  webui-kit/src/base/Sheet.vue —— 底部上滑面板原语（cr-29 Phase② 前置落地）
  用法：<Sheet :visible="show" title="标题" @close="show = false">...</Sheet>
  全屏遮罩 + 底部滑入面板（≤200ms）；Modal 的移动端同位原语。
-->
<script setup lang="ts">
import { watch, onUnmounted } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  visible: boolean;
  title?: string;
  /** 最大占屏高（面板内部滚动） */
  maxHeight?: string;
  /** 全屏形态（占满视口、无圆角/抓手；aux 选区面板等整页内容用） */
  full?: boolean;
  /** 保活形态（v-show 代替 v-if——隐藏不卸载，内部状态/滚动保留） */
  keepAlive?: boolean;
  closeOnOverlay?: boolean;
  zIndex?: number;
}>(), { maxHeight: '70vh', full: false, keepAlive: false, closeOnOverlay: true, zIndex: 600 });

const emit = defineEmits<{ close: [] }>();

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.visible) emit('close');
}
watch(() => props.visible, (v) => {
  if (v) document.addEventListener('keydown', onKey);
  else document.removeEventListener('keydown', onKey);
}, { immediate: true });
onUnmounted(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <Transition name="ui-sheet">
      <div v-if="keepAlive || visible" v-show="visible" class="ui-sheet" :class="{ full }" :style="{ zIndex }">
        <div class="ui-sheet-overlay" @click="closeOnOverlay && emit('close')" />
        <div class="ui-sheet-panel" :style="full ? undefined : { maxHeight }">
          <div v-if="!full" class="ui-sheet-grabber" />
          <div v-if="title" class="ui-sheet-head">
            <span class="ui-sheet-title">{{ title }}</span>
            <button class="ui-sheet-close" @click="emit('close')"><Icon name="x" :size="16" /></button>
          </div>
          <div class="ui-sheet-body"><slot /></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ui-sheet { position: fixed; inset: 0; display: flex; align-items: flex-end; }
.ui-sheet-overlay { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.35); }
.ui-sheet-panel {
  position: relative; width: 100%;
  background: var(--bg-raised); border-radius: var(--r-lg) var(--r-lg) 0 0;
  box-shadow: var(--shadow-panel); border: 1px solid var(--line); border-bottom: 0;
  display: flex; flex-direction: column;
}
/* 全屏形态：占满视口、顶到安全区（aux 面板等整页内容） */
.ui-sheet.full { align-items: stretch; }
.ui-sheet.full .ui-sheet-panel {
  border-radius: 0; border: 0; height: 100%;
  padding-top: var(--safe-top, 0px);
}
/* 全屏 body = 纯填充容器（面板自带内部滚动区；外层不滚，避免双滚动条） */
.ui-sheet.full .ui-sheet-body { padding: 0; overflow: hidden; }
.ui-sheet-grabber { width: 36px; height: 4px; border-radius: 999px; background: var(--line-strong); margin: 8px auto 4px; flex-shrink: 0; }
.ui-sheet-head { display: flex; align-items: center; gap: 8px; padding: 6px 16px 8px; flex-shrink: 0; }
.ui-sheet-title { font-size: 14px; font-weight: 600; flex: 1; }
.ui-sheet-close {
  border: 0; background: transparent; color: var(--text-3); cursor: pointer;
  display: grid; place-items: center; width: 24px; height: 24px; border-radius: var(--r-sm);
}
.ui-sheet-close:hover { background: var(--bg-hover); color: var(--text-1); }
.ui-sheet-body { padding: 0 0 calc(12px + var(--safe-bottom, 0px)); flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }

.ui-sheet-enter-active, .ui-sheet-leave-active { transition: opacity 0.2s var(--ease-out); }
.ui-sheet-enter-active .ui-sheet-panel, .ui-sheet-leave-active .ui-sheet-panel { transition: transform 0.2s var(--ease-out); }
.ui-sheet-enter-from, .ui-sheet-leave-to { opacity: 0; }
.ui-sheet-enter-from .ui-sheet-panel, .ui-sheet-leave-to .ui-sheet-panel { transform: translateY(100%); }
</style>