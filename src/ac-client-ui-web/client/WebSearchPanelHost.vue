<script setup lang="ts">
// ============================================================
// client/WebSearchPanelHost.vue —— aux 搜索选区宿主
//（宽度绑线对齐 FilePreviewPanelHost——选区自带宽度样式 ui.auxWidth；
//  active() 谓词住行注册面〔searchTabs.panelOpen 域内意愿〕，壳零域
//  知识；本宿主只渲染面板，卸载/让位由 AuxSidebarHost 选举机制管
//  ——缺省 volatile，区域收起即卸载，tab 状态住 pinia store 不丢，
//  重开恢复〔同 preview 选区姿势〕）
// ============================================================
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import WebSearchPanel from './WebSearchPanel.vue';

const ui = useUiStore();
</script>

<template>
  <WebSearchPanel :style="{ width: ui.auxWidth + 'px' }" />
</template>
