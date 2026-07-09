// ============================================================
// MCP stdio 客户端 —— 连接 MCP 服务器并发现工具/资源/提示
//
// 通过 stdio（stdin/stdout）与 MCP 服务器进程通信，
// 使用 JSON-RPC 2.0 协议。支持：
//   · initialize 握手
//   · tools/list / resources/list / prompts/list 发现
//   · tools/call 工具调用
//   · 自动重连与缓存
// ============================================================

import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface } from 'readline';
import {
  MCPServerConfig,
  MCPToolDef,
  MCPResourceDef,
  MCPPromptDef,
  MCPInitializeResult,
  MCPServerDiscovery,
  JSONRPCRequest,
  JSONRPCResponse,
} from './mcp-types';

// ============================================================
// 工具函数
// ============================================================

/** 解析字符串中的 ${VAR_NAME} 环境变量引用 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, varName: string) => {
    return process.env[varName] ?? '';
  });
}

/** 判断是否为 JSON-RPC 响应 */
function isResponse(msg: unknown): msg is JSONRPCResponse {
  return typeof msg === 'object' && msg !== null && 'id' in msg && ('result' in msg || 'error' in msg);
}

// ============================================================
// MCPClient —— 单个 MCP 服务器的 stdio 连接
// ============================================================

export class MCPClient {
  readonly serverName: string;

