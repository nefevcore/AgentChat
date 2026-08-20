// ============================================================
// Agent Presets API —— /api/agent-presets（预设 Agent 目录，Session 选用）
// ============================================================

import { request } from '../client';

/** 预设 Agent 目录条目（与后端 AgentPresetMeta 对齐） */
export interface AgentPresetInfo {
  /** 预设 Agent id（如 __standard__ / __minimal__） */
  id: string;
  /** Agent 名（消息身份显示用） */
  name: string;
  /** 选项标签（如「标准」「极简」） */
  label: string;
  description: string;
  /** 是否默认预设（空 Agent 会话的路由目标） */
  default: boolean;
}

export function fetchAgentPresets(): Promise<{ presets: AgentPresetInfo[] }> {
  return request('/api/agent-presets');
}
