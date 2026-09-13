<script setup lang="ts">
// ============================================================
// client/FileEditsPanelHost.vue —— 文件编辑 aux 选区宿主
//（宽度绑线 + 通用意图消费〔panel='file-edits' 帧〕；内容住
// FileEditsPanel——feed 驱动自动重算）
// ============================================================
import { watch } from 'vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import FileEditsPanel from './FileEditsPanel.vue';

const ui = useUiStore();

// 意图消费：未来入口（会话头按钮等）→ 选区切换 + 展开
watch(() => ui.auxIntent, (seq) => {
  if (!seq || ui.auxIntentPanel !== 'file-edits') return;
  ui.selectAuxPanel('file-edits');
  ui.applyAuxPanelWidth('file-edits'); // comfyWidth 单源（注册处 'half'）
  ui.openAux();
});
</script>

<template>
  <FileEditsPanel :style="{ width: ui.auxWidth + 'px' }" />
</template>
