# AgentChat 架构文档

> 最后更新 2026-08-16 · v0.6.3 —— **一切皆插件** 已达成，Router 投递链路已收敛（send/trigger + placement + whenSessionIdle）。
> 本文描述当前代码结构。历史迁移/设计方案见 [archive/README.md](archive/README.md)。

AgentChat 是一个基于 Node.js + TypeScript 的多 Agent 社区，运行在 **cordis 4 插件运行时** 之上：每个能力（引擎、LLM 适配器、工具、钩子、服务、HTTP 路由、WebUI）都是一个插件行，由 `cordis.yml` 声明、Loader 按服务依赖（inject）自动排序激活。仓库是 pnpm workspace monorepo：`src/*/*` 下 42 个 `@agentchat/*` 业务包 + `src/vendor/*` 下 8 个本地化的 cordis 生态包。

---

## 1. 总体原则

- **一切皆插件**：`cordis.yml` 的每一行 = 一个可挂/可摘的插件。业务能力全部经插件行注册进 `ctx` 服务。
- **契约先行**：包之间尽量只依赖类型（`import type`）；运行时能力经 `ctx` 服务（inject 依赖）获得。
- **注册中心归主**：`ctx.tools` / `ctx.hooks` 记录每个注册的 `owner`（插件名），支持动态插件卸载时精确回收。
- **装配自动排序**：`cordis.yml` 行序无激活语义；Loader 依据每个插件导出的 `inject` 声明推导服务依赖顺序。
- **挂行即挂能力**：摘掉某个工具域插件行，对应工具/钩子/HTTP 路由随之消失；boot 诊断行会在 5 秒后报告缺失服务而不崩进程。

## 2. 包布局（src/*/*）

```
src/
├── core/          L1 契约与引擎
│   ├── types/         @agentchat/types        核心域契约（消息/工具定义/来源元数据，零依赖）
│   ├── contracts/     @agentchat/contracts    引擎与钩子契约（Tool/CurrentContext/七类钩子/中断策略，零运行时依赖）
│   ├── llm/           @agentchat/llm          LLM 抽象基座（契约/BaseLLM/ChatStream/ctx.llm 注册表）
│   ├── llm-openai/    @agentchat/llm-openai   OpenAI 兼容适配器（openai + default 行）
│   ├── llm-deepseek/  @agentchat/llm-deepseek DeepSeek 适配器（thinking/logprobs/tool_choice）
│   ├── llm-glm/       @agentchat/llm-glm      智谱 GLM 适配器（glm-5.3 强制思考/reasoning_effort）
│   ├── llm-factory/   @agentchat/llm-factory  createLLM 库级分发（组合场景走 ctx.llm）
│   ├── agent-loop/    @agentchat/agent-loop   ReAct 引擎（run/createContext/pushSteer）
│   ├── agent-config/  @agentchat/agent-config AgentConfig/插件 manifest 契约（纯函数）
│   └── hooks/         @agentchat/hooks        钩子注册中心（ctx.hooks）
├── agents/        L2 单 Agent / 多 Agent 运行时
│   ├── agents/        @agentchat/agents        AgentAssembly / createAgentContext / Registry / 凭据
│   └── router/        @agentchat/router        消息路由 / GroupManager / VirtualAgent
├── toolkit|edit|tools   L3 工具基础
│   ├── toolkit/       @agentchat/toolkit       defineTool / 沙箱路径 / 命名空间 / token 工具
│   ├── edit/          @agentchat/edit          Hashline DSL 编辑引擎
│   └── tools/         @agentchat/tools        工具注册中心（ctx.tools）+ ToolContext 契约
├── fs|shell|web|dev|session-tools|restart|interaction|math   L3 工具领域（每域一个插件行）
├── agent-prompt|agent-skill|agent-session|agent-memory|agent-mcp|security|agent-tools   L3 扩展域（钩子/协作工具，每域一行）
├── svc/           L4 服务域
│   ├── timer/         @agentchat/timer         TimerManager + timer 工具（工具行 + 服务行）
│   ├── subagent/      @agentchat/subagent      SubAgentManager + subagent 工具
│   ├── archive/       @agentchat/archive       归档编排（先整理后归档）
│   ├── backup/        @agentchat/backup        数据备份
│   └── workspace/     @agentchat/workspace     工作区初始化
├── host/server/   L5 宿主：HTTP/WS 传输 + L4 门面
├── boot/boot/     L5 装配：bootstrap-core / finalize / diagnostics
├── plugins/plugins/   动态插件系统：PluginHost + 插件库 registry + 发布流程
├── sdk/protocol/      跨端类型契约（webui/desktop/后端共用）
├── ui/webui/          WebUI cordis 插件（Vue 前端源码 + dist + HTTP/WS/SPA）
├── util/util/         横切工具（日志/supervisor，零依赖）
├── examples/hello/    最小 cordis 插件示例（链路验证）
└── vendor/            本地化的 cordis 生态：cordis/cosmokit/schemastery/loader/logger/timer/hmr/include
```

