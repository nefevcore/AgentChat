# 直播管线 B 案——设计提案与实施清单（live-pipeline-event-projection）

> 性质：实施档案——直播管线 B 案（cr-972 §3/§5.3 升格独立项目）的设计提案 + 分阶段实施清单。
// 前置依赖：cr-973（viewer 读时投影 + 指针索引）/ cr-974（事件词汇 v2 + fold
// 单源 + run-end durable）已实施（提交 5956ed1b / 4cccc96b / 2c44f738）。
> 状态：已实施（cr-975 立项 2026-11-10 · cr-976 落地同日）· cr-1008 2026-11-11 整理批检阅归位——P3-1（ledger/event-appended 泛化 + ledger-event 旁带帧
// + ac-wire-format ledger-projection 投影层 + 旧帧族一步删除）与 P3-2（feed-core 合流层一次性重构：
// seq 恒等吸收 + 收敛驱动换源 run/settled + 载体惰性建卡）落地；P3-3 防御重论证逐条登记（§5 落地列）。
// 实施补充裁决：session/context-injected 帧保留（resume/resume-degraded 路径无 inject 行，帧面未被
// 事件行全覆盖；journaled inject 与该帧同锚同时发射，新增投影帧反而双渲染）；tool/started·progress
// 为流时序帧保留（D3-1 两时标承认的推论——subcall 占位与长任务进度无 durable 行）。D3-1~D3-5 原裁决
// 见 §4（2026-11-10 用户裁决）。现行事实源 = docs/design/session/session-design.md §7（B 案改版）。

# 直播管线 B 案：事件投影转发（cr-975 / cr-972 Phase 3）

> 裁决链：cr-972 D-4（不做过渡 A 案，B 直接另立项）→ 本文档。A/B 对比与
> 「一次动四层」风险清单见 cr-972 §3.2，本文不重复，只展开 B 案终态。

## 0. 问题与不变量

### 0.1 现状（L1/L2/L3 三层物理独立）

| 层 | 现状 | 关键件 |
|---|---|---|
| L1 直播 | ws-bridge 帧转发（`llm/delta` 30ms 微批 LlmDeltaBatcher、`loop/step-started`·`after-step`、`tool/*`） | ac-wire-format bridge-events 目录（10 帧）+ ac-ws-bridge |
| L2 存储 | v2 单文件事件日志（cr-974）——步级相位行、run-end durable、`ledger/step-journaled` seq 锚事件 | ac-ledger writer/fold |
| L3 历史 | `session/history` = fold 投影 + 指纹短路 + 指针索引 | ac-host-webui + ac-session-index |

双源合流住 feed-core（~135KB 单体：帧路由、吸收、历史分页、resume 合并、
未读持久化、run 计时），靠**收敛协议**（run-settled 重拉 + after-run +500ms
兜底）与**防御机制**（cr-106 吸收身份门、cr-107 悬挂流探针、发送 watchdog）
维持最终一致。已知病灶：**E-2**（run-settled 收敛信号无发射方——收敛全靠
兜底窗口赌命）。

### 0.2 目标不变量

- **直播与历史同源**：身份/锚/步/收束帧 = 事件日志 append 的投影转发——
  帧不是第二事实，是事实的视图；
- **收敛单事实**：`run-end` append+flush（durable）即收敛信号——重拉由落盘
  事实驱动，不再由「物化完成时刻」/兜底窗口驱动（E-2 根治形态）；
- **防御机制逐条重论证**：cr-106/107/watchdog 是事故沉淀——新结构下每条
  必须有**等价物**或**失效证明**（登记于 §5），不允许「架构变了所以旧防御
  作废」的默认假设（cr-972 §3.2 红线）；
- **两个时标物理承认**：`llm/delta` 是流时序（用户要逐字看），落盘是步终态
  ——B 案的「同源」= 身份与收敛同源，**不是**「delta 先落盘再转发」（D3-1）；
- **前缀稳定不受帧路径影响**：帧只读日志事实，不写会话态。

## 1. 架构：落盘通知 → 帧投影层

```
壳 writer append（相位/run-end/inject 行）
   │ ledger/event-appended（新事件：type + seq + run + ts——
   │   既有 ledger/step-journaled 的泛化，B2 语义「seq 已 durable」不变）
   ▼
宿主（订阅壳 ipc 事件面）
   │ 投影转发层（本方案新件）：事件 → 帧词汇映射 + seq 锚直通
   │   · 步级帧：step/* 相位行 → loop/step-started·after-step 的帧等价物
   │   · 工具帧：step/tool-call(-result) 行 → tool/started·after-execute
   │   · 注入帧：inject 行 → 注入卡帧（正文/label/payload 随行）
   │   · 收束帧：run-end 行 → run/settled（携带 finish/usage/runMs）
   ▼
ws-bridge（llm/delta 流帧照旧 30ms 微批；新帧族直转）→ 前端 feed-core 合流层
```

