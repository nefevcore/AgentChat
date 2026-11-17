# 定时器脚本化重做（timer-scripting）

> 性质：域深设计——定时域 cr-1147 重做的终态规格与代码映射
> 状态：现行 · cr-1147 2026-11-17
> 读者：改定时域（ac-timer-core / ac-host-rows timers 行 / timer-face / Timer UI）的人

## 一、定位（探测循环，非排定时刻）

定时器 = **探测循环 + 判定脚本**：宿主按脚本给的 `next` 周期性跑脚本，
触发与否由脚本当轮判定（action 有值才投唤醒信）。**next 是下次探测时刻，
不是业务触发时刻**——不存在「排定档位/锚点网格」概念。

使用者是 **Agent（自管理）**，人类经 Agent 间接设置——所以无模式、
无人类配置界面约束；真随机、读外部脚本分析、自适应间隔都是脚本的
原生能力（worker 内 Math.random/未来工具面），宿主零特殊支持。

## 二、契约（v2 终版）

```ts
// args：宿主记账快照（纯数据，4 字段零派生量）
{ now: string, last?: string, count: number, state?: unknown }
//   now/last = owner 时区 ISO（Date 可直接构造）；count = 历史投递次数
//   （gate 跳过轮不计数——「跑满 N 次收工」的正源）

// utils：时间工具纯函数包（per-owner 构造：闭包 tz+节假日配置；
//        方法对传入时刻求值，同参恒值可单测）
{ at(spec), after(iv, from?), minute(t), day(t), dow(t), workday(t), ms(iv) }
//   墙钟判定一律经 u——脚本内禁 new Date 墙钟操作（进程时区陷阱，
//   cr-1053 单源纪律：时区知识只在宿主侧）

// verdict：正交四轴
{ action?: string, next?: Date, state?: unknown, active?: boolean }
//   next = Date 唯一形态（意图时刻可持久化——重启断点；过去值钳 10s 地板）
```

## 三、执行环境（worker containment）

- runner = `packages/ac-host-rows/src/timer-check-worker.ts`：strip-only
  擦除 + `new Function('a', 'u', …)` 双参求值 + 墙钟 30s 超时杀。即拉即弃。
- utilsConfig（tz/holidays/makeupWorkdays）随 init 消息传 worker，
  worker 内 makeTimerUtils 构造注入——worker 无状态。
- 源码防线复用 ac-run-code-core（normalizeSource/findBannedModuleSyntax/
  scanFreeVariables——禁 import、自包含检查）。

## 四、探测循环（timers-row）

```
arm → check(owner, entry)
  → worker 求值 (a, u) → verdict
  → 状态前置持久化：state + persistNextAt 立即落盘（gate 跳过轮不丢记忆）
  → active:false → 记账 + (action? fire) + 归档
  → action 有值 → gate（存量兼容）→ conversationAlive → fire + 记账
  → nextWaitMs(next) → scheduleCheck（地板 10s）
  错误 → lastError 记账 + 退避（1m→5m→30m）→ 连续 5 次停排 fail-loud
```

- **重启断点（persistNextAt）**：verdict.next 持久化为 ISO；重启 arm 时
  未来值直接排（不跑脚本——防重启触发风暴），过期/缺席立即首检
  （脚本看 args.last 自决补偿）。「排定时刻」在实现上的化身仅此一个
  字段——探测循环的断点续传，非业务概念。
- **状态前置持久化**：脚本产出即落盘（state/断点先于 gate 与投递）——
  gate 跳过/会话消亡轮不丢记忆（v1 缺陷的修复）。

## 五、迁移（compileEntry——不炸、不丢）

boot 时逐 owner：旧 mode 条目 → (a,u) 编译产物 → timer.json.bak 备份 →
写回；同时清该条目的 scriptState（v1 残留 started 旗标会导致迁移后立即
触发），保留 executedCount/lastTriggeredAt（count 连续性）。全局条目与
GlobalTimerHost 简化形状（{time,hint,targets}）在 configEntries 读侧归一化。

语义等价性**降级为「不炸、不丢」**：编译产物机械直译旧模式意图
（u.minute 到点 + u.day 防重 / state.started 首轮静默 / Math.random 区间 /
u.workday 门控 / count 阈值终结），锚点精确性不再追求——Agent 后续自会
重写为原生探测脚本。

## 六、LLM 面（timer-face）

set（code 落盘前 dryRun 自检）/ test（干跑）/ list（v3 诊断字段：
lastAt/nextAt/lastSkip*/lastGate*/lastError*/errorStreak/triggeredCount）/ cancel。
工具描述即契约文档（探测循环语言 + (a,u) 签名 + u 方法集 + Date 唯一）。

## 七、与代码的映射点

| 件 | 位置 |
|---|---|
| 契约 + utils + nextWaitMs + compileEntry | packages/ac-timer-core/src/index.ts |
| runner worker（双参求值） | packages/ac-host-rows/src/timer-check-worker.ts |
| 探测循环 + persistNextAt + 迁移 | packages/ac-host-rows/src/timers-row.ts |
| LLM 面 | packages/ac-host-face/src/timer-face.ts |
| UI（TimerPane 脚本编辑） | packages/ac-client-ui-timer/client/TimerPane.vue |

## 八、存量兼容件（新条目不再宣传）

gate/gateOnError（判定归脚本——M2 工具面是它的归宿）/ task（archive-all、
backup-all 机制任务）/ target（全局条目多目标）。投递侧字段由宿主安全面
持有，脚本不可改投递目标。

## 九、开放项

- M2 脚本工具面（宿主侧受限只读 API：read/glob/grep）——安全模型单独设计。
- GlobalTimerHost（人类直设全局任务的 UI 口子）标记待退役。
- worker bundle 第二入口（run_code build-bundle 先例）——bundle 发布形态时补。