依赖分层与边类型详见 [dependencies.md](dependencies.md) 与交互图 [dependency-graph.html](dependency-graph.html)。

## 3. 运行时组合（cordis.yml）

`cordis.yml` 是唯一装配入口（39 个活动插件行，HMR 行默认注释），按能力分组：

| 组 | 行 | 作用 |
|----|----|------|
| 基建 | `cordis-logger`、`cordis-timer` | 日志、定时纤维 |
| 传输口 | `server/src/http-plugin` | 提供 `ctx.http`（HTTP 路由注册表），宿主不拥有业务路由 |
| 核心服务 | `agent-loop`、`llm`、`tools`、`hooks`、`plugins` | 提供 `ctx.agentLoop / llm / tools / hooks / pluginHost` |
| LLM 适配器 | `llm-openai/src/plugin`、`llm-deepseek/src/plugin`、`llm-glm/src/plugin` | 向 `ctx.llm` 注册 openai/default、deepseek 与 glm 后端（可替换） |
| 工具领域 | `fs`、`shell`、`web`、`dev`、`session-tools`、`restart`、`interaction` | 各域一行注册工具（inject: tools） |
| 扩展域 | `agent-prompt`、`agent-skill`、`agent-session`、`agent-memory`、`agent-mcp`、`security`、`agent-tools` | 注册钩子/协作工具（inject: hooks/tools） |
| 工具注册 | `timer`、`subagent`、`math` | 注册三个共享/工厂工具（inject: tools） |
| 装配 | `boot/src/plugin` | inject agentLoop/llm/tools/hooks → `ctx.bootstrap`（Assembly/Router/Registry/Loader） |
| 工作区 | `workspace/src/plugin` | inject bootstrap → `ctx.workspace` + 初始化 + loadAgents |
| 服务宿主 | `archive`、`timer/service-plugin`、`subagent/service-plugin` | 各 Manager 由自身插件行持有，写入 boot 的 PluginServices |
| L4 门面 | `server/src/service-plugin` | inject bootstrap/workspace/timerManager/subagent/archive/http → `ctx.l4` + `/api/agents|history|groups` |
| 收尾 | `boot/src/plugin-finalize` | inject bootstrap/workspace/archive/timerManager/subagent/l4 → PluginManager/timer 启动/pending flush/`ctx.webServerHost` |
| 路由/UI | `server/src/http-routes-plugin`、`plugins/src/http-plugin`、`webui/src/plugin` | 各自注册 `/api/*`、`/api/plugins`、HTTP+WS+SPA |
| 诊断/验证 | `boot/src/plugin-diagnostics`、`@agentchat/hello` | 装配缺口诊断与链路验证 |

`boot/src/register-core.ts` 是与 cordis.yml 同构的**无 Loader 兜底**（直接 `ctx.plugin(...)`），供测试与嵌入式场景复用。

## 4. 启动流程

