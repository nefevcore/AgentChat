// ============================================================
// agent-mcp 扩展 —— MCP 工具发现与注册
//
//   基于 @modelcontextprotocol/sdk，仅负责：
//   发现 MCP 服务器 → 注册工具 (ctx.registerTool)
// ============================================================

import * as fs from 'fs';
import { AgentContext, Extension, PreProcessHook } from '@core/types';
import { meta, cfg } from './meta';
import { MCPServerConfig } from './mcp-types';
import { MCPDiscoveryManager } from './mcp-client';
import { logger } from '../../../../utils/logger';

// ============================================================
// MCP 配置解析
// ============================================================

function resolveMCPConfig(ctx: AgentContext): { servers: MCPServerConfig[]; cacheTtlMs?: number } | null {
  const mcpCfg = cfg(ctx.runtimeConfig);
  if (!mcpCfg.mcp && !mcpCfg.mcpFile) return null;

  // 外部文件优先
  if (mcpCfg.mcpFile) {
    try {
      if (!fs.existsSync(mcpCfg.mcpFile)) {
        logger.warn(`[agent-mcp] MCP 文件不存在: ${mcpCfg.mcpFile}`);
        return null;
      }
      const fileContent = fs.readFileSync(mcpCfg.mcpFile, 'utf-8');
      const fileCfg = JSON.parse(fileContent);

      if (!fileCfg.servers || !Array.isArray(fileCfg.servers)) {
        logger.warn(`[agent-mcp] MCP 文件格式无效（缺少 servers 数组）: ${mcpCfg.mcpFile}`);
        return null;
      }

      logger.info(`[agent-mcp] 从外部文件加载 MCP 配置: ${mcpCfg.mcpFile} (${fileCfg.servers.length} 个服务器)`);
      return {
        servers: fileCfg.servers as MCPServerConfig[],
        cacheTtlMs: fileCfg.cacheTtlMs ?? mcpCfg.cacheTtlMs,
      };
    } catch (err: any) {
      logger.warn(`[agent-mcp] 读取 MCP 文件失败 (${mcpCfg.mcpFile}): ${err.message}`);
      return null;
    }
  }

  // 内联 servers（从 runtimeConfig 的 agent 级 mcp 字段读取）
  const agentNs = ctx.runtimeConfig?.['extension.agent_mcp'] as any;
  const rawMCP = agentNs?.mcp;
  const mcpObj = (typeof rawMCP === 'object' && rawMCP !== null) ? rawMCP as Record<string, unknown> : null;

  if (mcpObj?.servers && Array.isArray(mcpObj.servers)) {
    return {
      servers: mcpObj.servers as MCPServerConfig[],
      cacheTtlMs: mcpCfg.cacheTtlMs,
    };
  }

  return null;
}

// ============================================================
// 全局 MCP 发现管理器（单例，跨请求重用连接和缓存）
// ============================================================

let _mcpManager: MCPDiscoveryManager | null = null;
let _mcpManagerConfigKey: string = '';

function getMCPManager(servers: MCPServerConfig[], cacheTtlMs?: number): MCPDiscoveryManager {
  const configKey = JSON.stringify({ servers: servers.map(s => ({ ...s, env: undefined })), cacheTtlMs });
  if (_mcpManager && _mcpManagerConfigKey === configKey) {
    return _mcpManager;
  }

  _mcpManager?.disconnectAll();
  _mcpManager = new MCPDiscoveryManager(cacheTtlMs);
  _mcpManager.configure(servers);
  _mcpManagerConfigKey = configKey;

  return _mcpManager;
}

// ============================================================
// PreHook
// ============================================================

const preHook: PreProcessHook = async (ctx) => {
  const mcpCfg = resolveMCPConfig(ctx);
  if (!mcpCfg?.servers || mcpCfg.servers.length === 0) return ctx;

  try {
    const manager = getMCPManager(mcpCfg.servers, mcpCfg.cacheTtlMs);
    const discoveries = await manager.discoverAll();

    for (const d of discoveries) {
      if (!d.connected) continue;

      if (ctx.registerTool) {
        for (const tool of d.tools) {
          ctx.registerTool({
            name: tool.name,
            ns: 'tool.' + tool.name,
            label: `[MCP:${d.serverName}] ${tool.name}`,
            description: tool.description,
            definition: {
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description ?? `MCP 工具 (${d.serverName})`,
                parameters: {
                  type: tool.inputSchema.type,
                  properties: tool.inputSchema.properties ?? {},
                  ...(tool.inputSchema.required ? { required: tool.inputSchema.required } : {}),
                },
              },
            },
            execute: async (args: Record<string, any>) => {
              const client = manager.getClient(d.serverName);
              if (!client) return `MCP 服务器 "${d.serverName}" 未连接`;
              return await client.callTool(tool.name, args);
            },
          });
        }
      }
    }

    const connected = discoveries.filter(d => d.connected);
    logger.info(`[agent-mcp] 发现 ${connected.length} 个服务器, ${connected.reduce((s, d) => s + d.tools.length, 0)} 个工具`);
  } catch (err: any) {
    logger.warn(`[agent-mcp] 发现失败: ${err.message}`);
  }

  return ctx;
};

// ============================================================
// Extension 统一入口
// ============================================================

export const extension: Extension = {
  ...meta,
  preHook,
};
