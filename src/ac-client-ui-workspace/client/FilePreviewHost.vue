<script setup lang="ts">
// ============================================================
// client/FilePreviewHost.vue —— workspace 域 overlay 席位宿主
//（M28 P1：原 layout AppFrame 内联 SlotOutletItem 内容迁入——
// 绑线经 ui store 直连，DOM 结构不变〔D23-A 零包裹纪律〕）
// ============================================================
import FilePreviewModal from './FilePreviewModal.vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

const ui = useUiStore();
</script>

<template>
  <!-- 工作区文件预览弹窗（全局单例） -->
  <FilePreviewModal
    :visible="ui.previewVisible"
    :file-path="ui.previewFilePath"
    :fallback-agent-id="ui.previewFallbackAgentId"
    @close="ui.closePreview"
  />
</template>
