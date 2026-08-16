# @agentchat/protocol

> `src/sdk/protocol` · `@agentchat/protocol` 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述

跨端共享类型契约包：webui / desktop / 后端 services 共用的持久化与插件化 DTO 都收在这里，消除“两端各维护一份类型导致漂移”（如 `PersistedMessage.role` 不一致）。**零运行时依赖**——源码只做 `import type` 与常量对象 `PLUGIN_EVENT`，不产生运行时依赖；唯一依赖是 `@agentchat/types`（仅类型导入并 re-export `PersistedToolCall` / `MessageSource` / `MessageSourceKind` / `MessageForm`）。

判断标准：前端已复制一份的类型进本包；只在 src 内部使用的核心契约（LLMRequest / AgentContext / hooks）留在 `types/llm`。

## 目录

| 文件 | 说明 |
|---|---|
| `src/index.ts` | 唯一源文件（314 行）：消息/插件/UI 扩展/WS 事件全部类型 + `PLUGIN_EVENT` 常量 |
| `package.json` | `exports: {".": "./src/index.ts", "./src/*": "./src/*"}`；依赖 `@agentchat/types: workspace:*` |

## 插件行

无 cordis 插件行（纯类型包，不挂 `name/inject/apply`）。实际消费与再出口：

| 模块 | 关系 |
|---|---|
| `@agentchat/server/src/index.ts` | re-export `PersistedRole` `ToolCall` `AgentInfo` `GroupInfo` `GroupPersistedMessage` `PersistedMessage`、`UISlotInfo` |
| `@agentchat/server/src/agent-service.ts` | re-export `AgentInfo` |
| `@agentchat/server/src/group-service.ts` | re-export `GroupPersistedMessage` |
| `@agentchat/server/src/history-service.ts` | re-export `PersistedMessage` |
| `@agentchat/plugins`（host / registry / webui-service） | import `PluginInfo` `PluginCatalog` `PluginLibrary` `Staging*` `UIExtensionDescriptor` `UISlotId` `PLUGIN_EVENT` |
| `@agentchat/server`（ws/handler、api/plugins、api/ui） | import `PLUGIN_EVENT` 与插件域类型 |
| `@agentchat/boot/src/loader.ts` | import 插件域类型用于装配接线 |

## 提供的能力（类型契约）

### 1. 消息/会话持久化契约

| 类型 | 字段/取值 |
|---|---|
| `PersistedRole` | `'agent' \| 'system' \| 'tool' \| 'error' \| 'event'`（与 builtin hooks/session `toPersistedRole` 对齐；事件消息统一为 event，取代旧 trigger） |
| `ToolCall` | = `@agentchat/types.PersistedToolCall`（OpenAI 原生格式：`id` + `type:'function'` + `function:{name,arguments}`），并 re-export |
| `PersistedMessage` | `role` `content: string\|null` `agent_id?` `name?` `tool_call_id?` `tool_calls?` `reasoning_content?` `label?` `source?` `message_id?` `timestamp?` —— 1:1 对应 `messages.jsonl` 一行；`role='event'` 必带 `source` |
| `AgentInfo` | `agent_id` `name` `description?` `avatar?` `tags?` `virtual?` `llm?:{provider?,model?}` —— 列表/档案展示 |
| `GroupInfo` | `group_id` `name` `description?` `participants: string[]` |
| `GroupPersistedMessage` | `group_id?` `role` `content` `agent_id?` `name?` `label?` `message_id?` `timestamp?` —— `groups/<id>/messages.jsonl` 一行 |

### 2. 插件化 P1 契约

