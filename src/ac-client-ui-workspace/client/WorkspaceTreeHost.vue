<script setup lang="ts">
// ============================================================
// client/WorkspaceTreeHost.vue —— workspace 域 aside 席位选区宿主
//（aside = 第四层右侧区域——2026-11 构造对齐·层级修正；M28 P1：
// 原 layout AppFrame 内联视图迁入——宽度/预览/关闭绑线经 ui store
// 直连，DOM 结构不变〔D23-A 零包裹纪律〕）
// M33：previewFile 携带树基准上下文（agentId/conversationId）——
// 树随会话定位后点击路径相对基准，预览读面同基准推导。
// ============================================================
import WorkspaceTree from './WorkspaceTree.vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

const ui = useUiStore();

function onPreviewFile(path: string, agentId: string, conversationId: string) {
  ui.openPreview(path, agentId, conversationId);
}
</script>

<template>
  <WorkspaceTree
    :style="{ width: ui.auxWidth + 'px' }"
    @preview-file="onPreviewFile"
    @close="ui.auxVisible = false"
  />
</template>
