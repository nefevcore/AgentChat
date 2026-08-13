// ============================================================
// src/plugins/builtin/hooks/mcp.ts —— MCP 工具发现与注册（照搬旧 agent-mcp）
//
// 基于 @modelcontextprotocol/sdk，仅负责：发现 MCP 服务器 → 注册工具。
//
// 适配新架构：
//   · 旧 preHook 注册 ctx.registerTool → runStartHook 中向 ctx.tools.set()
//   · 旧 ctx.runtimeConfig 配置 → getNamespaceConfig(config, NS_AGENT_MCP)
//   · logger → createLogger
//
// 依赖方向：仅依赖 src/core + @agents/config + 本层 types + @modelcontextprotocol/sdk。
// ============================================================

import * as fs from 'fs';
import { createLogger } from '@core/logger';
import { getNamespaceConfig } from '@agents/config';
import { NS_AGENT_MCP } from '../namespaces';
import type { AgentConfig } from '@agents/config';
import type { CurrentContext, RunStartHook } from '@core/context';
import type { ConfigField } from '../../schema';

const logger = createLogger('[agent-mcp]');

// ============================================================
// 类型（照搬旧 mcp-types）
// ============================================================

export interface MCPServerConfig {
  name: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  connectTimeoutMs?: number;
  insecure?: boolean;
  transport?: 'stdio' | 'http';
}

export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPromptDef {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface MCPServerDiscovery {
  serverName: string;
  connected: boolean;
  error?: string;
  tools: MCPToolDef[];
  resources: MCPResourceDef[];
  prompts: MCPPromptDef[];
}

// ============================================================
// MCP 客户端（照搬旧 mcp-client：SDK 动态 import）
// ============================================================

let _sdkClient: any;
let _sdkStreamableHttp: any;
let _sdkStdio: any;

async function _loadSDK() {
  if (!_sdkClient) {
    [_sdkClient, _sdkStreamableHttp, _sdkStdio] = await Promise.all([
      import('@modelcontextprotocol/sdk/client'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
    ]);
  }
  return { Client: _sdkClient.Client, StreamableHTTPClientTransport: _sdkStreamableHttp.StreamableHTTPClientTransport, StdioClientTransport: _sdkStdio.StdioClientTransport };
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, varName: string) => {
    return process.env[varName] ?? '';
  });
}

function isHttpTransport(config: MCPServerConfig): boolean {
  if (config.transport === 'http') return true;
  if (config.transport === 'stdio') return false;
  if (config.url) return true;
  return /^https?:\/\//i.test(config.command || '');
}

