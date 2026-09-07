<script setup lang="ts">
// ============================================================
// ac-client-ui-sidebar/client/SidebarHost.vue —— sidebar 基础件的
// sidebar 席位宿主（M27.2-1 自 AppFrame 内联迁入；M27.2-2 随件出包）
// 绑线经 ui store 直连（pinia——本包 owning，D10），DOM 结构不变
// 〔D23-A 零包裹纪律〕；viewer 端点 id 本地常量（同 webui
// constants VIEWER_ID 值）。
// ============================================================
import Sidebar from './Sidebar.vue';
import { useUiStore } from './uiStore.ts';

const VIEWER_ID = 'user';

const ui = useUiStore();
</script>

<template>
  <Sidebar
    :list-visible="ui.listVisible"
    :list-panel="ui.listPanel"
    @open-list-panel="ui.openListPanel"
    @open-global-settings="ui.openGlobalSettings"
    @open-agent-settings="ui.openAgentSettings(VIEWER_ID)"
    @open-token-usage="ui.openTokenUsage"
    @show-version="ui.openVersion"
  />
</template>
