// ============================================================
// MCP (Model Context Protocol) 类型定义
//
// 基于 MCP 规范 2024-11-05，实现 JSON-RPC 2.0 over stdio。
// 本文件定义 MCP 服务器配置、协议消息、工具/资源发现等类型。
// ============================================================

// ============================================================
// MCP 服务器配置
// ============================================================

/**
 * 单个 MCP 服务器的启动配置。
 *
 * 配置示例（workspace/config.json 中）：
 *   "extension.agent_prompt": {
 *     "mcp": {
 *       "servers": [
 *         {
 *           "name": "filesystem",
 *           "command": "npx",
 *           "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
 *           "enabled": true
 *         }
 *       ]
 *     }
 *   }
 */
export interface MCPServerConfig {
  /** MCP 服务器唯一名称（用于日志和缓存键） */
  name: string;
  /** 启动命令（如 "npx"、"node"、"python"） */
  command: string;
  /** 命令行参数 */
  args?: string[];
  /** 环境变量（支持 ${ENV_VAR} 引用） */
  env?: Record<string, string>;
  /** 是否启用该服务器（默认 true） */
  enabled?: boolean;
  /** 连接超时（毫秒，默认 30000） */
  connectTimeoutMs?: number;
}

/**
 * agent-prompt 扩展的 MCP 子配置。
 */
export interface MCPConfig {
  /** MCP 服务器列表 */
  servers: MCPServerConfig[];
  /** 工具列表缓存 TTL（毫秒，默认 300000 = 5 分钟） */
  cacheTtlMs?: number;
}

// ============================================================
// MCP 协议消息 (JSON-RPC 2.0)
// ============================================================

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JSONRPCError;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

/** 所有 JSON-RPC 消息的联合类型 */
export type JSONRPCMessage = JSONRPCRequest | JSONRPCResponse | JSONRPCNotification;

// ============================================================
// MCP 能力定义
// ============================================================

/**
 * MCP 工具定义（由 tools/list 返回）。
 */
export interface MCPToolDef {
  /** 工具名称（唯一标识） */
  name: string;
  /** 工具描述 */
  description?: string;
  /** JSON Schema 格式的输入参数定义 */
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * MCP 资源定义（由 resources/list 返回）。
 */
export interface MCPResourceDef {
  /** 资源 URI */
  uri: string;
  /** 资源名称 */
  name: string;
  /** 资源描述 */
  description?: string;
  /** MIME 类型 */
  mimeType?: string;
}

/**
 * MCP 提示模板定义（由 prompts/list 返回）。
 */
export interface MCPPromptDef {
  /** 提示名称 */
  name: string;
  /** 提示描述 */
  description?: string;
  /** 提示参数 */
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

// ============================================================
// 发现结果
// ============================================================

/**
 * 单个 MCP 服务器的完整发现结果。
 */
export interface MCPServerDiscovery {
  /** 服务器配置名称 */
  serverName: string;
  /** 连接状态 */
  connected: boolean;
  /** 连接错误（如果失败） */
  error?: string;
  /** 发现的工具列表 */
  tools: MCPToolDef[];
  /** 发现的资源列表 */
  resources: MCPResourceDef[];
  /** 发现的提示模板列表 */
  prompts: MCPPromptDef[];
}

// ============================================================
// MCP 初始化结果
// ============================================================

export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
  };
  serverInfo?: {
    name: string;
    version: string;
  };
}
