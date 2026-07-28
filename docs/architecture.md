# AgentChat 架构文档

> 最后更新 2026-07-28 &middot; v0.1.0

AgentChat 是一个基于 Node.js + TypeScript 的多 Agent 协作框架。本文档面向开发者，描述系统内部设计。

---

## 1. 项目结构

```
AgentChat/
├── src/
│   ├── index.ts                # 启动入口 bootstrap()
│   ├── core/                   # 核心引擎
│   │   ├── agent.ts            #   ReAct 推理循环 (~1200 行)
│   │   ├── types.ts            #   全部核心类型定义 (457 行)
│   │   ├── config.ts           #   全局运行时配置 + 路径安全
│   │   ├── timer-manager.ts    #   定时任务调度 + 全局报时
│   │   ├── virtual-agent.ts    #   虚拟 Agent（用户代理）
│   │   ├── credential-store.ts #   凭据存储
│   │   ├── app-state.ts        #   全局 AppState
│   │   └── config-diff.ts      #   配置 diff 工具
│   ├── discovery/              # Agent 发现与加载
│   │   ├── agent-loader.ts     #   扫描 agents/ + 插件发现
│   │   └── config-types.ts     #   配置类型定义
│   ├── routing/                # 消息路由
│   │   ├── router.ts           #   电话交换机
│   │   ├── group-manager.ts    #   群组管理
│   │   ├── registry.ts         #   Agent 注册表
│   │   └── message-query.ts    #   历史查询服务
│   ├── llm/                    # LLM 适配器
│   │   ├── openai.ts           #   OpenAI Compatible
│   │   └── deepseek.ts         #   DeepSeek 专用
│   ├── global/                 # 全局插件
│   │   ├── agent-core/         #   核心插件包
│   │   └── agent-math/         #   数学工具插件包
│   └── utils/logger.ts         # 日志工具
├── webui/                      # Web 管理界面
│   ├── server/                 # Express + WebSocket 后端
│   └── client/                 # Vue 3 前端
├── workspace/default/          # 运行时数据目录
│   ├── agents/                 # Agent 定义
│   ├── sessions/               # 会话历史
│   ├── groups/                 # 群组数据
│   ├── files/                  # Agent 工作文件
│   └── config.json             # 全局配置
└── docs/                       # 项目文档
```

---

## 2. 启动流程

`bootstrap()` 函数按 7 步串联整个系统：

| Step | 组件 | 说明 |
|------|------|------|
| 1 | Router + Registry + GroupManager | 最先就绪，无 Agent 依赖 |
| 2 | AgentLoader.loadAll() | 扫描 agents/ 目录，解析 config.json，发现全局插件 |
| 3 | VirtualAgent 注册 | user 等虚拟 Agent，无 LLM，仅走 Hook 管道 |
| 4 | 真实 Agent 实例化 | LLM 工厂创建实例 &rarr; 注册工具 &rarr; 拦截器 &rarr; Hook |
| 5 | MessageQuery 初始化 | JSONL 只读查询服务 |
| 6 | WebUI Server 启动 | Express REST + WebSocket（可选） |
| 7 | TimerManager 启动 | 加载定时任务 + 全局报时 |

每个真实 Agent 拥有独立的 LLM 实例，通过 `user_id` 参数实现 DeepSeek 缓存隔离（格式: `<sender>__<receiver>`）。

---

## 3. 分层架构

系统分为 5 层：

### 3.1 入口层 (Entry)

| 模块 | 文件 | 职责 |
|------|------|------|
| bootstrap() | src/index.ts | 启动编排，串联全链路 |
| WebUI Server | webui/server/ | Express + WebSocket 双协议 |
| AgentLoader | src/discovery/ | 扫描 agents/，解析 plugin.json，LLM 池引用展开 |
| VirtualAgent | src/core/ | 用户代理，无 LLM，仅走 Hook 管道持久化消息 |

### 3.2 路由层 (Routing)

| 模块 | 职责 |
|------|------|
| AgentRouter | 电话交换机。send / sendAsync / trigger / broadcast 四种投递模式 |
| GroupManager | 群聊生命周期管理，消息广播与持久化 |
| AgentRegistry | Agent ID &rarr; 实例映射，区分真实/虚拟 Agent |
| MessageQuery | 只读历史查询，关键词过滤 + 分页 |

**死循环防护**：
- `correlation_id` 去重（Set 缓存最近 200 条）
- `maxHops` 跳数限制（默认 5）

### 3.3 核心层 (Agent Core)

| 模块 | 职责 |
|------|------|
| Agent | ReAct 推理引擎，9 种流式事件，支持中断/steer/热重载 |
| Types | 核心类型：Message, AgentContext (25+ 字段), Tool, Extension, Hook 等 |
| TimerManager | 5 种调度模式 + 中国节假日 (chinese-lunar) + 全局报时 |
| AppConfig | 统一配置，命名空间键解析 + 三层合并 + 路径沙箱 |

### 3.4 插件层 (Plugins)

采用 **PluginManifest 容器模式**：一个 plugin.json 可同时声明 Extensions、Tools、Interceptors。

**Extensions (PreHook / PostHook)**：

| 扩展 | 类型 | 功能 |
|------|------|------|
| agent-prompt | PreHook | 动态提示词生成，MCP 工具发现 |
| agent-session | Pre + PostHook | 会话持久化、历史加载、归档、摘要 |
| agent-memory | PreHook | 长期记忆管理 (memory.md) |

**Tools (16 个)**：

