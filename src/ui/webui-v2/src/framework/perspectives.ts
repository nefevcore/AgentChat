// ============================================================
// framework/perspectives.ts —— 布局插槽（视角注册表）
//
// 一个"视角"（Perspective）= 完整的一屏体验：
//   活动栏图标 + 列表面板（可空）+ 主视图 + 该视角挂载的全局弹窗。
//
// 扩展方式（增量加功能）：
//   registerPerspective({
//     id: 'community',
//     label: '社区',
//     icon: '<svg…>',
//     list: CommunityList,   // 可空
//     main: CommunityView,
//     modals: [CommunityModal],
//   })
// 之后 AppShell 的插槽自动渲染它，无需改框架本体。
// ============================================================

import type { Component } from 'vue';
import { SlotRegistry, type RegistryEntry } from './registry';

export interface Perspective extends RegistryEntry {
  /** 显示名称 */
  label: string;
  /** 活动栏图标（内联 SVG 字符串或路径） */
  icon: string;
  /** 列表面板组件（可空：该视角无左侧列表） */
  list?: Component;
  /** 主视图组件（必填） */
  main: Component;
  /** 该视角挂载的全局弹窗组件集合 */
  modals?: Component[];
}

const perspectiveRegistry = new SlotRegistry<Perspective>();

export function registerPerspective(p: Perspective): void {
  perspectiveRegistry.register(p);
}

export function getPerspective(id: string): Perspective | undefined {
  return perspectiveRegistry.get(id);
}

export function getPerspectives(): Perspective[] {
  return perspectiveRegistry.all();
}
