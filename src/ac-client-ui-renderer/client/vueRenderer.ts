// ============================================================
// ac-client-ui-renderer/client/vueRenderer.ts —— Vue 渲染适配
//（M27 S0/S1 D4；M27.2-2 随 renderer 件迁入本包）
//
// install(renderer) boot-once 契约的 Vue 实现（装配序列 base 批次）：
//   · render(key, data) —— 席位外部贡献直渲（不含宿主模板内容；
//     同轴合并与 single 回落由 SlotOutlet 承担，D16）；
//   · renderSlot(key, data) —— ctx 级渲染入口（§0.1 ⑥：app.mount 的
//     root 面 / 组件树内 props 传参 face）。
//
// root 空态可诊断（S1 验收）：root 席位无贡献（layout 基础件未装载/
// 已卸载）→ DEV 返回诊断横幅（生产 = 空渲染，宿主不残废）。
//
// 响应式不在本层：SlotOutlet 经版本计数 + 'slots/changed' 自建；
// render() 面向非 Outlet 场景（如 mount root），每次调用重取条目。
// ============================================================
import { h, defineComponent, type VNode } from 'vue';
import type { ClientContext, SlotRenderer } from 'ac-client-runtime';
import SlotOutlet from './SlotOutlet.vue';
import { orderedExternal } from './slotRender';

export interface VueSlotRenderer extends SlotRenderer {
  readonly framework: 'vue';
  /** ctx 级渲染入口：返回席位 vnode（mount 面用法见 main.ts 装配序列） */
  renderSlot(key: string, data?: unknown): VNode;
}

/** root 空态诊断横幅（DEV；S1 验收「卸载 layout 件 → root 空且有可诊断报错」） */
const RootEmptyDiagnostic = defineComponent({
  name: 'AcSlotRootEmptyDiagnostic',
  setup() {
    return () =>
      h('div', {
        style: {
          position: 'fixed', inset: '0', padding: '32px', fontFamily: 'monospace',
          fontSize: '14px', lineHeight: '1.7', color: '#b91c1c', background: '#fef2f2',
          whiteSpace: 'pre-wrap', zIndex: '9999',
        },
      }, [
        '[slots] root 席位为空：layout 基础件未装载或已卸载（M27 D3/S1 验收）。\n',
        '宿主不残废——装配序列第③步 await ctx.plugin(layoutBasePlugin) 后 root 出厂占据；\n',
        '本诊断仅 DEV 出现（生产为空渲染）。经 ctx.slots.snapshot() 查看声明账本。',
      ]);
  },
});

export function createVueRenderer(ctx: ClientContext): VueSlotRenderer {
  // vite DEV 旗标（根 tsc 无 vite/client 类型——结构性取值，两 tsconfig 通用）
  const DEV = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV ?? false;
  return {
    framework: 'vue',
    render(key: string, data?: unknown): VNode[] {
      // 直接渲染外部贡献；宿主模板内容/排序竞争归 Outlet（D16）
      return orderedExternal(ctx, key, data).map((x) => x.node);
    },
    renderSlot(key: string, data?: unknown): VNode {
      // root 空态可诊断（仅 DEV；其余席位空 = 正常空渲染）
      if (DEV && key === 'root' && ctx.slots.entries('root').length === 0) {
        return h(RootEmptyDiagnostic);
      }
      return h(SlotOutlet, { name: key, data });
    },
  };
}
