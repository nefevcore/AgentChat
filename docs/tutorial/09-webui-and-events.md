# 第 9 步：WebUI 与事件流

> 目标：理解 WebUI 作为 cordis 插件的结构，以及从前端到 Agent 再回来的完整事件流。

## 9.1 WebUI 也是插件行

`cordis.yml` 中的 `@agentchat/webui/src/plugin`（inject: `webServerHost`, `http`）：

1. 等 boot-finalize 提供 `webServerHost`（ServiceRegistry / 工作区 / 端口）与 `ctx.http`；
2. 注册 `/api/ui`（UI 扩展元数据）与 `/ui-plugin`（插件 UI 静态服务）；
3. `startWebUIServer()` 自行启动 HTTP + WebSocket + SPA 托管（内置 dist 存在即托管，桌面端单进程可用）；
4. 返回 dispose：卸载时摘路由并停服务器。

摘掉 webui 行 = 整个前端下线，后端能力完全不受影响。

## 9.2 前端结构（src/ui/webui/src）

| 目录/文件 | 职责 |
|-----------|------|
| `plugin.ts` / `index.ts` | 后端插件行与服务器启动 |
| `main.ts` / `App.vue` | Vue 3 入口与根布局 |
| `stores/` | Pinia：agents / chat / feed / groups / theme / ui / websocket |
| `core/api/` | REST 客户端（agents/groups/system/ui/workspace） |
| `core/registry/` | UI 扩展注册表：perspectives / messageViews / toolResultViews / eventHandlers |
| `core/extensions/` | 扩展宿主：bridge（桥接）、slots（8 类白名单）、isolated（iframe 隔离运行时）、p5.5-policy |
| `components/chat/` | 流式消息与工具结果渲染（ToolResult* 系列：终端/代码/编辑/浏览器/Web/写入/子代理） |
| `settings/` | 设置面板：模型池、Agent、定时、插件库/暂存审查 |

## 9.3 一次对话的完整事件流

```
你在 ChatInput 发消息
→ WS send（chat.send）→ WSHandler → RPC/路由 → Router.send(msg, { wait: true })
→ Agent.receive → createAgentContext
→ loop 运行，经 AgentAssembly.emit 包装为 router 'message' 事件：
    chat.start → chat.step.start
    → chat.message.start/update/end（流式内容）
    → chat.thinking.*（思维链）
    → chat.toolcall.*（LLM 调用意图）
    → chat.tool_execution.start/update/end（真实工具执行）
    → chat.step.end → chat.end
→ WSHandler 广播给已连接客户端
→ Vue stores 增量更新 → 分块 markdown 渲染 + rAF 滚动合并
```

`chat.continue` 是同一事件流的 trigger 变体：WSHandler 用 `void router.trigger(...)` fire-and-forget 受理，再 `await router.whenSessionIdle(chatDialogKey(viewerId, to))` 等 run 收尾后清理会话状态。

WS 还承载：RPC 请求/响应、心跳保活（30s ping/pong，清理半死连接）、插件事件（catalog/reload/assembly/ui-extensions）。

## 9.4 UI 扩展槽位（宿主先开口，插件后填空）

| slot | 作用 |
|------|------|
| `perspective` | 新增视角页 |
| `tool-result` | 自定义工具结果视图 |
| `message-view` | 自定义消息视图 |
| `ws-event` | 订阅 WS 事件 |
| `settings-tab:global` / `settings-tab:agent` | 设置页新标签 |
| `sidebar-action` | 侧边栏动作 |
| `global-style` | 全局样式 |

插件 `manifest.ui` 声明 `entry`（浏览器入口）、`slots`、`isolated`（iframe 隔离 + 受限桥接）。发布 stage 时宿主用 esbuild 打包 `ui/index.ts` → `ui/dist/index.js`。

## 9.5 练习

1. 打开浏览器 DevTools → Network → WS 帧，观察一次对话的所有事件类型。
2. 在 `src/ui/webui/src/core/registry/toolResultViews.ts` 找到 `read/write/edit/bash/web_search/browser/subagent` 对应的视图组件。
3. 读 `src/ui/webui/tests/csp-audit.test.ts` 与 `p5.5-policy.test.ts`，了解隔离运行时的安全边界。

## 下一步

[第 10 步：架构与依赖图](10-architecture-and-dependency-graph.md)