  private config: MCPServerConfig;
  private process: ChildProcess | null = null;
  private rl: Interface | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private buffer = '';
  private _connected = false;
  private _initialized = false;
  private _serverCapabilities: MCPInitializeResult | null = null;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.serverName = config.name;
  }

  get connected(): boolean {
    return this._connected && this.process?.exitCode === null;
  }

  get capabilities(): MCPInitializeResult | null {
    return this._serverCapabilities;
  }

  // ---- 连接管理 ----

  /**
   * 启动 MCP 服务器进程并完成 initialize 握手。
   */
  async connect(): Promise<void> {
    if (this._connected && this._initialized) return;

    const timeoutMs = this.config.connectTimeoutMs ?? 30000;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`MCP 服务器 "${this.serverName}" 连接超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      const env: Record<string, string> = { ...process.env as Record<string, string> };
      if (this.config.env) {
        for (const [key, value] of Object.entries(this.config.env)) {
          env[key] = resolveEnvVars(value);
        }
      }

      const args = this.config.args ?? [];
      console.log(`[MCP] 启动服务器 "${this.serverName}": ${this.config.command} ${args.join(' ')}`);

      try {
        this.process = spawn(this.config.command, args, {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
        });
      } catch (err: any) {
        clearTimeout(timer);
        reject(new Error(`MCP 服务器 "${this.serverName}" 启动失败: ${err.message}`));
        return;
      }

      // 行级读取 stdout
      this.rl = createInterface({ input: this.process.stdout!, crlfDelay: Infinity });

      this.rl.on('line', (line: string) => {
        this._handleLine(line);
      });

      // stderr 只记录日志
      if (this.process.stderr) {
        this.process.stderr.on('data', (data: Buffer) => {
          const msg = data.toString('utf-8').trim();
          if (msg) {
            console.log(`[MCP:${this.serverName}] ${msg}`);
          }
        });
      }

      this.process.on('exit', (code) => {
        this._connected = false;
        this._initialized = false;
        console.log(`[MCP] 服务器 "${this.serverName}" 已退出 (code=${code})`);
        // 拒绝所有未完成的请求
        for (const [id, { reject: rej }] of this.pending) {
          rej(new Error(`MCP 服务器 "${this.serverName}" 意外退出`));
          this.pending.delete(id);
        }
      });

      this.process.on('error', (err) => {
        this._connected = false;
        clearTimeout(timer);
        reject(new Error(`MCP 服务器 "${this.serverName}" 进程错误: ${err.message}`));
      });

      // 等待进程就绪后发送 initialize
      this._connected = true;

      this._initialize(timer, resolve, reject);
    });
  }

  /**
   * 断开连接并清理进程。
   */
  disconnect(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this._connected = false;
    this._initialized = false;
    this._serverCapabilities = null;
  }

  // ---- 协议：initialize 握手 ----

  private async _initialize(
    timer: NodeJS.Timeout,
    resolve: () => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    try {
      const result = await this._sendRequest<MCPInitializeResult>('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
        clientInfo: {
          name: 'AgentChat',
          version: '1.0.0',
        },
      });

      this._serverCapabilities = result;
      this._initialized = true;

      // 发送 initialized 通知
      this._sendNotification('notifications/initialized', {});

      clearTimeout(timer);
      console.log(`[MCP] 服务器 "${this.serverName}" 已连接 (协议 v${result.protocolVersion})`);
      resolve();
    } catch (err: any) {
      clearTimeout(timer);
      reject(new Error(`MCP 服务器 "${this.serverName}" initialize 失败: ${err.message}`));
    }
  }

  // ---- 能力发现 ----

  /**
   * 列出 MCP 服务器提供的工具。
   */
  async listTools(): Promise<MCPToolDef[]> {
    if (!this._initialized) await this.connect();
    try {
      const result = await this._sendRequest<{ tools: MCPToolDef[] }>('tools/list', {});
      return result.tools ?? [];
    } catch (err: any) {
      console.warn(`[MCP:${this.serverName}] tools/list 失败: ${err.message}`);
      return [];
    }
  }

  /**
   * 列出 MCP 服务器提供的资源。
   */
  async listResources(): Promise<MCPResourceDef[]> {
    if (!this._initialized) await this.connect();
    try {
      const result = await this._sendRequest<{ resources: MCPResourceDef[] }>('resources/list', {});
      return result.resources ?? [];
    } catch (err: any) {
      console.warn(`[MCP:${this.serverName}] resources/list 失败: ${err.message}`);
      return [];
    }
  }

  /**
   * 列出 MCP 服务器提供的提示模板。
   */
  async listPrompts(): Promise<MCPPromptDef[]> {
    if (!this._initialized) await this.connect();
    try {
      const result = await this._sendRequest<{ prompts: MCPPromptDef[] }>('prompts/list', {});
      return result.prompts ?? [];
    } catch (err: any) {
      console.warn(`[MCP:${this.serverName}] prompts/list 失败: ${err.message}`);
      return [];
    }
  }

  /**
   * 调用 MCP 工具并返回文本结果。
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this._initialized) await this.connect();
    try {
      const result = await this._sendRequest<{ content: Array<{ type: string; text?: string }> }>(
        'tools/call',
        { name, arguments: args },
      );
      const contents = result.content ?? [];
      return contents
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text!)
        .join('\n');
    } catch (err: any) {
      return `MCP 工具 "${name}" 调用失败: ${err.message}`;
    }
  }

  // ---- 完整发现 ----

  /**
   * 执行完整的服务器发现（工具 + 资源 + 提示）。
   */
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

      console.log(
        `[MCP:${this.serverName}] 发现 ${tools.length} 工具, ${resources.length} 资源, ${prompts.length} 提示`,
      );
    } catch (err: any) {
      result.error = err.message;
      console.warn(`[MCP:${this.serverName}] 发现失败: ${err.message}`);
    }

    return result;
  }

  // ---- 底层 JSON-RPC 通信 ----

  private async _sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++this.requestId;
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });

      const payload = JSON.stringify(request) + '\n';
      if (!this.process?.stdin) {
        reject(new Error('MCP 进程 stdin 不可用'));
        return;
      }
      this.process.stdin.write(payload);
    });
  }

  private _sendNotification(method: string, params: Record<string, unknown>): void {
    const notification = {
      jsonrpc: '2.0' as const,
      method,
      params,
    };
    const payload = JSON.stringify(notification) + '\n';
    this.process?.stdin?.write(payload);
  }

  private _handleLine(line: string): void {
    try {
      const msg = JSON.parse(line);
      if (isResponse(msg)) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;

        this.pending.delete(msg.id);

        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
      // 通知消息暂不处理
    } catch {
      // 非 JSON 行（如日志），忽略
    }
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
  private clients: Map<string, MCPClient> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTtlMs: number;

  constructor(cacheTtlMs: number = 300000) {
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * 初始化所有配置的 MCP 服务器客户端。
   */
  configure(servers: MCPServerConfig[]): void {
    // 清理不再配置的客户端
    const configuredNames = new Set(servers.filter(s => s.enabled !== false).map(s => s.name));
    for (const name of this.clients.keys()) {
      if (!configuredNames.has(name)) {
        this.clients.get(name)?.disconnect();
        this.clients.delete(name);
        this.cache.delete(name);
      }
    }

    // 创建新客户端
    for (const server of servers) {
      if (server.enabled === false) continue;
      if (!this.clients.has(server.name)) {
        this.clients.set(server.name, new MCPClient(server));
      }
    }
  }

  /**
   * 发现所有 MCP 服务器的工具/资源/提示。
   * 在缓存有效期内直接返回缓存结果。
   */
  async discoverAll(forceRefresh = false): Promise<MCPServerDiscovery[]> {
    const results: MCPServerDiscovery[] = [];
    const now = Date.now();

    for (const [name, client] of this.clients) {
      // 检查缓存
      if (!forceRefresh) {
        const cached = this.cache.get(name);
        if (cached && (now - cached.timestamp) < this.cacheTtlMs) {
          results.push(cached.discovery);
          continue;
        }
      }

      // 执行发现
      const discovery = await client.discover();
      this.cache.set(name, { discovery, timestamp: now });
      results.push(discovery);
    }

    return results;
  }

  /**
   * 收集所有服务器发现的工具（去重，按名称合并）。
   */
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

  /**
   * 按服务器名称获取客户端（用于 tools/call）。
   */
  getClient(serverName: string): MCPClient | undefined {
    return this.clients.get(serverName);
  }

  /**
   * 断开所有连接。
   */
  disconnectAll(): void {
    for (const client of this.clients.values()) {
      client.disconnect();
    }
    this.clients.clear();
    this.cache.clear();
  }
}
