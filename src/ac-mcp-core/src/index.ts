// ============================================================
// ac-mcp-core/src/index.ts —— MCP 客户端纯库（M14）
//
// src agent-mcp 的 mcp.ts 平移重构（零 cordis 依赖；协议实现住纯库、
// 注册中心/装配住 ac-mcp 行——"协议实现/重算法 → 纯库包"）：
//   · McpConnection       连接抽象（connect/listTools/callTool/close）
//   · createSdkConnection 官方 SDK 包装（HTTP[StreamableHTTP] /
//     stdio 双传输；SDK 动态 import——依赖显式声明于 package.json）
//   · insecure 服务器（自签名证书）：per-server undici Agent 关闭
//     本连接的证书校验，绝不触碰全局 NODE_TLS_REJECT_UNAUTHORIZED
//     （src 踩坑：环境变量只在建连瞬间生效，连接池重建后间歇性
//     "fetch failed"）
//   · describeError       展开 err.cause 链（Node fetch 的真实原因
//     在 cause，message 只有 "fetch failed"）——实现住 ac-error-core
//     纯库（ac-llm 重试判定/loop 收束诊断共享），本包 re-export 维持
//     既有 API 面
//   · resolveEnvVars      stdio env 的 ${VAR} 展开
//   · pickToolName        撞名命名空间策略（裸名 → `${server}__${name}`
//     回退；仍撞 → null 跳过）
//
// 测试注入面：createSdkConnection 的 loaders（loadSdk/loadUndici）
// 可注入假实现——纯库单测零网络零子进程。
// ============================================================

/** MCP 服务器配置（全局注册单位；transport 缺省按 url/command 推断） */
export interface McpServerConfig {
  name: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  connectTimeoutMs?: number;
  /** 自签名证书放行（per-server dispatcher，不动全局） */
  insecure?: boolean;
  transport?: 'stdio' | 'http';
}

/** MCP 工具定义（inputSchema 为 JSON Schema） */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** 工具调用结果（content text 项拼接；协议级 isError 由调用方判断） */
export interface McpCallResult {
  text: string;
  isError?: boolean;
}

/** 连接抽象（ac-mcp 服务消费；测试注入假实现） */
export interface McpConnection {
  readonly serverName: string;
  readonly connected: boolean;
  connect(): Promise<void>;
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): void;
}

// ============================================================
// 纯工具函数
// ============================================================

// describeError 实现 2026-09-05 迁至 ac-error-core 纯库（ac-llm 瞬时
// 网络错误重试与 ac-agent-loop 收束诊断共享同源判定）；此处 re-export
// 维持本包既有 API 面（下方连接/调用失败诊断继续使用）
export { describeError } from 'ac-error-core';
import { describeError } from 'ac-error-core';

/** stdio env 的 ${VAR} 展开（缺失变量展开为空串） */
export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, varName: string) => process.env[varName] ?? '');
}

/** 传输判定：显式 transport 优先 → url → http(s) command；缺省 stdio */
export function isHttpTransport(config: McpServerConfig): boolean {
  if (config.transport === 'http') return true;
  if (config.transport === 'stdio') return false;
  if (config.url) return true;
  return /^https?:\/\//i.test(config.command ?? '');
}

/**
 * 撞名命名空间策略：裸名优先；已被占用（含其他 MCP 服务器/本地工具）
 * → `${server}__${name}` 前缀回退；仍占用 → null（跳过并告警）。
 * @param taken 已占用的工具名集合（调用方维护，含本次会注册的名字）
 */
export function pickToolName(server: string, toolName: string, taken: Set<string>): string | null {
  if (!taken.has(toolName)) return toolName;
  const prefixed = `${server}__${toolName}`;
  return taken.has(prefixed) ? null : prefixed;
}

// ============================================================
// SDK 包装（动态 import；loaders 可注入）
// ============================================================

/** 官方 SDK 面（loaders 注入点；any——SDK 类型不进纯库契约） */
export interface McpSdk {
  Client: new (options: unknown) => SdkClientLike;
  StreamableHTTPClientTransport: new (url: URL, options?: unknown) => unknown;
  StdioClientTransport: new (options: unknown) => unknown;
}

/** SDK Client 最小面（结构化包装，不泄露 SDK 类型） */
export interface SdkClientLike {
  connect(transport: unknown, options?: unknown): Promise<void>;
  close(): Promise<void> | void;
  listTools(): Promise<{ tools?: Array<{ name: string; description?: string; inputSchema?: McpToolDef['inputSchema'] }> }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
  getServerVersion?(): { name: string; version: string } | null;
}

/** undici 面（insecure dispatcher 用） */
export interface UndiciLike {
  Agent: new (options: unknown) => { close(): void };
  fetch(input: unknown, init?: unknown): Promise<unknown>;
}

/** SDK 加载器（默认动态 import 官方包；测试可注入） */
export type LoadSdk = () => Promise<McpSdk>;
/** undici 加载器（默认动态 import；测试可注入） */
export type LoadUndici = () => Promise<UndiciLike>;

