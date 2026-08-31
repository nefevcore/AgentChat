// ============================================================
// 工具结果解析与渲染 composable
// 组件分发改由 core/registry/toolResultViews 注册表承担（扩展点）。
// ============================================================

import { computed, type Ref } from 'vue';
import { resolveToolResultView } from '@/core/registry/toolResultViews';

interface ToolResultData {
  status: 'success' | 'error' | 'warning' | 'info' | 'blocked' | 'launched';
  title?: string;
  message?: string;
  data?: Record<string, unknown>;
  type?: string;
}

function parseToolResult(content: string): ToolResultData | null {
  // 流式短路：工具结果是追加式 JSON 增长，尾部不是 }/] 时必然不完整——
  // 直接返回 null，无需付出 JSON.parse + 抛异常的代价（异常构造堆栈昂贵，
  // 大输出流式期间每 delta 一次全量 parse 是 O(n²) CPU 卡顿的主源之一）
  const trimmed = content.trimEnd();
  if (trimmed.length === 0) return null;
  const last = trimmed[trimmed.length - 1]!;
  if (last !== '}' && last !== ']') return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj.status === 'string') return obj as ToolResultData;
    return null;
  } catch {
    return null;
  }
}

export function useToolResult(rawContent: Ref<string>, toolName?: Ref<string | undefined>) {
  const parsed = computed<ToolResultData | null>(() => parseToolResult(rawContent.value));
  const isJson = computed(() => parsed.value !== null);
  // 组件分发改由注册表解析（getToolResultComponent 兼容导出无外部引用已删除）
  const component = computed(() => resolveToolResultView(toolName?.value));
  return { parsed, isJson, component };
}
