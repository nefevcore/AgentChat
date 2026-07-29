// ============================================================
// 工具结果解析与渲染 composable
// ============================================================

import { computed, type Component, type Ref } from 'vue';
import ToolResultCode from '@/components/chat/ToolResult/ToolResultCode.vue';
import ToolResultWeb from '@/components/chat/ToolResult/ToolResultWeb.vue';
import ToolResultTerminal from '@/components/chat/ToolResult/ToolResultTerminal.vue';
import ToolResultCard from '@/components/chat/ToolResult/ToolResultCard.vue';
import ToolResultWrite from '@/components/chat/ToolResult/ToolResultWrite.vue';
import ToolResultEdit from '@/components/chat/ToolResult/ToolResultEdit.vue';

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

const COMPONENT_MAP: Record<string, Component> = {
  bash: ToolResultTerminal,
  read: ToolResultCode,
  write: ToolResultWrite,
  edit: ToolResultEdit,
  web_search: ToolResultWeb,
  // 浏览器相关工具
  browser: ToolResultWeb,
  fetch_webpage: ToolResultWeb,
  open_browser_page: ToolResultWeb,
  navigate_page: ToolResultWeb,
  read_page: ToolResultWeb,
  click_element: ToolResultWeb,
  type_in_page: ToolResultWeb,
  screenshot_page: ToolResultWeb,
  hover_element: ToolResultWeb,
  drag_element: ToolResultWeb,
  handle_dialog: ToolResultWeb,
  run_playwright_code: ToolResultWeb,
};

export function getToolResultComponent(toolName: string | undefined): Component | null {
  if (toolName && COMPONENT_MAP[toolName]) {
    return COMPONENT_MAP[toolName];
  }
  // 未知工具类型返回 null，由调用方按普通文本渲染
  return null;
}

export function useToolResult(rawContent: Ref<string>, toolName?: Ref<string | undefined>) {
  const parsed = computed<ToolResultData | null>(() => parseToolResult(rawContent.value));
  const isJson = computed(() => parsed.value !== null);
  const component = computed(() => getToolResultComponent(toolName?.value));
  return { parsed, isJson, component };
}
