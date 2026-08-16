# @agentchat/webui

> `src/ui/webui` · `@agentchat/webui` 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述

WebUI cordis 插件，源码自包含：Vue 3 SPA 前端源码 + 内置 `dist` 构建产物 + 服务端 `WebUIServer`（Express HTTP + WS + SPA 托管）。插件行 `inject: webServerHost, http`，在 boot 把 ServiceRegistry / 工作区 / 端口 / HTTP 路由注册表准备好后，自行启动 HTTP+WS+SPA 并注册 `ctx.server`；`host.enabled=false` 时直接返回不启动。L3 路由（`/api/ui` 与 `/ui-plugin` 静态）由本行注册到 `ctx.http`，挂/摘本行 = 挂/摘 UI 路由。

前端栈：Vue 3 + Pinia + markdown-it（+texmath）+ KaTeX + highlight.js + chart.js + d3-chord。内置 UI 扩展宿主（perspectives / messageViews / toolResultViews / eventHandlers 注册表 + 8 类 slot 白名单），支持 iframe 隔离运行时与受限桥接。

## 目录（前端分层结构）

| 文件/目录 | 说明 |
|---|---|
| `package.json` | 依赖 Vue3/Pinia/markdown-it/katex/highlight.js/chart.js/d3-chord 等；scripts: dev/typecheck/build/test/preview |
| `vite.config.ts` | `@` → `src`、`@shared` → `src/shared` 别名；dev 代理 `/api`、`/ws` → 3830；build 双入口（主 SPA + `ui-plugin-iframe.html`），vendor chunk 拆分 vue/markdown/chart |
| `index.html` | SPA 入口（生产构建含 CSP meta） |
| `ui-plugin-iframe.html` | P5.5 isolated 档沙箱容器页：`default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'`，加载 `isolated-runtime.ts` |
| `src/plugin.ts` | cordis 插件行：`agentchat-webui`，inject `webServerHost, http`，注册 L3 路由并启动 `startWebUIServer` |
| `src/index.ts` | `webuiDistDir()`（指向插件内置 `dist`）+ `startWebUIServer()` + `new ServerService(ctx, server)`；re-export `webuiPlugin` |
| `src/main.ts` / `App.vue` | 前端引导与根组件（内置 UI 挂载点） |
| `src/stores/*` | Pinia stores：`agents` / `chat` / `feed` / `groups` / `theme` / `ui` / `websocket` |
| `src/core/registry/*` | UI 扩展注册表：`perspectives` / `messageViews` / `toolResultViews` / `eventHandlers` |
| `src/core/extensions/*` | UI 扩展宿主：`types` / `host` / `slots` / `isolated` / `bridge` / `p5.5-policy` |
| `src/core/api/*` | REST client 与 endpoints（`/api/ui/extensions` 等） |
| `src/core/events/*` | WS 事件契约常量（`WS_SEND`/`WS_EVENT`） |
| `src/services/websocket.ts` | `WebSocketClient` 实现 |
| `src/settings/*` | 设置页（面板/api/schema/types/useSettings） |
| `src/components/` | 顶层：`AgentList` `ChatView` `ChatInput` `Sidebar` `GroupChat` `TokenUsage` `VersionDialog` 等；`chat/`（`Message`、`ToolResult`、`shared`）、`dialog/`（`DialogView`、`GroupDrawer`）、`layout/`（`PerspectiveHost`、`ResizeHandle`） |
| `tests/` | `p5.5-policy.test.ts` + `csp-audit.test.ts` |

## 插件行

| 模块文件 | 插件 name | inject | 提供/注册内容 |
|---|---|---|---|
| `src/plugin.ts` | `agentchat-webui` | `webServerHost`, `http` | 注册 `/api/ui` 路由（`createUiRouter(ctx)`）与 `/ui-plugin` 静态（`createUiPluginStaticHandler(ctx)`）；调用 `startWebUIServer` 启动 HTTP+WS+SPA；可选读取 `bootstrap.pluginEvents` 接入插件事件广播；返回 disposer（摘行时注销两条 L3 路由并 `server.stop()`） |
| `src/index.ts`（re-export `webuiPlugin`） | 同上 | 同上 | 导出 `webuiDistDir` / `startWebUIServer` / `WebServerHostLike`；`startWebUIServer` 创建 `WebUIServer`（`staticDir=webuiDistDir()`，`routeRegistry=ctx.http`），`await server.start()` 后 `new ServerService(ctx, server)` 挂载 `ctx.server` |

