// ============================================================
// 工具结果解析与渲染 composable
// 组件分发改由 core/registry/toolResultViews 注册表承担（扩展点）。
// ============================================================

import { computed, type Ref } from 'vue';
import { resolveToolResultView } from '@/core/registry/toolResultViews';

export interface ToolResultData {
  status: 'success' | 'error' | 'warning' | 'info' | 'blocked';
  title?: string;
  message?: string;
  data?: Record<string, unknown>;
  type?: string;
}

export function parseToolResult(content: string): ToolResultData | null {
  try {
    const obj = JSON.parse(content);
    if (obj && typeof obj.status === 'string') return obj as ToolResultData;
    return null;
  } catch {
    return null;
  }
}

/** 兼容导出：由注册表解析 */
export function getToolResultComponent(toolName: string | undefined): ReturnType<typeof resolveToolResultView> {
  return resolveToolResultView(toolName);
}

export function useToolResult(rawContent: Ref<string>, toolName?: Ref<string | undefined>) {
  const parsed = computed<ToolResultData | null>(() => parseToolResult(rawContent.value));
  const isJson = computed(() => parsed.value !== null);
  const component = computed(() => getToolResultComponent(toolName?.value));
  return { parsed, isJson, component };
}
