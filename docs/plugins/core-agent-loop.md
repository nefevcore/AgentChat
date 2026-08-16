# @agentchat/agent-loop
> 包路径 `src/core/agent-loop` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
ReAct 引擎包：把 `run(ctx)` 编排纯函数、`CurrentContext` 执行快照、语义化中断与会话键哈希封装为 cordis 服务 `ctx.agentLoop`。引擎不持有状态、不触碰 Agent 实例/全局配置，只消费装配层注入的 `CurrentContext`；消费者（router/agents/subagent）经 `AgentAssembly.engine` 或构造器注入获得，不再直接 import 引擎函数。

> 契约化调整：`CurrentContext / Tool / RunResult / CoreEventType / InterruptReason / 七类钩子 / InterruptHandler` 已迁至 `@agentchat/contracts`；本包 re-export 保持兼容。

## 目录
| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | 服务插件行：`ctx.agentLoop = new AgentLoopService(ctx)` |
| `service.ts` | `AgentLoopService` / `AgentLoopEngine`：暴露 `run/createContext/pushSteer` |
| `contracts.ts` | 引擎契约：`Tool`、`RunResult`、`AgentResult`、`CoreEventType` |
| `loop.ts` | ReAct 编排纯函数 `run(ctx)` + 单步处理/流式调用/工具执行/usage 累计 |
| `context.ts` | `CurrentContext` + `createContext/pushSteer/drainSteer` + 七类生命周期钩子契约 |
| `interrupt.ts` | `InterruptReason`（5 类）、`ToolInterrupt`、`isToolInterrupt`、`describeInterrupt` |
| `hash.ts` | `hashDialogId`：dialogId → SHA-256 截断 32 位 hex（进程内 memoize） |

## 插件行
| 模块文件 | 插件 name | inject | 提供的 ctx 服务 / 注册内容 |
| --- | --- | --- | --- |
| `plugin.ts` | `agentchat-agent-loop` | —（无依赖） | `ctx.agentLoop = AgentLoopService`（`run`/`createContext`/`pushSteer`） |

## 提供的能力
### ctx.agentLoop（AgentLoopService）
| 成员 | 类型 / 语义 |
| --- | --- |
| `run(ctx)` | `(ctx: CurrentContext) => Promise<RunResult>`，执行完整 ReAct 生命周期 |
| `createContext` | `(input: Omit<CurrentContext,'inbox'> & { inbox? }) => CurrentContext`（inbox 缺省双空队列） |
| `enqueue` | `(ctx, message, target)` 按 lane 入队（底层原语） |
| `followup / steer / inject` | next-turn / next-step 唤醒 / next-step 不唤醒 |
| `drainInbox` | `(ctx, target)` 消费指定队列（FIFO） |
| `pushSteer` | **@deprecated** 旧 API = steer（next-step） |

### CurrentContext 关键字段
| 字段 | 语义 |
| --- | --- |
| `llm` | `LLMProvider` 推理引擎 |
| `systemPrompt` / `history` / `currentMessage` | 初始消息装配输入 |
| `tools` | `Map<string, Tool>`，每步重新生成定义快照（支持运行时热注册） |
| `inbox` | `{ nextTurn, nextStep }` 双队列：loop 每步 `drainInbox('next-step')`；next-turn 由 router 在 run 边界消费 |
| `deepThink` / `maxSteps` | 深度思考开关 / ReAct 步数上限（`>0` 仅 trigger 模式生效） |
| `signal` | `AbortSignal` 外部中断 |
| `dialogId` / `agentId` | 缓存隔离键来源 / 当前执行 Agent ID |
| `emit` | 事件发射；缺省时 loop 走非流式 fast-path |
| 七类钩子数组 | `runStartHook/runEndHook/stepStartHook/stepEndHook/toolExecutionStartHook/toolExecutionEndHook/fallbackHook` |
| `toolExecutionEndHook` | 观察 + 变换：返回 `string | { content?, details? }` 时 loop 在写入 tool 消息/发射事件前应用 |
| `interruptHandlers` | 语义化中断策略：返回 `{ action:'continue', patch? }` 则继续推理，否则收尾（替代 `performReload`） |
| `meta` | 上层约定的通用扩展元数据通道；`meta['chat.start'] = { hint?, source? }` 供 chat.start 事件展开 |

