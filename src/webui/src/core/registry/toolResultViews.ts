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
//   · 内置 12 卡经 tool 基础件（clients/base/tool.ts）出厂注册进
//     slot 注册表（本模块 BUILTINS 导出，模块求值期不再自注册双轨）。
// ============================================================

import { ref, type Component } from 'vue';
import type { SlotEntry } from 'ac-client-slots';
import { clientRuntime } from '@/runtime/clientRuntime';
import ToolResultCode from '@/components/chat/ToolResult/ToolResultCode.vue';
import ToolResultWeb from '@/components/chat/ToolResult/ToolResultWeb.vue';
import ToolResultTerminal from '@/components/chat/ToolResult/ToolResultTerminal.vue';
import ToolResultWrite from '@/components/chat/ToolResult/ToolResultWrite.vue';
import ToolResultEdit from '@/components/chat/ToolResult/ToolResultEdit.vue';
import ToolResultSubagent from '@/components/chat/ToolResult/ToolResultSubagent.vue';
import ToolResultBrowser from '@/components/chat/ToolResult/ToolResultBrowser.vue';
// 任务追踪工具面：goal 卡内置（ac-goal 未迁）；todo 卡随行走迁
// ac-client-ui-todo/client（M27.1 前端行——行 client 出厂贡献 id 'todo'）
import ToolResultGoal from '@/components/chat/ToolResult/ToolResultGoal.vue';

export interface ToolResultViewDef {
  /** 精确工具名 或 正则（族匹配，如 /^browser_/） */
  match: string | RegExp;
  component: Component;
  /** 同命中时优先级，默认 0（越大越优先，用于覆盖内置） */
  priority?: number;
}

/** D9 别名席（声明住 runtime/hostLedger.ts 的 tool-card:result-view） */
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

// ── 内置注册清单（tool 基础件出厂注册进 slot 注册表；单测回落面由
//    resolve 的 legacy 路径消费——本模块不再求值期自注册）──
export const BUILTIN_TOOL_RESULT_VIEWS: Array<[string | RegExp, Component]> = [
  ['bash', ToolResultTerminal],
  ['read', ToolResultCode],
  ['write', ToolResultWrite],
  ['edit', ToolResultEdit],
  ['web_search', ToolResultWeb],
  // 浏览器主工具（独立组件：多动作 tab / steps 批量）；其余浏览器族工具走 ToolResultWeb
  ['browser', ToolResultBrowser],
  // 浏览器相关工具族
  [/^(fetch_webpage|open_browser_page|navigate_page|read_page|click_element|type_in_page|screenshot_page|hover_element|drag_element|handle_dialog|run_playwright_code)$/, ToolResultWeb],
  // subAgent 工具（0.6.1 合并为单一 subagent，action 分发）
  ['subagent', ToolResultSubagent],
  // 任务追踪工具面（ac-goal；todo 随 UI 行走迁 ac-client-ui-todo/client 出厂贡献）
  ['goal', ToolResultGoal],
];
