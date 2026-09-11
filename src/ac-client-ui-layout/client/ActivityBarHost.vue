<script setup lang="ts">
// ============================================================
// client/ActivityBarHost.vue —— activity-bar 席位宿主
//（2026-11 命名对齐区域席；随 ac-client-ui-sidebar 行归并壳件迁入，
// 前身 SidebarHost 自 AppFrame 内联迁出〔M27.2-1〕后随件出包）
// 绑线经 ui store 直连（pinia——本包 owning，D10），DOM 结构不变
// 〔D23-A 零包裹纪律〕；viewer 端点 id 单源住 ac-client-runtime
//（M29 P1-1 收敛）。
// ============================================================
import ActivityBar from './ActivityBar.vue';
import { useUiStore } from './uiStore.ts';
import { VIEWER_ID } from 'ac-client-runtime';

const ui = useUiStore();
</script>

<template>
  <ActivityBar
    :primary-visible="ui.primaryVisible"
    :primary-panel="ui.primaryPanel"
    @open-primary-panel="ui.openPrimaryPanel"
    @open-global-settings="ui.openGlobalSettings"
    @open-agent-settings="ui.openAgentSettings(VIEWER_ID)"
    @open-token-usage="ui.openTokenUsage"
    @show-version="ui.openVersion"
  />
</template>
