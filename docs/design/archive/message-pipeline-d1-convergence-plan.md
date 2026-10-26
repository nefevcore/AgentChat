# 消息链路 D1 收敛协议实施计划（message-pipeline-d1-convergence-plan.md）

> 批准实施：用户 2026-10-01「可以开始处理了，根治这个问题」。前置分析：
> `message-pipeline-analysis.md`（F1 主根因）+ `message-pipeline-graph.html`。CR 登记：cr-94。

## 目标与断根逻辑

**根因**：直播行→权威行替换无收敛信号，`scheduleSettlementReload` 硬编码 500ms 赌窗（含
TURN_DONE_DELAY 300ms 全局指示器）——两条管线时序对不上时视图错位，历次补丁（cr-60/61、
双键去重、liveEventIds）只能移动窗口。

**断根**：后端在「权威数据确定可读」的确切时刻 emit `session/run-settled`；前端收到即重拉。
发射点构造保证 = settleTail 完成点（durable flush + journal 剔除后）——`records()` 读侧本就先
排空在途 settlement 链（index.ts L2511 注释），事件在此点后到达即数据必可见。

## 改动面（7 文件 + 测试）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `ac-session/src/events.ts` | 新增 `session/run-settled` 目录条目（emit/@scope run；载荷 conversationId/agentId/runId——瘦身，不带正文） |
| 2 | `ac-session/src/index.ts` | settleTail 末尾 emit；group 桶/机制 run 不 emit |
| 3 | `ac-ws-bridge/src/index.ts` | 加 fwd 转发（紧邻 session/context-injected） |
| 4 | `ac-remote-link/src/service.ts` | REMOTE_DOWNLINK_EVENTS 加该事件 |
| 5 | feed-core switch | 新 case：run-settled → 重拉（0 延时） |
| 6 | feed-core reload 函数 | delay 参数化（事件=0；after-run 兜底=500 保留） |
| 7 | feed-core 运行中合并 | L662 预登记点，事件到达时消费（gated 路径） |

## 行为矩阵

| 场景 | 旧行为 | 新行为 |
|---|---|---|
| run 收束（journal settlement） | after-run +500ms 赌窗 | run-settled 事件 0 延时重拉（fast） |
| run 收束（无 journal 直落） | after-run +500ms | 不变（无事件，兜底覆盖） |
| WS 断线期间收束 | resume 快照/切换重拉 | 不变；事件丢失由兜底窗口覆盖 |
| group 桶 run | 不重拉 | 不变（不 emit） |

## 验证

- 单测：ac-session run-settled-emit.test.ts（journal run 事件到达/载荷正确；群桶/机制 run 无事件）
- 单测：ac-client-ui-conversation settlement-converge.test.ts（事件驱动 0 延时 vs 兜底 500ms；连发不双拉）
- event-catalog 静态测试自动覆盖
- 验证阶梯：typecheck + test:unit + check:deps + 定向 eslint

## 实施结果（cr-94 落地记录）

- 七处改动全部落地；e2e 帧序列实测含 `session/run-settled`（webui-e2e.integration）。
- 构造保证经单测锁定：事件回调内 `records()` 已含权威收束行（run-settled-emit.test.ts）。
- 实施中发现并修正：事件路径须 `gated=false`（预登记空集时 gated 早退会让事件失效）。
- 顺手修 cr-85 遗留：webui-e2e 断言 `llm/delta` → `llm/delta-batch`（微批帧名，前会话漏改）。
- 验证：typecheck / check:deps / webui:typecheck / test:unit 2295 全绿 / test:integration 572 全绿。

## 后续批实施（同日）

- **cr-95 D2**：lite 投影归位 ac-session（`liteProjectRecords` 导出 + `records({view:'lite'})` 单源）；web-api 投影块整删改参数透传；缓存零变异纪律单点锁定（lite-project.test.ts）。
- **精简批**：`_settlementReload` 预登记集 + gated 参数判死清除——cr-94 后两驱动（run-settled / after-run）均无条件重拉，预登记只写不读；`liveEventIds` 保留（run 进行中滚动合并去重，与 settlement 收敛正交——原「可退役」判断修正为保留）。
- 全量验证：typecheck / webui:typecheck / check:deps / 单测 2298 / 集成 572 全绿。

## 退役路线（仍未退役，后续批）

resume 快照特判（`mergeResumeSnapshot`）与 `liveEventIds` 过滤仍在场：前者覆盖会话切换时序、后者覆盖 run 进行中滚动合并去重——均与 settlement 收敛正交，不能由 run-settled 替代；真正的退役依赖 D3（feed-core 拆分出独立合并器模块）。