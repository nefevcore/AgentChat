// ============================================================
// MCP 客户端 —— 基于 @modelcontextprotocol/sdk
//
// 封装官方 SDK 的 Client + Transport，支持：
//   · Streamable HTTP（url + headers，如 vscode-adt）
//   · Stdio（command + args，向后兼容）
//   · 工具发现 / 调用 / 缓存管理
//
// SDK 是 ESM 模块，CJS 项目通过动态 import() 延迟加载。
// ============================================================

import {
  MCPServerConfig,
  MCPToolDef,
  MCPResourceDef,
  MCPPromptDef,
  MCPServerDiscovery,
} from './mcp-types';
import { logger } from '../../../../utils/logger';

// ============================================================
// 动态加载 SDK（延迟 import，避免 CJS/ESM 冲突）
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

// ============================================================
// 工具函数
// ============================================================

/** 解析字符串中的 ${VAR_NAME} 环境变量引用 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, varName: string) => {
    return process.env[varName] ?? '';
  });
}

/** 判断是否 HTTP 传输 */
function isHttpTransport(config: MCPServerConfig): boolean {
  if (config.transport === 'http') return true;
  if (config.transport === 'stdio') return false;
  if (config.url) return true;
  return /^https?:\/\//i.test(config.command || '');
}

// ============================================================
// MCPSDKClient —— 单个 MCP 服务器（基于官方 SDK）
// ============================================================

export class MCPSDKClient {
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

  get connected(): boolean {
    return this._connected;
  }

  get serverVersion(): { name: string; version: string } | null {
    return this._serverVersion;
  }

  // ---- 连接管理 ----

  async connect(): Promise<void> {
    if (this._connected) return;

    const { Client } = await _loadSDK();
    this.client = new Client({ name: 'AgentChat', version: '1.0.0' });

    const url = this.config.url || (isHttpTransport(this.config) ? this.config.command : undefined);

    if (url) {
      // ---- HTTP（Streamable HTTP）----
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
    logger.debug(`[MCP] 连接 HTTP 服务器 "${this.serverName}": ${url}`);

    this.transport = new StreamableHTTPClientTransport(url, { requestInit });

    try {
      await this.client.connect(this.transport);
      this._connected = true;
      this._serverVersion = this.client.getServerVersion?.() ?? null;
      logger.info(`[MCP] 服务器 "${this.serverName}" 已连接 (HTTP)`);
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

    logger.debug(`[MCP] 启动 stdio 服务器 "${this.serverName}": ${command} ${args.join(' ')}`);

    this.transport = new StdioClientTransport({ command, args, env });

    try {
      await this.client.connect(this.transport);
      this._connected = true;
      this._serverVersion = this.client.getServerVersion?.() ?? null;
      logger.info(
        `[MCP] 服务器 "${this.serverName}" 已连接` +
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

  // ---- 能力发现 ----

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
    } catch (err: any) {
      return [];
    }
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
    } catch (err: any) {
      return [];
    }
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

  // ---- 完整发现 ----

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

      logger.info(
        `[MCP:${this.serverName}] 发现 ${tools.length} 工具, ${resources.length} 资源, ${prompts.length} 提示`,
      );
    } catch (err: any) {
      result.error = err.message;
      logger.warn(`[MCP:${this.serverName}] 发现失败: ${err.message}`);
    }

    return result;
  }
}

// ============================================================
// MCPDiscoveryManager —— 多服务器管理器（带缓存）
// ============================================================

interface CacheEntry {
  discovery: MCPServerDiscovery;
  timestamp: number;
}

export class MCPDiscoveryManager {
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

  async collectAllTools(): Promise<MCPToolDef[]> {
    const discoveries = await this.discoverAll();
    const seen = new Set<string>();
    const tools: MCPToolDef[] = [];

    for (const d of discoveries) {
      if (!d.connected) continue;
      for (const tool of d.tools) {
        if (!seen.has(tool.name)) {
          seen.add(tool.name);
          tools.push(tool);
        }
      }
    }

    return tools;
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
