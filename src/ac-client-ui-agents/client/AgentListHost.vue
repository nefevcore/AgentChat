<script setup lang="ts">
// ============================================================
// client/AgentListHost.vue —— agents 域面板宿主（list-panel:domain
// 选举席贡献；M28 P2：原 sidebar ListPanelsHost 内联面板迁入——
// 绑线经 ctx.groups 服务面直连，DOM 结构不变〔D23-A〕）
// ============================================================
import { computed } from 'vue';
import AgentList from './AgentList.vue';
import { useClientContext } from 'ac-client-runtime';

const groupSvc = useClientContext()?.groups;
const groups = computed(() => groupSvc?.groups.value ?? []);
const activeGroupId = computed(() => groupSvc?.activeGroupId.value ?? '');
</script>

<template>
  <AgentList
    :groups="groups"
    :active-group-id="activeGroupId"
    @select-group="(id: string) => groupSvc?.selectGroup(id)"
    @deselect-group="() => groupSvc?.deselectGroup()"
    @create-group="() => groupSvc?.openCreateGroup()"
  />
</template>
