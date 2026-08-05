# AgentChat 架构文档

> 最后更新 2026-08-06 · v0.5.0
>
> 本文档是**开发者向的架构说明**（反映当前代码结构）。详细的**目标架构设计与行为决策**
> 见工作区权威文档：`workspace/default/files/agent_chat_dev/note/architecture-target-20260805.md`
> （5 层目标架构 / Agent 无状态化 / steer 模型 / shutdown 域化）。

AgentChat 是一个基于 Node.js + TypeScript 的多 Agent 协作框架。5 层单向依赖架构：
`core`(引擎) → `agents`(调度) → `plugins`(扩展) → `services`(门面) → `app`(装配)。

---

## 1. 项目结构（5 层）

```
src/
├── core/        L1 引擎（依赖根：零外部依赖）
│   ├── loop.ts        ReAct 推理引擎（原 core/agent，Agent 类）
│   ├── context.ts     会话运行态（RunSession / SessionManager / convKeyFor）
│   ├── queue.ts       会话级执行队列（串行化 receive/trigger）
│   ├── interrupt.ts   语义化中断（InterruptReason 5 类 + ToolInterrupt）
│   ├── types/         核心契约（Message/Tool/Hook/LLMProvider/...）
│   └── llm/           推理引擎实现（base/openai/deepseek/chat-stream/schemas）
├── agents/      L2 调度（多 Agent 协作，仅进程内存态）
│   ├── registry.ts    Agent 注册表（实例管理）
│   ├── router.ts      电话交换机（消息分发 / steer / 网络失效 / 重启 pending）
│   ├── group.ts       群组管理（原 group-manager）
│   ├── config.ts      全局运行时配置 + 路径沙箱
│   ├── config-diff.ts 配置 diff / 热更新
│   ├── virtual-agent.ts  虚拟 Agent（user 端点，无 LLM）
│   ├── app-state.ts   AppState 运行时字典（registry/router 等注入点）
│   └── credential-store.ts  API Key AES-256-GCM 加密存取
├── plugins/     L3 扩展（实现 core 接口；插件自主注册服务）
│   ├── types.ts       插件契约（PluginManifest / PluginMeta）
│   ├── builtin/       内置插件（原 agent-core，plugin.json 容器模式）
│   │   ├── extensions/   agent-mcp / agent-prompt / agent-session / agent-memory
│   │   ├── tools/        全部内置工具（tag 驱动注入）
│   │   ├── interceptors/ send_agent_from / send_group_from / agent_profile
│   │   └── src/          timer（定时）/ sub-agent（子 Agent）
│   └── builtin-math/  数学工具插件（独立开关）
├── services/    L4 门面（webui/TUI/Desktop 唯一入口）
│   ├── registry.ts     服务注册表
│   ├── rpc.ts          JSON-RPC 2.0 适配层
│   ├── agent-service.ts / config-service.ts / group-service.ts / history-service.ts
│   ├── backup.ts       数据备份（weekly 轮转）
│   └── interactions.ts ask_user 交互桥
├── app/         L5 装配（唯一有副作用层）
│   ├── index.ts        启动流程 bootstrap（原 src/index.ts）
│   ├── loader.ts       AgentLoader（扫描 agents/ 装配）
│   ├── plugin-loader.ts PluginLoader（插件发现/加载/热重载）
│   ├── supervisor.ts   Supervisor 父进程（42=重启约定）
│   └── shutdown.ts     优雅关闭/重启（router 域 → 插件域 → WebUI → exit）
├── utils/       横切（logger / tokens，被全层用）
└── types/       chinese-lunar.d.ts
shared/types/    跨端契约（前端/后端共用，顶层零依赖）
```

**路径别名**：`@core` / `@agents` / `@app` / `@plugins` / `@services` / `@llm`(→core/llm) / `@utils` / `@shared`。

**分层铁律**：
- core 不 import agents/plugins/services/app
- agents 仅依赖 core
- plugins 仅依赖 core + agents（服务注册经 app 注入的 registerService 回调，不直接 import services）
- webui/server 只 import services/

---

## 2. 启动流程（app/index.ts bootstrap）

1. **Router + Registry + GroupManager** 最先就绪，无 Agent 依赖 → setAppState
2. **SubAgentManager** 初始化（子 Agent 生命周期管理）
3. **PluginLoader** 创建并注册（插件发现，注入 AppState + ServiceRegistry）
4. **AgentLoader.loadAll()** 扫描 `agents/`，装配工具/扩展/hooks（按 requires 匹配 tags）
5. **虚拟 Agent**（user）注册 → **真实 Agent** 实例化（LLM 工厂 + 凭据注入 + 注册工具）
6. **MessageQuery + HistoryService** 注册（只读历史查询门面）
7. **AgentService** 注册 + 可选启动 **WebUI Server**（REST + WS，默认 3830）
8. **TimerManager** 启动定时任务 → **Router.flushPendingMessages**（重启后重投 pending）
9. 首次运行：触发默认 admin Agent 自我介绍

每个真实 Agent 拥有独立 LLM 实例，通过 `user_id` 参数实现 DeepSeek 缓存隔离（`<sender>__<receiver>`）。

---

## 3. 核心引擎（core/loop.ts）

`Agent` 类持有 config / llm / tools / hooks / SessionManager，`run()` 执行 ReAct 循环：

