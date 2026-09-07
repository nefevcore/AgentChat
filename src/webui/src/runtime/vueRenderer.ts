// ============================================================
// webui/src/runtime/vueRenderer.ts —— Vue 渲染适配（M27 S0，D4）
//
// install(renderer) boot-once 契约的 Vue 实现（装配序列第②步）：
//   · render(key, data) —— 席位外部贡献直渲（不含宿主模板内容；
//     同轴合并与 single 回落由 SlotOutlet 承担，D16）；
//   · renderSlot(key, data) —— ctx 级渲染入口（§0.1 ⑥：app.mount 的
//     root 面 / 组件树内 props 传参 face）。
//
// 响应式不在本层：SlotOutlet 经版本计数 + 'slots/changed' 自建；
// render() 面向非 Outlet 场景（如 mount root），每次调用重取条目。
// ============================================================
import { h, type VNode } from 'vue';
import type { ClientContext, SlotRenderer } from 'ac-client-runtime';
import SlotOutlet from '../components/SlotOutlet.vue';
import { orderedExternal } from './slotRender';

export interface VueSlotRenderer extends SlotRenderer {
  readonly framework: 'vue';
  /** ctx 级渲染入口：返回 root 席位 vnode（mount 面用法见 runtime/slots-demo.ts） */
  renderSlot(key: string, data?: unknown): VNode;
}

export function createVueRenderer(_ctx: ClientContext): VueSlotRenderer {
  return {
    framework: 'vue',
    render(key: string, data?: unknown): VNode[] {
      // 直接渲染外部贡献；宿主模板内容/排序竞争归 Outlet（D16）
      const ctx = _ctx;
      return orderedExternal(ctx, key, data).map((x) => x.node);
    },
    renderSlot(key: string, data?: unknown): VNode {
      return h(SlotOutlet, { name: key, data });
    },
  };
}
