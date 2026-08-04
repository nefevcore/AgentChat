// ============================================================
// MCP (Model Context Protocol) 类型定义
//
// 基于官方 @modelcontextprotocol/sdk，封装服务器配置、工具/资源/提示类型。
// ============================================================

// ============================================================
// MCP 服务器配置
// ============================================================

/**
 * 单个 MCP 服务器的连接配置。
 *
 * 支持两种传输方式：
 *   - HTTP（Streamable HTTP）：url + 可选 headers（如 Authorization Bearer）
 *   - Stdio：command + args + env（子进程方式）
 *
 * HTTP 配置示例（vscode-adt）：
 *   { "name": "vscode-adt", "url": "http://localhost:2236/mcp",
 *     "headers": { "Authorization": "Bearer xxx" }, "enabled": true }
 *
 * Stdio 配置示例：
 *   { "name": "filesystem", "command": "npx",
 *     "args": ["-y", "@modelcontextprotocol/server-filesystem"], "enabled": true }
 */
export interface MCPServerConfig {
  /** MCP 服务器唯一名称（日志和缓存键） */
  name: string;

  /**
   * HTTP(S) MCP 端点 URL（Streamable HTTP 传输）。
   * 与 command 互斥——有 url 则用 HTTP，否则用 stdio。
   */
  url?: string;

  /**
   * HTTP 自定义请求头（如 Authorization）。
   * 仅 HTTP 传输有效。
   */
  headers?: Record<string, string>;

  /**
   * 启动命令（stdio 传输，向后兼容）。
   * 当 url 未指定时使用此字段。
   */
  command?: string;

  /** 命令行参数（仅 stdio） */
  args?: string[];

  /** 环境变量，支持 ${ENV_VAR} 引用（仅 stdio） */
  env?: Record<string, string>;

  /** 是否启用（默认 true） */
  enabled?: boolean;

  /** 连接超时（毫秒，默认 30000） */
  connectTimeoutMs?: number;

  /**
   * 是否跳过 TLS 证书验证（仅 HTTP 模式）。
   * 内网自签名证书场景需要设为 true。
   */
  insecure?: boolean;

  /**
   * 显式指定传输方式，覆盖自动检测。
   * - "http": 使用 StreamableHTTPClientTransport
   * - "stdio": 使用 StdioClientTransport
   */
  transport?: 'stdio' | 'http';
}

// ============================================================
// MCP 扩展配置
// ============================================================

/** agent-prompt 扩展的 MCP 子配置 */
export interface MCPConfig {
  /** MCP 服务器列表（内联方式） */
  servers?: MCPServerConfig[];
  /** 外部 .json 配置文件路径（含敏感凭证时使用） */
  mcpFile?: string;
  /** 工具列表缓存 TTL（毫秒，默认 300000 = 5 分钟） */
  cacheTtlMs?: number;
}

// ============================================================
// MCP 工具/资源/提示（发现结果）
// ============================================================

/** MCP 工具定义（由 tools/list 返回） */
export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** MCP 资源定义 */
export interface MCPResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** MCP 提示模板定义 */
export interface MCPPromptDef {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** 单个 MCP 服务器的完整发现结果 */
export interface MCPServerDiscovery {
  serverName: string;
  connected: boolean;
  error?: string;
  tools: MCPToolDef[];
  resources: MCPResourceDef[];
  prompts: MCPPromptDef[];
}
