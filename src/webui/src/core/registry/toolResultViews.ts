// ============================================================
// core/registry/toolResultViews.ts —— 工具结果视图注册表 ★扩展点
//
// 后端新增工具时，前端只需注册一个渲染组件：
//   registerToolResultView('my_tool', MyToolResult.vue)
// 匹配链：精确名 / 正则族 → 优先级覆盖 → 未命中返回 null（调用方按文本渲染）。
//
// M27 D9 收编（S2）：数据面改经 SlotRegistry（tool-card:result-view
// keyed presentation seat——D13 别名席）。本模块保留为【解析面】：
//   · register → ctx.slots.register（meta 携带 def；match/priority
//     语义原样进选举）；runtime 未装配（pre-boot/单测）→ 旧数组；
//   · resolveToolResultView ← ctx.slots.entries 的 meta.def（版本计数
//     响应式；无 runtime 回落旧数组——既有测试零改动）；
//   · 内置 8 卡 + 席位声明 + 卡片数据管线经 tool 基础件
//    （M27.2-2 出包 = ac-client-ui-tool/client）出厂注册；本模块
//     不再持有组件资产（ToolResultViewDef/SLOT_KEY 自包内 re-export
//     维持旧导入路径）。
// ============================================================

import { ref, type Component } from 'vue';
import type { SlotEntry } from 'ac-client-slots';
import { clientRuntime } from '@/runtime/clientRuntime';
import type { ToolResultViewDef } from 'ac-client-ui-tool/client/index.ts';

export type { ToolResultViewDef } from 'ac-client-ui-tool/client/index.ts';
export { SLOT_KEY } from 'ac-client-ui-tool/client/index.ts';
import { SLOT_KEY } from 'ac-client-ui-tool/client/index.ts';

/** D9 别名席（owning = ac-client-ui-tool/client——M27.2-2 出包） */

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
