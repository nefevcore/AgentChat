<script setup lang="ts">
// ============================================================
// client/ListPanelsHost.vue —— sidebar 基础件的三面板壳（M27.2-2 面板壳收尾自 webui clients/base/ 迁入——shim 退役）
//（M27.2-1：原 AppFrame list-panel 席位内联内容迁入——agents/sessions/
//  tracking 三选一；group/singles 域投影经客户端服务面消费（域件
//  未装载 → undefined → 对应消费面消失，可摘除性 D19）。DOM 结构
//  不变〔D23-A〕）
// ============================================================
import { computed, onMounted } from 'vue';
import { useClientContext } from 'ac-client-runtime';
import { useUiStore } from './uiStore.ts';
import AgentList from './AgentList.vue';
import SessionList from './SessionList.vue';
import RunTrackingPanel from './RunTrackingPanel.vue';

const ui = useUiStore();

// group 域投影（跨域消费走客户端服务面 ctx.groups）
const groupSvc = useClientContext()?.groups;
const groups = computed(() => groupSvc?.groups.value ?? []);
const activeGroupId = computed(() => groupSvc?.activeGroupId.value ?? '');

// singles 域投影（刷新恢复链随三面板壳走——sessions 面板消费方）
const singlesBoard = useClientContext()?.singleBoard;

function selectGroup(id: string) { groupSvc?.selectGroup(id); }
function deselectGroup() { groupSvc?.deselectGroup(); }

onMounted(() => {
  groupSvc?.init(); // group 域件未装载 → 跳过（群消费面消失，可摘除性）
  // 刷新恢复：上次在独立会话 → 拉完列表后恢复选中（历史由 DialogView 的 single watch 加载）
  void singlesBoard?.refresh().then(() => { singlesBoard?.restoreLastSingle(); });
});
</script>

<template>
  <AgentList
    v-if="ui.listPanel === 'agents'"
    :class="{ 'sidebar-mobile-visible': ui.sidebarVisible }"
    :groups="groups"
    :active-group-id="activeGroupId"
    @select-group="selectGroup"
    @deselect-group="deselectGroup"
    @create-group="groupSvc?.openCreateGroup"
  />
  <SessionList
    v-else-if="ui.listPanel === 'sessions'"
    :class="{ 'sidebar-mobile-visible': ui.sidebarVisible }"
    @deselect-group="deselectGroup"
  />
  <RunTrackingPanel v-else :class="{ 'sidebar-mobile-visible': ui.sidebarVisible }" />
</template>
