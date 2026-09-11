<script setup lang="ts">
// ============================================================
// client/WorkspaceTreeHost.vue —— workspace 域 aside 席位选区宿主
//（aside = 第四层右侧区域——2026-11 构造对齐·层级修正；M28 P1：
// 原 layout AppFrame 内联视图迁入——宽度/预览/关闭绑线经 ui store
// 直连，DOM 结构不变〔D23-A 零包裹纪律〕）
// ============================================================
import WorkspaceTree from './WorkspaceTree.vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

const ui = useUiStore();
</script>

<template>
  <WorkspaceTree
    :style="{ width: ui.auxWidth + 'px' }"
    @preview-file="ui.openPreview"
    @close="ui.auxVisible = false"
  />
</template>
