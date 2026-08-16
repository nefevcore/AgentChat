# Router 重构实施文档（下一个会话执行）

> 状态：已实施（v0.6.3；验收见文末勾选与 CHANGELOG Unreleased）。
> 范围：`@agentchat/router`（`src/agents/router/src/router.ts`）投递链路收敛。
> 前提：执行层术语已正名为 `step/run`；`turn` 只保留交互层语义。

---

## 0. 结论摘要

- **公开入口收敛为两个**：`send()` 与 `trigger()`，`sendAsync()` 降为一行糖。
- **`wait` 只属于 `send`**：`send` 存在“等回复”与“fire-and-forget”；`trigger` 永远是 fire-and-forget。
- **内部收敛为一条路径**：`route()` 统一处理生命周期闸门、目标解析、会话繁忙策略。
- **三个路由核心维度**：target × delivery × placement。
- **两个前置关注点（不是路由维度）**：input mode、lifecycle gate。

---

## 1. 现状问题清单（以 `router.ts` 为准）

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| B1 | shutdown 分支直接 push 内存，不调 `persistPending()` | `deliver()`、`trigger()` 的 shutdown 分支 | 进入关机模式后到达的消息，进程重启会丢 |
| B2 | pending 分组键用 `${from}__${to}` 手拼 | `flushPendingMessages()` | 与运行态 `chatDialogKey/groupDialogKey` 两套规则 |
| B3 | `send/sendAsync/trigger` 三入口、`deliver/dispatch/trigger` 三路径 | `router.ts` | shutdown、registry、busy 策略重复三处 |
| B4 | trigger 的“是否等待”语义靠调用方自行选择 | `trigger()` 返回 `Promise<string>` | 调用方有的 `await`、有的 `.catch`，语义不一致 |
| B5 | trigger 关机 pending 丢字段 | shutdown 分支只写 `hint` | 重启后 `maxSteps/meta/wrapHint/deepThink` 丢失 |
| B6 | flush 用 `type === 'trigger'` 猜测恢复语义 | `flushPendingMessages()` | 无法区分 receive/trigger 之外的未来形态 |
| B7 | `sync/async` 字符串无类型 | `deliver()` | 易拼写错误，语义不明确 |
| B8 | 广播 `broadcast/broadcastAsync` 重复 fanout | `router.ts` | 与 1v1 路径重复 |
| B9 | busy 决策散落 | `dispatch()` 与 `trigger()` | placement 规则无法统一测试 |
| B10 | WS `chat.continue` 借用 `await trigger` 等待 run 结束 | `handler.ts` | 与“trigger 永远 fire-and-forget”冲突 |

---

## 2. 目标模型

### 2.1 公开 API

```ts
export type BusyPlacement = 'steer' | 'next-run'

export interface SendOptions {
  /** 是否等待目标回复；默认 true（保持 send 现状） */
  wait?: boolean
  /** 会话繁忙策略；默认 'steer' */
  placement?: BusyPlacement
  /** 外部中断信号 */
  signal?: AbortSignal
}

export interface TriggerOptions {
  // 现有字段不变
  maxSteps?: number
  deepThink?: boolean
  source?: string
  hint?: string
  wrapHint?: boolean
  target?: string
  group_id?: string
  meta?: Record<string, unknown>
  /** 会话繁忙策略；默认 'steer'，带 run 级选项时强制 'next-run' */
  placement?: BusyPlacement
}
```

```ts
/** 等待回复；sendAsync 是其 wait=false 糖 */
send(message: RouterMessage, options?: SendOptions): Promise<string>

/** 永远 fire-and-forget：受理即返回，不等 run 完成 */
trigger(agentId: string, options?: TriggerOptions, signal?: AbortSignal): Promise<string>

/** 糖：立即返回 */
sendAsync(message: RouterMessage): Promise<string> {
  return this.send(message, { wait: false })
}

/** 等待会话空闲；供需要“触发后等到 run 收尾”的调用方（WS chat.continue） */
whenSessionIdle(convKey: string, timeoutMs?: number): Promise<boolean>
```

