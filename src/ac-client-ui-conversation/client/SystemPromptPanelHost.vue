<script setup lang="ts">
// ============================================================
// client/SystemPromptPanelHost.vue —— prompt aux 选区宿主
//（cr-30：宽度绑线 = 宿主统一消费 ui.auxPaneStyle；内容逻辑住
// SystemPromptPanel——当选兜底请求覆盖 rail 直开场景）
// ============================================================
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import SystemPromptPanel from './SystemPromptPanel.vue';

const ui = useUiStore();
</script>

<template>
  <SystemPromptPanel :style="ui.auxPaneStyle" />
</template>
