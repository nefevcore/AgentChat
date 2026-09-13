<script setup lang="ts">
// ============================================================
// client/TimersPanelHost.vue —— timers aux 选区宿主（A3）
//（宽度绑线 + 通用意图消费〔panel='timers' 帧〕；聚合内容住 TimersPanel）
// ============================================================
import { watch } from 'vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import TimersPanel from './TimersPanel.vue';

const ui = useUiStore();

// 意图消费（/timer 快捷命令等未来入口）→ 选区切换 + 展开
watch(() => ui.auxIntent, (seq) => {
  if (!seq || ui.auxIntentPanel !== 'timers') return;
  ui.selectAuxPanel('timers');
  ui.applyAuxPanelWidth('timers'); // 按选区形态重整（def.comfyWidth 单源）
  ui.openAux();
});
</script>

<template>
  <TimersPanel :style="{ width: ui.auxWidth + 'px' }" />
</template>