### 2.2 语义矩阵

| 输入 | delivery | 现状 | 目标 |
|---|---|---|---|
| receive（send） | wait=true | `await dispatch` | 不变：等 run 结果 |
| receive（send） | wait=false | `sendAsync` | 不变：受理后立即返回 |
| trigger | fire-and-forget | 部分调用方 await、部分 catch | 统一：受理后立即返回 |
| trigger | wait | 不存在 | **不提供** |

### 2.3 五个关注点

```text
input(receive | trigger)         ← 决定如何构造 run 输入
  → lifecycleGate(live | shutdown) ← 决定落盘 pending 还是投递
    → route(target × delivery × placement)  ← 真正的路由核心
```

| 关注点 | 取值 | 处理位置 |
|---|---|---|
| input | `receive` / `trigger` | `send()` / `trigger()` 构造 `AgentInput` |
| lifecycle | `live` / `shutdown` | `route()` 第一行 |
| target | `agent_id` / `'*'` / `group_id` | `route()` 目标解析 |
| delivery | `wait=true` / `wait=false` | 仅 receive；`fanout()` |
| placement | `steer` / `next-run` | `submit()` 单一决策点 |

---

## 3. 核心类型（内部）

```ts
type DeliveryMode = 'await' | 'fire-and-forget'

interface ReceiveInput {
  mode: 'receive'
  message: RouterMessage
}

interface TriggerInput {
  mode: 'trigger'
  agentId: string
  options?: TriggerOptions
}

type AgentInput = ReceiveInput | TriggerInput

interface RunPlan {
  convKey: string
  agentId: string
  /** 构造 CurrentContext；run 级选项只存在于这里 */
  buildCtx: (controller: AbortController) => CurrentContext
  /** busy + steer 时注入活跃 run 的消息 */
  steerMessages: AgentMessage[]
  /** 新 run 启动前作为初始 steer 注入的消息（合并投递 / trigger hint） */
  initialSteer: AgentMessage[]
}

interface SubmitOptions {
  delivery: DeliveryMode
  placement: BusyPlacement
  signal?: AbortSignal
  /** 虚拟 Agent 的回执分支 */
  virtualReply?: string
}
```

---

## 4. 实施步骤

### P0：正确性收口（小步、先做）

#### P0-1 统一 pending 入口

`deliver()` 与 `trigger()` 的 shutdown 分支不再直接 `push`，统一：

```ts
if (this._shutdownMode) {
  this.enqueuePending(this.pendingOf(input))
  return '[Router] 系统正在重启，消息已入队，重启后将自动投递。'
}
```

`pendingOf(input)` 只做一件事：把 `AgentInput` 转成可落盘的 `RouterMessage`（receive 原样，trigger 组装 `type:'trigger'` + `triggerOptions`）。`enqueuePending()` 已具备“shutdown 时落盘”逻辑，保持不变。

#### P0-2 flush 分组键统一

```ts
const key = msg.group_id
  ? groupDialogKey(msg.group_id, msg.to)
  : msg.type === 'trigger'
    ? chatDialogKey(msg.to, (msg.data?.target as string) ?? 'system')
    : chatDialogKey(msg.from, msg.to)
```

验收：shutdown 前由不同来源生成的消息，flush 分组结果与运行态 convKey 一致。

#### P0-3 DeliveryMode 类型

```ts
type DeliveryMode = 'await' | 'fire-and-forget'
```

`deliver(message, mode, signal)` 内部使用该类型；本次只替换字面量，不改行为。

---

### P1：内部路径收敛

#### P1-1 `route()` 唯一入口