- **投影转发层落位**：ac-ws-bridge 内新模块（消费事件面 → 发帧）——行级 owning
  归桥接行，事件词汇归 ac-ledger（谁 emit 谁声明）；
- **帧身份 = 事件身份**：帧携带 `seq`（行级锚）+ `run` + `stepId?`——前端
  吸收/去重从「同锚启发式」升级为「同 seq 恒等」（cr-106 身份门的等价物
  候选，见 §5）；
- **断连语义**：帧是投影 → 丢帧无损（重连 = 重放 fold 增量，seq 水位续读）。

## 2. 微批语义重建（B 案硬点）

| 机制 | 现状 | B 案形态 |
|---|---|---|
| `llm/delta` 30ms 微批 | ws-bridge LlmDeltaBatcher（流帧攒批） | **保留原样**——流帧不经落盘（D3-1），微批仍在传输层 |
| 步级帧 100ms 级合并 | feed-core 合流层启发式 | 投影层按事件粒度直发（相位行本身即步内序——cr-946 教训的直播面对应物）；前端合流按 seq 恒等去重，无需时间窗 |
| 边界 flush | delta-end 前清空在途批（保序） | 保留 + run-end 帧强制 flush（收敛前零在途） |

## 3. 收敛协议重设计（E-2 一次做对）

- 收敛信号 = `ledger/event-appended(type='run-end')`（宿主收到即广播
  `run/settled` 帧并触发该会话指纹失效）——「落盘通知」与「重拉权威」
  合为一条因果链；
- 重拉载荷 = fold 投影（历史与直播同一投影面，cr-974 已就位）；
- 兜底降级：after-run +500ms 从「收敛主力」降为「通知面可达性保险」
  （保留窗口但不再承担正确性——§5 重论证条目 #4）。

## 4. 决策点（2026-11-10 用户裁决，全部已裁）

| # | 问题 | 裁决 |
|---|---|---|
| D3-1 | delta 流帧是否也走「落盘后转发」 | **否**——流时序与落盘时标分离，delta 保留壳内流转发 + seq 锚 |
| D3-2 | 事件通知通道 | **A：壳 ipc 事件面**（ledger/step-journaled 泛化——宿主单进程已在事件链上） |
| D3-3 | 旧帧族去留 | **一步切换**（feed-core 单批重构，风险集中认赔）——双写期否决：双写清理易遗忘 |
| D3-4 | feed-core 合流层重构切分 | **一次性重构**（不做渐进三步） |
| D3-5 | remote-link 同构时机 | **滞后**——留待 remote-link 重写时一并处理 |

## 5. 防御机制逐条重论证清单（cr-972 §3.2 红线兑现；落地列 = cr-976 实施登记）

| # | 机制 | 事故背景 | B 案下的处置候选 | 落地（cr-976） |
|---|---|---|---|---|
| 1 | cr-106 吸收身份门 | 用户落盘行被身份吸收进 Agent 占位（镜像事故） | 帧带 seq 恒等 → 吸收按键恒等；身份门保留为第二道（等价物：恒等门） | **保留原样**（mergeHistory 身份门 + 空载门不动）；stepId 键控路径即「恒等门」——step/journaled 帧到达即锚 seq 到载体，键即身份 |
| 2 | cr-107 悬挂流探针 | 收尾帧缺席 → 占位无限残留 | run-settled 帧由 durable 事实驱动 → 悬挂主因（事件丢失）消除；探针降级为「通知面死亡探测」（后端不可达仍不可区分——保留） | **保留原样**（180s 探针 + conversation/stats 判活 + force 收敛）；durable 驱动消除「事件丢失」主因，探针继续覆盖通知面死亡与盲区 |
| 3 | 发送 watchdog | 投递失败红条 + 流式态回落 | 与帧路径无关（投递面）——**保留原样** | **保留原样**（30s armSendWatchdog + 权威 stats 判活） |
| 4 | after-run +500ms 兜底 | run-settled 事件丢失时的收敛保险 | 正确性归 run-end durable 通知；窗口保留为通知可达性保险（可延长/保留） | **退役**：正确性归 run/settled（durable 因果）；可达性保险 = 重连对账重拉（rpc.onOpen 只重拉活跃分区）+ 探针 + watchdog——帧丢失 ⇔ ws 断 ⇔ 重连补偿，同因同补 |
| 5 | 防自激（会话状态机） | 帧回流触发新 run | 不变（宿主→前端单向，帧不写会话态——本方案不动） | **不变**（投影层只读日志事实，零会话态写入） |
| 6 | 指纹短路 | 切换重入全读浪费 | **保留**（cr-973/974 已同源：索引指纹 → fold） | **保留原样**（服务端 unchanged 轻载荷；run/settled 落盘已改文件 → 指纹天然失效，无需显式失效面） |