const defaultLoadSdk: LoadSdk = async () => {
  const [client, http, stdio] = await Promise.all([
    import('@modelcontextprotocol/sdk/client'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  return {
    Client: client.Client as unknown as McpSdk['Client'],
    StreamableHTTPClientTransport: http.StreamableHTTPClientTransport as unknown as McpSdk['StreamableHTTPClientTransport'],
    StdioClientTransport: stdio.StdioClientTransport as unknown as McpSdk['StdioClientTransport'],
  };
};

const defaultLoadUndici: LoadUndici = async () => import('undici') as unknown as UndiciLike;

/** 连接选项（loader 注入口） */
export interface SdkConnectionOptions {
  loadSdk?: LoadSdk;
  loadUndici?: LoadUndici;
}

/** 官方 SDK 连接实现（懒建连：connect 后缓存；close 幂等） */
export class SdkConnection implements McpConnection {
  readonly serverName: string;

  private readonly config: McpServerConfig;
  private readonly loadSdk: LoadSdk;
  private readonly loadUndici: LoadUndici;
  private client: SdkClientLike | null = null;
  private transport: unknown = null;
  private insecureAgent: { close(): void } | null = null;
  private _connected = false;

  constructor(config: McpServerConfig, options: SdkConnectionOptions = {}) {
    this.serverName = config.name;
    this.config = config;
    this.loadSdk = options.loadSdk ?? defaultLoadSdk;
    this.loadUndici = options.loadUndici ?? defaultLoadUndici;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    if (this._connected) return;
    const { Client } = await this.loadSdk();
    this.client = new Client({ name: 'AgentChat', version: '1.0.0' });

    const url = this.config.url || (isHttpTransport(this.config) ? this.config.command : undefined);
    if (url) await this.connectHttp(url);
    else await this.connectStdio();

    this._connected = true;
  }

  private async connectHttp(baseUrl: string): Promise<void> {
    const { StreamableHTTPClientTransport } = await this.loadSdk();
    const url = new URL(baseUrl);
    const requestInit: { headers?: Record<string, string> } = {};
    if (this.config.headers) requestInit.headers = { ...this.config.headers };

    // insecure：per-server dispatcher（见文件头注释），不动全局环境变量
    let fetchLike: ((input: unknown, init?: unknown) => Promise<unknown>) | undefined;
    if (this.config.insecure) {
      const undici = await this.loadUndici();
      this.insecureAgent = new undici.Agent({ connect: { rejectUnauthorized: false } });
      const agent = this.insecureAgent;
      fetchLike = (input: unknown, init: unknown) => undici.fetch(input, { ...(init as object), dispatcher: agent });
    }

    this.transport = fetchLike
      ? new StreamableHTTPClientTransport(url, { requestInit, fetch: fetchLike })
      : new StreamableHTTPClientTransport(url, { requestInit });

    try {
      await this.client!.connect(this.transport, this.connectOptions());
    } catch (err: unknown) {
      throw new Error(`MCP HTTP 服务器 "${this.serverName}" 连接失败: ${describeError(err)}`);
    }
  }

  private async connectStdio(): Promise<void> {
    const { StdioClientTransport } = await this.loadSdk();
    const command = this.config.command;
    if (!command) {
      throw new Error(`MCP 服务器 "${this.serverName}" 未配置 command（stdio 传输）`);
    }
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const [key, value] of Object.entries(this.config.env ?? {})) {
      env[key] = resolveEnvVars(value);
    }
    this.transport = new StdioClientTransport({ command, args: this.config.args ?? [], env });
    try {
      await this.client!.connect(this.transport, this.connectOptions());
    } catch (err: unknown) {
      throw new Error(`MCP stdio 服务器 "${this.serverName}" 连接失败: ${describeError(err)}`);
    }
  }

  private connectOptions(): { timeout?: number } | undefined {
    return this.config.connectTimeoutMs !== undefined
      ? { timeout: this.config.connectTimeoutMs }
      : undefined;
  }

  async listTools(): Promise<McpToolDef[]> {
    await this.connect();
    try {
      const result = await this.client!.listTools();
      return (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema ?? { type: 'object' }) as McpToolDef['inputSchema'],
      }));
    } catch (err: unknown) {
      if (/not\s*supported|method\s*not\s*found|not\s*implemented/i.test(String(err))) {
        return []; // 服务器不支持 tools 能力
      }
      throw new Error(`[MCP:${this.serverName}] tools/list 失败: ${describeError(err)}`);
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.connect();
    try {
      const result = await this.client!.callTool({ name, arguments: args });
      const contents = result.content ?? [];
      const text = contents
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n');
      return { text, isError: result.isError === true };
    } catch (err: unknown) {
      throw new Error(`MCP 工具 "${name}" 调用失败: ${describeError(err)}`);
    }
  }

  close(): void {
    this._connected = false;
    this.transport = null;
    const client = this.client;
    this.client = null;
    void Promise.resolve(client?.close?.()).catch(() => {});
    this.insecureAgent?.close();
    this.insecureAgent = null;
  }
}

/** 连接工厂（ac-mcp 服务 registerServer 的注入面——测试假实现） */
export type McpConnectionFactory = (config: McpServerConfig) => McpConnection;

/** 缺省工厂：官方 SDK 连接 */
export const createSdkConnection: McpConnectionFactory = (config) => new SdkConnection(config);
