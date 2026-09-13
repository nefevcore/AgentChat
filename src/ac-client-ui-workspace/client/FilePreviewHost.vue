<script setup lang="ts">
// ============================================================
// client/FilePreviewHost.vue —— workspace 域 overlay 席位宿主
//（P1 aux 预览选区：桌面 = aux 多 tab 面板，窄屏 = 原 Modal 全屏形态）
//
// 形态分派（ui.openPreview 写通用 auxIntent——layout 壳零域依赖）：
//   · 宽屏（>768）：消费意图 → previewTabs.openTab + 显式选区 'preview'
//     + 舒适宽（半屏）+ 展开 aux；
//   · 窄屏（≤768）：维持原 Modal 直开（previewVisible 全屏）。
// 本组件常驻 overlay 席位（零渲染输出——只做意图分派）；
// aux 面板组件经 FilePreviewPanelHost 注册到 aux-sidebar 席位。
// ============================================================
import { watch } from 'vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { usePreviewTabsStore } from './previewTabs.ts';
import FilePreviewModal from './FilePreviewModal.vue';

const ui = useUiStore();
const tabs = usePreviewTabsStore();

// ── 桌面意图消费：通用 auxIntent（panel='preview' 帧）→ 开 tab + 切选区 + 展开 ──
watch(() => ui.auxIntent, (seq) => {
  if (!seq || ui.auxIntentPanel !== 'preview') return;
  const path = ui.previewFilePath;
  if (!path) return;
  tabs.openTab(path, { agentId: ui.previewIntentFallback, conversationId: ui.previewIntentConversationId });
  ui.selectAuxPanel('preview'); // 显式选区置位（panelOpen 已随 openTab 置真）
  ui.applyAuxPanelWidth('preview'); // 按选区形态重整（def.comfyWidth 单源）
  ui.openAux(); // 展开区域（收起态点树/消息文件 → 面板弹出）
});
</script>

<template>
  <!-- 窄屏（≤768）：Modal 全屏形态（visible 分派在 uiStore——openPreview
       按 isNarrow 写 previewVisible 或 auxIntent） -->
  <FilePreviewModal
    :visible="ui.previewVisible"
    :file-path="ui.previewFilePath"
    :fallback-agent-id="ui.previewFallbackAgentId"
    :conversation-id="ui.previewConversationId"
    @close="ui.closePreview"
  />
</template>
