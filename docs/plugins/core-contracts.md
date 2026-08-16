# @agentchat/contracts
> 包路径 `src/core/contracts` · 版本 0.1.0

## 概述
零运行时依赖的引擎与钩子契约包（仅 `import type`）。`@agentchat/agent-loop` 与 `@agentchat/hooks` 共同依赖本包，消除“配置/钩子反向依赖引擎实现”的耦合。

## 提供的能力
| 文件 | 契约 |
| --- | --- |
| `interrupt.ts` | `InterruptReason`（5 类）、`ReloadScope` |
| `engine.ts` | `Tool`、`RunResult`、`AgentResult`、`CoreEventType` |
| `context.ts` | `CurrentContext`、七类钩子签名、`ToolExecutionOutcome/Result`、`InterruptHandler/Resolution`、`CHAT_START_META_KEY`、`RunStartMeta` |

## 关键约定
- `CurrentContext` 不再包含 `mode / triggerHint / triggerSource / performReload / redactResult`，且 `steer[]` 升级为 `inbox { nextTurn, nextStep }` 双队列。
- run 事件元数据经 `ctx.meta[CHAT_START_META_KEY]`（=`'chat.start'`）传递 `{ hint?, source? }`；loop 只展开该键到 `chat.start` 事件，不判断 trigger；后台/前台由消费方 `isBackgroundRunSource(source)` 分类。
- `toolExecutionEndHook` 返回 `string | { content?, details? }` 时由 loop 应用变换。
- `interruptHandlers` 返回 `{ action:'continue', patch? }` 时 loop 应用补丁继续推理。

## 与其他包的关系
- 依赖（type-only）：`@agentchat/types`、`@agentchat/llm`。
- 使用方：`@agentchat/agent-loop`、`@agentchat/hooks`、`@agentchat/agents`、`@agentchat/router`、`@agentchat/security`、`@agentchat/tools`。
