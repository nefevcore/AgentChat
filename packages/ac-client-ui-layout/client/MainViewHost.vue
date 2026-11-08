<script lang="ts">
// ============================================================
// client/MainViewHost.vue —— 主区视图选举宿主（2026-09-11 主区语义纯化）
//
// main 席位 = keyed 选举席（多选一）：会话（视角容器 PerspectiveHost）/
// 运行矩阵（RunTracking）/未来其他主区视图同轴竞争——active 谓词 ×
// order 选举（解析面 mainViews.ts；安全求值纪律同 perspectives）。
// 壳（AppFrame）零域知识：让位协议全部住各条目 active()（owning 行）。
//
// 渲染经 entryVNode（crash-hardening）：当选视图组件带条目级崩溃边界
// + 退位身份——视图崩溃 = 退位该条目 + 重选举次位（chat 兜底），不再
// 上抛击穿壳（DSH guarded() 对位物）。全候选退位（cell dry）= 出口
// 崩溃面（deadCellFace——不再空白）。渲染函数组件：候选 vnode 在
// computed 内构建，模板无法直接消费预构建 vnode。
//
// 生命周期策略（per-entry keepAlive 旗标——「多选一」下的保活裁决）：
//   · keepAlive 条目：曾赢得选举即常驻 v-show（文档流保活——DOM 常驻
//     则 scrollTop 天然保留、流式帧持续上屏（回来即最新帧）、切换零
//     重挂载；chat 出厂 keepAlive=true：会话视图局部态〔输入草稿/
//     滚动跟随壳/工具卡展开/弹层开合〕不因主区视图切换丢失。
//   · volatile 条目（缺省）：仅赢得选举期间挂载（v-if——离开即卸载，
//     后台零轮询；运行矩阵缺省 volatile：runs 轮询随卸载停）。
//
// 席位占用门控内在于选举：条目缺席（行卸载）→ 非候选 → 兜底 chat 直显
//（壳不残废）。pane = 宿主自有布局层（flex 填充——继承原 chat-area 样式职责）。
// ============================================================
import { computed, defineComponent, h, onBeforeUnmount, reactive, watchEffect, type VNode } from 'vue';
import { useClientContext } from 'ac-client-runtime';
import { entryVNode, deadCellFace } from 'ac-client-ui-renderer/client';
import {
  activeMainView, mainViewEntries, mainViewVersion, safeMainViewProps,
  type MainViewCandidate, type MainViewDef,
} from './mainViews.ts';

export default defineComponent({
  name: 'MainViewHost',
  setup() {
    const ctx = useClientContext();

    // ── 席位版本订阅（key 级细粒度失效轴）：
    //    行装载/卸载/退位 → 'slots/changed'(main) → 版本计数 → 候选/赢家重算 ──
    const offSlot = ctx?.on('slots/changed', (key: string) => {
      if (key === 'main') mainViewVersion.value++;
    });
    onBeforeUnmount(() => offSlot?.());

    /** 候选清单（order 升序——选举轴；def + 来源条目，见 mainViews.ts） */
    const entries = computed<MainViewCandidate[]>(() => mainViewEntries());

    /** 当前赢家（第一个 active 候选——active 抛错的缺陷 def 只失去资格；
     *  安全求值并源 activeMainView〔测试同消费〕） */
    const winner = computed<MainViewDef | null>(() => activeMainView());

    /** keepAlive 条目的「曾赢得选举」账本（id 级单调；条目消失即随候选清单失效） */
    const everWon = reactive(new Set<string>());
    watchEffect(() => {
      const w = winner.value;
      if (w?.keepAlive) everWon.add(w.id);
    });

    /** 渲染清单：keepAlive 条目曾当选即常驻（visible = 是否当前赢家——输家
     *  v-show 隐藏）；volatile 条目仅当选期间入列（离列即卸载）。每项经
     *  entryVNode = 条目崩溃边界 + fiber 对齐包裹（crash-hardening）。 */
    const rendered = computed<Array<{ id: string; visible: boolean; node: VNode }>>(() => {
      const w = winner.value;
      const out: Array<{ id: string; visible: boolean; node: VNode }> = [];
      for (const cand of entries.value) {
        const { def } = cand;
        if (def.keepAlive) {
          if (!everWon.has(def.id)) continue;
        } else if (w?.id !== def.id) {
          continue;
        }
        out.push({
          id: def.id,
          visible: w?.id === def.id,
          node: entryVNode(ctx, 'main', cand.entry, safeMainViewProps(def), def.component),
        });
      }
      return out;
    });

    /** dead cell（三态契约）：全部候选退位 → 出口崩溃面（不再空白） */
    const dead = computed(() => {
      void mainViewVersion.value;
      return entries.value.length === 0 && (ctx?.slots.abdicatedOf('main').length ?? 0) > 0;
    });

    return () => [
      // 多根平铺（零包裹纪律 D23-A）：每个当选过/正当选的主区视图一个 pane
      ...rendered.value.map((r) =>
        h('div', { key: r.id, class: 'main-view-pane', style: { display: r.visible ? undefined : 'none' } }, [r.node]),
      ),
      dead.value ? deadCellFace('main', ctx?.slots.lastErrorOf('main')) : null,
    ];
  },
});
</script>

<style scoped>
/* pane：主区视图统一布局层（原 chat-area 样式职责——flex 填充 + 溢出收敛） */
.main-view-pane {
  flex: 1; display: flex; min-width: 0; overflow: hidden; height: 100%;
}
</style>
