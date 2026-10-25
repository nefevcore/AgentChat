<script setup lang="ts">
// ============================================================
// client/AuxSidebarHost.vue —— aux-sidebar 区域宿主（2026-09-11 区域构造对齐·层级
// 修正：aux-sidebar 席位 = 辅助侧边栏（第四区域本身）——与 ActivityBarHost/
// MainViewHost 同构，壳的每个区域 = 一个席位，宿主只是解析渲染面）
//
// 会话区重构（二轮·辅助活动栏形态）：
//   · 区域 = [当选选区面板列][辅助活动栏列]（AuxActivityBar——右侧的
//     活动栏同构物：常规布局列、占位不覆盖、常驻可见；各选区 rail
//     资产同级按钮，点非当选区展开 / 当选且展开时二次点击收起）；
//   · 当选举区 = 显式选区（ui.auxPanel，辅助活动栏点击置位）优先、
//     active() 谓词回落（order 小者先）；activate = 域侧激活动作
//    （如 group 的 drawerOpen 置位）；
//   · 无当选选区且无 rail 按钮（行卸载）→ 区域整体消失（占用门控
//     内在于选举，壳不残废）；available 谓词不合格的选区不出现在
//     辅助活动栏。
//
// 生命周期：选区缺省 volatile（区域收起即卸载——树体轻无保活诉求；
// keepAlive 旗标留作未来重选区扩展位）。多根平铺（零包裹 D23-A）：
// ResizeHandle + 面板列 + 辅助活动栏列 = app-layout 行的三个 flex 子项。
//
// 窄屏形态（cr-30 Phase②）：右侧栏在手机上无立足之地，改**全屏 Sheet**
// 承载当选选区面板（webui-kit Sheet 原语——同一选区注册面零改动，只换
// 壳的排布）；辅助活动栏不渲染（入口归 MobileMoreSheet「面板」区，该区
// 列 auxSidebarRailDefs 全量），返回键/关闭钮收起。宽度由 ui.auxPaneStyle
// 单源给（窄屏 100%）——此前选区宿主自绑 ui.auxWidth 会在全屏里撑破。
// ============================================================
import { computed, inject, onBeforeUnmount, reactive, watchEffect } from 'vue';
import { useClientContext } from 'ac-client-runtime';
import { Sheet } from '@agentchat/webui-kit';
import ResizeHandle from './ResizeHandle.vue';
import AuxActivityBar from './AuxActivityBar.vue';
import { useUiStore } from './uiStore.ts';
import {
  electedAuxSidebarPanel, auxSidebarRailDefs, auxSidebarPanelDefs, auxSidebarPanelVersion, safeAuxSidebarPanelProps,
  type AuxSidebarPanelDef,
} from './auxSidebarViews.ts';

const ctx = useClientContext();
const ui = useUiStore();

/** 窄屏（单源 ui.narrow——响应式）*/ 
const isNarrow = computed(() => ui.narrow);
/** Sheet 标题（选区 rail 文案单源；无 rail 回落 id） */
const sheetTitle = computed(() => winner.value?.rail?.title ?? winner.value?.id ?? '');

// 返回键消费（cr-30）：窄屏全屏 Sheet 开着时消费返回（关 Sheet，不退后台；
// 未开 = 不消费，交壳判定 push 页/root 层）
const registerBack = inject<((fn: () => boolean) => () => void) | null>('registerBackConsumer', null);
let offBack: (() => void) | null = null;
if (registerBack) {
  offBack = registerBack(() => {
    if (isNarrow.value && ui.auxVisible) { ui.closeAux(); return true; }
    return false;
  });
}
onBeforeUnmount(() => offBack?.());

// ── 席位版本订阅（key 级细粒度失效轴——同 MainViewHost 机制）：
//    行装载/卸载 → 'slots/changed'(aux-sidebar) → 版本计数 → 当选举区重算 ──
const offSlot = ctx?.on('slots/changed', (key: string) => {
  if (key === 'aux-sidebar') auxSidebarPanelVersion.value++;
});
onBeforeUnmount(() => offSlot?.());

/** 当选举区（显式选区优先 + 谓词选举回落——active 抛错的缺陷 def 只失去资格） */
const winner = computed<AuxSidebarPanelDef | null>(() => electedAuxSidebarPanel(ui.auxPanel));

