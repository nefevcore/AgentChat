// ============================================================
// core/extensions/slots.ts —— 新 slot 注册表（P5.4）
//
// settings-tab:global / settings-tab:agent / sidebar-action
// 宿主布局保持不变，插件只能向这些固定插口“填空”。
// 排序规则：order ?? 100 升序；同 order 按注册先后（稳定）。
// 同 id 后注册者替换前者（与 HooksService 同名覆盖一致）。
// ============================================================

import { ref, computed, type Component } from 'vue';
import type { Disposer } from './types';

export interface SettingsTabDef {
  /** 页签 id（同 slot 内唯一；插件经 bridge 注册时会加插件名前缀） */
  id: string;
  label: string;
  icon?: string;
  order?: number;
  component: Component;
  /** 传给组件的 props：对象，或基于宿主 base props 的工厂函数 */
  props?: Record<string, unknown> | ((base: Record<string, unknown>) => Record<string, unknown>);
}

export interface SidebarActionDef {
  id: string;
  label: string;
  icon: string;
  order?: number;
  onClick: () => void;
}

// ── 响应式注册表（原始数组，供调试/替换） ──
export const settingsTabs = ref<SettingsTabDef[]>([]);
export const agentSettingsTabs = ref<SettingsTabDef[]>([]);
export const sidebarActions = ref<SidebarActionDef[]>([]);

function compareOrder(a: { order?: number }, b: { order?: number }): number {
  return (a.order ?? 100) - (b.order ?? 100);
}

// ── 排序后的只读访问器（宿主组件渲染用） ──
export const sortedSettingsTabs = computed(() => [...settingsTabs.value].sort(compareOrder));
export const sortedAgentSettingsTabs = computed(() => [...agentSettingsTabs.value].sort(compareOrder));
export const sortedSidebarActions = computed(() => [...sidebarActions.value].sort(compareOrder));

function registerTab(registry: typeof settingsTabs, def: SettingsTabDef): Disposer {
  const idx = registry.value.findIndex(t => t.id === def.id);
  if (idx >= 0) {
    registry.value.splice(idx, 1, def); // 同 id 替换，保持位置
  } else {
    registry.value.push(def);
  }
  return () => {
    const arr = registry.value;
    const i = arr.indexOf(def);
    if (i >= 0) arr.splice(i, 1);
  };
}

export function registerSettingsTab(def: SettingsTabDef): Disposer {
  return registerTab(settingsTabs, def);
}

export function registerAgentSettingsTab(def: SettingsTabDef): Disposer {
  return registerTab(agentSettingsTabs, def);
}

export function registerSidebarAction(def: SidebarActionDef): Disposer {
  const idx = sidebarActions.value.findIndex(a => a.id === def.id);
  if (idx >= 0) {
    sidebarActions.value.splice(idx, 1, def); // 同 id 替换
  } else {
    sidebarActions.value.push(def);
  }
  return () => {
    const arr = sidebarActions.value;
    const i = arr.indexOf(def);
    if (i >= 0) arr.splice(i, 1);
  };
}

/** 解析页签 props：无 props 时返回 base；函数则调用后与 base 合并（tab props 优先） */
export function resolveTabProps(tab: SettingsTabDef, base: Record<string, unknown>): Record<string, unknown> {
  if (!tab.props) return { ...base };
  if (typeof tab.props === 'function') return { ...base, ...tab.props(base) };
  return { ...base, ...tab.props };
}
