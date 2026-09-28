<!-- ============================================================ -->
<!-- client/FilePreviewHost.vue —— workspace 域 overlay 席位宿主

零渲染宿主（cr-36：窄屏 Modal 形态退役——FilePreviewModal 删除；宽窄统一
走 aux 'preview' 选区，窄屏由 AuxSidebarHost 全屏 Sheet 呈现同一多 tab
面板）。本组件的唯一职责 = 承载 auxIntent 消费 watch（须住 overlay 常驻
组件——插件级 watch 绑死建立时 pinia；选区宿主 volatile 卸载即收不到意图帧）：
  消费意图 → previewTabs.openTab + 显式选区 'preview' + 舒适宽 + 展开。
-->
<script setup lang="ts">
import { watch } from 'vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { usePreviewTabsStore } from './previewTabs.ts';

const ui = useUiStore();
const tabs = usePreviewTabsStore();

watch(() => ui.auxIntent, (seq) => {
  if (!seq || ui.auxIntentPanel !== 'preview') return;
  const path = ui.previewFilePath;
  if (!path) return;
  tabs.openTab(path, { agentId: ui.previewIntentFallback, conversationId: ui.previewIntentConversationId });
  ui.selectAuxPanel('preview'); // 显式选区置位（panelOpen 已随 openTab 置真）
  ui.applyAuxPanelWidth('preview'); // 按选区形态重整（def.comfyWidth 单源）
  ui.openAux(); // 展开区域（窄屏 = 全屏 Sheet）
});
</script>

<template>
  <!-- 零渲染：v-if=false 仅占位（本宿主不出视觉输出） -->
  <span v-if="false" />
</template>
