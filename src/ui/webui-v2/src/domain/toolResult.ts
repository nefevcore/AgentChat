// ============================================================
// domain/toolResult.ts —— 工具结果解析（纯函数，零 UI 依赖）
// ============================================================

/** 工具结果的统一结构（JSON 序列化契约） */
export interface ToolResultData {
  status: 'success' | 'error' | 'warning' | 'info' | 'blocked';
  title?: string;
  message?: string;
  data?: Record<string, unknown>;
  type?: string;
  [key: string]: unknown;
}

/**
 * 解析工具结果字符串。若为合法的 JSON 工具结果对象则返回结构化数据，
 * 否则返回 null（按普通文本渲染）。
 */
export function parseToolResult(content: string): ToolResultData | null {
  if (!content) return null;
  try {
    const obj = JSON.parse(content);
    if (obj && typeof obj.status === 'string') return obj as ToolResultData;
    return null;
  } catch {
    return null;
  }
}
