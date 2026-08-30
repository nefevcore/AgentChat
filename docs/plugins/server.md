# @agentchat/server
> 包路径 `src/host/server` · 版本 0.1.0 · 文档对应 v0.6.3（2026-08-16）

## 概述
宿主域包：L3 传输层（`HttpRouteRegistry` + `WebUIServer` HTTP/WS + JSON-RPC over WS）与 L4 服务门面（`ServiceRegistry` / `RPCBridge` / `InteractionBridge` / `AgentService` / `GroupService` / `HistoryService` / `ConfigService` / `Runtime`）。业务路由由各域插件行注册到 `ctx.http`，本包只提供注册口；`/api/agents|history|groups` 由 L4 服务行注册，其余通用路由由 http-routes 行注册。

## 目录（关键源文件 + 一句话）

| 文件 | 职责 |
| --- | --- |
| `http-plugin.ts` | 插件行 `agentchat-http`：注册 `ctx.http = HttpRouteRegistry` |
| `http-routes.ts` | `HttpRouteRegistry`：稳定中间件 + 动态重建 Router + 注册/摘除 |
| `service-plugin.ts` | 插件行 `agentchat-server-services`：构造 L4 全部服务并注册业务路由 |
| `http-routes-plugin.ts` | 插件行 `agentchat-server-http-routes`：注册通用 REST 路由 |
| `webui-server.ts` | `WebUIServer`：Express + WS + SPA fallback |
| `ws/handler.ts` | `WSHandler`：连接管理、心跳、RPC 分发、事件广播、会话快照/重连 |
| `ws/protocol.ts` | WS 消息类型常量与 Inbound/Outbound 集合 |
| `registry.ts` | `ServiceRegistry`：服务注册表（register/get/require/list） |
| `rpc.ts` | `RPCBridge`：`name.method` 映射与 JSON-RPC 2.0 调用 |
| `runtime.ts` | Runtime 门面：Router/Registry/GroupManager/全局配置/重启函数注入 |
| `interactions.ts` | `InteractionBridge`：`ask_questions` 用户交互桥（durable-interaction 持久化） |
| `interaction-recovery.ts` | 崩溃恢复调和：悬空 `ask_questions` tool_call × durable 记录 → 合成 tool 结果 / pending 挂起 |
| `config-service.ts` | `ConfigService`：全局配置读取/热重载/凭据 |
| `service.ts` | `ServerService`（ctx.server）、`WebServerHostService`、L4 门面 Service |
| `agent-service.ts` / `group-service.ts` / `history-service.ts` | L4 门面实现 |
| `api/*.ts` | 各 REST 路由薄传输层（只读头部了解路由即可） |

## 插件行

| 模块文件 | 插件 name | inject | 提供/注册内容 |
| --- | --- | --- | --- |
| `http-plugin.ts` | `agentchat-http` | `[]` | `ctx.http = HttpRouteRegistry`（`register/registerStatic/list/has` + `middleware`） |
| `service-plugin.ts` | `agentchat-server-services` | `['bootstrap','workspace','timerManager','subagent','archive','http','durableInteraction']` | `ctx.l4 = ServerServicesHost`（interactionBridge/serviceRegistry/rpc/agentService/groupService/historyService）；ctx 门面 `agentService/groupService/historyService/configService`；把 `ctx.durableInteraction` 切到 `<ws>/.durable-interactions.jsonl`；注入 `recoverHistory` 与 late-reply 唤醒；注册 `/api/agents`、`/api/history`、`/api/groups` |
| `http-routes-plugin.ts` | `agentchat-server-http-routes` | `['http','l4']` | 注册 `/api/upload|config|browse|workspace|backup|version|usage|sessions` |

说明：`ctx.server`（`ServerService`，持有 `WebUIServer`）由 `@agentchat/webui` 插件行提供，不在本包；`ctx.webServerHost` 由 `@agentchat/boot` finalize 提供，WebUI 行 `inject: ['webServerHost', 'http']` 后自行启动 HTTP/WS。

## 提供的能力

### ctx 服务表

| 服务名 | 来源 | 内容 |
| --- | --- | --- |
| `ctx.http` | agentchat-http | `HttpRouteRegistry` |
| `ctx.l4` | agentchat-server-services | `ServerServicesHost` 聚合 |
| `ctx.agentService` / `ctx.groupService` / `ctx.historyService` / `ctx.configService` | service-plugin | 各 L4 门面（`.service`） |
| `ctx.webServerHost` | boot-finalize | `serviceRegistry/dataDir/port/enabled` |
| `ctx.server` | @agentchat/webui | `ServerService.server = WebUIServer` |

