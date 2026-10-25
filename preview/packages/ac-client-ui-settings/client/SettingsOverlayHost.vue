<script setup lang="ts">
// ============================================================
// clients/base/SettingsOverlayHost.vue —— settings 基础件的 overlay
// 席位宿主（M27.2-1：原 AppFrame 内联 SlotOutletItem 内容迁入——
// 绑线经 ui store 直连，DOM 结构不变〔D23-A 零包裹纪律〕）
// ============================================================
import SettingsPanel from './components/SettingsPanel.vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

const ui = useUiStore();
</script>

<template>
  <!-- 全局配置面板（含 Agent 设置） -->
  <SettingsPanel
    :visible="ui.globalSettingsVisible"
    :initial-agent-id="ui.settingsAgentTarget"
    :initial-section="ui.settingsSectionTarget"
    @close="ui.closeSettings"
  />
</template>
