<!-- ============================================================ -->
<!-- client/TokenUsageHost.vue —— usage 域 overlay 席位宿主

零渲染宿主（cr-30：窄屏 Modal 形态退役——TokenUsage 组件的 modal 形态不再
有消费方；宽窄统一走 aux 'usage' 选区，窄屏由 AuxSidebarHost 全屏 Sheet
呈现 panel 形态）。本组件的唯一职责 = 承载 auxIntent 消费 watch：
意图消费必须住 overlay 常驻组件（插件级 watch 会绑死建立时的 active pinia
实例；选区宿主是 volatile——区域收起即卸载，watch 不在场时收不到意图帧）。
-->
<script setup lang="ts">
import { watch } from 'vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

const ui = useUiStore();

// 意图消费：通用 auxIntent（panel='usage' 帧）→ 显式选区 + 舒适宽 + 展开
watch(() => ui.auxIntent, (seq) => {
  if (!seq || ui.auxIntentPanel !== 'usage') return;
  ui.selectAuxPanel('usage'); // 显式选区置位（active 谓词据此当选）
  ui.applyAuxPanelWidth('usage'); // 按选区形态重整（def.comfyWidth 单源）
  ui.openAux(); // 展开区域（窄屏 = 全屏 Sheet）
});
</script>

<template>
  <!-- 零渲染：v-if=false 仅占位（本宿主不出视觉输出） -->
  <span v-if="false" />
</template>
