<!--
  ui/Modal.vue —— 基础弹窗（Teleport + 遮罩 + ESC 关闭）
  用法：<Modal :visible="show" title="标题" @close="show = false">...</Modal>
-->
<script setup lang="ts">
import { watch, onUnmounted } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  visible: boolean;
  title?: string;
  width?: number | string;
  /** 固定高度（如 '70vh'）。设置后切换内容时弹窗高度不跳变，body 内部滚动 */
  height?: number | string;
  closeOnOverlay?: boolean;
  /** 层级（settings 面板内弹窗需高于面板 z-index 1000） */
  zIndex?: number;
}>(), { width: 440, closeOnOverlay: true, zIndex: 600 });

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
    <Transition name="ui-modal">
      <div v-if="visible" class="ui-modal" :style="{ zIndex }">
        <div class="ui-modal-overlay" @click="closeOnOverlay && emit('close')" />
        <div class="ui-modal-panel" :style="{
          width: typeof width === 'number' ? width + 'px' : width,
          ...(height ? { height: typeof height === 'number' ? height + 'px' : height } : {}),
        }">
          <div v-if="title" class="ui-modal-head">
            <span class="ui-modal-title">{{ title }}</span>
            <span class="ui-modal-head-extra"><slot name="head-extra" /></span>
            <button class="ui-modal-close" @click="emit('close')"><Icon name="x" :size="16" /></button>
          </div>
          <div class="ui-modal-body"><slot /></div>
          <div v-if="$slots.footer" class="ui-modal-footer"><slot name="footer" /></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ui-modal { position: fixed; inset: 0; z-index: 600; display: flex; align-items: center; justify-content: center; }
.ui-modal-overlay { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.35); }
.ui-modal-panel {
  position: relative; background: var(--bg-raised); border-radius: var(--r-lg);
  box-shadow: var(--shadow-panel); border: 1px solid var(--line);
  max-width: 92vw; max-height: 86vh;
  display: flex; flex-direction: column;
}
.ui-modal-head { display: flex; align-items: center; gap: 8px; padding: 10px 16px 8px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
.ui-modal-title { font-size: 14px; font-weight: 600; flex: 1; }
.ui-modal-head-extra { display: inline-flex; align-items: center; margin-right: 8px; font-size: 12px; color: var(--text-3); }
.ui-modal-close {
  border: 0; background: transparent; color: var(--text-3); cursor: pointer;
  display: grid; place-items: center; width: 24px; height: 24px; border-radius: var(--r-sm);
}
.ui-modal-close:hover { background: var(--bg-hover); color: var(--text-1); }
.ui-modal-body { padding: 0; flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.ui-modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 16px 10px; border-top: 1px solid var(--line); flex-shrink: 0; }

.ui-modal-enter-active, .ui-modal-leave-active { transition: opacity 0.18s var(--ease-out); }
.ui-modal-enter-active .ui-modal-panel, .ui-modal-leave-active .ui-modal-panel { transition: transform 0.18s var(--ease-out); }
.ui-modal-enter-from, .ui-modal-leave-to { opacity: 0; }
.ui-modal-enter-from .ui-modal-panel, .ui-modal-leave-to .ui-modal-panel { transform: translateY(8px) scale(0.98); }
</style>
