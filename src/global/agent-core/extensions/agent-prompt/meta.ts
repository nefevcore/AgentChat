import type { ConfigField } from '@discovery/config-types';
import { resolveNamespaceConfig } from '@core/config';

export const meta = {
  name: 'agent-prompt',
  label: '系统提示词',
  description: '工具概览、动态指引、技能清单、系统环境、日期 + SYSTEM.md覆盖 / AGENT.md追加。MCP 工具描述由 agent-mcp 扩展提供。',
  ns: 'extension.agent_prompt',
  configuration: [
    { name: 'tools', label: '工具', description: '启用工具定义列表装配', type: 'checkbox', default: true },
    { name: 'guidelines', label: '工具使用指南', description: '启用动态指引装配', type: 'checkbox', default: true },
    { name: 'skills', label: '技能', description: '启用技能清单装配', type: 'checkbox', default: true },
    { name: 'systemEnv', label: '系统环境', description: '启用系统环境信息注入（OS、Shell、编码等）', type: 'checkbox', default: true },
    { name: 'datetime', label: '日期', description: '启用当前日期时间注入', type: 'checkbox', default: true },
    { name: 'conversationPartner', label: '会话对象', description: '启用当前会话对象身份注入（帮助 Agent 识别对话方是用户还是其他 Agent）', type: 'checkbox', default: true },
  ] as ConfigField[],
};

export interface PromptConfig {
  tools: boolean; guidelines: boolean; systemEnv: boolean;
  skills: boolean; datetime: boolean; conversationPartner: boolean;
}
function defaults(): PromptConfig {
  return { tools: true, guidelines: true, systemEnv: true, skills: true, datetime: true, conversationPartner: true };
}
export function cfg(runtimeConfig?: Record<string, Record<string, unknown>>): PromptConfig {
  return resolveNamespaceConfig(meta.ns, defaults(), runtimeConfig);
}