```ts
private async route(input: AgentInput, delivery: DeliveryMode, signal?: AbortSignal): Promise<string> {
  // 1. 生命周期闸门：唯一 shutdown 检查
  if (this._shutdownMode) {
    this.enqueuePending(this.pendingOf(input))
    return '[Router] 系统正在重启，消息已入队，重启后将自动投递。'
  }

  if (input.mode === 'trigger') {
    return this.routeTrigger(input, signal)
  }

  const msg = input.message

  // 2. 群组：走 GroupManager，不做 1v1 dispatch
  if (msg.group_id) {
    try {
      const result = await this.groupManager.deliverGroupMessage(msg as GroupMessage)
      return `[Group] 消息已投递到群组 "${msg.group_id}"，已触发 ${result.triggered.length} 个参与者`
    } catch (err: any) {
      return `[Group] 群组消息投递失败：${err.message}`
    }
  }

  // 3. 入站事件：仍只对 1v1/广播发射
  this.emit('message.received', msg)

  // 4. target 解析：1v1 = fanout(1)
  const targets = msg.to === '*'
    ? this.registry.listIds().filter(id => id !== msg.from)
    : [msg.to]

  return this.fanout(targets, msg, delivery, signal)
}
```

#### P1-2 `fanout()` 合并广播

```ts
private async fanout(targets: string[], msg: RouterMessage, delivery: DeliveryMode, signal?: AbortSignal): Promise<string> {
  const run = (id: string) => this.deliverOne(id, msg, delivery, signal)

  if (delivery === 'fire-and-forget') {
    for (const id of targets) {
      void run(id).catch(err => log.error(`[Router] 异步投递失败 ${msg.from} → ${id}: ${err.message}`))
    }
    return `[Router] 已异步投递到 ${targets.length} 个 Agent`
  }

  const results = await Promise.all(targets.map(run))
  return targets.length === 1
    ? results[0] ?? ''
    : results.filter(Boolean).map((r, i) => `[${targets[i]}] ${r}`).join('\n')
}
```

删除 `broadcast()` / `broadcastAsync()`。

#### P1-3 `submit()`：唯一 busy 决策点

```ts
private async submit(plan: RunPlan, opts: SubmitOptions): Promise<string> {
  const active = this.running.get(plan.convKey)
  const fire = opts.delivery === 'fire-and-forget'

  // 运行中且将死：等待清理后 startRun
  if (active?.ctx.signal?.aborted) {
    if (fire) {
      void this.waitThenStart(plan, opts, 'aborted-clear')
      return '[Router] 已受理，等待旧会话清理后执行。'
    }
    await this.waitAbortedClear(plan.convKey)
    return this.startRun(plan, opts)
  }

  // 运行中且可 steer
  if (active && opts.placement === 'steer') {
    for (const m of plan.steerMessages) {
      this.assembly.engine.pushSteer(active.ctx, m)
    }
    return '[Router] 会话运行中，消息已注入为下一步 steer。'
  }

  // 运行中且要求独立 run
  if (active && opts.placement === 'next-run') {
    if (fire) {
      void this.waitThenStart(plan, opts, 'idle')
      return '[Router] 已受理，会话空闲后作为独立 run 执行。'
    }
    const idle = await this.waitSessionIdle(plan.convKey)
    if (!idle) return '[Router] 会话繁忙，next-run 等待超时，已放弃。'
    return this.startRun(plan, opts)
  }

  return this.startRun(plan, opts)
}

/**
 * fire-and-forget 的非立即路径：后台等待 aborted 清理或会话空闲后 startRun。
 * 超时/异常只记日志，不向 trigger 调用方抛错。
 */
private async waitThenStart(plan: RunPlan, opts: SubmitOptions, mode: 'aborted-clear' | 'idle'): Promise<void> {
  try {
    if (mode === 'aborted-clear') {
      await this.waitAbortedClear(plan.convKey)
    } else if (!(await this.waitSessionIdle(plan.convKey))) {
      log.warn(`[Router] next-run 等待会话空闲超时，放弃（${plan.convKey}）`)
      return
    }
    await this.startRun(plan, opts)
  } catch (err: any) {
    log.error(`[Router] fire-and-forget 后台投递失败 ${plan.agentId}: ${err?.message ?? String(err)}`)
  }
}
```

#### P1-4 `startRun()`

