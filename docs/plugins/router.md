# @agentchat/router
> 包路径 `src/agents/router` · 版本 0.1.0 · 文档对应 v0.6.3（2026-08-16）

## 概述

消息调度域运行库（非 cordis 插件）：`AgentRouter`（电话交换机式消息分发、steer
注入、关机 pending 落盘）、`GroupManager`（纯内存群组生命周期与群聊投递）、
`VirtualAgent`（user 端点，无 LLM）。由 boot 装配 `AgentAssembly` 后创建。

## 目录（关键源文件 + 一句话）

| 文件 | 职责 |
| --- | --- |
| `router.ts` | `AgentRouter`：`route()` 单路径（lifecycle gate → target × delivery × placement）→ `fanout/submit/startRun`；trigger 永远 fire-and-forget；pending 序列化与恢复 |
| `group.ts` | `GroupManager`：群组创建/join/leave/重命名/消息投递（只分发不落盘） |
| `virtual-agent.ts` | `VirtualAgent`：user 端点，无 LLM；`receive/trigger` 兼容回执 |
| `index.ts` | 统一 re-export |

## 插件行

无插件行，作为运行库由 boot 装配使用。

## 提供的能力

### AgentRouter 分发

| 模式 | API | 语义 |
| --- | --- | --- |
| 等待回复 | `send(msg, { wait: true })`（默认） | 等待目标 Agent 回复文本 |
| 异步发送 | `send(msg, { wait: false })` | fire-and-forget，不等待回复；`sendAsync(msg)` 是其一行的糖 |
| 广播 | `to='*'` | 统一 `fanout`：wait=true 并行 `Promise.all`；wait=false 逐个 fire-and-forget |
| 自主推理 | `trigger(agentId, options?, signal?)` | **永远 fire-and-forget**：受理即返回，不返回 run 最终内容；hint 以普通 `user` 消息注入，来源语义由 `sourceMeta`（kind/form/summary）表达 |
| 等待会话空闲 | `whenSessionIdle(convKey, timeoutMs=190s)` | 供「触发后等到 run 收尾」的调用方（如 WS `chat.continue`） |
| steer / next-run | `placement` | 会话繁忙时：`'steer'`（默认）注入活跃 run 的 next-step；`'next-run'` 等待空闲后新开独立 run（trigger 带 run 级选项时默认强制） |
| next-turn / next-step | `followup / steer / inject` | 显式 inbox 投递：followup=run 结束后的独立轮；steer=当前 run 下一 ReAct step；inject=只入队 next-step 不唤醒空闲会话 |
| 群组投递 | `msg.group_id` | 委托 `GroupManager.deliverGroupMessage`，不直接 dispatch |
| 虚拟 Agent | `config.virtual` | 统一 run 流程（空 LLM）+ `chat.virtual.receive` 推送 + 回执兜底 |

- 会话键：点到点 `chatDialogKey(from, to)`；群组 trigger `groupDialogKey(gid, agentId)`。
- 内部单路径：`route()` 统一处理 shutdown 闸门、群组委托、`message.received` 事件与目标解析；
  `submit()` 是唯一 busy 决策点（steer / next-run / aborted-clear）。
- 中断：`abortSession(agentId)`、`hasActiveSession`、`waitRunningDrained(timeoutMs=10s)`。
- 事件面：`message.received`（入站点到点/广播）；`message`（虚拟 Agent 实时推送）。

### 关机模式与 pending 落盘

- `enterShutdownMode()`：后续 send/trigger 不再投递，统一经 `pendingOf(input)` 序列化后 `enqueuePending()` 落盘 `<ws>/.router_pending.jsonl`。
- `enqueuePending(msg)`：主动入队（restart-requested / 恢复消息）。
- `flushPendingMessages()`：重启后读盘恢复；分组键与运行态一致（`chatDialogKey/groupDialogKey`）。
  - `input='trigger'` → 用 `triggerOptions` 重建内部 submit plan（`delivery='await'`，保留重投成败判定）；旧文件无 `input` 按 `type==='trigger'` 一次性推断。
  - `input='receive'` → 群组/广播逐条 `send`；1v1 同 convKey + 同目标合并（首条 currentMessage + 其余 initial steer），`wait` 取首条。
  - 失败写回文件留待下次重试；`maxSteps/meta/sourceMeta/deepThink/placement` 等 trigger 选项重启后不丢。
- `enqueueResumeForActiveSessions()`：为活跃 1v1 会话入队「继续会话」trigger（群聊跳过）。
- restart-requested 中断：入队 continue trigger + 进入关机模式 + `assembly.requestRestart`。

### 去重/跳数与网络失效（以当前源码为准）

- `correlation_id` 仅透传（L5 WS 关联用），**当前 AgentRouter 不消费 `maxHops`、不做跳数去重**
  （`maxHops: 5` 仍存在于 boot/host 全局配置默认值中，但未参与本包分发逻辑）。
