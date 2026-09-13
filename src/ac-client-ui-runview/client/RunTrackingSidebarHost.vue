<script setup lang="ts">
// ============================================================
// client/RunTrackingSidebarHost.vue —— tracking aux 选区宿主
//（A5：运行跟踪自主侧边栏第三面板迁辅助侧边栏——主侧边栏回归
//  纯导航〔agents/sessions〕，监视类全归右栏；RunTrackingPanel
//  组件原样复用——数据/轮询/入口行为不变，仅席位迁移）
//
// 宽度绑线 + 通用意图消费（panel='tracking'——活动栏原 tracking
// 按钮经 uiStore.openTrackingPanel 写意图）。
// ============================================================
import { watch } from 'vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import RunTrackingPanel from './RunTrackingPanel.vue';

const ui = useUiStore();

// 意图消费：活动栏 tracking 按钮 / 清单入口 → 选区切换 + 展开
watch(() => ui.auxIntent, (seq) => {
  if (!seq || ui.auxIntentPanel !== 'tracking') return;
  ui.selectAuxPanel('tracking');
  ui.applyAuxPanelWidth('tracking'); // 按选区形态重整（def.comfyWidth 单源）
  ui.openAux();
});
</script>

<template>
  <RunTrackingPanel :style="{ width: ui.auxWidth + 'px' }" />
</template>
