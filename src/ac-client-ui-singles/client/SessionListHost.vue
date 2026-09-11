<script setup lang="ts">
// ============================================================
// client/SessionListHost.vue —— singles 域面板宿主（primary-sidebar:domain
// 选举席贡献；M28 P2：原 sidebar ListPanelsHost 内联面板迁入——
// 群选中清除经 ctx.groups 服务面直连）
// ============================================================
import SessionList from './SessionList.vue';
import { useClientContext } from 'ac-client-runtime';

const groupSvc = useClientContext()?.groups;
</script>

<template>
  <SessionList @deselect-group="() => groupSvc?.deselectGroup()" />
</template>