### L4 门面核心 API

| 类 | 关键方法 |
| --- | --- |
| `ServiceRegistry` | `register(name, impl)`（同名告警覆盖）、`get`、`require`（未注册抛错）、`list`、`registerPluginServices(provider)` |
| `RPCBridge` | `registerService(name, svc)` 自动把原型公开方法映射为 `name.method`（如 `agent.list`）；`listMethods()`；`call(method, params)`（params 为数组按多参展开，否则单对象参数或无参） |
| `InteractionBridge` | `askUser({agentId,convKey,question,options,allowCustom,timeoutMs,signal,correlationId})`（缺省永久 0，显式 timeoutMs 才有时限；先落盘再弹窗）；`askQuestions`（逐题串行）；`respond(id, choice)`（先落盘再 resolve，幂等）；`abortAgent` / `abortAll`（关闭持久记录）；`listOpen/toWireMessage`（重连重推）；`pendingCount` |
| `Runtime` | `initRuntime({router,requestRestart,globalConfig})`；`getRouter/getRegistry/getGroupManager`；`get/setGlobalConfig`；`requestRestart`；`setRequestRestart` |
| `ConfigService` | `getGlobalConfig()`；`reloadGlobalConfig()`（重读 `<workspace>/config.json`，默认值合并 + 路径派生 + 原地 mutate）；`get/setCredential`；`setAgentCredential` |
| `AgentService` | `buildGlobalBase/createLLM/saveAgentConfig/hotReloadAgent/createAgentRuntime/getEffectiveConfig/list/listBasic/unregister/getAgentTimers/saveAgentTimers/getAgentSystemPrompt/getAgentToolDefs` |
| `GroupService` | `loadGroupsFromDisk/listGroups/listGroupsWithActivity/getGroup/createGroup/deleteGroup/updateGroup/getGroupHistory/joinGroup/leaveGroup`；监听 GroupManager 事件落盘 `groups/<id>/group.json` 与 `sessions/group~<gid>/messages.jsonl` |
| `HistoryService` | `query(filter)`、`requestArchive(agentId, counterpart)`、`idleArchive`、`deleteFromJSONL`；新架构 `chat~` 平铺路径 + 旧嵌套路径兼容 |

### WebUIServer / WS

- `WebUIServer`：Express `cors()` + `express.json()` + 静态托管（`src/ui/webui/dist` 存在即托管）+ `routeRegistry.middleware`（稳定中间件）+ SPA fallback；默认端口 `3830`，监听 `::`；`start()` 幂等（复用同一 Promise），`stop()` 主动断开 WS、2s 超时兜底。
- `WSHandler`：连接与 Agent 会话解耦；`router.on('message')` 广播流式事件（后台会话按 `chat.start` 下发的 `source` + `isBackgroundRunSource` 分类并登记 `correlation_id` 静默；`chat.start/end` 边界事件仍广播，不污染 1:1 且前端可渲染分隔符）；`archive.completed → session.archived`；GroupManager 事件广播；`agent.profile.updated`；插件域事件（catalog.changed/reload/assembly.changed/ui.extensions.changed）；`chat.interaction` 广播；`chat.subscribe` 重连恢复快照——`data.session` 存在时按会话键 `single~<sid>` 精确匹配（本连接 `conn:single:sid` + 跨连接 `findDialogSnapshot`）并回显 `session`，同 Agent 多个独立会话并存时不串台。快照更新（`updateSessionSnapshot`）事件带 `dialogId` 时按 `ActiveSession.dialogKey` 精确匹配（无则回退 agentId）；`chat.interrupt` 带 `data.session` 时会话级精确中断（`router.abortDialog(convKey)`，不牵连同 Agent 其他会话），不带时维持按 Agent 全量中断。
- `chat.continue`：`void router.trigger(to, { target: viewerId, source:'continue:<to>', sourceMeta:{kind:'continue', form:'hint'} }, signal)`（fire-and-forget）→ `await router.whenSessionIdle(chatDialogKey(viewerId, to))` 等 run 收尾，之后再清理本连接的 `activeSessions`。
- 心跳：`HEARTBEAT_INTERVAL_MS = 30_000`，每 30s `ws.ping()`，未回 pong 判定半死连接并 `terminate`。
- 去重：`chat.send` 幂等缓存 30s（`CHAT_SEND_DEDUP_MS`），持久化到 `<dataDir>/.chat_send_dedup.json`。
- RPC over WS：入站 `{type:'rpc', data:{method,params,id}}` → `parseRPCMessage` → `rpc.call` → `{type:'rpc.response'|'rpc.error'}`。