- 网络失效 down 模式已移除：源码注释明确 LLM 异常由 L1 `fallbackHook` 兜底，run 不抛给
  调用方，无需 router 级 down 队列与 base_url 探测。

### GroupManager（纯内存）

- 生命周期：`createGroup/deleteGroup/joinGroup/leaveGroup/renameGroup/getGroup/listGroups/listGroupsForAgent/isParticipant`。
- `createGroup` 校验参与者已注册；`leaveGroup` 清空后自动删除。
- 投递：`deliverGroupMessage` 校验房间与发送者（`user` 始终允许）→
  emit `group.message.received`（L4 落盘/L5 展示）→ 对每个其他参与者 emit `group.trigger`
  （router 内部桥接为 `trigger`）。不落盘。
- 事件：`group.created/deleted/join/leave/renamed`、`group.message.received`、`group.trigger`。

### VirtualAgent

- `config.virtual` 的 Agent（如 user）无 LLM：`createAgentContext` 注入空 LLM，loop 跳过推理，
  完整走 runStart/stepStart/stepEnd/runEnd 钩子管道。
- `receive` 为兼容回执（注释标记已弃用）；`trigger` 直接返回不支持。

## 关键契约 / API

| API | 签名 | 说明 |
| --- | --- | --- |
| `AgentRouter` | `constructor(assembly: AgentAssembly)` | 内置 `AgentRegistry` + `GroupManager`，自动接线 group.trigger |
| `send` | `(message: RouterMessage, options?: SendOptions) => Promise<string>` | `options.wait` 默认 `true`；`options.placement` 默认 `'steer'`；`options.signal` 外部中断 |
| `sendAsync` | `(message: RouterMessage) => Promise<string>` | `send(msg, { wait: false })` 糖 |
| `trigger` | `(agentId: string, options?: TriggerOptions, signal?) => Promise<string>` | 永远 fire-and-forget：受理即返回 |
| `deliverInput` | `(agentId, message, delivery?: MessageDelivery, opts?) => Promise<string>` | inbox 底层投递：lane + wakeup |
| `followup` | `(agentId, message, opts?) => Promise<string>` | `deliverInput` with lane=next-turn, wakeup=true |
| `steer` | `(agentId, message, opts?) => Promise<string>` | `deliverInput` with lane=next-step, wakeup=true |
| `inject` | `(agentId, message, opts?) => Promise<string>` | `deliverInput` with lane=next-step, wakeup=false（idle 只入队） |
| `whenSessionIdle` | `(convKey: string, timeoutMs=190_000) => Promise<boolean>` | 等待会话空闲（trigger 先注册/steer 后 resolve，无竞态） |
| `flushPendingMessages` | `() => Promise<number>` | 退出关机模式并重投 pending |
| `getRegistry` / `getGroupManager` | `() => AgentRegistry / GroupManager` | 供 L4/L5 使用 |
| `BusyPlacement` | `'steer' \| 'next-run'` | 会话繁忙策略 |
| `RouterMessage` | `{ from, to, type, payload, correlation_id?, data?, group_id?, input?, wait?, placement?, triggerOptions? }` | 电话协议；`input/wait/placement/triggerOptions` 为 pending 恢复字段 |
| `TriggerOptions` | `{ maxSteps?, deepThink?, source?, sourceMeta?, hint?, wrapHint?（已废弃）, target?, group_id?, meta?, placement? }` | hint 统一为普通 user 消息；`sourceMeta` 表达 `MessageSource.kind/form/summary`，缺省由旧 `source` 字符串推断 kind；带 run 级选项时 placement 默认 `'next-run'` |

- 每个会话持有跨 run 的 `inbox { nextTurn, nextStep }`；`runWithGate` 在 run 结束后逐条消费 next-turn，系统/自主来源连续自动连跑上限 `MAX_AUTO_WAKES=3`（用户/Agent 来源重置预算）。

## 配置

本包无插件配置命名空间。工作区根来自 `assembly.workspaceDir ??
process.env.AGENTCHAT_WORKSPACE ?? 'workspace/default'`；pending 文件固定为
`<ws>/.router_pending.jsonl`。

## 与其他插件的关系

- 依赖（package.json）：`@agentchat/agent-loop`、`@agentchat/agents`、
  `@agentchat/llm`、`@agentchat/util`、`@agentchat/agent-config`。
- 使用方：boot/host 装配 `AgentRouter`；`agent-session`/`agent-prompt` 通过
  `getRegistry()/getGroupManager()` 读取群组与名称；L4 监听 `message.received`/
  `group.message.received` 落盘；L5 监听事件推 WebUI。

## 测试

`package.json`：`typecheck`、`test`（vitest run）。
测试文件：`tests/router.test.ts`、`tests/group.test.ts`、`tests/virtual-agent.test.ts`。

## 相关文档

固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
