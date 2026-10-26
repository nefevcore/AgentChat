// ============================================================
// ac-client-ui-settings/client/extensionTabs.ts —— settings 页签
// 解析面（M27.2-2 settings 件随件迁；自 webui core/extensions/slots.ts
// 拆出——注册面 register* 与 bridge 留 webui）
//
// 解析面（sorted* computed ← ctx.slots.entries(<alias 键>) 的
// meta.def；order 语义同旧轨：缺省 100 升序稳定）+ resolveTabProps
// props 契约适配。webui core/extensions/slots.ts re-export 维持旧
// 导入路径（bridge/types 消费——同一模块实例）。
// ============================================================

import { computed, ref, type Component } from 'vue';
import { clientRuntime } from 'ac-client-runtime';

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

/** D13 别名键（→ slot-tree §6 收编表；声明住本包 client/index.ts） */
export const SLOT_SETTINGS_TABS = 'settings:main-view';
export const SLOT_AGENT_SETTINGS_TABS = 'agent-pane:tab';

// ── 响应式：'slots/changed'（相关键）→ 版本计数 → computed 重算。
//    版本计数轴（而非 ctx.slots.version 直读）的理由：runtime 缺席期的
//    首读（pre-boot/单测）也要建立依赖锚——runtime 后装配/注册后读取面
//    能失效重算（旧轨 webui slots.ts 同款语义）。 ──
const version = ref(0);
const WATCHED = new Set([SLOT_SETTINGS_TABS, SLOT_AGENT_SETTINGS_TABS]);

/** 装配序列调用：订阅注册表变更（main.ts initExtensionSlots 经 webui
 *  re-export 消费——同一模块实例，无双重订阅） */
export function initSettingsTabs(ctx: { on: (event: 'slots/changed', cb: (key: string) => void) => void }): void {
  ctx.on('slots/changed', (key) => {
    if (WATCHED.has(key)) version.value++;
  });
}

/** entries → 旧 def 视图（meta.def 原样携带；排序语义 = 注册表 order 轴——
 *  缺省 100 升序稳定）。 */
function defsOf<T>(key: string): T[] {
  void version.value; // 依赖锚
  const ctx = clientRuntime();
  if (!ctx) return [];
  return ctx.slots.entries(key).map((e) => e.meta?.def as T);
}

// ── 排序后的只读访问器（宿主组件渲染用；签名与旧轨一致） ──
export const sortedSettingsTabs = computed(() => defsOf<SettingsTabDef>(SLOT_SETTINGS_TABS));
export const sortedAgentSettingsTabs = computed(() => defsOf<SettingsTabDef>(SLOT_AGENT_SETTINGS_TABS));

/** 解析页签 props：无 props 时返回 base；函数则调用后与 base 合并（tab props 优先） */
export function resolveTabProps(tab: SettingsTabDef, base: Record<string, unknown>): Record<string, unknown> {
  if (!tab.props) return { ...base };
  if (typeof tab.props === 'function') return { ...base, ...tab.props(base) };
  return { ...base, ...tab.props };
}
