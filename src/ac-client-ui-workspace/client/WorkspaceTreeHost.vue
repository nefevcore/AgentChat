<script setup lang="ts">
// ============================================================
// client/WorkspaceTreeHost.vue —— workspace 域 main:workspace 席位
// 宿主（M28 P1：原 layout AppFrame 内联视图迁入——宽度/预览/关闭
// 绑线经 ui store 直连，DOM 结构不变〔D23-A 零包裹纪律〕）
// ============================================================
import WorkspaceTree from './WorkspaceTree.vue';
import { useUiStore } from 'ac-client-ui-sidebar/client/uiStore.ts';

const ui = useUiStore();
</script>

<template>
  <WorkspaceTree
    :style="{ width: ui.workspaceWidth + 'px' }"
    @preview-file="ui.openPreview"
    @close="ui.workspaceVisible = false"
  />
</template>