class MCPSDKClient {
  readonly serverName: string;
  private config: MCPServerConfig;
  private client: any = null;
  private transport: any = null;
  private _connected = false;
  private _serverVersion: { name: string; version: string } | null = null;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.serverName = config.name;
  }

  get connected(): boolean { return this._connected; }
  get serverVersion(): { name: string; version: string } | null { return this._serverVersion; }

  async connect(): Promise<void> {
    if (this._connected) return;

    const { Client } = await _loadSDK();
    this.client = new Client({ name: 'AgentChat', version: '1.0.0' });

    const url = this.config.url || (isHttpTransport(this.config) ? this.config.command : undefined);

    if (url) {
      const requestInit: RequestInit = {};
      if (this.config.headers) {
        requestInit.headers = { ...this.config.headers };
      }

      if (this.config.insecure) {
        const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        try {
          await this._connectHttp(url, requestInit);
        } finally {
          if (prev !== undefined) {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
          } else {
            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
          }
        }
      } else {
        await this._connectHttp(url, requestInit);
      }
    } else {
      await this._connectStdio();
    }
  }

  private async _connectHttp(baseUrl: string, requestInit: RequestInit): Promise<void> {
    const { StreamableHTTPClientTransport } = await _loadSDK();
    const url = new URL(baseUrl);
    logger.debug(`连接 HTTP 服务器 "${this.serverName}": ${url}`);

    this.transport = new StreamableHTTPClientTransport(url, { requestInit });

    try {
      await this.client.connect(this.transport);
      this._connected = true;
      this._serverVersion = this.client.getServerVersion?.() ?? null;
      logger.info(`服务器 "${this.serverName}" 已连接 (HTTP)`);
    } catch (err: any) {
      this._connected = false;
      throw new Error(`MCP HTTP 服务器 "${this.serverName}" 连接失败: ${err.message}`);
    }
  }

  private async _connectStdio(): Promise<void> {
    const { StdioClientTransport } = await _loadSDK();
    const command = this.config.command;
    if (!command) {
      throw new Error(`MCP 服务器 "${this.serverName}" 未配置 command（stdio 传输）`);
    }

    const args = this.config.args ?? [];
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (this.config.env) {
      for (const [key, value] of Object.entries(this.config.env)) {
        env[key] = resolveEnvVars(value);
      }
    }

    logger.debug(`启动 stdio 服务器 "${this.serverName}": ${command} ${args.join(' ')}`);

    this.transport = new StdioClientTransport({ command, args, env });

    try {
      await this.client.connect(this.transport);
      this._connected = true;
      this._serverVersion = this.client.getServerVersion?.() ?? null;
      logger.info(
        `服务器 "${this.serverName}" 已连接` +
        (this._serverVersion ? ` (${this._serverVersion.name} v${this._serverVersion.version})` : ''),
      );
    } catch (err: any) {
      this._connected = false;
      throw new Error(`MCP stdio 服务器 "${this.serverName}" 连接失败: ${err.message}`);
    }
  }

  disconnect(): void {
    this._connected = false;
    this.transport = null;
    this.client?.close?.().catch(() => {});
    this.client = null;
  }

  async listTools(): Promise<MCPToolDef[]> {
    if (!this._connected) await this.connect();
    try {
      const result = await this.client.listTools();
      return (result.tools ?? []).map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as MCPToolDef['inputSchema'],
      }));
    } catch (err: any) {
      if (/not\s*supported|method\s*not\s*found|not\s*implemented/i.test(err.message)) {
        logger.debug(`[MCP:${this.serverName}] tools 功能不可用`);
      } else {
        logger.warn(`[MCP:${this.serverName}] tools/list 失败: ${err.message}`);
      }
      return [];
    }
  }

  async listResources(): Promise<MCPResourceDef[]> {
    if (!this._connected) await this.connect();
    try {
      const result = await this.client.listResources();
      return (result.resources ?? []).map((r: any) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
    } catch { return []; }
  }

  async listPrompts(): Promise<MCPPromptDef[]> {
    if (!this._connected) await this.connect();
    try {
      const result = await this.client.listPrompts();
      return (result.prompts ?? []).map((p: any) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments?.map((a: any) => ({
          name: a.name,
          description: a.description,
          required: a.required,
        })),
      }));
    } catch { return []; }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this._connected) await this.connect();
    try {
      const result: any = await this.client.callTool({ name, arguments: args });
      const contents: any[] = result?.content ?? [];
      if (contents.length === 0) return '';
      return contents
        .filter((c: any) => c.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('\n');
    } catch (err: any) {
      return `MCP 工具 "${name}" 调用失败: ${err.message}`;
    }
  }

  async discover(): Promise<MCPServerDiscovery> {
    const result: MCPServerDiscovery = {
      serverName: this.serverName,
      connected: false,
      tools: [],
      resources: [],
      prompts: [],
    };

    try {
      await this.connect();
      result.connected = true;

      const [tools, resources, prompts] = await Promise.all([
        this.listTools(),
        this.listResources(),
        this.listPrompts(),
      ]);

      result.tools = tools;
      result.resources = resources;
      result.prompts = prompts;

      logger.info(`[MCP:${this.serverName}] 发现 ${tools.length} 工具, ${resources.length} 资源, ${prompts.length} 提示`);
    } catch (err: any) {
      result.error = err.message;
      logger.warn(`[MCP:${this.serverName}] 发现失败: ${err.message}`);
    }

    return result;
  }
}

interface CacheEntry {
  discovery: MCPServerDiscovery;
  timestamp: number;
}

class MCPDiscoveryManager {
  private clients: Map<string, MCPSDKClient> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTtlMs: number;

  constructor(cacheTtlMs: number = 300000) {
    this.cacheTtlMs = cacheTtlMs;
  }

  configure(servers: MCPServerConfig[]): void {
    const configuredNames = new Set(servers.filter(s => s.enabled !== false).map(s => s.name));
    for (const name of this.clients.keys()) {
      if (!configuredNames.has(name)) {
        this.clients.get(name)?.disconnect();
        this.clients.delete(name);
        this.cache.delete(name);
      }
    }

    for (const server of servers) {
      if (server.enabled === false) continue;
      if (!this.clients.has(server.name)) {
        logger.info(`[MCP] 创建客户端 "${server.name}" (${isHttpTransport(server) ? 'HTTP' : 'stdio'})`);
        this.clients.set(server.name, new MCPSDKClient(server));
      }
    }
  }

