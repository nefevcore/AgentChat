<script setup lang="ts">
// ============================================================
// client/ListPanelsHost.vue —— sidebar 基础件的三面板壳
//（M27.2-2 面板壳收尾 → M28 P2 退化终态：零内联面板）
//
// 三面板全部 = 域行 list-panel:domain 选举席贡献：agents ← ui-agents、
// sessions ← ui-singles、tracking ← ui-runview（M28 P1-3/P2）。壳职责：
// 按 ui.listPanel 匹配贡献 meta.panel 选举渲染 + 域数据链启动
//（groupSvc.init / singles 刷新恢复——P3 stores 退役时随行收口）。
// DOM 结构不变〔D23-A〕；无匹配贡献 = 空面板区（行卸载即面板消失）。
// ============================================================
import { computed, onMounted, ref, onBeforeUnmount } from 'vue';
import { useClientContext } from 'ac-client-runtime';
import type { SlotEntry } from 'ac-client-slots';
import { useUiStore } from './uiStore.ts';

const ui = useUiStore();
const clientCtx = useClientContext();

// group 域投影（数据链启动：init 幂等——帧订阅随 group 域 fiber）
const groupSvc = clientCtx?.groups;

// singles 域投影（刷新恢复链：上次在独立会话 → 拉完列表后恢复选中）
const singlesBoard = clientCtx?.singleBoard;

// ── list-panel:domain 选举席（P0-3/P2）：贡献携带 meta.panel = 面板
//    id，壳按 ui.listPanel 选举。响应式 = 席位版本计数轴（D14）。 ──
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
  <!-- 域贡献面板（meta.panel 选举——agents=ui-agents / sessions=ui-singles /
       tracking=ui-runview；无匹配贡献 = 空面板区） -->
  <component
    :is="domainPanel?.component"
    v-if="domainPanel"
    :class="{ 'sidebar-mobile-visible': ui.sidebarVisible }"
  />
</template>
