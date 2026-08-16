# @agentchat/subagent
> 包路径 `src/svc/subagent` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
子 Agent 服务与工具。服务行 `agentchat-subagent-service` 构造并持有 `SubAgentManager`（无 hooks 独立上下文、共享父 LLM、受控工具集），工具行 `agentchat-subagent-tools` 注册单一 `subagent` 工具（action 分发 spawn/list/await/kill）。迁移自旧 `services/subagent + tools/subagent`。

## 目录（关键源文件 + 一句话）
| 文件 | 说明 |
| --- | --- |
| plugin.ts | 工具插件行：注册 subagent 工具 |
| service-plugin.ts | 服务插件行：构造 SubAgentManager，写 ctx.subagent 与 core.services.subAgent |
| register.ts | `registerSubagentTool(tools, owner)` 工厂注册入口 |
| tool.ts | subagent 工具（action=spawn/list/await/kill） |
| subagent.ts | SubAgentManager：spawn/awaitResult/kill/list/get 生命周期 |
| service.ts | `SubAgentService`（ctx.subagent 暴露 manager） |

## 插件行（工具行与服务行）
| 模块文件 | 插件 name | inject | 提供/注册内容 |
| --- | --- | --- | --- |
| plugin.ts | agentchat-subagent-tools | tools | 注册 subagent 工具（经 registerSubagentTool） |
| service-plugin.ts | agentchat-subagent-service | bootstrap + agentLoop | 构造 SubAgentManager → `ctx.subagent` 与 `core.services.subAgent` |

两行共用同一 SubAgentManager：工具运行时经 `services.subAgent` 取服务行构造的实例。

## 提供的能力
### ctx 服务表
| 服务 | 挂载点 | 说明 |
| --- | --- | --- |
| SubAgentService（name=`subagent`） | `ctx.subagent.manager` | SubAgentManager 实例 |
| ToolContext.subAgent | `core.services.subAgent` | 工具运行时读取同一 SubAgentManager |

### 工具表
| 工具 | label | requires | 要点 |
| --- | --- | --- | --- |
| subagent | 子 Agent 调度 | conductor | action=spawn/list/await/kill |

## 工具参考
| 工具 | name | label | requires | action 枚举 | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- | --- |
| subagent | subagent | 子 Agent 调度 | conductor | spawn / list / await / kill | spawn：task（必填）、name、tools、context、max_steps（默认 15）、timeout_s（默认 300）、wait（默认 false）、no_wait（旧名）、wait_s（默认 120）；await：subagent_id（必填）、wait_s（默认 60）；kill：subagent_id（必填） | spawn 异步运行并返回 `subagent_id`；`wait=true` 或 `no_wait=false` 时阻塞等待结果；await 可重复调用；kill 中断并回收 |

## 关键契约 / API
```ts
export class SubAgentManager {
  constructor(engine: AgentLoopEngine)            // ctx.agentLoop 注入
  setEventBus(bus: EventEmitter): this             // bootstrap 注入 router 事件总线
  async spawn(opts: SpawnSubAgentOptions, llm: LLMProvider,
              parentTools: Map<string, Tool>, onEvent?): Promise<SubAgentHandle>
  async awaitResult(id: string, waitMs?: number): Promise<SubAgentHandle | null>
  kill(id: string): boolean
  list(): SubAgentHandle[]
  get(id: string): SubAgentHandle | undefined
  readonly size: number
}
export type SubAgentStatus = 'running' | 'done' | 'error' | 'timeout' | 'killed'
export interface SubAgentHandle { id; parentId; name; status; task; startedAt; finishedAt?; result?; error? }
```
- 子 Agent 设计：无 hooks / 无会话持久化 / 无记忆注入；独立上下文（`history: []`、`systemPrompt: ''`、任务 prompt = 任务 + 附加上下文）；共享父 Agent 的 LLM 实例；受控工具集从父工具 `Map` 按 `toolNames` 筛选（留空则纯推理）；独立 `AbortController`，超时（默认 5 分钟）或 kill 可中断。
- 生命周期：`spawn → running → done/error/timeout/killed → 自动回收`；完成后 handle 保留结果进 `completed` 缓存（上限 50）供 `awaitResult` 查询。
- `subagent_id` 格式：`sub_<Date.now()>_<4 位随机>`。
- 事件上报：`setEventBus(core.router)` 注入 router 事件总线；`spawn` 的 `onEvent` 透传给引擎 `createContext.emit`。
- spawn 参数：`maxSteps` 默认 15；`timeoutMs` 默认 300s（`timeout_s * 1000`）；`wait_s` spawn 阻塞默认 120s，await 默认 60s。
- `awaitResult`：先查 completed 缓存，再查活跃表；`waitMs` 只用于日志提示，实际始终 `await entry.promise`（超时任务仍在后台，可再次 await）。

## 配置
本包无自有配置命名空间，无配置项。权限由工具 requires（`conductor`）控制。

## 与其他插件的关系
package.json 依赖：`@agentchat/agent-loop`、`@agentchat/llm`、`@agentchat/tools`、`@agentchat/util`、`@agentchat/cordis`、`@agentchat/toolkit`、`@agentchat/agent-config`。

使用方：boot 经 `ctx.plugin()` 挂载两行；服务行 inject `bootstrap + agentLoop`（引擎由 agent-loop 插件行提供）；工具行依赖 ToolContext 注入的 `subAgent`、`llm`、`tools`（父 LLM 与父工具集）。

## 行为细节
- `spawn` 组装的任务 prompt 明确告知子 Agent：「思考过程与工具调用不会写入任何会话记录」，完成后只返回最终结论。
- `list` 只返回活跃子 Agent；已完成/超时/被杀的在 completed 缓存中，可经 `get(id)` 查询。
- 父 kill 通过 `AbortController.abort()` 中断引擎运行，handle 状态置为 `killed`。

## 测试
package.json：`typecheck`（tsc --noEmit）、`test`（vitest run）。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
