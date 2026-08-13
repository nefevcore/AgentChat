// ============================================================
// core/registry/toolResultViews.ts —— 工具结果视图注册表 ★扩展点
//
// 后端新增工具时，前端只需注册一个渲染组件：
//   registerToolResultView('my_tool', MyToolResult.vue)
// 匹配链：精确名 / 正则族 → 优先级覆盖 → 未命中返回 null（调用方按文本渲染）。
// ============================================================

import type { Component } from 'vue';
import ToolResultCode from '@/components/chat/ToolResult/ToolResultCode.vue';
import ToolResultWeb from '@/components/chat/ToolResult/ToolResultWeb.vue';
import ToolResultTerminal from '@/components/chat/ToolResult/ToolResultTerminal.vue';
import ToolResultWrite from '@/components/chat/ToolResult/ToolResultWrite.vue';
import ToolResultEdit from '@/components/chat/ToolResult/ToolResultEdit.vue';
import ToolResultSubagent from '@/components/chat/ToolResult/ToolResultSubagent.vue';
import ToolResultBrowser from '@/components/chat/ToolResult/ToolResultBrowser.vue';

export interface ToolResultViewDef {
  /** 精确工具名 或 正则（族匹配，如 /^browser_/） */
  match: string | RegExp;
  component: Component;
  /** 同命中时优先级，默认 0（越大越优先，用于覆盖内置） */
  priority?: number;
}

const views: ToolResultViewDef[] = [];

/** 注册工具结果视图（可由插件/外部模块追加或覆盖内置） */
export function registerToolResultView(match: string | RegExp, component: Component, opts?: { priority?: number }): void {
  views.push({ match, component, priority: opts?.priority ?? 0 });
}

/** 解析工具名 → 渲染组件（精确匹配优先于正则族；同命中取最高优先级） */
export function resolveToolResultView(toolName?: string): Component | null {
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

// ── 内置注册（迁移自 useToolResult.ts 的 COMPONENT_MAP）──
registerToolResultView('bash', ToolResultTerminal);
registerToolResultView('read', ToolResultCode);
registerToolResultView('write', ToolResultWrite);
registerToolResultView('edit', ToolResultEdit);
registerToolResultView('web_search', ToolResultWeb);
// 浏览器主工具（独立组件：多动作 tab / steps 批量）；其余浏览器族工具走 ToolResultWeb
registerToolResultView('browser', ToolResultBrowser);
// 浏览器相关工具族
registerToolResultView(/^(fetch_webpage|open_browser_page|navigate_page|read_page|click_element|type_in_page|screenshot_page|hover_element|drag_element|handle_dialog|run_playwright_code)$/, ToolResultWeb);
// subAgent 工具族
registerToolResultView(/^(spawn_subagent|await_subagent|list_subagents|kill_subagent)$/, ToolResultSubagent);
