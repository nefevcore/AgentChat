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

/** output 载荷 → 卡片 data：对象直通；原始值（字符串/数字）包一层 output 键（终端等组件读 data.output） */
function asData(v: unknown): Record<string, unknown> | undefined {
  if (v !== null && typeof v === 'object') return v as Record<string, unknown>;
  if (v === undefined || v === null) return undefined;
  return { output: v };
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
    if (obj === null || typeof obj !== 'object') return null;
    // 三形归一（2026-09-03 修复：src 工具结果此前解析恒 null——专用卡片
    // 只见参数预览，read/write/edit 正文全空）：
    //   ① 历史回放形：{ok, output} 信封（JSON.stringify(ToolResult 全对象)）
    //   ② live 形：裸 output 对象（stringifyToolResult = JSON.stringify(output)）
    //   ③ 旧 preview 形：{status, ...}（扩展插件仍可用）
    if (typeof (obj as Record<string, unknown>).ok === 'boolean') {
      const o = obj as { ok: boolean; output?: unknown; error?: unknown };
      if (o.ok) return { status: 'success', ...(asData(o.output) !== undefined ? { data: asData(o.output)! } : {}) };
      return {
        status: 'error',
        message: typeof o.error === 'string' && o.error ? o.error : '工具执行失败',
        ...(asData(o.output) !== undefined ? { data: asData(o.output)! } : {}),
      };
    }
    if (typeof (obj as Record<string, unknown>).status === 'string') return obj as ToolResultData;
    return { status: 'success', data: obj as Record<string, unknown> };
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