### 主要 REST 路由表

| 挂载点 | 路由（方法） |
| --- | --- |
| `/api/agents` | `GET /`、`GET /models`、`GET /:agentId/avatar`、`POST /:agentId/avatar`、`DELETE /:agentId/avatar`、`POST /`、`DELETE /:agentId`、`GET/POST /:agentId/config`、`GET/POST /:agentId/timer` |
| `/api/history` | `GET /` |
| `/api/groups` | `GET /`、`GET /:groupId`、`POST /`、`DELETE /:groupId`、`PATCH /:groupId`、`GET /:groupId/history`、`POST /:groupId/join`、`POST /:groupId/leave` |
| `/api/upload` | `POST /`（multer，files 去重） |
| `/api/config` | `GET /`、`GET /pools`、`POST /` |
| `/api/browse` | `GET /read-file`、`POST /file`（PowerShell 文件选择） |
| `/api/workspace` | `GET /file`、`GET /raw`、`GET /tree` |
| `/api/backup` | `GET /`（列表）、`POST /`（手工备份） |
| `/api/version` | `GET /`、`GET /changelog`、`POST /update` |
| `/api/usage` | `GET /tokens`（可选 `?days=N` / `?from=&to=` 日期范围，响应含 `range`）、`POST /refresh` |
| `/api/sessions` | `GET /:agentId/tokens` |
| `/api/ui`（webui 域） | `GET /extensions`、`GET /slots`、静态 `/ui-plugin/:name/*` |

## 关键契约 / API

```ts
// WS 入站类型（protocol.ts 节选）
CHAT_SEND / CHAT_INTERRUPT / CHAT_CONTINUE / CHAT_SUBSCRIBE / AGENT_LIST /
HISTORY_REQUEST / GROUP_* / SESSION_COMPRESS / SESSION_ARCHIVE /
CHAT_DELETE_MESSAGE / AGENT_SYSTEM_PROMPT / AGENT_TOOL_DEFS /
SYSTEM_RESTART / CHAT_INTERACT_RESPOND / FILE_UPLOAD

// RPC 命名规则
registerService('agent', agentService)  // → 'agent.list' / 'agent.getConfig' / ...
// JSON-RPC 2.0 风格：{ type:'rpc', method, params, id }

// RuntimeDeps
interface RuntimeDeps { router: AgentRouter; requestRestart?; globalConfig? }
```

## 配置

`ConfigService.CONFIG_DEFAULTS`（与 boot `loadGlobalConfig` 对齐）：

| 字段 | 默认值 |
| --- | --- |
| `maxHops` | `5` |
| `messageQueryDefaultLimit` | `20` |
| `workspaceDir` | `'workspace/default'` |
| `agentsDir` / `sessionsDir` / `groupsDir` | `''`（派生自 workspaceDir） |
| `viewerId` | `'user'` |
| `llmProviders` / `searchProviders` | `{}` |
| `allowedPaths` | `[]` |
| `timezone` | `'Asia/Shanghai'` |
| `namespaces` | `{}` |

`WebUIServerOptions` 默认：`port 3830`、`uploadDir <workspace>/files`、`dataDir <workspace>`、`serveStatic`（dist 存在即 true）、`routeRegistry` 缺省空 Router。

## 与其他插件的关系
- 依赖：`@agentchat/agent-loop`、`agents`、`archive`、`backup`、`llm`、`protocol`、`router`、`timer`、`tools`、`util`、`cordis`、`toolkit`、`agent-session`、`agent-config` + `cors`/`express`/`multer`/`ws`。
- 使用方：`@agentchat/boot`（inject `l4`，finalize 注册 PluginManager 到 `serviceRegistry`、构造 `WebServerHostService`）；`@agentchat/plugins`（http-plugin inject `http/pluginManager`，注册 `/api/plugins`）；`@agentchat/webui`（inject `webServerHost` 启动 `WebUIServer`）。
- 反向依赖避免：`service-plugin` 只 import `@agentchat/archive/src/plugin` 类型；`plugins-shared` 供 boot 复用且 boot 依赖 server，不形成环。

## 测试
package.json 的 test 脚本为 `vitest run`。测试文件：`tests/agent-service.test.ts`、`agent-service-integration.test.ts`、`config-service.test.ts`、`group-service.test.ts`、`history-service.test.ts`、`http-routes.test.ts`、`plugin-api.test.ts`、`rpc.test.ts`、`runtime.test.ts`、`ui-api.test.ts`。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