1. cordis Loader 读取 `cordis.yml`，按 inject 依赖排序激活所有行（各能力注册进 ctx）。
2. `boot/src/plugin`（inject: agentLoop/llm/tools/hooks）：
   - 加载全局配置（`workspace/config.json`，命名空间键 `prefix.key` 进 `namespaces`）；
   - 扫描全局插件库（`workspace/plugins/registry.json`）加载已安装插件；
   - 构建 `AgentAssembly`（engine=ctx.agentLoop；createLLM=ctx.llm；resolveTools=ctx.tools；resolveHooks=ctx.hooks；emit 包装为 router 'message' 事件）；
   - 创建 `AgentRouter` + `AgentRegistry` + `AgentLoader`，注册 `ctx.bootstrap` 与 `ctx.agents`。
3. `workspace/src/plugin`：files 指引、默认 `user` 虚拟 Agent、首次运行创建 `admin`（艾吉）与自我介绍，然后 `loadAgents()` 扫描 `workspace/default/agents/` 注册所有 Agent。
4. `archive / timer / subagent / server` 各行依次构造并持有自己的 Manager/门面，把共享引用写回 `PluginServices`（services.timer / subAgent / archiveSession / idleReset），并注册 `ctx.archive / timerManager / subagent / l4`。
5. `boot/src/plugin-finalize`：
   - 注册 PluginManager（`/api/plugins` 消费）→ 接线 shutdown 依赖；
   - `timer.reloadAll()`（全局 timer.tasks + 各 Agent timer 配置）；
   - 后台 `flushPendingMessages()`（重启后重投 pending，不阻塞启动）；
   - 启动归档超时 watcher；创建 `WebServerHostService`（enableWebUI 默认 true，`AGENTCHAT_NO_WEBUI=1` 可关）。
6. `webui/src/plugin`（inject: webServerHost/http）：注册 `/api/ui` 与 `/ui-plugin` 静态服务，启动 WebUIServer（HTTP + WS + SPA 托管，默认 3830）。
7. `boot/src/plugin-diagnostics`：5 秒后检查 `bootstrap/workspace/archive/timerManager/subagent/durableInteraction/l4/webServerHost` 八个必需服务，缺失告警但不崩。

## 5. 核心引擎（@agentchat/agent-loop）

`ctx.agentLoop` 暴露引擎入口 `run / createContext / enqueue / followup / steer / inject / drainInbox`。`run(ctx)` 是纯编排函数：

```
receive(msg) / trigger(opts)
  → createAgentContext(config, assembly, input)   # 每次投递即时装配（共享会话 inbox）
  → runStart 钩子链（按 config.hooks 顺序表执行；默认 admin 模板：mcp → prompt → memory → history）
  → ReAct 循环 [ 消费 next-step → chat.step.start → stepStart 钩子
                 → LLM 流式推理 → toolExecutionStart 钩子（持久化 checkpoint）
                 → 工具执行（并行/串行受控）→ chat.step.end
                 → stepEnd 钩子（本步增量落盘）]（直至 done）
  → runEnd 钩子链（save-session 最终 flush / idle-reset / archive-session / log-usage）
  → router 依序消费 next-turn（独立后续 run，受 MAX_AUTO_WAKES 约束）
  → 结果返回 router（send 调用方 / trigger 后台收尾）
```

术语边界（v0.6.3 起）：

| 术语 | 含义 |
|------|------|
| `run` | 一次执行生命周期：`chat.start` → … → `chat.end`，消息经 step checkpoint 增量落盘，runEnd 最终 flush |
| `step` | 一次 LLM 请求 + 它触发的工具执行 |
| `turn` | 交互层概念：一条用户提示到完成回复；由前端/协议层使用，不进 L1 字段 |

