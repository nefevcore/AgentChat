<script setup lang="ts">
// ============================================================
// client/FilePreviewPanelHost.vue —— aux 预览选区宿主
//（P1：多 tab 文件预览面板 = 辅助侧边栏第三选区 'preview'）
//
// 宽度绑线对齐 WorkspaceTreeHost（选区自带宽度样式——ui.auxWidth）；
// active() 谓词住行注册面（previewTabs.panelOpen 域内意愿——
// 壳零域知识）；keepAlive 语义：本宿主只渲染面板，卸载/让位由
// AuxSidebarHost 选举机制管（缺省 volatile——区域收起即卸载，
// tab 状态住 pinia store 不丢，重开恢复）。
// ============================================================
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import FilePreviewPanel from './FilePreviewPanel.vue';

const ui = useUiStore();
</script>

<template>
  <FilePreviewPanel
    :style="{ width: ui.auxWidth + 'px' }"
  />
</template>
