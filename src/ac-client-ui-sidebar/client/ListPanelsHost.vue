<script setup lang="ts">
// ============================================================
// client/ListPanelsHost.vue —— sidebar 基础件的三面板壳（M27.2-2 面板壳
// 收尾自 webui clients/base/ 迁入——shim 退役；M28 P1-3 面板贡献化）
//
// agents/sessions 两面板暂内联（P2 sidebar 退化时随域行走）；tracking
// 面板 = ui-runview 行经 list-panel 席位贡献——壳按 ui.listPanel 三选一
// 选举（选举谓词随贡献 meta.panel，P0-3 机制首例）。域件未装载 →
// undefined → 对应消费面消失（可摘除性 D19）。DOM 结构不变〔D23-A〕。
// ============================================================
import { computed, onMounted, ref, onBeforeUnmount } from 'vue';
import { useClientContext } from 'ac-client-runtime';
import type { SlotEntry } from 'ac-client-slots';
import { useUiStore } from './uiStore.ts';
import AgentList from './AgentList.vue';
import SessionList from './SessionList.vue';

const ui = useUiStore();
const clientCtx = useClientContext();

// group 域投影（跨域消费走客户端服务面 ctx.groups）
const groupSvc = clientCtx?.groups;
const groups = computed(() => groupSvc?.groups.value ?? []);
const activeGroupId = computed(() => groupSvc?.activeGroupId.value ?? '');

// singles 域投影（刷新恢复链随三面板壳走——sessions 面板消费方）
const singlesBoard = clientCtx?.singleBoard;

function selectGroup(id: string) { groupSvc?.selectGroup(id); }
function deselectGroup() { groupSvc?.deselectGroup(); }

// ── 域面板选举席（P0-3）：域行面板贡献登记在 list-panel:domain 选举席
//    （非外层 list-panel outlet——防与壳叠加渲染），壳按 ui.listPanel
//    匹配贡献 meta.panel 键（agents/sessions 内联在先，域贡献面追踪
//    面板等后续行）。响应式 = 席位版本计数轴（D14）。 ──
const panelVersion = ref(clientCtx?.slots.version('list-panel:domain') ?? 0);
const offPanelSlot = clientCtx?.on('slots/changed', (key: string) => {
  if (key === 'list-panel:domain') panelVersion.value++;
});
onBeforeUnmount(() => offPanelSlot?.());
const domainPanel = computed<SlotEntry | null>(() => {
  void panelVersion.value; // 依赖锚
  const entries = clientCtx?.slots.entries('list-panel:domain') ?? [];
  return entries.find((e) => e.meta?.panel === ui.listPanel) ?? null;
});

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
  <!-- 域贡献面板（meta.panel 选举——tracking = ui-runview 行；无匹配贡献 = 空面板区） -->
  <component
    :is="domainPanel?.component"
    v-else-if="domainPanel"
    :class="{ 'sidebar-mobile-visible': ui.sidebarVisible }"
  />
</template>