## 提供的能力

### 服务端能力

| 能力 | 说明 |
|---|---|
| `startWebUIServer(ctx, host, port?)` | 自启动 HTTP+WS+SPA；`staticDir` 固定指向插件内置 `dist`（存在即托管 SPA）；`routeRegistry` 复用 `ctx.http` 中间件 |
| L3 路由注册 | `/api/ui`（UI 扩展/槽位目录）、`/ui-plugin`（插件浏览器入口与静态资源） |
| `ctx.server` | 经 `new ServerService(ctx, server)` 注册为 cordis Service |

### 前端 stores

| Store | 职责 |
|---|---|
| `agents` | Agent 列表、排序、选择与恢复（`lastActivity` 排序，`localStorage.agentchat.lastAgent`） |
| `chat` | 业务动作：发送/中断/重生成/删除/编辑/压缩/继续/交互/System Prompt 与工具定义预览；非消息类 WS 事件分发表 |
| `feed` | 统一信息流单一真相源：per-dialog `rawMessages` + 派生 `turns`（memo 增量构建）、历史分页、流式 ingest、群组消息、会话恢复、全局活动索引 |
| `groups` | 群组列表/选中/创建弹窗；WS `group.*` 事件刷新与活跃排序 |
| `theme` | 明暗主题切换与持久化（`agentchat.theme`），派发 `theme-changed` 事件 |
| `ui` | 面板可见性/宽度/拖拽 resize/文件预览（列表/工作区/设置/Token/版本/预览） |
| `websocket` | WS 连接管理（`connected`）与 `onMessage/onConnect/send` 幂等 init |

### UI 扩展宿主（P5.3–P5.5）

| 注册表/文件 | 关键行为 |
|---|---|
| `perspectives.ts` | 顶层视角注册表：`{id,label,icon?,active(),component,props?}`；同 id 替换；`activePerspective()` 取第一个 active |
| `messageViews.ts` | 消息视图注册表：`{id,match(turn,final),priority?,renderer?}`；解析优先级取最高；内置 `user`/`assistant` 两个视图 |
| `toolResultViews.ts` | 工具结果视图：`{match:string\|RegExp,component,priority?}`；精确名优先于正则族；内置 bash/read/write/edit/web_search/browser 族/subagent |
| `eventHandlers.ts` | WS 事件处理器注册表：同事件多 handler 顺序执行；`dispatchEvent` 统一分发、异常隔离；`clearEventHandlers()` 供测试 |
| `slots.ts` | 新 slot 注册表：`settingsTabs` / `agentSettingsTabs` / `sidebarActions`；`order ?? 100` 升序稳定排序；同 id 替换 |
| `bridge.ts` | `createBridge(descriptor)` 构造 `UiExtensionContext`：注入 Vue 子集（h/defineComponent/ref/computed/watch）、各 `registerXxx` 先 `assertSlot`（manifest.ui.slots 白名单）、`request`/`wsOn`/`onUnload`；所有 disposer 记录在 WeakMap，卸载逆序执行 |
| `host.ts` | `initUiExtensionHost()`：拉取 `/api/ui/extensions` → `import('/ui-plugin/<name>/<entry>?v=<version>')` → `install(ctx)`；WS `ui.extensions.changed` 150ms debounce 后 sync；单个插件失败隔离，卸载按 name 逆序 dispose + 移除样式 |
| `isolated.ts` | iframe 隔离档宿主：`sandbox="allow-scripts"`（无 `allow-same-origin` → opaque origin）；父窗口代理 `request`（白名单 GET 只读）与 `event`（白名单生命周期事件）；不暴露 Vue/slot/宿主 DOM |
| `p5.5-policy.ts` | 纯策略函数：`rewriteGlobalStyle`（CSS 消毒 + 前缀重写 + 禁 url()/at-rule/@import/javascript:/style 标签）、`isAllowedIsolatedRequest`、`isAllowedIsolatedEvent` |

