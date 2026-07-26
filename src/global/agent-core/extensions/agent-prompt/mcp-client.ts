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
  JSONRPCNotification,
} from './mcp-types';
import { logger } from '../../../../utils/logger';

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

/** 判断错误是否表示服务器不支持该功能（而非真正的故障） */
function _isNotSupported(message: string): boolean {
  const lower = message.toLowerCase();
  return /not\s*supported|method\s*not\s*found|not\s*implemented|unknown\s*method/i.test(lower);
}

/** 判断 command 是否为 HTTP(S) URL */
function _isHttpUrl(command: string): boolean {
  return /^https?:\/\//i.test(command);
}

/**
 * 尝试修复常见的 JSON 格式瑕疵。
 * 某些 MCP 服务器返回的 JSON 可能有小问题（如数字后多余字符），
 * 尝试修复后再解析。
 */
function _tryParseJson(raw: string): JSONRPCResponse {
  // 直接尝试解析
  try {
    return JSON.parse(raw) as JSONRPCResponse;
  } catch {}

  // 修复1: 数字后紧跟的非法字符（如 32601- → 32601）
  let fixed = raw.replace(/(\d+)-([,\s}\]])/g, '$1$2');
  try {
    return JSON.parse(fixed) as JSONRPCResponse;
  } catch {}

  // 修复2: 去掉 BOM 头
  fixed = raw.replace(/^\uFEFF/, '');
  try {
    return JSON.parse(fixed) as JSONRPCResponse;
  } catch {}

  throw new Error(`无法解析 JSON: ${raw.slice(0, 300)}`);
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
      logger.debug(`[MCP] 启动服务器 "${this.serverName}": ${this.config.command} ${args.join(' ')}`);

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
            logger.debug(`[MCP:${this.serverName}] ${msg}`);
          }
        });
      }

      this.process.on('exit', (code) => {
        this._connected = false;
        this._initialized = false;
        logger.info(`[MCP] 服务器 "${this.serverName}" 已退出 (code=${code})`);
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
      logger.info(`[MCP] 服务器 "${this.serverName}" 已连接 (协议 v${result.protocolVersion})`);
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
      if (_isNotSupported(err.message)) {
        logger.debug(`[MCP:${this.serverName}] tools 功能不可用（服务器不支持）`);
      } else {
        logger.warn(`[MCP:${this.serverName}] tools/list 请求失败: ${err.message}`);
      }
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
      if (_isNotSupported(err.message)) {
        logger.debug(`[MCP:${this.serverName}] resources 功能不可用（服务器不支持）`);
      } else {
        logger.warn(`[MCP:${this.serverName}] resources/list 请求失败: ${err.message}`);
      }
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
      if (_isNotSupported(err.message)) {
        logger.debug(`[MCP:${this.serverName}] prompts 功能不可用（服务器不支持）`);
      } else {
        logger.warn(`[MCP:${this.serverName}] prompts/list 请求失败: ${err.message}`);
      }
      return [];
    }
  }

  /**
   * 调用 MCP 工具并返回文本结果。
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this._initialized) await this.connect();
    try {
      const result = await this._sendRequest<{ content: Array<{ type: string; text?: unknown }> }>(
        'tools/call',
        { name, arguments: args },
      );
      const contents = result.content ?? [];
      return contents
        .filter(c => c.type === 'text' && c.text != null)
        .map(c => (typeof c.text === 'string' ? c.text : JSON.stringify(c.text)))
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

      logger.info(
        `[MCP:${this.serverName}] 发现 ${tools.length} 工具, ${resources.length} 资源, ${prompts.length} 提示`,
      );
    } catch (err: any) {
      result.error = err.message;
      logger.warn(`[MCP:${this.serverName}] 发现失败: ${err.message}`);
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
// HttpMCPClient —— MCP HTTP(S) 传输客户端
//
// 通过 HTTP POST 发送 JSON-RPC 请求，适用于远程 MCP 服务器。
// 与 MCPClient（stdio）拥有相同的公共接口，可互换使用。
// ============================================================

export class HttpMCPClient {
  readonly serverName: string;

  private url: string;
  private config: MCPServerConfig;
  private requestId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private _initialized = false;
  private _serverCapabilities: MCPInitializeResult | null = null;
  private _connected = false;
  private _abortController: AbortController | null = null;
  private _insecure: boolean;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.serverName = config.name;
    this.url = config.command.replace(/\/$/, ''); // 去除末尾斜杠
    this._insecure = config.insecure === true;
  }

  get connected(): boolean {
    return this._connected && this._initialized;
  }

  get capabilities(): MCPInitializeResult | null {
    return this._serverCapabilities;
  }

  // ---- 连接管理 ----

  async connect(): Promise<void> {
    if (this._initialized) return;

    const timeoutMs = this.config.connectTimeoutMs ?? 30000;
    this._abortController = new AbortController();
    const timer = setTimeout(() => this._abortController!.abort(), timeoutMs);

    try {
      logger.debug(`[MCP] 连接 HTTP 服务器 "${this.serverName}": ${this.url}`);

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
      this._connected = true;

      // 发送 initialized 通知
      await this._sendNotification('notifications/initialized', {});

      clearTimeout(timer);
      logger.info(`[MCP] HTTP 服务器 "${this.serverName}" 已连接 (协议 v${result.protocolVersion})`);
    } catch (err: any) {
      clearTimeout(timer);

      // 如果 initialize 不被支持（Method not found），跳过握手直接使用
      if (_isNotSupported(err.message)) {
        logger.info(`[MCP] HTTP 服务器 "${this.serverName}" 不支持 initialize，跳过握手直连`);
        this._initialized = true;
        this._connected = true;
        return;
      }

      this._connected = false;
      throw new Error(`MCP HTTP 服务器 "${this.serverName}" initialize 失败: ${err.message}`);
    }
  }

  disconnect(): void {
    this._abortController?.abort();
    this._abortController = null;
    this._connected = false;
    this._initialized = false;
    this._serverCapabilities = null;
    // 拒绝所有未完成的请求
    for (const [id, { reject: rej }] of this.pending) {
      rej(new Error(`MCP HTTP 服务器 "${this.serverName}" 已断开`));
      this.pending.delete(id);
    }
  }

  // ---- 能力发现 ----

  async listTools(): Promise<MCPToolDef[]> {
    if (!this._initialized) await this.connect();
    try {
      const result = await this._sendRequest<{ tools: MCPToolDef[] }>('tools/list', {});
      return result.tools ?? [];
    } catch (err: any) {
      if (_isNotSupported(err.message)) {
        logger.debug(`[MCP:${this.serverName}] tools 功能不可用（服务器不支持）`);
      } else {
        logger.warn(`[MCP:${this.serverName}] tools/list 请求失败: ${err.message}`);
      }
      return [];
    }
  }

  async listResources(): Promise<MCPResourceDef[]> {
    if (!this._initialized) await this.connect();
    try {
      const result = await this._sendRequest<{ resources: MCPResourceDef[] }>('resources/list', {});
      return result.resources ?? [];
    } catch (err: any) {
      if (_isNotSupported(err.message)) {
        logger.debug(`[MCP:${this.serverName}] resources 功能不可用（服务器不支持）`);
      } else {
        logger.warn(`[MCP:${this.serverName}] resources/list 请求失败: ${err.message}`);
      }
      return [];
    }
  }

  async listPrompts(): Promise<MCPPromptDef[]> {
    if (!this._initialized) await this.connect();
    try {
      const result = await this._sendRequest<{ prompts: MCPPromptDef[] }>('prompts/list', {});
      return result.prompts ?? [];
    } catch (err: any) {
      if (_isNotSupported(err.message)) {
        logger.debug(`[MCP:${this.serverName}] prompts 功能不可用（服务器不支持）`);
      } else {
        logger.warn(`[MCP:${this.serverName}] prompts/list 请求失败: ${err.message}`);
      }
      return [];
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this._initialized) await this.connect();
    try {
      const result = await this._sendRequest<{ content: Array<{ type: string; text?: unknown }> }>(
        'tools/call',
        { name, arguments: args },
      );
      const contents = result.content ?? [];
      return contents
        .filter(c => c.type === 'text' && c.text != null)
        .map(c => (typeof c.text === 'string' ? c.text : JSON.stringify(c.text)))
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

  // ---- 底层 JSON-RPC over HTTP ----

  /**
   * 发送 HTTP 请求，当配置 insecure=true 时临时跳过 TLS 证书验证。
   */
  private async _fetch(url: string, init: RequestInit): Promise<Response> {
    if (this._insecure) {
      const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      try {
        return await fetch(url, init);
      } finally {
        if (prev !== undefined) {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
        } else {
          delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        }
      }
    }
    return fetch(url, init);
  }

  private async _sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++this.requestId;
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const signal = this._abortController?.signal;

    let response: Response;
    try {
      response = await this._fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(request),
        signal,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`MCP HTTP 服务器 "${this.serverName}" 请求超时`);
      }
      throw new Error(`MCP HTTP 请求失败: ${err.message}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `MCP HTTP 服务器 "${this.serverName}" 返回 HTTP ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    // 先读文本再解析 JSON，使用容错解析处理常见格式瑕疵
    const rawText = await response.text();
    const body = _tryParseJson(rawText);

    if (body.error) {
      throw new Error(body.error.message);
    }

    return body.result as T;
  }

  private async _sendNotification(method: string, params: Record<string, unknown>): Promise<void> {
    const notification: JSONRPCNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const signal = this._abortController?.signal;

    try {
      // 通知类消息：发送后不关心响应
      await this._fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(notification),
        signal,
      });
    } catch {
      // 通知失败可忽略
    }
  }
}