```ts
private async startRun(plan: RunPlan, opts: SubmitOptions): Promise<string> {
  const controller = this.makeController(opts.signal)
  const ctx = plan.buildCtx(controller)
  for (const m of plan.initialSteer) this.assembly.engine.pushSteer(ctx, m)

  const promise = this.runWithGate(plan.convKey, plan.agentId, ctx, controller)

  if (opts.delivery === 'fire-and-forget') {
    void promise.catch(err => log.error(`[Router] 异步投递失败 ${plan.agentId}: ${err.message}`))
    return '[Router] 消息已异步投递。'
  }
  return promise
}
```

注意：`runWithGate` 同步写 `running` Map，因此 fire-and-forget 返回时会话一定已注册或已 steer。

#### P1-5 receive / trigger 变为 plan 构造器

```ts
private deliverOne(agentId: string, msg: RouterMessage, delivery: DeliveryMode, signal?: AbortSignal): Promise<string> {
  const config = this.registry.get(agentId)
  if (!config) return Promise.resolve(`[Router] Agent "${agentId}" 未在注册表中找到。...`)

  const convKey = chatDialogKey(msg.from, msg.to)
  const plan: RunPlan = {
    convKey,
    agentId,
    buildCtx: (c) => createAgentContext(config, this.assembly, {
      currentMessage: { role: 'user', content: msg.payload, agent_id: msg.from },
      dialogId: convKey,
      signal: c.signal,
    }),
    // busy 时注入当前消息；新 run 由 currentMessage 承载，不重复注入
    steerMessages: [this.toSteerMessage(msg)],
    initialSteer: [],
  }
  return this.submit(plan, { delivery, placement: 'steer', signal })
}
```

虚拟 Agent（receive）分支保持在 `deliverOne`，不进入 `submit` 的通用逻辑：

- `wait=true`：沿用现语义，run 完成后 `emit('message', chat.virtual.receive)`，返回 `content || 回执`。
- `wait=false`：受理即返回，虚拟 Agent 的 `chat.virtual.receive` 仍由后台 run 完成后发射。

trigger 侧：

```ts
private routeTrigger(input: TriggerInput, signal?: AbortSignal): Promise<string> {
  const { agentId, options } = input
  const config = this.registry.get(agentId)
  if (!config) return Promise.resolve(`[Router] Agent "${agentId}" 未在注册表中找到。...`)
  if (config.virtual) return Promise.resolve(`[VirtualAgent] "${agentId}" 是虚拟 Agent，不支持自主推理。`)

  const convKey = options?.group_id
    ? groupDialogKey(options.group_id, agentId)
    : chatDialogKey(options?.target ?? 'system', agentId)

  // run 级选项不能降级为 steer
  const hasRunScopedOptions = !!(options?.meta || options?.maxSteps !== undefined || options?.deepThink !== undefined)
  const placement = options?.placement ?? (hasRunScopedOptions ? 'next-run' : 'steer')

  const hint = this.makeHintSteer(options)
  const plan: RunPlan = {
    convKey,
    agentId,
    buildCtx: (c) => createAgentContext(config, this.assembly, {
      dialogId: convKey,
      signal: c.signal,
      maxSteps: options?.maxSteps,
      deepThink: options?.deepThink,
      meta: options?.meta,
      // 无 currentMessage
    }),
    // trigger hint：busy 时注入活跃 run；新 run 作为初始 steer
    steerMessages: hint ? [hint] : [],
    initialSteer: hint ? [hint] : [],
  }

  // trigger 永远 fire-and-forget
  return this.submit(plan, { delivery: 'fire-and-forget', placement, signal })
}
```

---

### P2：公开 API 与调用方

#### P2-1 新签名

```ts
async send(message: RouterMessage, options: SendOptions = {}): Promise<string> {
  return this.route(
    { mode: 'receive', message },
    options.wait === false ? 'fire-and-forget' : 'await',
    options.signal,
  )
}

async sendAsync(message: RouterMessage): Promise<string> {
  return this.send(message, { wait: false })
}

async trigger(agentId: string, options?: TriggerOptions, signal?: AbortSignal): Promise<string> {
  return this.route({ mode: 'trigger', agentId, options }, 'fire-and-forget', signal)
}
```