/** keepAlive 选区的「曾当选」账本（id 级单调；选区消失即随候选清单失效） */
const everWon = reactive(new Set<string>());
watchEffect(() => {
  const w = winner.value;
  if (w?.keepAlive) everWon.add(w.id);
});

/**
 * 渲染清单：keepAlive 选区曾当选即常驻（v-show——收起/让位仅隐藏）；
 * volatile 选区仅「区域展开 && 当选」期间挂载（收起即卸载）。
 */
const rendered = computed<Array<{ def: AuxSidebarPanelDef; visible: boolean }>>(() => {
  const w = winner.value;
  const expanded = !!w && ui.auxVisible;
  const out: Array<{ def: AuxSidebarPanelDef; visible: boolean }> = [];
  for (const def of auxSidebarPanelDefs()) {
    if (def.keepAlive) {
      if (everWon.has(def.id)) out.push({ def, visible: expanded && w.id === def.id });
    } else if (expanded && w.id === def.id) {
      out.push({ def, visible: true });
    }
  }
  return out;
});

/** 辅助活动栏按钮清单（带 rail 资产且 available——域态驱动可见性） */
const railDefs = computed<AuxSidebarPanelDef[]>(() => auxSidebarRailDefs());
/** 高亮 = 区域展开中的当选选区（收起态无高亮） */
const activeRailId = computed<string | null | undefined>(() => (ui.auxVisible ? winner.value?.id : null));

/** 辅助活动栏交互（活动栏同款）：点非当选区 = 域侧激活 + 显式置位 +
 *  按选区形态重整宽度 + 展开；点当选且展开 = 收起区域（选区记忆保留）。
 *  宽度重整（applyAuxPanelWidth）读 def.comfyWidth 单源声明——rail 直点
 *  与意图通道同一形态（无声明 = 窄面板 280；preview=half；usage=840），
 *  消除「上一选区铺开值被沿用」的串宽。 */
function togglePanel(def: AuxSidebarPanelDef) {
  if (ui.auxVisible && winner.value?.id === def.id) {
    ui.toggleAux(); // 二次点击收起
    return;
  }
  ui.openAuxPanel(def); // 域侧激活 + 显式置位 + 宽度重整 + 展开（语义单点）
}
</script>

<template>
  <!-- ── 窄屏（cr-30）：全屏 Sheet 形态 ──
       keepAlive：Sheet 隐藏不卸载——选区 keepAlive 语义（曾当选即常驻）
       在开关之间保持（定时任务等编辑中状态不丢）。 -->
  <Sheet
    v-if="isNarrow"
    :visible="!!winner && ui.auxVisible"
    :title="sheetTitle"
    full
    keep-alive
    :z-index="150"
    @close="ui.closeAux()"
  >
    <div v-for="r in rendered" :key="r.def.id" v-show="r.visible" class="aux-sheet-pane">
      <component :is="r.def.component" v-bind="safeAuxSidebarPanelProps(r.def)" />
    </div>
  </Sheet>

  <!-- ── 宽屏：原形态（分屏把手 + 面板列 + 辅助活动栏列）── -->
  <template v-else>
    <!-- 展开态：分屏把手 + 当当选区面板（多根平铺——选区自带宽度样式/关闭按钮） -->
    <template v-if="winner && ui.auxVisible">
      <ResizeHandle kind="aux" />
    </template>
    <div v-for="r in rendered" :key="r.def.id" v-show="r.visible" class="aux-pane">
      <component :is="r.def.component" v-bind="safeAuxSidebarPanelProps(r.def)" />
    </div>
    <!-- 辅助活动栏（app-layout 行最右列——常规布局列，零覆盖）：各选区
         同级按钮；点非当选区展开 / 当选且展开时二次点击收起 -->
    <AuxActivityBar
      v-if="railDefs.length > 0"
      :defs="railDefs"
      :active-id="activeRailId"
      @toggle="togglePanel"
    />
  </template>
</template>

<style scoped>
/* pane：选区统一布局层（flex 收敛——选区自带宽度样式） */
.aux-pane {
  display: flex; flex-shrink: 0; min-width: 0; height: 100%; overflow: hidden;
}

/* 窄屏全屏 Sheet 内的选区容器（宽高都由 Sheet 给满——选区面板自带滚动区） */
.aux-sheet-pane {
  display: flex; flex-direction: column;
  width: 100%; min-width: 0; height: 100%; overflow: hidden;
}
</style>
