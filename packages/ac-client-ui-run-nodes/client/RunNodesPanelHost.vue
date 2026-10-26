<script setup lang="ts">
// ============================================================
// client/RunNodesPanelHost.vue —— run-nodes aux 选区宿主
//（宽度绑线；内容 = RunNodesPanel——feed 驱动自动重算，无意图消费）
// ============================================================
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import RunNodesPanel from './RunNodesPanel.vue';

const ui = useUiStore();
</script>

<template>
  <RunNodesPanel :style="ui.auxPaneStyle" />
</template>
