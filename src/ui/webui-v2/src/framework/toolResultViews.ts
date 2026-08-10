// ============================================================
// framework/toolResultViews.ts —— 工具结果渲染插槽
//
// 按工具名分发 ToolResult 展示组件。新增工具 = 注册一个组件，
// ToolMessage 通过本插槽查找渲染器，未知工具回退 'fallback'。
//
// 扩展方式：
//   registerToolResultView('my_tool', MyToolView);
//   registerToolResultView('*', MyFallbackView); // 覆盖默认回退
// ============================================================

import type { Component } from 'vue';
import { SlotRegistry, type RegistryEntry } from './registry';

export interface ToolResultViewEntry extends RegistryEntry {
  /** 工具名（'*' = 兜底） */
  toolName: string;
  component: Component;
}

const toolResultRegistry = new SlotRegistry<ToolResultViewEntry>();

export const FALLBACK_TOOL_ID = '*';

/** 注册工具结果视图（同名覆盖） */
export function registerToolResultView(toolName: string, component: Component): void {
  toolResultRegistry.register({ id: toolName, toolName, component });
}

export function getToolResultView(toolName: string | undefined): Component | undefined {
  if (toolName) {
    const exact = toolResultRegistry.get(toolName);
    if (exact) return exact.component;
  }
  return toolResultRegistry.get(FALLBACK_TOOL_ID)?.component;
}

export function getToolResultViews(): ToolResultViewEntry[] {
  return toolResultRegistry.all();
}
