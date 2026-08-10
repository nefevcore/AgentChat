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
  closeOnOverlay?: boolean;
}>(), { width: 440, closeOnOverlay: true });

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
      <div v-if="visible" class="ui-modal">
        <div class="ui-modal-overlay" @click="closeOnOverlay && emit('close')" />
        <div class="ui-modal-panel" :style="{ width: typeof width === 'number' ? width + 'px' : width }">
          <div v-if="title" class="ui-modal-head">
            <span class="ui-modal-title">{{ title }}</span>
            <button class="ui-modal-close" @click="emit('close')"><Icon name="x" :size="16" /></button>
          </div>
          <div class="ui-modal-body"><slot /></div>
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
  max-width: 92vw; max-height: 86vh; overflow-y: auto;
}
.ui-modal-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.ui-modal-title { font-size: 14px; font-weight: 600; flex: 1; }
.ui-modal-close {
  border: 0; background: transparent; color: var(--text-3); cursor: pointer;
  display: grid; place-items: center; width: 26px; height: 26px; border-radius: var(--r-sm);
}
.ui-modal-close:hover { background: var(--bg-hover); color: var(--text-1); }
.ui-modal-body { padding: 0; }

.ui-modal-enter-active, .ui-modal-leave-active { transition: opacity 0.18s var(--ease-out); }
.ui-modal-enter-active .ui-modal-panel, .ui-modal-leave-active .ui-modal-panel { transition: transform 0.18s var(--ease-out); }
.ui-modal-enter-from, .ui-modal-leave-to { opacity: 0; }
.ui-modal-enter-from .ui-modal-panel, .ui-modal-leave-to .ui-modal-panel { transform: translateY(8px) scale(0.98); }
</style>