关键设计：
- **装配工厂**：`createAgentContext` 每次投递烘焙 LLM 实例、工具 Map、历史、七类钩子数组；`config.virtual` 时注入空 LLM（user 端点）。`AgentConfig` 只显式声明配置字段（deepThink/maxSteps 等），运行时字段由工厂显式映射，不再继承 `CurrentContext`。
- **会话级并行**：状态按会话隔离（`running: Map<convKey, ctx>` + `inboxes: Map<convKey, {nextTurn,nextStep}>`），一个 Agent 可同时处理多个会话。
- **双队列投递**：`next-step` 在当前 run 下一个 ReAct step 消费（loop 自然结束前会继续消费遗留 next-step）；`next-turn` 在当前 run 结束后作为独立 run 逐条消费（自主来源自动连跑 ≤ `MAX_AUTO_WAKES=3`）。`followup/steer/inject` 分别对应 next-turn 唤醒、next-step 唤醒、next-step 只入队不唤醒。
- **同会话串行**：同 convKey 运行中收到新消息 → 默认注入 `next-step`；
  `placement='next-run'`（或 trigger 带 `meta/maxSteps/deepThink`）等待会话空闲后作为独立 run 执行。
- **语义化中断**：`user-abort / tool-interrupt / reload-requested / restart-requested / max-steps` 五类；runEnd 钩子是唯一出口。
- **中断策略**：`CurrentContext.interruptHandlers` 由装配层注入，返回 `continue + patch` 则应用补丁继续推理、`end/void` 则收尾。reload-requested 的处理器重读配置并返回 `{ tools, systemPrompt }` 补丁（替代旧 performReload）。
- **run 事件元数据**：`chat.start` 携带 `hint/source`（来自 `CurrentContext.meta['chat.start']`）；后台/前台由消费方用 `isBackgroundRunSource(source)` 分类，loop 不判断 `isTrigger`。
- **持久化交互**：`ctx.durableInteraction`（`@agentchat/durable-interaction`，领域无关）提供 pending → answered → closed 状态机与 JSONL/内存后端；`ask_questions` 经 `InteractionBridge` 先落盘问题再弹窗、先落盘回答再续跑，`timeout_ms=0` 表示跨重启永久等待。

## 6. 工具系统（@agentchat/tools）

`ctx.tools = ToolsService` 是工具注册与解析的唯一入口。

- **注册**：`register(owner, tools, {always, replace})`（共享工具）与 `registerFactory(owner, factory)`（per-Agent 工厂）；`owner` = cordis 插件名 = preset id。
- **解析 `resolveTools(config, services)`**（旧 `(names, config, services)` 调用兼容）：
  1. presets 过滤：`config.presets` 声明启用哪些 owner；presets 缺省 = 旧契约兼容（不过滤）；无主/`always` 注册始终参与；
  2. requires 权限门禁：`requires` 非空时全部命中 Agent 能力标签才可启用（门禁不通过，include 也无效）。受控词汇表 `base/dev/admin/conductor`；`base` 为隐式基础能力层，旧 `agent` 标签读取时自动归一化；
  3. 工具意图覆盖：`config.tools = { include, exclude }`，优先级 `exclude > include > 默认`（requires 非空的候选默认启用）。
- **卸载**：`unregister(owner)` 供 PluginHost 回收动态插件注册。

工具清单（v0.6.3 实际注册）：

| 插件（owner） | 工具 |
|---|---|
| agentchat-fs-tools | read、write、edit |
| agentchat-shell-tools | bash |
| agentchat-web-tools | web_search、browser |
| agentchat-dev-tools | code_search(dev)、read_logs(dev)、reload(dev) |
| agentchat-plugin-tools | register_tool(admin)、register_plugin/unregister_plugin/publish_plugin(admin) |
| agentchat-session-tools | query_history、continue_turn、inspect_session(dev) |
| agentchat-restart-tools | system_restart(admin) |
| agentchat-interaction-tools | ask_questions |
| agentchat-agent-tools | send_agent、send_group、list_agents、list_groups、list_tools、read_agent_info、update_agent_profile |
| agentchat-timer-tools | timer（set/list/disable） |
| agentchat-subagent-tools | subagent(conductor)（spawn/list/await/kill） |
| agentchat-math | math |

