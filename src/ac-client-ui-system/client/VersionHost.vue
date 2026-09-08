<script setup lang="ts">
// ============================================================
// client/VersionHost.vue —— system 域 overlay 席位宿主
//（M28 P1：原 layout AppFrame 内联 SlotOutletItem 内容迁入——
// 绑线经 ui store 直连，DOM 结构不变〔D23-A 零包裹纪律〕）
// ============================================================
import VersionDialog from './VersionDialog.vue';
import { useUiStore } from 'ac-client-ui-sidebar/client/uiStore.ts';

const ui = useUiStore();
</script>

<template>
  <!-- 版本信息弹窗 -->
  <VersionDialog :visible="ui.versionVisible" @close="ui.closeVersion" />
</template>