### run() 流程
`chat.start` → `runStartHook` → 每步 [ `drainInbox('next-step')`（有消息时发 `chat.step.steered`）→ `stepStartHook` → LLM 流式推理 → 工具调用（`toolExecutionStartHook(toolName, args, execution)` 可拦截/改写参数 → 执行 → `toolExecutionEndHook` 变换）→ 结束判定 ] → `stepEndHook` → `runEndHook` → `chat.end`。`execution` 携带 `toolCallId/dialogId/agentId/context/messages`（持久化 checkpoint 用）。异常路径经 `fallbackHook` + 致命兜底后事件流仍闭合；自然结束时若 next-step 非空则继续一个 step 消费。

## 关键契约 / API
### Tool 契约
```ts
export interface Tool {
  name: string;                    // = definition.function.name
  label: string;
  description?: string;
  ns?: string;                     // 如 "tool.bash"
  requires?: string[];             // AND 语义：Agent 需含全部标签才可用
  definition: ToolDefinition;
  execute: (args, stream?, signal?, exec?: ToolExecutionContext) =>
    Promise<string | { content: string; details?: any }>;
  // exec = { toolCallId, dialogId?, agentId? }（恢复对账 / 持久化用；可选，旧工具兼容）
  extractLabel?: (args) => string; // UI 标签简短描述
}
```

### InterruptReason（5 类）
```ts
type InterruptReason =
  | { type: 'user-abort'; detail?: string }                   // 用户打断（AbortSignal）
  | { type: 'tool-interrupt'; tool: string; detail?: string } // 工具被中止
  | { type: 'reload-requested'; scope: ReloadScope }          // 请求热重载
  | { type: 'restart-requested'; reason?: string }            // 请求重启后端
  | { type: 'max-steps' };                                    // 达到最大步数
```
- `ToolInterrupt` 是“预期控制流”（非错误）：工具抛它表达 reload/restart/被中止，`runTools` 捕获后不写 error tool 消息，改为 `(工具中断) ...` tool 消息并语义化收尾。
- `reload-requested`：装配层注入的 `interruptHandlers` 可执行热重载并返回 `{ action:'continue', patch:{ tools, systemPrompt } }`，loop 应用补丁后继续推理；未注入处理器则按中断收尾。

### CoreEventType 全集（18 个）
```ts
'chat.start' | 'chat.end'
| 'chat.step.start' | 'chat.step.end' | 'chat.step.steered'
| 'chat.message.start' | 'chat.message.update' | 'chat.message.end' | 'chat.message.error'
| 'chat.thinking.start' | 'chat.thinking.update' | 'chat.thinking.end'
| 'chat.toolcall.start' | 'chat.toolcall.update' | 'chat.toolcall.end'
| 'chat.tool_execution.start' | 'chat.tool_execution.update' | 'chat.tool_execution.end'
```
- `emitLoop` 统一附加 `dialogId + agentId` 到事件 data。

### 其他
- `hashDialogId(dialogId)`：SHA-256 → 32 位 hex；DeepSeek `user_id` 缓存隔离键（稳定、避免特殊字符、进程内 Map 缓存）。
- `RunResult`：`{ content, interrupted, interruptReason?, messages, usage? }`；`AgentResult`：`{ content, interrupted, interruptReason? }`。
- usage 累计双轨：`prompt_tokens/total_tokens` 覆盖为最新值；`completion_tokens/cache_hit/cache_miss/accumulated_*` 累加；`react_steps` 每次 +1。

## 配置
无插件配置命名空间。引擎行为由 `CurrentContext` 字段驱动（`deepThink`、`maxSteps`、`dialogId`、`agentId`、`meta` 等）。

## 与其他插件的关系
- 工作区依赖：`@agentchat/llm`、`@agentchat/types`、`@agentchat/util`、`@agentchat/cordis`。
- 典型使用方：`@agentchat/agent-config`（`AgentConfig` 继承 `CurrentContext` 配置面）、`@agentchat/hooks`（import type 七类钩子类型）、`@agentchat/agents`（`AgentAssembly.engine` 注入 `ctx.agentLoop`）、router/subagent 装配层。

## 测试
- `tests/interrupt.test.ts`：`ToolInterrupt` 构造/跨 bundle 识别、`describeInterrupt` 文案。
- `tests/context.test.ts`：`createContext` inbox 缺省、`enqueue/followup/steer/inject/drainInbox` 双队列 FIFO、旧 pushSteer 兼容。
- `tests/loop.test.ts`：基本回复、工具循环、`maxSteps`、abort 前置、next-step 注入与末轮竞态续跑、LLM/工具错误、`ToolInterrupt` 语义化中断、`interruptHandlers` 续跑、toolExecutionEnd 变换、usage 双轨累计、事件流与七类钩子（含钩子抛错隔离、致命兜底闭合）。

## 相关文档
[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