```
receive(msg) / trigger(opts)
  (1) 会话级队列串行化（每会话独立，跨会话并行）
  (2) preHooks 链式变换（agent-prompt → agent-memory → agent-session）
  (3) executeLoop：中断检查 → steer 注入 → LLM 流式推理 → processTurn
  (4) runTools：ToolInterceptor 管道 → 并行执行 → 结果注入
  (5) 回到 (3) 或退出循环
  (6) postHooks 副作用（持久化 / 记忆更新）
```

**关键设计**：
- **会话级并行**：状态按会话隔离（RunSession per-conversation），一个 Agent 可同时处理多个会话
- **steer 转向**：会话执行中注入新指令，下一轮优先处理（按会话路由）
- **中断系统**：语义化 `InterruptReason` 5 类——`user-abort` / `tool-interrupt` / `reload-requested` / `restart-requested` / `max-turns`；postHooks 是唯一出口（中断/正常/异常都经过）
- **热重载**：reload（self/global/all）后 reinit 继续，无需重启

---

## 4. 消息路由（agents/router.ts）

```
User/Agent → Router.send(msg) → correlation_id 去重 → maxHops 检查 → Agent.receive() → ReAct → 响应
```

| 模式 | 触发条件 | 行为 |
|------|---------|------|
| 广播 | `to='*'` | 遍历所有 Agent |
| 群组 | `group_id` 非空 | 委托 GroupManager，遍历参与者 trigger() |
| 异步 | sendAsync() | fire-and-forget |
| 自主推理 | trigger() | 无消息的 ReAct 循环（定时/自省/steer） |

**网络失效模式**：连续网络类错误 → Router 进入 down，消息入队 pending（落盘）；恢复后重投。
**重启模式**：`enterRestartMode` 后新消息入队 pending，重启后 `flushPendingMessages` 重投。

---

## 5. 插件体系（plugins/）

**PluginManifest 容器模式**：一个 `plugin.json` 声明 Extensions / Tools / Interceptors，每项带 `requires`（tag 匹配）。

**工具注入（tag 驱动，v0.4.11+）**：工具按 `requires`（AND 语义）匹配 Agent `tags` 自动注入——`agent` 基础 / `dev` 开发 / `conductor` 调度 / `admin` 管理；config.tools 退化为显式追加。

**扩展（Pre/Post Hook）**：

| 扩展 | 类型 | 功能 |
|------|------|------|
| agent-prompt | PreHook | 动态 System Prompt 装配 + MCP 工具发现 |
| agent-session | Pre + PostHook | 会话持久化、历史加载、归档、摘要 |
| agent-memory | PreHook | 长期记忆（memory.md，token 预算截断） |
| agent-mcp | PreHook | MCP 服务器发现与工具注册（官方 SDK） |

**拦截器（3 个强制约束）**：`send_agent_from` / `send_group_from`（防伪造 from）、`agent_profile`（档案保护）。

**子 Agent 与定时器**：`plugins/builtin/src/sub-agent/`（SubAgentManager，无 hooks 独立上下文）与 `plugins/builtin/src/timer/`（TimerManager，5 种调度 + chime）为插件域能力。

---

## 6. 配置系统（agents/config.ts）

### 6.1 合并顺序

```
工具/扩展默认值 → workspace/config.json → agent/config.json
```

通过 `resolveNamespaceConfig(ns, defaults, runtimeCfg)` 三层合并；命名空间键（`"prefix.key"`）自动解析。

### 6.2 LLM Provider 池

```json
"llm": "deepseek-v4-pro"                            // 纯引用
"llm": { "$ref": "deepseek", "temperature": 0.5 }   // 引用 + 覆盖
"llm": { "provider": "deepseek", "model": "..." }   // 内嵌
```

---

## 7. 定时任务（plugins/builtin/src/timer/）

| 模式 | 配置 | 说明 |
|------|------|------|
| delay | `delay: "5m"` | 固定间隔 |
| random | `delayMin/delayMax` | 随机间隔 |
| time | `time: "08:00"` | 定时/指定日期 |
| workday / holiday | `time` | 基于 chinese-lunar |

全局报时（chime）默认北京时间 8:00-23:00 每小时推送；`__archive_all__` 特殊 hint 触发全局批量归档。

---

## 8. 服务门面（services/）

webui/TUI/Desktop 唯一入口。服务经 `ServiceRegistry` 注册，可映射为 **JSON-RPC 2.0** 调用（`agent.list` → `agentService.list` 等）；插件启动时经 app 注入的 `registerService` 回调自主注册服务。

---

## 9. 事件流

```
Agent._emit() → EventBus → Router → WebSocket → Vue 3 前端
```

流式事件：`chat.{start,end}` · `chat.turn.{start,end}` · `chat.message.{start,update,end,error}` · `chat.thinking.*` · `chat.toolcall.*` · `chat.tool_execution.*` · `chat.virtual.receive`

---

## 10. 文档索引

| 文档 | 说明 |
|------|------|
| [architecture.md](architecture.md) | 本文档（开发者向架构说明） |
| [tool-dev-guide.md](tool-dev-guide.md) | 工具开发指南 |
| [archive-orchestration.md](archive-orchestration.md) | 归档调度机制设计 |
| [token-usage-guide.md](token-usage-guide.md) | Token 消耗分析与优化 |
| [read-edit-design.md](read-edit-design.md) | read/edit 工具设计演进 |
| [README.md](../README.md) | 用户指南 |

> 历史复盘报告（记录当时事实，路径引用已过期，仅供追溯）：`group-reply-sparsity-report.md`、`message-role-refactor-report.md`
