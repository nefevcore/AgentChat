<script setup lang="ts">
// ============================================================
// client/SystemPromptPanelHost.vue —— prompt aux 选区宿主
//（A1：宽度绑线 + 通用意图消费〔panel='prompt' 帧〕；内容逻辑住
//  SystemPromptPanel〔与 modal 同源 chatStore〕）
// ============================================================
import { watch } from 'vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import SystemPromptPanel from './SystemPromptPanel.vue';

const ui = useUiStore();

// 意图消费：会话头按钮（宽屏）→ 选区切换 + 展开。
// 内容请求由按钮自带（openPreview 先 requestSystemPrompt 再写意图——
// modal/aux 双形态同路径）；SystemPromptPanel 的当选兜底只补
// rail 直开场景（无入口按钮）。
watch(() => ui.auxIntent, (seq) => {
  if (!seq || ui.auxIntentPanel !== 'prompt') return;
  ui.selectAuxPanel('prompt');
  ui.applyAuxPanelWidth('prompt'); // 按选区形态重整（def.comfyWidth 单源）
  ui.openAux();
});
</script>

<template>
  <SystemPromptPanel :style="{ width: ui.auxWidth + 'px' }" />
</template>
