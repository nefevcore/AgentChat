<script setup lang="ts">
// ============================================================
// client/MainViewHost.vue —— 主区视图选举宿主（2026-11 主区语义纯化）
//
// main 席位 = keyed 选举席（多选一）：会话（视角容器 PerspectiveHost）/
// 运行矩阵（RunTracking）/未来其他主区视图同轴竞争——active 谓词 ×
// order 选举（解析面 mainViews.ts；安全求值纪律同 perspectives）。
// 壳（AppFrame）零域知识：让位协议全部住各条目 active()（owning 行）。
//
// 生命周期策略（per-entry keepAlive 旗标——「多选一」下的保活裁决）：
//   · keepAlive 条目：曾赢得选举即常驻 v-show（文档流保活——DOM 常驻
//     则 scrollTop 天然保留、流式帧持续上屏（回来即最新帧）、切换零
//     重挂载；chat 出厂 keepAlive=true：会话视图局部态〔输入草稿/
//     滚动跟随壳/工具卡展开/弹层开合〕不因主区视图切换丢失。备选均逊：
//     KeepAlive 不可包〔多根零包裹 D23-A；实例缓存摘 DOM 会重置滚动〕；
//     「状态全上提 store + v-if」违背瞬态视图态留视图）；
//   · volatile 条目（缺省）：仅赢得选举期间挂载（v-if——离开即卸载，
//     后台零轮询；运行矩阵缺省 volatile：runs 轮询随卸载停）。
//
// 席位占用门控内在于选举：条目缺席（行卸载）→ 非候选 → 兜底 chat 直显
//（壳不残废——原 useSeatOccupancy('main:tracking') 手码门控退役）。
// pane = 宿主自有布局层（flex 填充——继承原 chat-area 样式职责）。
// ============================================================
import { computed, onBeforeUnmount, reactive, watchEffect } from 'vue';
import { useClientContext } from 'ac-client-runtime';
import { activeMainView, mainViewDefs, mainViewVersion, safeMainViewProps, type MainViewDef } from './mainViews.ts';

const ctx = useClientContext();

// ── 席位版本订阅（key 级细粒度失效轴）：
//    行装载/卸载 → 'slots/changed'(main) → 版本计数 → 候选/赢家重算 ──
const offSlot = ctx?.on('slots/changed', (key: string) => {
  if (key === 'main') mainViewVersion.value++;
});
onBeforeUnmount(() => offSlot?.());

/** 候选清单（order 升序——选举轴） */
const entries = computed<MainViewDef[]>(() => mainViewDefs());

/** 当前赢家（第一个 active 候选——active 抛错的缺陷 def 只失去资格；
 *  安全求值并源 activeMainView〔测试同消费〕） */
const winner = computed<MainViewDef | null>(() => activeMainView());

/** keepAlive 条目的「曾赢得选举」账本（id 级单调；条目消失即随候选清单失效） */
const everWon = reactive(new Set<string>());
watchEffect(() => {
  const w = winner.value;
  if (w?.keepAlive) everWon.add(w.id);
});

/**
 * 渲染清单：keepAlive 条目曾当选即常驻（visible = 是否当前赢家——输家
 * v-show 隐藏）；volatile 条目仅当选期间入列（离列即卸载）。
 */
const rendered = computed<Array<{ def: MainViewDef; visible: boolean }>>(() => {
  const w = winner.value;
  const out: Array<{ def: MainViewDef; visible: boolean }> = [];
  for (const def of entries.value) {
    if (def.keepAlive) {
      if (everWon.has(def.id)) out.push({ def, visible: w?.id === def.id });
    } else if (w?.id === def.id) {
      out.push({ def, visible: true });
    }
  }
  return out;
});
</script>

<template>
  <!-- 多根平铺（零包裹纪律 D23-A）：每个当选过/正当选的主区视图一个 pane -->
  <div
    v-for="r in rendered"
    :key="r.def.id"
    v-show="r.visible"
    class="main-view-pane"
  >
    <component :is="r.def.component" v-bind="safeMainViewProps(r.def)" />
  </div>
</template>

<style scoped>
/* pane：主区视图统一布局层（原 chat-area 样式职责——flex 填充 + 溢出收敛） */
.main-view-pane {
  flex: 1; display: flex; min-width: 0; overflow: hidden; height: 100%;
}
</style>