| 类型 | 关键内容 |
|---|---|
| `PluginPermission` | `'fs' \| 'network' \| 'process' \| 'shell' \| 'ui'` |
| `PluginSource` | `'builtin' \| 'installed' \| 'dev' \| 'session'` |
| `HookKind` | `runStart` `runEnd` `stepStart` `stepEnd` `toolExecutionStart` `toolExecutionEnd` `fallback`（七类，与 HooksService 一一对应） |
| `PluginMeta` | `name` `label` `description?` `type?` `enabled?` + 索引签名 |
| `PluginProvides` | `tools: string[]` `hooks: string[]`（manifest.provides 声明） |
| `PluginInfo` | `name` `label?` `description?` `version?` `source` `permissions?` `grantedPermissions?` `owner?` `installedAt?` `entry?` `dir?` `provides?` |
| `HookInfo` | `name` `kind` `label` `description?` `owner` `order` `configNs?` `security?`（`order` = kind 内注册顺序，UI 启用/排序的推荐锚点） |
| `AgentToolInfo` | `name` `label?` `description?` `requires?` `ns?` `owner?` |
| `AssemblyView` | `agentId` + `presets[]` + `available: PluginInfo[]` + `hooks:{order,catalog}` + `tools:{include,exclude,enabled,catalog}` + `legacy?` |
| `AssemblyUpdate` | PUT assembly 请求体：`presets?` `tools?`（`{include,exclude}`）`hooks?` |
| `StagingRecord` | `id` `manifest` `sourceDir` `hash` `owner` `createdAt` `requiredGrants`（发布暂存待审） |
| `PluginCatalog` | `plugins` `hooks` `tools`（GET `/api/plugins/catalog`） |
| `PluginLibrary` | `installed` `staging`（GET `/api/plugins/library`） |
| `PluginPermissionsView` | `vocabulary` `defaultGranted` `explicitRequired` |
| `StagingFileInfo` / `StagingFileContent` | 暂存目录条目 / 人审只读内容 |

### 3. P5 深度 UI 扩展契约

| 类型 | 关键内容 |
|---|---|
| `UISlotId` | 8 类白名单：`perspective` `tool-result` `message-view` `ws-event` `settings-tab:global` `settings-tab:agent` `sidebar-action` `global-style` |
| `UIExtensionDescriptor` | `name` `version` `entry`（`/ui-plugin/<name>/...`）`styles[]` `slots[]` `isolated` `status:'installed'\|'session'` `grantedPermissions` |
| `UISlotInfo` | `id` `label` `description`（GET `/api/ui/slots` 目录条目） |
| `UIExtensionsChangedEvent` | `name` `reason:'register'\|'unregister'\|'reload'` |

### 4. 插件域 WS 事件

`PLUGIN_EVENT` 常量（复用现有 message 通道 data 字段）：

| 常量 | 值 |
|---|---|
| `CATALOG_CHANGED` | `'plugin.catalog.changed'` |
| `RELOAD` | `'plugin.reload'` |
| `ASSEMBLY_CHANGED` | `'agent.assembly.changed'` |
| `UI_EXTENSIONS_CHANGED` | `'ui.extensions.changed'` |

事件载荷：`PluginCatalogChangedEvent {kind:'installed'|'staging'|'session'}` · `PluginReloadEvent {name, status:'loaded'|'replaced'|'failed', error?}` · `AgentAssemblyChangedEvent {agentId}` · `PluginEventMap` 汇总四类事件。

> RPC 类型：本包源码中**不含** RPC 类型；RPC 桥接（`RPCBridge`/`parseRPCMessage`/`buildRPCSuccess`/`buildRPCError`）在 `@agentchat/server/src/rpc.ts`。

## 关键契约 / API

- `ToolCall` 与 `PersistedToolCall` 等价，openAI 原生 `arguments` 为 JSON 字符串；内存 `@agentchat/types.ToolCall` 的 `arguments` 为对象。
- `PersistedMessage.role` 统一包含 `event`（取代旧 `trigger`）；`MessageSource`/`MessageSourceKind`/`MessageForm` 从 `@agentchat/types` re-export。
- `UIExtensionDescriptor.slots` 是运行时注册检查依据：前端 `bridge` 注册前核对 manifest 声明。
- `PLUGIN_EVENT` 是**运行时值**（`as const`），不是纯类型。

## 配置

无运行时配置。

## 与其他插件的关系

- 上游依赖 `@agentchat/types`（仅类型），被 `@agentchat/server`、`@agentchat/plugins`、`@agentchat/boot`、`@agentchat/archive` 等 import。
- 不依赖 cordis，可安全用于浏览器与 Node 双侧。
- `@agentchat/webui` 前端经 `@shared` 别名复用本包类型（`UIExtensionDescriptor`/`UISlotId`）。

## 测试

本包仅 `typecheck`（`tsc --noEmit`）；无独立测试文件。类型正确性由各消费包（server / plugins / webui）的 typecheck 与测试间接覆盖。

## 相关文档

固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
