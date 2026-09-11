<script setup lang="ts">
// ============================================================
// client/TokenUsageHost.vue —— usage 域 overlay 席位宿主
//（M28 P1：原 layout AppFrame 内联 SlotOutletItem 内容迁入——
// 绑线经 ui store 直连，DOM 结构不变〔D23-A 零包裹纪律〕）
// ============================================================
import TokenUsage from './TokenUsage.vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

const ui = useUiStore();
</script>

<template>
  <!-- Token 用量面板 -->
  <TokenUsage :visible="ui.tokenUsageVisible" @close="ui.closeTokenUsage" />
</template>
