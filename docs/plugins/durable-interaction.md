# @agentchat/durable-interaction
> 包路径 `src/interaction/durable-interaction` · 版本 0.1.0 · 文档对应 v0.6.3（2026-08-16）

## 概述

领域无关的**持久化暂停点 / 可恢复交互**服务（durable suspension / resumable
interaction）。把“等待外部回答”从进程内 Promise 变成一条可恢复状态：

```
pending ──reply──▶ answered ──close──▶ closed
   │                     ▲
   └──────close──────────┘（timeout / aborted / consumed）
```

三条不依赖任何业务框架的不变式：

1. **先落盘意图，再发生外部可见动作**（弹窗/回调/审批）。
2. **先落盘回答，再推进执行**。
3. **同一 interaction_id 的回答幂等**，重复回包返回 `duplicate` + 原答案。

包不 import 任何 AgentChat 业务类型，只依赖 `@agentchat/cordis` 与 Node 内置模块。

## 插件行

| 模块 | name | inject | 提供 |
| --- | --- | --- | --- |
| `src/plugin.ts` | `agentchat-durable-interaction` | 无 | `ctx.durableInteraction`（DurableInteractionService） |

由 `cordis.yml` 挂载；`registerCoreServices` 的无 Loader 兜底同样经本行。

## 目录

| 文件 | 职责 |
| --- | --- |
| `types.ts` | JsonValue / 状态机 / store 契约 / 过滤 / 错误类型 |
| `store.ts` | `MemoryDurableInteractionStore` + `JsonlDurableInteractionStore` |
| `service.ts` | cordis Service：open/reply/close/get/list/listOpen/clear + 事件 |
| `plugin.ts` | cordis 插件行 |

## 关键契约 / API

```ts
interface DurableInteractionService {
  configure(config: DurableInteractionConfig): void
  open(input: DurableInteractionInput): DurableInteraction
  reply(id: string, answer: JsonValue): ReplyOutcome
  close(id: string, reason?: string): boolean
  get(id: string): DurableInteraction | undefined
  list(filter?: DurableInteractionFilter): DurableInteraction[]
  listOpen(filter?: DurableInteractionFilter): DurableInteraction[]
  clear(): number
  dispose(): void
}

interface DurableInteractionInput {
  key: string           // 路由/会话身份（convKey / orderId / workflowId）
  kind: string          // 交互种类（ask_questions / approval / webhook …）
  payload: JsonValue    // 客户端展示与处理所需完整数据
  correlationId?: string // 与执行点关联（tool_call_id / stepId）
  owner?: string        // 属主（agentId / userId）
  deadline?: number     // epoch ms；缺省 = 永久等待
  id?: string           // 确定性测试 / 跨写者协作
}
```

- `reply` 返回值：`ok | duplicate | not-found | closed`；`duplicate` 携带此前落盘的回答。
- `close` 原因自由文本：`timeout / aborted / consumed` 等。
- 事件：`durable-interaction/opened | replied | closed`（cordis `ctx.emit`）。

### JSONL 后端

- 配置：`{ backend: 'jsonl', file: '<path>', fsync?: boolean }`；`fsync` 缺省 `true`。
- 每次 `open/reply/close` 追加**一条完整记录行**并 fsync；加载时按行序折叠
  （last-write-wins），忽略物理 torn tail（最后半行），已提交前缀可恢复。
- 单写者假设（与 AgentChat 当前单进程形态一致）；多写者部署应替换为带租约/事务的后端实现。

### 内存后端

缺省 `backend='memory'`：同一状态机与幂等语义，用于测试、嵌入式与降级。

## 恢复决策表（消费方对账）

| 恢复时状态 | 行为 |
| --- | --- |
| 记录不存在 | 什么都没发生过，忽略 |
| `pending` | 继续等待；客户端重连时重推，不自动推进执行 |
| `answered` 且未消费 | 用持久回答幂等续跑（按 correlationId 配对执行点） |
| `answered` 且已消费 / `closed` | done；重复回答只返回 ok/closed，不再触发任何事 |

## AgentChat 适配

`@agentchat/server` 的 `InteractionBridge` 现以本服务为持久 sink：

- `ask_questions` 提问先 `open` 落盘，再发 `chat.interaction` 弹窗；
- 用户回答先 `reply` 落盘，再 resolve 内存 Promise；
- `timeout_ms=0` 表示永久等待（不装定时器）；
- 进程重启后 pending 记录恢复，WS 新连接连接时自动重推弹窗；
- 回答在重启后到达时以 `answered` 状态落盘，供后续 step 级持久化 / 恢复调和消费。

恢复调和已接线（v0.7）：`agent-session.load-history` 调用宿主注入的 `recoverHistory`；
`server/src/interaction-recovery.ts` 按 `correlationId=tool_call_id` 对账——
answered 完整则合成 tool 结果，pending 保持悬空并由 WS 层 park 新输入；
晚到回答经 `onLateReply` 唤醒原会话。

存储文件默认 `<workspaceDir>/.durable-interactions.jsonl`（由 server service-plugin
调用 `configure` 指定；初始化失败降级 memory 并告警）。

## 测试

`package.json`：`typecheck`、`test`（vitest run）。
测试文件：`tests/store.test.ts`（状态机/幂等/torn tail/跨实例恢复）、
`tests/service.test.ts`（cordis 服务 + 事件 + configure）。
宿主侧适配测试：`@agentchat/server/tests/interactions-durable.test.ts`。

## 相关文档

固定链接：[插件索引](./README.md) · [interaction（ask_questions）](./interaction.md) · [server](./server.md) · [architecture](../architecture.md)
