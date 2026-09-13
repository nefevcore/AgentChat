<script setup lang="ts">
// ============================================================
// client/TokenUsagePanelHost.vue —— usage 域 aux 选区宿主
//（P2：Token 用量 = 辅助侧边栏选区之一——panel 形态上下布局，
//  图表常驻可监视；与 modal 形态（窄屏/活动栏 fallback）共用
//  TokenUsage 组件与全部数据逻辑）
//
// active() 谓词住行注册面（usageOpen 意图——见 index.ts 意图通道）；
// keepAlive 语义：选区让位不卸载（图表/筛选状态保留），由
// AuxSidebarHost 的 keepAlive 旗标管；本宿主只做宽度绑线。
// ============================================================
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import TokenUsage from './TokenUsage.vue';

const ui = useUiStore();
</script>

<template>
  <TokenUsage
    :style="{ width: ui.auxWidth + 'px' }"
    variant="panel"
    :visible="true"
  />
</template>