| 工具 | 类型 | 功能 |
|------|------|------|
| read / write / edit / bash | 静态 | 文件系统操作（可选声明） |
| web_search | 静态 | 网络搜索，4 引擎可选 |
| list_agents / send_agent | autoInject | Agent 查询与通信 |
| list_groups / send_group | autoInject | 群聊查询与通信 |
| query_history | autoInject | 对话历史查询 |
| set_timer / list_timers / disable_timer | autoInject | 定时任务管理 |
| get_agent_profile / update_agent_profile | autoInject | Agent 档案管理 |
| reload_self_tools | autoInject | 工具热加载 |

> autoInject 标记的工具自动注入到所有真实 Agent，无需在 config.json 中显式声明。

**Interceptors (3 个强制约束)**：

| 拦截器 | 功能 |
|--------|------|
| send_agent_from | 自动注入 from 字段，防伪造 |
| send_group_from | 自动注入群聊 from，防伪造 |
| agent_profile | 禁止 Agent 修改他人档案 |

### 3.5 基础设施层 (Infrastructure)

| 模块 | 职责 |
|------|------|
| LLM Adapters | OpenAI Compatible + DeepSeek 专用适配器 |
| Sessions / Files | JSONL 持久化、memory.md、记忆归档 |
| CredentialStore | Agent 级 &gt; 全局级 &gt; 池配置 api_key 三级查找，AES-256-GCM 加密 |
| Chime | 全局报时，整点推送 (8:00-23:00) |

---

## 4. ReAct 推理循环

Agent.run() 的执行流程分为 6 个阶段：

```
receive(msg) / trigger(opts)
  (1) 执行队列串行化（MAX=32）
  (2) preHooks 链式变换
        agent-prompt &rarr; agent-memory &rarr; agent-session
  (3) executeLoop
        中断检查 &rarr; steer 注入 &rarr; invokeLLM(流式) &rarr; processTurn
  (4) runTools（有 tool_calls 时）
        每条调用 &rarr; Interceptor(强制约束) &rarr; 执行 &rarr; 结果注入
  (5) 回到 (3) 或退出循环
  (6) postHooks 副作用
        agent-session(持久化) &rarr; agent-memory(更新记忆)
```

**关键设计决策**：
- postHooks 是**唯一出口**：中断、正常完成、异常三条路径都经过它
- 流式调用通过 9 种事件类型驱动前端实时渲染
- steer 机制允许在 Agent 执行中途注入新指令

---

## 5. 消息路由

### 5.1 点对点通信

```
User/Agent &rarr; Router.send(msg) &rarr; cid 去重 &rarr; maxHops 检查 &rarr; Agent.receive(msg) &rarr; ReAct &rarr; 响应
```

### 5.2 特殊路由

| 模式 | 触发条件 | 行为 |
|------|---------|------|
| 广播 | `to='*'` | 遍历所有 Agent |
| 群组 | `group_id` 非空 | 委托 GroupManager，遍历参与者 trigger() |
| 异步 | sendAsync() | fire-and-forget，不等待回复 |
| 自主推理 | trigger() | 无消息的 ReAct 循环（定时/自省） |

---

## 6. 配置系统

### 6.1 合并顺序

```
工具/扩展默认值 &rarr; workspace/config.json &rarr; agent/config.json
```

通过 `resolveNamespaceConfig(ns, defaults, runtimeCfg)` 实现三层合并。

### 6.2 命名空间键

workspace/config.json 中以 `"prefix.key"` 格式命名的键自动解析到命名空间字典：

```json
{
  "tool.bash": { "defaultTimeout": 30000 },
  "extension.agent_session": { "maxContextTokens": 1000000 }
}
```

### 6.3 LLM Provider 池

Agent 可通过三种方式引用 LLM：

```json
"llm": "deepseek-v4-pro"                              // 纯引用
"llm": { "$ref": "deepseek", "temperature": 0.5 }     // 引用 + 覆盖
"llm": { "provider": "deepseek", "model": "..." }     // 内嵌
```

---

## 7. 定时任务系统

支持 5 种调度模式：

| 模式 | 配置 | 说明 |
|------|------|------|
| delay | `delay: "5m"` | 固定间隔 |
| random | `delayMin: "30s"`, `delayMax: "5m"` | 随机间隔 |
| time | `time: "08:00"` 或 `"2026-07-28 14:30"` | 定时/指定日期 |
| workday | `time: "09:00"` | 工作日（基于 chinese-lunar） |
| holiday | `time: "10:00"` | 节假日（基于 chinese-lunar） |

全局报时 (chime) 通过 TimerManager 实现，默认北京时间 8:00-23:00 每小时推送。

---

## 8. LLM 适配器

两个适配器，每个 Agent 独立实例：

| 适配器 | 文件 | 特性 |
|--------|------|------|
| OpenAIChatLLM | src/llm/openai.ts | chat + stream，兼容 OpenAI API |
| DeepSeekChatLLM | src/llm/deepseek.ts | thinking 流式、user_id 缓存隔离、logprobs、reasoning_effort |

---

## 9. 事件流

Agent 通过 EventBus 向外发射流式事件，Router 转发到 WebSocket，前端实时渲染：

```
Agent._emit() &rarr; EventBus &rarr; Router &rarr; WebSocket &rarr; Vue 3 前端
```

**16 种事件类型**：chat.thinking.{start,update,end} &middot; chat.message.{start,update,end,error} &middot; chat.toolcall.{start,update,end} &middot; chat.tool_execution.{start,update,end} &middot; chat.turn.{start,end} &middot; chat.{start,end,interrupt} &middot; chat.virtual.receive

---

## 10. 文档索引

| 文档 | 说明 |
|------|------|
| [architecture.html](architecture.html) | 架构全景图（HTML 可视化） |
| [architecture.md](architecture.md) | 本文档 |
| [README.md](../README.md) | 用户指南 |
| [tool-dev-guide.md](tool-dev-guide.md) | 工具开发指南 |
