# @agentchat/interaction
> 包路径 `src/interaction/interaction` · 版本 0.1.0 · 文档对应 v0.6.3（2026-08-16）

## 概述
用户交互工具包。提供 ask_questions（InteractionBridge 交互桥批量提问）。领域独立，可脱离 AgentChat 复用。
（2026-08-16 自 `@agentchat/app-tools` 拆分：system_restart 与 ask_questions 各自独立插件行，可分别启停。）

## 目录（关键源文件 + 一句话）
| 文件 | 说明 |
| --- | --- |
| plugin.ts | cordis 插件行，注册用户交互工具 |
| register.ts | `registerInteractionTools(tools, owner)` 工厂注册入口 |
| tools.ts | ask_questions 实现 |

## 插件行
| 模块文件 | 插件 name | inject | 提供/注册内容 |
| --- | --- | --- | --- |
| plugin.ts | agentchat-interaction-tools | tools | 经 `registerInteractionTools` 注册 ask_questions |

## 提供的能力
### 工具表
| 工具 | label | requires | 要点 |
| --- | --- | --- | --- |
| ask_questions | 询问用户 | base | InteractionBridge 交互桥，pending 问题与用户回答 |

## 工具参考
| 工具 | name | label | requires | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- |
| ask_questions | ask_questions | 询问用户 | base | questions（必填，最多 5 题；每题 question + options 2-6 个）、timeout_ms（可选；不设或 0 = 永久等待，跨重启恢复；正整数 = 等待时限） | 调 `services.interaction`（InteractionBridge）的 `askQuestions({agentId, convKey, questions, timeoutMs, signal})`；convKey 缺省 `${agentId}__unknown`；超时返回 `{status:'timeout'}`；正常返回 `{status:'ok', data:{answers, questions}}` |

## 关键契约 / API
```ts
registerInteractionTools(tools: ToolsService, owner: string): void
// 工厂：makeInteractionTools(config, services) → [makeAskQuestionsTool(config, services)]
```
- `ask_questions` 依赖 ToolContext 注入的 `services.interaction`（InteractionBridge）；工具 `execute` 拿到 `signal`（AbortSignal）并传给交互桥。
- `ask_questions` 参数规整：题目被 `slice(0,5)` 截断、每题选项 `slice(0,6)`，过滤无 question 或无选项的题目；`timeout_ms` 仅接受 number 类型，**缺省 0（永久等待），仅显式设置正整数才有时限**（交互桥同口径）。
- `ask_questions` 的参数 Schema 要求 questions 为数组；`args.convKey` 虽未在 Schema 声明，但运行期会读取（可用于关联会话）。

## 配置
本包无自有配置命名空间。相关项：

| 项 | 值/默认 | 说明 |
| --- | --- | --- |
| ask_questions.questions | 最多 5 题 | 每题 question + options（截断到 6 个） |
| ask_questions.timeout_ms | 0（永久等待） | 缺省永久等待（跨重启恢复）；显式设置正整数才有时限 |
| ask_questions.convKey | `<agent_id>__unknown` | 关联 pending 问题与回答 |

## 与其他插件的关系
package.json 依赖：`@agentchat/agent-loop`、`@agentchat/toolkit`、`@agentchat/tools`、`@agentchat/cordis`、`@agentchat/agent-config`。

使用方：工具经 `ctx.tools` 注册；`ask_questions` 依赖 `ctx.tools` 的 ToolContext 注入 `interaction` 桥（InteractionBridge，由 server 服务行提供）。

## 行为细节
- `ask_questions` 在工具执行期间暂停当前推理；前端逐题回答（避免来回调用工具）；默认允许用户输入自定义答案替代选项。
- `ask_questions` 的交互桥调用参数：`{agentId, convKey, questions, timeoutMs, signal}`；`convKey` 用于关联 pending 问题与用户回答会话。
- 持久语义（v0.7）：提问先经 `@agentchat/durable-interaction` 落盘再弹窗；回答先落盘再续跑；`timeout_ms=0` 不装定时器，进程重启后由 WS 重连重推同一问题。
- 恢复语义（v0.7）：工具以 `tool_call_id` 作为 `correlationId` 落盘；重启后 `recoverHistory` 把已答复的悬空调用合成 tool 结果续跑，未答复则 park 新输入等待回答。
- 错误返回约定：桥未注入返回 `{status:'error'}`；超时返回 `{status:'timeout', data:{message, questions}}`；成功返回 `{status:'ok', data:{answers, questions}}`。

## 备注
- `ask_questions` 面向需要用户决策/确认/授权的场景，避免 Agent 擅自做不可逆决定。
- `ask_questions` 选项数量描述为 2-6 个，运行期 `slice(0,6)` 兜底；少于 2 个选项也能工作（只要求至少 1 个）。
- 工具 owner 为 `agentchat-interaction-tools`（presets 过滤依据），可与 system_restart 的 owner 独立启停。
- `makeInteractionTools` 工厂在每次 Agent 上下文烘焙时被调用，`services.interaction` 为空时 ask_questions 会返回错误而非抛异常。
- `ask_questions` 在桥超时后任务仍可继续，Agent 可根据返回的 `{status:'timeout'}` 决定重试或放弃。

## 测试
package.json 仅 `typecheck`（无 test script）；测试文件 `tests/ask-questions.test.ts`（ToolExecutionContext 注入 / timeout_ms=0 永久等待），随仓库根 `pnpm test` 运行。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
