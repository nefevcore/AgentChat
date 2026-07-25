import type { ConfigField } from '@discovery/config-types';
import { resolveNamespaceConfig } from '@core/config';

export const meta = {
  name: 'agent-prompt',
  label: '系统提示词',
  description: '工具、MCP工具、动态指引、技能清单、系统环境、日期 + SYSTEM.md覆盖 / AGENT.md追加。',
  ns: 'extension.agent_prompt',
  configuration: [
    { name: 'tools', label: '工具', description: '启用工具定义列表装配', type: 'checkbox', default: true },
    { name: 'mcp', label: 'MCP', description: '启用 MCP 工具和资源发现', type: 'checkbox', default: false },
    { name: 'mcpFile', label: 'MCP配置文件路径', description: '外部 MCP 配置文件绝对路径（xxx.json，含敏感凭证时使用，优先级高于内联 servers）', type: 'file', accept: '.json', showWhen: { mcp: true } },
    { name: 'guidelines', label: '工具使用指南', description: '启用动态指引装配', type: 'checkbox', default: true },
    { name: 'skills', label: '技能', description: '启用技能清单装配', type: 'checkbox', default: true },
    { name: 'windowsEnv', label: '系统环境', description: '启用系统环境信息注入', type: 'checkbox', default: true },
    { name: 'datetime', label: '日期', description: '启用当前日期时间注入', type: 'checkbox', default: true },
    { name: 'conversationPartner', label: '会话对象', description: '启用当前会话对象身份注入（帮助 Agent 识别对话方是用户还是其他 Agent）', type: 'checkbox', default: true },
  ] as ConfigField[],
};

export interface PromptConfig {
  tools: boolean; guidelines: boolean; windowsEnv: boolean;
  skills: boolean; datetime: boolean; mcp: boolean; conversationPartner: boolean;
}
function defaults(): PromptConfig {
  return { tools: true, guidelines: true, windowsEnv: true, skills: true, datetime: true, mcp: false, conversationPartner: true };
}
export function cfg(runtimeConfig?: Record<string, Record<string, unknown>>): PromptConfig {
  return resolveNamespaceConfig(meta.ns, defaults(), runtimeConfig);
}
