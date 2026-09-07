// ============================================================
// webui/src/runtime/slotRender.ts —— slot 条目 → VNode 的共享渲染面（M27 S0）
//
// SlotOutlet 与 vueRenderer 共用：贡献组件经 ownerOf 取注册方 ctx
// 包 wrapComponent（D17：Vue 树与 fiber 树对齐），props/data 按
// D16-③ 透传（data = owner 上下文；条目 props 优先于 data 同名键）。
// 零包裹纪律（D23-A）：h 直接落在贡献组件上，不加任何包装节点。
// ============================================================
import { h, type Component, type VNode } from 'vue';
import { wrapComponent, type ClientContext } from 'ac-client-runtime';
import type { SlotEntry } from 'ac-client-slots';
import { DEFAULT_SLOT_ORDER } from 'ac-client-slots';

/** (entry → wrapped 组件) 缓存：避免每次渲染重建包裹层 */
const wrapCache = new WeakMap<object, Component>();

/** 单条贡献 → VNode（隔离 ctx 包裹 + key 稳定 + props/data 透传） */
export function entryVNode(ctx: ClientContext | undefined, entry: SlotEntry, data: unknown): VNode {
  let component = entry.component as Component;
  const owner = ctx?.slots.ownerOf(entry);
  if (owner) {
    let wrapped = wrapCache.get(entry);
    if (!wrapped) {
      wrapped = wrapComponent(component, owner as ClientContext);
      wrapCache.set(entry, wrapped);
    }
    component = wrapped;
  }
  const extra =
    typeof entry.props === 'function' ? (entry.props as (d: unknown) => Record<string, unknown>)(data) : entry.props;
  return h(component, { key: entry.id, data, ...(extra ?? {}) });
}

/** 一个席位的外部贡献（含解析后的 order；宿主模板内容由 Outlet 侧合并） */
export function orderedExternal(
  ctx: ClientContext | undefined,
  key: string,
  data: unknown,
): { order: number; node: VNode }[] {
  if (!ctx) return [];
  return ctx.slots.entries(key).map((e) => ({ order: e.order ?? DEFAULT_SLOT_ORDER, node: entryVNode(ctx, e, data) }));
}
