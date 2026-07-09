// ============================================================
// 工具结果解析与渲染 composable
// ============================================================

import { computed, type Component, type Ref } from 'vue';
import ToolResultCode from '@/components/chat/ToolResult/ToolResultCode.vue';
import ToolResultWeb from '@/components/chat/ToolResult/ToolResultWeb.vue';
import ToolResultTerminal from '@/components/chat/ToolResult/ToolResultTerminal.vue';
import ToolResultCard from '@/components/chat/ToolResult/ToolResultCard.vue';
import ToolResultFallback from '@/components/chat/ToolResult/ToolResultFallback.vue';

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
  write: ToolResultCard,
  edit: ToolResultCard,
  web_search: ToolResultWeb,
};

export function getToolResultComponent(toolName: string | undefined): Component {
  if (toolName && COMPONENT_MAP[toolName]) {
    return COMPONENT_MAP[toolName];
  }
  return ToolResultFallback;
}

export function useToolResult(rawContent: Ref<string>, toolName?: Ref<string | undefined>) {
  const parsed = computed<ToolResultData | null>(() => parseToolResult(rawContent.value));
  const isJson = computed(() => parsed.value !== null);
  const component = computed(() => getToolResultComponent(toolName?.value));
  return { parsed, isJson, component };
}
