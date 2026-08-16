# @agentchat/agent-mcp
> 包路径 `src/agent-mcp/agent-mcp` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述

Agent MCP 扩展：runStart 钩子 `agent-mcp.open-mcp` 基于
`@modelcontextprotocol/sdk` 发现 MCP 服务器，把远程工具注册进 `ctx.tools`。
支持 HTTP（StreamableHTTP）与 stdio 两种传输，配置可来自内联 `agent.mcp` 或外部
`.mcp` 文件。

## 目录（关键源文件 + 一句话）

| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | cordis 插件行：`agentchat-agent-mcp`，inject `hooks` |
| `register.ts` | 注册 runStart 钩子 `agent-mcp.open-mcp` |
| `mcp.ts` | MCP 配置解析、SDK 客户端、发现缓存、工具注册 |
| `index.ts` | 统一 re-export |

## 插件行

| 模块文件 | 插件 name | inject | 注册内容 |
| --- | --- | --- | --- |
| `plugin.ts` | `agentchat-agent-mcp` | `['hooks']` | runStart 钩子 `agent-mcp.open-mcp`（owner = 插件 name） |

## 提供的能力

### 钩子

| 钩子 | 阶段 | 行为 |
| --- | --- | --- |
| `agent-mcp.open-mcp` | runStart | 解析 `agent.mcp` 配置 → 创建/复用 `MCPDiscoveryManager` → `discoverAll()` → 每个已连接服务器的工具 `ctx.tools.set(...)` |

### MCP 服务器发现（以 `mcp.ts` 为准）

配置来源（优先级）：
1. `agent.mcp.mcpFile`：外部 `.mcp` 文件（JSON，含 `servers` 数组；可带文件级 `cacheTtlMs`）。
2. `agent.mcp.mcp === true / 'true'` 或对象：内联 `mcp.servers` 数组。

传输判定（`isHttpTransport`）：
- `transport === 'http'` → HTTP；`transport === 'stdio'` → stdio。
- 未指定时：有 `url` → HTTP；`command` 以 `http(s)://` 开头 → HTTP；否则 stdio。

`MCPServerConfig` 字段：`name`、`url?`、`headers?`、`command?`、`args?`、`env?`、
`enabled?`、`connectTimeoutMs?`、`insecure?`、`transport?: 'stdio' | 'http'`。
（`insecure` 仅在 HTTP 连接期间临时设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。）

### 工具注册（进 ctx）

对每个已连接服务器 `d` 的每个工具 `tool`：

```ts
ctx.tools.set(tool.name, {
  name: tool.name,
  label: `[MCP:${d.serverName}] ${tool.name}`,
  description: tool.description,
  definition: { type: 'function', function: { name, description, parameters: tool.inputSchema } },
  execute: async (args) => client.callTool(tool.name, args),
});
```

- `callTool` 只返回 text 内容（`content[].type === 'text'` 的 `text` join `\n`），失败返回错误字符串。
- 除工具外 `discover()` 也枚举 `resources` 与 `prompts`（不注册进 ctx）。

### SDK 与缓存

- SDK 动态 import：`@modelcontextprotocol/sdk/client`、`.../client/streamableHttp.js`、
  `.../client/stdio.js`。
- `MCPDiscoveryManager`：客户端按 `server.name` 缓存；`discoverAll(forceRefresh?)`
  命中缓存 TTL（默认 300000ms）且已连接时直接复用；`configure` 会断开已移除/禁用的服务器。

## 关键契约 / API

| API | 签名 | 说明 |
| --- | --- | --- |
| `MCPServerConfig` | 见上 | 服务器配置 |
| `MCPServerDiscovery` | `{ serverName, connected, error?, tools, resources, prompts }` | 发现结果 |
| `makeOpenMCPHook` | `(config: AgentConfig) => RunStartHook` | 钩子工厂 |
| `MCP_CONFIG_SCHEMA` | `ConfigField[]` | UI 配置声明 |
| `registerMcpHooks` | `(hooks, owner) => void` | 注册入口 |

## 配置（`agent.mcp`，`MCP_CONFIG_SCHEMA`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mcpFile` | 无 | 外部 `.mcp` 文件路径（含 `servers` 数组；内联 `mcp` 配置留在 config JSON） |
| `cacheTtlMs` | `300000` | 工具发现结果缓存时长（毫秒） |

另：`mcp` 本身可作为布尔开关或内联服务器配置对象；`servers.length === 0` 时钩子直接返回。

## 与其他插件的关系

- 依赖（package.json）：`@agentchat/agent-loop`、`@agentchat/hooks`、
  `@agentchat/toolkit`、`@agentchat/util`、`@modelcontextprotocol/sdk`（^1.30.0）、
  `@agentchat/agent-config`。
- 使用方：runStart 钩子按顺序声明在 `agent-skill.discovered_skills` 之后执行，
  为后续 prompt/工具装配提供 MCP 工具；不依赖其他 agent 域插件。

## 测试

`package.json`：仅 `typecheck`（无 test script）。包内未发现独立测试文件。

## 相关文档

固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
