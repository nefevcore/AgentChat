<script setup lang="ts">
// ============================================================
// clients/base/SidebarHost.vue —— sidebar 基础件的 sidebar 席位宿主
//（M27.2-1：原 AppFrame 模板内联 SlotOutletItem 内容迁入——绑线
//  经 ui store 直连，DOM 结构不变〔D23-A 零包裹纪律〕）
// ============================================================
import Sidebar from '../../components/Sidebar.vue';
import { useUiStore } from '../../stores/ui';
import { VIEWER_ID } from '../../constants';

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
