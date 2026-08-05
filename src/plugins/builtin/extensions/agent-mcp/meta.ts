import type { ConfigField } from '@core/types';
import { resolveNamespaceConfig } from '@agents/config';

export const meta = {
  name: 'agent-mcp',
  label: 'MCP 工具',
  description: '发现并注册 MCP (Model Context Protocol) 服务器工具，供 Agent 调用。',
  ns: 'extension.agent_mcp',
  configuration: [
    { name: 'mcp', label: 'MCP', description: '启用 MCP 工具发现和注册', type: 'checkbox', default: false },
    { name: 'mcpFile', label: 'MCP配置文件路径', description: '外部 MCP 配置文件绝对路径（xxx.json，含敏感凭证时使用，优先级高于内联 servers）', type: 'file', accept: '.json', showWhen: { mcp: true } },
    { name: 'cacheTtlMs', label: '缓存TTL', description: '工具列表缓存时间（毫秒，默认 300000 = 5 分钟）', type: 'number', default: 300000 },
  ] as ConfigField[],
};

export interface MCPConfig {
  mcp: boolean;
  mcpFile?: string;
  cacheTtlMs?: number;
}

function defaults(): MCPConfig {
  return { mcp: false, cacheTtlMs: 300000 };
}

export function cfg(runtimeConfig?: Record<string, Record<string, unknown>>): MCPConfig {
  return resolveNamespaceConfig(meta.ns, defaults(), runtimeConfig);
}
