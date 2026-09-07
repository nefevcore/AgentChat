// ============================================================
// core/extensions/slots.ts —— 旧 slot 注册面 → SlotRegistry 转发层（M27 S1）
//
// D13 双轨（S1 形态）：本模块的公开签名（SettingsTabDef/SidebarActionDef、
// register* 三件、sorted* 三个 computed、resolveTabProps）保持不变——
// 旧调用方（bridge.ts / SettingsPanel / AgentPane / Sidebar）零改动；
// 数据面改经客户端 SlotRegistry（声明账本键见 runtime/hostLedger.ts）：
//   · register* → ctx.slots.register(<alias 键>, { …, meta: { def } })——
//     旧 def（label/icon/onClick 等非组件词汇）经 meta 原样携带；
//   · sorted* computed ← ctx.slots.entries(<alias 键>) 的 meta.def
//     （order 语义同旧轨：缺省 100 升序稳定）；
//   · S3 末收敛为纯转发 + 静态断言无内部直用（本文件即转发本体）。
//
// 运行时锚：runtime/clientRuntime.ts（装配序列写入）；未装配时注册面
// 抛可诊断错误（注册只发生在 boot 后——bridge install 与内置注册）。
// ============================================================

import { computed, ref, type Component } from 'vue';
import type { ClientContext } from 'ac-client-runtime';
import type { SlotEntry } from 'ac-client-slots';
import type { Disposer } from './types';
import { clientRuntime } from '@/runtime/clientRuntime';

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

/** D13 别名键（→ slot-tree §6 收编表；声明住 runtime/hostLedger.ts） */
export const SLOT_SETTINGS_TABS = 'settings:main-view';
export const SLOT_AGENT_SETTINGS_TABS = 'agent-pane:tab';
export const SLOT_SIDEBAR_ACTIONS = 'sidebar:plugin-actions';

// ── 响应式：'slots/changed'（相关键）→ 版本计数 → computed 重算 ──
const version = ref(0);
const WATCHED = new Set([SLOT_SETTINGS_TABS, SLOT_AGENT_SETTINGS_TABS, SLOT_SIDEBAR_ACTIONS]);

/** 装配序列调用：订阅注册表变更（main.ts，紧跟 createClient） */
export function initExtensionSlots(ctx: ClientContext): void {
  ctx.on('slots/changed', (key) => {
    if (WATCHED.has(key)) version.value++;
  });
}

function rt(): ClientContext {
  const ctx = clientRuntime();
  if (!ctx) throw new Error('client runtime 未装配——register* 需在 main.ts 装配序列之后调用（M27 S1 双轨）');
  return ctx;
}

/** entries → 旧 def 视图（meta.def 原样携带；排序语义 = 注册表 order 轴） */
function defsOf<T>(key: string): T[] {
  void version.value; // 依赖锚
  const ctx = clientRuntime();
  if (!ctx) return [];
  return ctx.slots.entries(key).map((e) => e.meta?.def as T);
}

// ── 排序后的只读访问器（宿主组件渲染用；签名与旧轨一致） ──
export const sortedSettingsTabs = computed(() => defsOf<SettingsTabDef>(SLOT_SETTINGS_TABS));
export const sortedAgentSettingsTabs = computed(() => defsOf<SettingsTabDef>(SLOT_AGENT_SETTINGS_TABS));
export const sortedSidebarActions = computed(() => defsOf<SidebarActionDef>(SLOT_SIDEBAR_ACTIONS));

/** 旧 props 契约（base: Record）→ SlotEntry 工厂契约（data: unknown）适配 */
function adaptProps(p?: SettingsTabDef['props']): SlotEntry['props'] {
  if (typeof p === 'function') return (d: unknown) => p(d as Record<string, unknown>);
  return p;
}

function registerDef(key: string, def: SettingsTabDef | SidebarActionDef, component: Component): Disposer {
  const off = rt().slots.register(key, {
    id: def.id,
    component,
    order: def.order,
    ...(def instanceof Object && 'props' in def && def.props !== undefined ? { props: adaptProps(def.props) } : {}),
    meta: { def },
  });
  return () => void off();
}

export function registerSettingsTab(def: SettingsTabDef): Disposer {
  return registerDef(SLOT_SETTINGS_TABS, def, def.component);
}

export function registerAgentSettingsTab(def: SettingsTabDef): Disposer {
  return registerDef(SLOT_AGENT_SETTINGS_TABS, def, def.component);
}

export function registerSidebarAction(def: SidebarActionDef): Disposer {
  // sidebar-action 旧契约非组件（icon+onClick）——宿主 Sidebar 自渲染按钮，
  // 条目 component 为占位（消费面只读 meta.def）
  return registerDef(SLOT_SIDEBAR_ACTIONS, def, { name: 'SidebarActionStub', render: () => null });
}

/** 解析页签 props：无 props 时返回 base；函数则调用后与 base 合并（tab props 优先） */
export function resolveTabProps(tab: SettingsTabDef, base: Record<string, unknown>): Record<string, unknown> {
  if (!tab.props) return { ...base };
  if (typeof tab.props === 'function') return { ...base, ...tab.props(base) };
  return { ...base, ...tab.props };
}