> 注：`@agentchat/edit` 的 `makeEditTool`（Hashline DSL 编辑引擎）独立成包，由 `@agentchat/fs` re-export 并纳入 `makeFileTools`，随 `agentchat-fs-tools` 行自动注册（2026-08-16 起）。详见 [plugins/edit.md](plugins/edit.md)。

## 7. 钩子系统（@agentchat/hooks）

`ctx.hooks = HooksService`，七类钩子与引擎一一对应：

| kind | L1 字段 | 语义 |
|------|---------|------|
| runStart | runStartHook | 整次执行开始（chat.start） |
| runEnd | runEndHook | 整次执行结束（chat.end） |
| stepStart / stepEnd | stepStartHook / stepEndHook | 每个 ReAct step（一次 LLM + 工具批）前后 |
| toolExecutionStart / toolExecutionEnd | 同名 | 工具执行前/后 |
| fallback | fallbackHook | 失败路径兜底 |

- 钩子工厂签名 `(config, services) => hook`；`config.hooks.<kind>` 是**启用清单**，数组顺序即执行顺序，不在清单里 = 停用（没有独立的 disabled 数组）。
- owner 不在 presets 中会被跳过；未注册名字跳过（允许先配置后安装）。
- 内置注册：`agent-prompt.build-system-prompt`、`agent-skill.discovered_skills`、`agent-memory.load-memory`、`agent-mcp.open-mcp`、`agent-session.load-history`（runStart）；`security.security-check`（toolExecutionStart）；`security.redact-output`（toolExecutionEnd 变换，对结果 content/details 脱敏）、`hooks.log-tool`（toolExecutionEnd）；`agent-session.save-session / idle-reset / archive-session / log-usage`（runEnd）。
- `toolExecutionEnd` 支持返回 `string | { content?, details? }` 变换结果：loop 在写入 tool 消息与发射 `chat.tool_execution.end` 前应用。
- 旧配置的 `builtin.*` 名字经 `LEGACY_HOOK_ALIASES` 归一化为 `<域>.*`（见 plugins/core-agent-config.md）。

## 8. 消息路由与多 Agent（@agentchat/router）

```
input(receive | trigger)
  → lifecycleGate(live | shutdown)          # shutdown → pendingOf → enqueuePending 落盘
    → route(target × delivery × placement)  # 唯一投递路径
      target    = agent_id | '*'（广播 fanout）| group_id（GroupManager 委托）
      delivery  = await | fire-and-forget    # 仅 receive 可 await；trigger 永远 fire-and-forget
      placement = steer | next-run           # submit() 唯一 busy 决策点
      inbox     = next-turn | next-step      # 双队列：loop 消费 next-step，router 消费 next-turn
        → fanout → deliverOne / routeTrigger → submit → startRun → runWithGate
```

- **公开入口**：`send(msg, { wait, placement, signal })`（wait 默认 true）、`sendAsync(msg)` 为 wait=false 糖、
  `trigger(agentId, options?, signal?)` 永远 fire-and-forget、`followup/steer/inject(agentId, message, opts?)`
  显式 inbox 投递、`whenSessionIdle(convKey, timeoutMs)` 等待会话收尾（WS `chat.continue` 用）。
- **去重/跳数**：`correlation_id` 由 L5 WS 关联透传；`maxHops` 仍存在于全局配置默认值，但当前 AgentRouter 不消费（详见 plugins/router.md）。

- **会话繁忙（placement）**：默认 `steer` —— 注入当前 run 的 next-step；`next-run` —— 等待会话空闲后作为独立 run
  （receive 可显式指定；trigger 带 `meta/maxSteps/deepThink` 等 run 级选项时默认强制 `next-run`）。
- **inbox 双队列**：`next-step` 每个 ReAct step 前消费全部，run 自然结束时若仍有 next-step 则继续消费；
  `next-turn` 在当前 run 结束后逐条开新 run（自主来源连跑 ≤ 3 次，用户/Agent 来源不受限）。