#### P2-2 trigger 契约

- 解析到**已受理**即返回；不返回 run 最终内容。
- 内部错误只记日志，不让调用方依赖异常控制流。
- 返回示例：
  - 成功受理：`[Router] 已触发 "${agentId}" 自主推理。`
  - shutdown：`[Router] 系统正在重启，trigger 已入队，重启后将自动投递。`
  - 未注册 / 虚拟 Agent：保持现有提示。

#### P2-3 调用方更新

| 文件 | 改动 |
|---|---|
| `src/host/server/src/ws/handler.ts` `handleChatContinue` | `void router.trigger(...)` + `await router.whenSessionIdle(chatDialogKey(viewerId, to))` 后再清理 activeSessions |
| `src/svc/timer/src/timer.ts` `fireEntry` / 补触发 | 去掉 `await`，改 `void this.router.trigger(...)` |
| `src/agents/router/src/router.ts` 群组接线 | `void this.trigger(...)`，去掉 `.catch` |
| `src/svc/archive/src/index.ts` 整理 run 触发 | 去掉 `.catch`，改 `void this.router!.trigger(...)` |
| `src/session-tools/session-tools/src/tools.ts` | 已经是 `void router.trigger`，无需改动 |

#### P2-4 `whenSessionIdle`

```ts
async whenSessionIdle(convKey: string, timeoutMs = 190_000): Promise<boolean> {
  return this.waitSessionIdle(convKey, timeoutMs)
}
```

约束：`trigger` 必须在“running 已注册 / steer 已注入”之后才 resolve；这样 `whenSessionIdle` 不会因竞态提前返回。

---

### P3：pending 序列化与恢复

#### P3-1 RouterMessage 扩展

```ts
export interface RouterMessage {
  // 现有字段不变
  from: string
  to: string
  type: AgentMessageType
  payload: string
  correlation_id?: string
  data?: Record<string, any>
  group_id?: string
  // 新增：pending 恢复用
  input?: 'receive' | 'trigger'
  wait?: boolean
  placement?: BusyPlacement
  triggerOptions?: TriggerOptions
}
```

#### P3-2 trigger 入队时保存完整 options

shutdown 分支构造：

```ts
const msg: RouterMessage = {
  from: 'system',
  to: agentId,
  type: 'trigger',
  payload: options?.hint ?? '',
  correlation_id: options?.source,
  input: 'trigger',
  triggerOptions: options,
  placement,
  data: { target: options?.target },
}
this.enqueuePending(msg)
```

#### P3-3 flush 恢复

- `input === 'trigger'` → 用 `msg.triggerOptions` 重建 **内部 `submit` plan**，并显式使用 `delivery: 'await'`，以保留 flush 的成功/失败判定；**不调用公开 `trigger()`**（公开 trigger 永远 fire-and-forget，无法报告重投失败）。
- `input === 'receive'`：
  - group / broadcast → 逐条 `send(msg, { wait: msg.wait })`（保持逐条投递）。
  - 1v1 → 同 convKey 合并，首条 currentMessage + 其余初始 steer；`wait` 取首条。
- 无 `input` 字段的旧 pending 文件按现逻辑推断（一次性兼容，仅限旧文件读取）。

#### P3-4 持久化

所有 shutdown 入队都经 `enqueuePending()`，落盘 JSON 自动带上新字段。

---

### P4：测试与文档

#### P4-1 新增/修改测试（`src/agents/router/tests/router.test.ts`）

必须覆盖：

