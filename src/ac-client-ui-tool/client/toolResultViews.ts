// ============================================================
// ac-client-ui-tool/client/toolResultViews.ts —— 工具结果视图解析面
//（★扩展点；M27.2-2 conversation 视图半边随件迁）
//
// 后端新增工具时，前端只需注册一个渲染组件：
//   registerToolResultView('my_tool', MyToolResult.vue)
// 匹配链：精确名 / 正则族 → 优先级覆盖 → 未命中返回 null（调用方按文本渲染）。
//
// M27 D9 收编（S2）：数据面经 SlotRegistry（tool-card:result-view
// keyed presentation seat——席位声明 + 内置 8 卡出厂批次住本包
// client/index.ts）。本模块 = 【解析面】：
//   · register → ctx.slots.register（meta 携带 def；match/priority
//     语义原样进选举）；runtime 未装配（pre-boot/单测）→ 旧数组；
//   · resolveToolResultView ← ctx.slots.entries 的 meta.def（版本计数
//     响应式；无 runtime 回落旧数组——既有测试零改动）。
// webui core/registry/toolResultViews.ts re-export 维持旧路径（bridge/
// main.ts/测试导入面零改动——同一模块实例）。SLOT_KEY/def 类型在
// index.ts 与本模块间单源住本模块（index re-export）——node 测试链
// 引入本模块不触 .vue 组件。
// ============================================================

import { ref, type Component } from 'vue';
import type { SlotEntry } from 'ac-client-slots';
import { clientRuntime } from 'ac-client-runtime';

/** 工具结果视图 def（精确工具名/正则族 + 优先级——选举语义） */
export interface ToolResultViewDef {
  match: string | RegExp;
  component: Component;
  /** 同命中时优先级，默认 0（越大越优先，用于覆盖内置） */
  priority?: number;
  /** 卡片友好名词条（M28 P3/T9：卡片行自带 label meta——toolLabel 解析
   *  面先查注册表，未装载行回落静态表词条） */
  label?: string;
  /** 卡片图标名（M28 P3/T9：同 label——lucide 名，toolIcon 解析面先查） */
  icon?: string;
}

/** 席位键（与 webui 解析面同词汇；声明 + 出厂批次住 client/index.ts） */
export const SLOT_KEY = 'tool-card:result-view';

// ── 响应式：'slots/changed'（相关键）→ 版本计数 → resolve 重解析 ──
const version = ref(0);

/** 装配序列调用：订阅注册表变更（main.ts，紧跟 createClient） */
export function bindToolResultViews(): void {
  const ctx = clientRuntime();
  ctx?.on('slots/changed', (key) => {
    if (key === SLOT_KEY) version.value++;
  });
}

/** 旧数组（runtime 未装配时的回落面——pre-boot/单测） */
const legacyViews: ToolResultViewDef[] = [];

/** 当前生效 def 集（slot 注册表优先；无 runtime 回落旧数组） */
function defs(): ToolResultViewDef[] {
  void version.value; // 依赖锚
  const ctx = clientRuntime();
  if (!ctx) return legacyViews;
  return ctx.slots.entries(SLOT_KEY).map((e) => e.meta?.def as ToolResultViewDef).filter(Boolean);
}

/** 注册工具结果视图（可由插件/外部模块追加或覆盖内置）。
 *  幂等：同 match 的既有条目被替换（与 perspectives/messageViews 一致）——
 *  重复注册此前是纯 push，解析取先注册者 → 插件更新组件时静默不生效且旧条目永不清理。 */
export function registerToolResultView(match: string | RegExp, component: Component, opts?: { priority?: number }): () => void {
  const def: ToolResultViewDef = { match, component, priority: opts?.priority ?? 0 };
  const rt = clientRuntime();
  if (rt && rt.slots.declOf(SLOT_KEY)) {
    const off = rt.slots.register(SLOT_KEY, {
      id: String(match),
      component,
      priority: def.priority,
      meta: { def },
    } satisfies SlotEntry);
    return () => void off();
  }
  const idx = legacyViews.findIndex(v => v.match === match);
  if (idx >= 0) legacyViews.splice(idx, 1, def);
  else legacyViews.push(def);
  return () => {
    const i = legacyViews.indexOf(def);
    if (i >= 0) legacyViews.splice(i, 1);
  };
}

/** 解析工具名 → 渲染组件（精确匹配优先于正则族；同命中取最高优先级） */
export function resolveToolResultView(toolName?: string): Component | null {
  const views = defs(); // 建立响应式依赖：动态注册/卸载后自动重解析
  if (!toolName) return null;
  // ① 精确名匹配（可覆盖正则族内置）
  let best: ToolResultViewDef | null = null;
  for (const v of views) {
    if (typeof v.match === 'string' && v.match === toolName) {
      if (!best || (v.priority ?? 0) > (best.priority ?? 0)) best = v;
    }
  }
  if (best) return best.component;
  // ② 正则族匹配
  let bestRegex: ToolResultViewDef | null = null;
  for (const v of views) {
    if (typeof v.match !== 'string' && v.match.test(toolName)) {
      if (!bestRegex || (v.priority ?? 0) > (bestRegex.priority ?? 0)) bestRegex = v;
    }
  }
  return bestRegex?.component ?? null;
}

/**
 * 解析工具名 → 展示词条（label/icon；M28 P3/T9——卡片行自带 meta，
 * 解析面只做 election）。匹配链与 resolveToolResultView 同源
 * （精确名 → 正则族 → 未命中 null——调用方回落静态表/裸名）。
 * 响应式：读 version 依赖锚，行装卸后消费 computed 自动重解析。
 */
export function resolveToolDisplayMeta(toolName?: string): { label?: string; icon?: string } | null {
  const views = defs();
  if (!toolName) return null;
  let best: ToolResultViewDef | null = null;
  for (const v of views) {
    if (typeof v.match === 'string' && v.match === toolName) {
      if (!best || (v.priority ?? 0) > (best.priority ?? 0)) best = v;
    }
  }
  if (!best) {
    for (const v of views) {
      if (typeof v.match !== 'string' && v.match.test(toolName)) {
        if (!best || (v.priority ?? 0) > (best.priority ?? 0)) best = v;
      }
    }
  }
  if (!best) return null;
  return best.label !== undefined || best.icon !== undefined
    ? { label: best.label, icon: best.icon }
    : null;
}