- **重启恢复**：`enterShutdownMode()` 后新消息/trigger 统一经 `pendingOf` 序列化落盘 `<ws>/.router_pending.jsonl`；
  `flushPendingMessages()` 按 `chatDialogKey/groupDialogKey` 分组重投：trigger 用 `triggerOptions` 重建内部 plan
  （delivery=await 保留失败判定），receive 同会话同目标合并；失败保留待下次重试。
- **GroupManager**：群组创建/join/leave；消息广播给参与者，每个 Agent 独立判断是否回复。
- **VirtualAgent**：`user` 等虚拟端点无 LLM，仅作路由端点。

## 9. L4 门面与传输（@agentchat/server）

`ctx.l4`（server/src/service-plugin）聚合：

| 组件 | 职责 |
|------|------|
| InteractionBridge | `ask_questions` 用户交互桥（pending 问题/回答） |
| ServiceRegistry | 服务注册表（agentService/groupService/historyService/pluginManager/…） |
| RPCBridge | JSON-RPC 2.0（`agent.list` → `agentService.list` 等） |
| AgentService / GroupService / HistoryService | CRUD/查询门面 |
| HttpRouteRegistry（ctx.http） | 各插件行自行注册路由；`WebUIServer` 只 mount 中间件/WS/SPA |

主要路由：`/api/agents`、`/api/history`、`/api/groups`（service-plugin）；`/api/upload|config|browse|workspace|backup|version|usage|sessions`（http-routes-plugin）；`/api/plugins/*`（plugins/http-plugin）；`/api/ui`、`/ui-plugin`（webui 行）。

WS 通道：RPC 请求 + 流式事件广播 + 心跳保活（30s ping/pong）。

## 10. 动态插件系统（@agentchat/plugins）

`ctx.pluginHost = PluginHost` 支持运行态加载第三方插件：

- **manifest 契约**（`workspace/plugins/<name>/manifest.json`）：name/version/entry/inject/config/permissions/provides/ui。
- **权限 gate**：`fs/network` 默认授予；`process/shell/ui` 需宿主显式授予；import 之前拒绝未授权插件。
- **生命周期**：同名替换先回收旧 fiber 与 owner 的 tools/hooks 注册，激活失败回滚旧版本；watch 开发模式按目录哈希（750ms 轮询）自动重载。
- **插件库**：`publish_plugin(stage→approve)` 人审流程；`registry.json` 记录安装/权限/哈希；`.staging/.backup` 管理暂存与旧版本；"发布 ≠ 启用"，Agent 需在 `presets` 中引用 manifest.name。
- **UI 扩展**：manifest.ui 声明浏览器入口/slots（perspective、tool-result、message-view、ws-event、settings-tab:global/agent、sidebar-action、global-style），可选 iframe 隔离运行。

## 11. 事件流

```
loop 事件 → AgentAssembly.emit 包装 → Router 'message' 事件 → WSHandler → Vue 前端
```

流式事件：`chat.{start,end}` · `chat.step.{start,end,steered}` · `chat.message.{start,update,end,error}` · `chat.thinking.{start,update,end}` · `chat.toolcall.{start,update,end}` · `chat.tool_execution.{start,update,end}`。

插件域事件（PluginHost → PluginEventBus → WS）：`plugin.catalog.changed`、`plugin.reload`、`agent.assembly.changed`、`plugin.ui.extensions.changed`。

## 12. 文档索引

| 文档 | 说明 |
|------|------|
| [configuration.md](configuration.md) | 配置参考 |
| [plugin-system.md](plugin-system.md) | 插件体系与开发闭环 |
| [dependencies.md](dependencies.md) / [dependency-graph.html](dependency-graph.html) | 依赖图 |
| [plugins/README.md](plugins/README.md) | 41 包 + vendor 的插件文档索引 |
| [tutorial/README.md](tutorial/README.md) | Step-by-Step 学习资料 |
| [archive/README.md](archive/README.md) | 历史文档归档 |