1. **shutdown 后新消息也落盘**：`enterShutdownMode()` 后连续 `send/trigger`，新 Router 实例读 `.router_pending.jsonl` 能恢复全部消息。
2. **trigger 永远 fire-and-forget**：空闲触发返回“已受理”，run 在后台完成；LLM 最终结果不再作为返回值。
3. **trigger busy + steer**：同会话运行中 trigger → pushSteer，不新开 run。
4. **trigger run 级选项强制 next-run**：带 `meta` / `maxSteps` 的 trigger 在会话运行中等待空闲后新开 run。
5. **send wait=false**：立即返回确认，后台投递。
6. **send wait=true**：保持返回 LLM 最终内容。
7. **广播 wait/fire 两态**：`fanout` 路径结果与现有测试等价。
8. **placement 显式 `next-run`**：文本消息也能在会话空闲后作为独立 run。
9. **whenSessionIdle**：触发后能等到 run 结束；aborted 场景同样收尾。
10. **flush trigger 恢复完整 options**：`maxSteps/meta/wrapHint` 重启后不丢。
11. **pending 分组键与运行态一致**：`from/to` 倒序 / 群组键分组符合 `chatDialogKey/groupDialogKey`。

现有测试需要调整的预期：

- trigger 返回最终内容（`tick-done`）→ 改为受理确认。
- 带 meta trigger 的 `await` 等待语义 → 改由 `whenSessionIdle` 观测。
- 所有 `await trigger` 的地方改为 `void trigger` + 需要时 `whenSessionIdle`。

#### P4-2 文档同步

| 文件 | 更新 |
|---|---|
| `docs/plugins/router.md` | 公开 API 表：`send(msg, options)`、`trigger(...)` 永远 fire-and-forget、`whenSessionIdle`、`BusyPlacement` |
| `docs/tutorial/05-multi-agent-communication.md` | 5.3 表格去掉 `sendAsync()` 独立模式，改为 `send(msg, { wait })`；注明 trigger 不等待 |
| `docs/architecture.md` §8 | 更新 Router 模型图：`route()` 单路径、三维路由核心 + 两个前置闸门 |
| `CHANGELOG.md` | 在 Unreleased 补一条 Router 重构 breaking change |

---

## 5. 行为对比（旧 → 新）

| 场景 | 旧 | 新 |
|---|---|---|
| `send(msg)` | 等回复 | 等回复（不变） |
| `sendAsync(msg)` | fire-and-forget | `send(msg, { wait:false })` |
| `trigger(idle)` | await 到 run 结束 | 受理即返回；run 后台执行 |
| `trigger(busy, 无 run 级选项)` | pushSteer 后返回 | 相同 |
| `trigger(busy, 有 meta/maxSteps)` | 等空闲后 run | 后台等空闲后 run；受理即返回 |
| `trigger(shutdown)` | push 内存，不落盘 | `enqueuePending` 落盘 |
| WS `chat.continue` | await trigger 到 run 结束 | trigger + whenSessionIdle |
| 广播 | 两个方法 | fanout 一个方法，n=1 即 1v1 |
| 群组 | GroupManager 委托 | 不变 |
| pending 恢复 trigger | 丢失 maxSteps/meta | 完整恢复 TriggerOptions |

---

## 6. 明确不做

- **不做 `inject` / inbox 双队列**：AgentChat 空闲无 inbox 载体，没有消费方。
- **不做 per-conv `next-run` FIFO**：当前 `waitSessionIdle` 足够；有排队需求时再加队列。
- **不在 Router 消费 `maxHops`**：全局配置的 `maxHops` 应另开任务删除或交给 hop 治理。
- **不改 GroupManager 生命周期/持久化**：本次只收敛 Router 投递入口。

---

## 7. 验收标准

- [x] `pnpm typecheck` 0 错误
- [x] `pnpm test` 全量通过（router 测试按 P4 更新）
- [x] `docs/plugins/router.md`、`docs/tutorial/05`、`docs/architecture.md` 与代码一致
- [x] 全局 grep 无 `sendAsync` 语义副本（只保留糖方法）
- [x] shutdown 期间新到的 send/trigger 在进程重启后可从 `.router_pending.jsonl` 恢复
- [x] `trigger` 的所有调用方不再依赖其返回值等待 run 完成