### 8 类 UI slot 白名单

`perspective` · `tool-result` · `message-view` · `ws-event` · `settings-tab:global` · `settings-tab:agent` · `sidebar-action` · `global-style`

### 设置页 / 插件库 / 装配视图

| 面板 | 说明 |
|---|---|
| `SettingsPanel.vue` | 设置总面板：全局/Agent 双上下文，含“插件库”页签 |
| `PluginLibraryPane.vue` | 插件库（P3）：已安装 / 待审 / 开发三页签 + 人审流 + 卸载备份 |
| `AgentPane.vue` | Agent 设置与装配视图：presets / tools{include,exclude} / hooks 启用清单装配 patch（`AssemblyView`），旧契约只读提醒 |
| `ExtToolsPane.vue` | 工具/钩子扩展面板：catalog + enabled + include/exclude 装配声明 |
| 其他 | `StagingReviewModal.vue`（人审）、`PluginCard.vue` / `PluginDevCard.vue` / `NsFieldList.vue` / `SettingField.vue` / `TimerPane.vue` / `PoolManager.vue` |

## 关键契约 / API

| API/契约 | 说明 |
|---|---|
| `webuiDistDir()` | `src/ui/webui/dist`（插件内置构建产物） |
| `startWebUIServer(ctx, host, port=host.port)` | 返回 `WebUIServer`；内部 `new ServerService(ctx, server)` |
| `UiExtensionContext` | 插件入口约定：`export function install(ctx)` 返回 `void \| Disposer \| Promise<...>` |
| `UiExtensionModule` | 动态 import 的插件模块：`install?(ctx)` |
| `resolveToolResultView(toolName?)` | 精确名 → 正则族 → 未命中 null（fallback 文本渲染） |
| `resolveMessageView(turn, final)` | 视图 id 解析，未命中 null |
| `PLUGIN_EVENT.UI_EXTENSIONS_CHANGED` | 驱动宿主 sync 的 WS 事件（`ui.extensions.changed`） |
| 隔离白名单 | GET：`/api/ui/extensions` `/api/ui/slots` `/api/config` `/api/version` `/api/plugins/catalog` `/api/plugins/permissions` `/api/plugins/library` `/api/plugins/assembly/<id>`；事件：`ui.extensions.changed` `plugin.catalog.changed` `plugin.reload` `agent.assembly.changed` |

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `webuiPort` | 继承 `webServerHost.port`（cordis.yml 中为 3830） | 覆盖 WebUI 监听端口 |

```yaml
- name: '@agentchat/webui/src/plugin'
  config:
    webuiPort: 3830
```

## 与其他插件的关系

- 依赖 `@agentchat/server`（`WebUIServer` / `createUiRouter` / `createUiPluginStaticHandler` / `ServerService` / `WebServerHostService`）、`@agentchat/cordis`、`@agentchat/util`。
- `webServerHost` 由 `@agentchat/boot/src/plugin-finalize` 提供（`enableWebUI` / `webuiPort` 控制）；`http` 由 `@agentchat/server/src/http-plugin` 注册。
- 插件 UI 资源由 `@agentchat/plugins` 的 `ctx.webui` 挂到 `/ui-plugin/*`，本插件负责前端宿主消费 `/api/ui/extensions` 并加载。
- 可选接入 boot 核心行的 `pluginEvents`（`PluginEventBus`）广播 `plugin.*` 事件。

## 测试

| 测试 | 覆盖 |
|---|---|
| `tests/p5.5-policy.test.ts` | `rewriteGlobalStyle` 前缀重写/scope/:root 放行/禁 url()/禁 @import 与 at-rule/非法 scope 与括号错误；isolated request/event 白名单正反例 |
| `tests/csp-audit.test.ts` | 生产 `dist` CSP 审计：主 SPA `script-src 'self'` + `connect-src 'self' ws: wss:` + 无远程脚本；isolated 容器页 `default-src 'none'` + 无内联脚本（先 `pnpm build` 再跑） |

运行：`pnpm --filter @agentchat/webui test`（脚本内 `cd ../../.. && pnpm vitest run src/ui/webui/tests/...`）。

## 相关文档

固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