// ============================================================
// MCPDiscoveryManager —— 多服务器管理器（带缓存）
// ============================================================

/** MCP 客户端联合类型（stdio 或 HTTP） */
type MCPClientLike = MCPClient | HttpMCPClient;

interface CacheEntry {
  discovery: MCPServerDiscovery;
  timestamp: number;
}

/** 判断配置应使用哪种传输方式 */
function _resolveTransport(config: MCPServerConfig): 'stdio' | 'http' {
  if (config.transport) return config.transport;
  return _isHttpUrl(config.command) ? 'http' : 'stdio';
}

export class MCPDiscoveryManager {
  private clients: Map<string, MCPClientLike> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTtlMs: number;

  constructor(cacheTtlMs: number = 300000) {
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * 初始化所有配置的 MCP 服务器客户端。
   * 根据 command 自动选择传输方式：HTTP URL → HttpMCPClient，否则 → stdio MCPClient。
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

    // 创建新客户端（根据传输方式选择类型）
    for (const server of servers) {
      if (server.enabled === false) continue;
      if (!this.clients.has(server.name)) {
        const transport = _resolveTransport(server);
        if (transport === 'http') {
          logger.info(`[MCP] 为 "${server.name}" 创建 HTTP 客户端: ${server.command}`);
          this.clients.set(server.name, new HttpMCPClient(server));
        } else {
          this.clients.set(server.name, new MCPClient(server));
        }
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
      // 检查缓存（失败结果不缓存，确保下次会重试）
      if (!forceRefresh) {
        const cached = this.cache.get(name);
        if (cached && cached.discovery.connected && (now - cached.timestamp) < this.cacheTtlMs) {
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
  getClient(serverName: string): MCPClientLike | undefined {
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
