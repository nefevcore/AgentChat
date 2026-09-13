<script setup lang="ts">
// ============================================================
// client/TokenUsageHost.vue —— usage 域 overlay 席位宿主
//（M28 P1：原 layout AppFrame 内联 SlotOutletItem 内容迁入；
//  P2：兼通用 auxIntent 消费面——宽屏入口写意图〔panel='usage'〕，
//  本宿主（overlay 常驻）watch 之 → 显式选区 + 舒适宽 + 展开。
//  同 FilePreviewHost 模式〔watch 住常驻组件，绑 app pinia 实例——
//  插件级 watch 会绑死建立时的 active pinia〕〕）
// ============================================================
import { watch } from 'vue';
import TokenUsage from './TokenUsage.vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

const ui = useUiStore();

// 宽屏意图消费：通用 auxIntent（panel='usage' 帧）
watch(() => ui.auxIntent, (seq) => {
  if (!seq || ui.auxIntentPanel !== 'usage') return;
  ui.selectAuxPanel('usage'); // 显式选区置位（active 谓词据此当选）
  ui.applyAuxPanelWidth('usage'); // 按选区形态重整（def.comfyWidth 单源）
  ui.openAux(); // 展开区域
});
</script>

<template>
  <!-- Token 用量面板（modal 形态——窄屏 fallback） -->
  <TokenUsage :visible="ui.tokenUsageVisible" @close="ui.closeTokenUsage" />
</template>
