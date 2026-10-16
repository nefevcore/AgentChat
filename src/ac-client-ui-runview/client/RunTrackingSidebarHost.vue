<script setup lang="ts">
// ============================================================
// client/RunTrackingSidebarHost.vue —— tracking aux 选区宿主
//（A5：运行跟踪自主侧边栏第三面板迁辅助侧边栏——主侧边栏回归
//  纯导航〔agents/sessions〕，监视类全归右栏；RunTrackingPanel
//  组件原样复用——数据/轮询/入口行为不变，仅席位迁移）。
//
// 入口即壳层 aux rail 按钮直点（openAuxPanel 语义单点），无需意图
// 通道消费；宿主职责 = 宽度绑线（auxPaneStyle 单源）。
// ============================================================
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import RunTrackingPanel from './RunTrackingPanel.vue';

const ui = useUiStore();
</script>

<template>
  <RunTrackingPanel :style="ui.auxPaneStyle" />
</template>