> 每条在实施对应阶段落地时必须写「等价物证明或失效证明」并登记 CR——
> 本表是承诺清单，不是默认作废清单。

## 6. 实施清单（阶段化，每阶段独立验收；按 §4 裁决定稿）

### P3-1 通知源与帧词汇（不碰前端）——✅ 已实施（cr-976）
1. `ledger/event-appended` 事件（type/seq/run/stepId?/ts——泛化 step-journaled，旧事件保留兼容窗）：落点 ac-ledger writer onAppend 回调（deliver/appendEvents/settle 各切片 fsync 后发射）
2. wire-format 新帧族：`run/settled`、`step/journaled`、`tool/result`（ledger-projection.ts 纯函数，seq 锚直通）；旧帧族同批删除（D3-3：loop/step-started·after-step·after-run、tool/after-execute、session/run-settled、ledger/step-journaled、run-settled/step-started/after-step/tool-result 旁带帧族）
3. ws-bridge 投影转发模块 + run-end 强制 flush：落点 ac-post-office stream-bridge（消费 ledger-event 旁带帧 → projectLedgerAppend；run/settled 前 flushNow）
4. 验证：帧序 ≡ 事件行序（p3-ledger-projection.test 黄金对拍）；E-2 修复实证（e2e-stream：run/settled 帧 seq ≡ 日志 run-end 行 seq，旧帧族零出现）

### P3-2 feed-core 合流层一次性重构（D3-4）——✅ 已实施（cr-976）
1. 单批重构：seq 恒等吸收（step/journaled 锚定块——水位只进不退 + 载体 seq 锚，锚定在建卡之后：载体缺席窗口首帧不丢 seq）+ 收敛驱动换源（run/settled 帧 delay=0；+500ms 退役归 §5 #4）+ 载体惰性建卡（首个带 stepId 的 delta / step/journaled 兜底——step-started 帧退役的对应物）
2. 验证：60 文件 / 302 用例全绿（含 cr-106/107 回归族、断连重连幂等 resync-converge、b2-frame-seq 按新语义重写）

### P3-3 防御机制重论证落地（§5 兑现 + 逐条 CR）——✅ 已登记（cr-976，见 §5 落地列）

### P3-4 remote-link / lite 面同构（D3-5：滞后——留待 remote-link 重写一并处理；
本项在此前维持 lite 投影同源现状，帧面不迁）

### P3-5 收尾——✅ 已实施（cr-976）
- 旧帧词汇已在 P3-1 删除（一步切换无清理尾巴）；feed-core 单体切分延续（cr-956 轨）
- 文档：session-design §7 已按 B 案改版 + 本文档状态戳；README 架构面无直播管线专段（§7 单源）
- **回滚边界变更**（一步切换的代价认赔）：P3-1+P3-2 合并为一个可回滚单元
  （git revert 整批；双写窗不存在）——发布前需整批过全量 + e2e（✅ 417 文件 / 3005 用例 + 集成全绿）

## 7. 验收与回滚

- 性质化：**直播与历史同源**（同源断言 = 帧投影增量 ⊕ fold 快照 ≡ fold 全量）；
  断连重连幂等（seq 水位续读零重复）；收敛因果链单事实（run-end → settled 帧
  → 重拉，无第二触发源）；
- 回滚：P3-1+P3-2 为一个回滚单元（D3-3/D3-4 一步切换——无双写窗，git revert 整批；发布前整批过全量 + e2e）；
- 红线：不动 fold/词汇（归 cr-974 域）；帧不写会话态；ws 断连不丢事实。

## 8. 明确不做

- 不做 delta 帧落盘转发（D3-1 已裁否）；
- 不做帧级持久化/回放缓存（帧 = 投影，重放走 fold）；
- 不动会话状态机/编排键（run 概念已归位编排层——cr-972 §2.2）；
- 不做 per-view 帧投影（视图参数归读面）。