  async discoverAll(forceRefresh = false): Promise<MCPServerDiscovery[]> {
    const results: MCPServerDiscovery[] = [];
    const now = Date.now();

    for (const [name, client] of this.clients) {
      if (!forceRefresh) {
        const cached = this.cache.get(name);
        if (cached && cached.discovery.connected && (now - cached.timestamp) < this.cacheTtlMs) {
          results.push(cached.discovery);
          continue;
        }
      }

      const discovery = await client.discover();
      this.cache.set(name, { discovery, timestamp: now });
      results.push(discovery);
    }

    return results;
  }

  getClient(serverName: string): MCPSDKClient | undefined {
    return this.clients.get(serverName);
  }

  disconnectAll(): void {
    for (const client of this.clients.values()) {
      client.disconnect();
    }
    this.clients.clear();
    this.cache.clear();
  }
}

// ============================================================
// 配置解析 + turnStart 注册
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

/** open-mcp 钩子配置命名空间 Schema（agent.mcp；PluginDefinition.configs 声明，UI 弹窗内编辑） */
export const MCP_CONFIG_SCHEMA: ConfigField[] = [
  { name: 'mcpFile', label: 'MCP 配置文件', description: '服务器清单 .mcp 文件路径（含 servers 数组；内联 mcp 配置留在 config JSON）', type: 'file', accept: '.mcp' },
  { name: 'cacheTtlMs', label: '发现缓存 TTL', description: '工具发现结果缓存时长（毫秒）', type: 'number', default: 300000 },
];

/**
 * 整次执行开始（runStart）：发现并注册 MCP 工具（照搬旧 preHook）。
 * 配置：AgentConfig[NS_AGENT_MCP]（mcp / mcpFile / cacheTtlMs）。
 * 工厂烘焙：config 在 PluginHooks 工厂中传入。
 */
export function makeOpenMCPHook(config: AgentConfig): RunStartHook {
  return async (ctx: CurrentContext): Promise<void> => {
    const cfg = getNamespaceConfig(config, NS_AGENT_MCP) as Record<string, unknown>;
    const mcpEnabled = cfg.mcp === true || cfg.mcp === 'true';
    const mcpFile = typeof cfg.mcpFile === 'string' ? cfg.mcpFile : undefined;
    const cacheTtlMs = typeof cfg.cacheTtlMs === 'number' ? cfg.cacheTtlMs : 300000;

    let servers: MCPServerConfig[] = [];
    let resolvedCacheTtlMs = cacheTtlMs;

    // 外部文件优先
    if (mcpFile) {
      try {
        if (!fs.existsSync(mcpFile)) {
          logger.warn(`MCP 文件不存在: ${mcpFile}`);
          return;
        }
        const fileContent = fs.readFileSync(mcpFile, 'utf-8');
        const fileCfg = JSON.parse(fileContent);
        if (!fileCfg.servers || !Array.isArray(fileCfg.servers)) {
          logger.warn(`MCP 文件格式无效（缺少 servers 数组）: ${mcpFile}`);
          return;
        }
        servers = fileCfg.servers as MCPServerConfig[];
        resolvedCacheTtlMs = fileCfg.cacheTtlMs ?? cacheTtlMs;
        logger.info(`从外部文件加载 MCP 配置: ${mcpFile} (${servers.length} 个服务器)`);
      } catch (err: any) {
        logger.warn(`读取 MCP 文件失败 (${mcpFile}): ${err.message}`);
        return;
      }
    } else if (mcpEnabled) {
      // 内联 servers（agent 级 mcp 字段）
      const rawMCP = cfg.mcp;
      const mcpObj = (typeof rawMCP === 'object' && rawMCP !== null) ? rawMCP as Record<string, unknown> : null;
      if (mcpObj?.servers && Array.isArray(mcpObj.servers)) {
        servers = mcpObj.servers as MCPServerConfig[];
      }
    }

    if (servers.length === 0) return;

    try {
      const manager = getMCPManager(servers, resolvedCacheTtlMs);
      const discoveries = await manager.discoverAll();

      for (const d of discoveries) {
        if (!d.connected) continue;
        for (const tool of d.tools) {
          const client = manager.getClient(d.serverName);
          ctx.tools.set(tool.name, {
            name: tool.name,
            label: `[MCP:${d.serverName}] ${tool.name}`,
            description: tool.description,
            definition: {
              type: 'function',
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
              if (!client) return `MCP 服务器 "${d.serverName}" 未连接`;
              return await client.callTool(tool.name, args);
            },
          });
        }
      }

      const connected = discoveries.filter(d => d.connected);
      logger.info(`发现 ${connected.length} 个服务器, ${connected.reduce((s, d) => s + d.tools.length, 0)} 个工具`);
    } catch (err: any) {
      logger.warn(`发现失败: ${err.message}`);
    }
  };
}
