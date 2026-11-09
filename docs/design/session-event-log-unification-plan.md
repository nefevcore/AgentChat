// 目标读者：实现本方案的人/Agent。本文是设计提案 + 分阶段实施清单（cr-972 登记，
// 2026-11-09 会话收敛——背景对比 DSH session 模型与本机 \.dsh 会话解码实证）。
// 状态：**裁决定稿**——D-1~D-4 已裁（2026-11-09 用户裁决，见 §4）：D-1 subcalls 不分流
// （索引精准定位取代全文扫描）；D-2 标记行 + step/* 细粒度事件词汇；D-3 读方配平；
// D-4 直播管线不做过渡 A 案，B 案直接另立项（Phase 3 升格独立项目）。
// 取代关系：无（是 session-design.md 的换代提案）。若实施，将推翻的既有裁决见 §6 清单；
// 实施完成前 session-design.md 仍为现行事实源。

# Session 事件日志统一（cr-972）

> 裁决链：viewer 账本物化复杂度（cr-698 写面兜底族）→「只索引真源 + 读时投影」→
> 用户三判断（多 viewer 投影 / 无需收束 / 归档只动索引）逐条核实：第 1 条成立（但机制
> 是一份指针索引 + N 个读时投影，非 per-view 索引）、第 2 条半成立（run 终态标记永存，
> 物化编排退役）、第 3 条是陷阱（索引携带语义 = 第二事实源；正解 = 压缩事件化 + fold）→
> 本方案定型为「单一 append-only 事件日志 + fold 单源 + SQLite 指针索引 + 读时投影」。

## 0. 问题与不变量

### 0.1 现状痛点

1. **viewer 账本是物化派生物**（cr-698）：requestId 幂等、run 键单行、锚行修复
   （repairDuplicateAnchors）、读时派生兼崩溃兜底——写面复杂度全部为「派生结果落盘」付出；
   多显示视图（气泡 / 无气泡 / 藏思维链）本应是读时参数，现受物化形态约束。
2. **settlement 两阶段物化编排**（段行/注入行物化 → journal 剔除 → settleOrphan 收口 →
   收敛协议重拉）：cr-726 三处疑点（E-2 run-settled 无发射方 / P5 指纹短路服务端半边 /
   S2 lite 投影未随迁）同根——「物化完成时刻」作为信号源难以为继。
3. **收束是搬移不是回收**（2026-11-09 会话校正）：journal 行删除但内容转写进定稿流，
   空间中性；真正的回收面只有 compact/归档的 tmp+rename 重写。物化的价值不在空间，
   在「定稿流可独立扫描」——代价是回放形态被物化定型（再解释空间受限）。

### 0.2 目标不变量（沿袭 S1–S5 并重述）

- **事实源一份**：每会话桶一个 append-only 事件日志（agent 域），永不重写；
- **一切投影 = 读时纯函数**：fold 单源——LLM 回放（viewer 投影 + 轨迹展开）、webui 视图
  （chat/plain/lite）、压缩后视图三方共用同一折叠函数（DSH foldSurface 同款纪律）；
- **指针索引只指真源、零语义**：行定位 / 分页 / FTS；索引可全量重建（纯缓存）；
- **显式 replace 白名单**收缩为：压缩事件边界（fold 语义层）+ 版本迁移；物理重写只发生在
  归档时机（S5 白名单捎带整段单流压缩——不采 DSH 小独立帧，实测 2.4x 教训，见 §3.3）；
- **前缀稳定**：fold 确定性 + append-only ⇒ 每 run 派生 = 上次字节前缀 + 纯追加后缀。

## 1. 第一刀：viewer 实时投影 + 指针索引（不碰 LLM 面）

### 1.1 机制

| 件 | 落点 | 说明 |
|---|---|---|
| 指针索引 | 新服务行（如 ac-session-index），SQLite WAL | 行：`(convId, domain, seq, byteOffset, role, agent_id, run, requestId, message_id, ts)`；subcalls 索引：`(run, tool_call_id)`（否则 stepsOfLedger 联查仍拖重会话） |
| 索引维护 | writer 落账后按 last-seen seq 尾读增量；打开时对账（mtime + size + 尾 seq） | 索引写者 = 宿主单进程（对齐「宿主单进程串行」现状，无多写者问题） |
| 读面 | web-api 分页 → 索引查偏移 → seek jsonl → projectRecord(viewer=user) → lite 投影 | 指纹短路服务端半边（疑点 P5）顺带落地：索引存文件指纹，未变回 unchanged 轻载荷 |
| 视图参数化 | records(conv, { view }) | chat（气泡+思维链）/ plain（无气泡，DSH 式）/ lite（移动端，收口疑点 S2）——纯函数，零存储差异 |

### 1.2 viewer 文件退役

- `viewer/sessions/<sid>/messages.jsonl` 停写；存量文件读面兼容一个版本后可弃（纯派生物，可重建）；
- 消费方迁移清单（2026-11-09 核实）：ac-host-webui 读面（session/history、消息计数、
  `UserLedger.replay()` 三处）、ac-import（projectUserLedger 从物化退化为建索引）、
  ac-host-rows（目录词汇单源改指 agent 域）、ac-shell-conversation（prefix-snapshot 路径
  改住 agent 域 session 目录或 singles 元数据旁）。
- `session.json`（singles 元数据）**保留**——它是引用/覆盖配置，不是消息派生物。

### 1.3 验收与回滚

- 插槽-插头：摘掉索引行 → 读面回落全扫投影（慢但正确）；行为等价测试（分页/指纹/lite）；
- 回滚 = 重跑 cr-698 派生重建 viewer 文件——第一刀整体可逆。

## 2. 第二刀：事件日志统一（journal 事件化 + 收束退役 + 压缩事件化）

### 2.1 journal-type 词汇重设计

现行 journal 判别行升为一等日志事件（messages.jsonl 与 journal/partials.jsonl 合并为单文件，
头行升 `version: 2`，未知 type 安全忽略的前向兼容机制沿用）：

| 现行 | 新事件 | 备注 |
|---|---|---|
| journal-step（整步一行） | `step/reasoning` · `step/tool-call` · `step/content` 等细粒度事件族 | **D-2 裁决**：LLM 回放行按步内相位拆细，行序即步内序——**cr-946 的 textBeforeTools 字段退役**（相位序由事件序天然承载；存量行读兼容保留该字段） |
| journal-tool-result | `step/tool-call-result` | subcall 全文随事件入主日志——**D-1 裁决**：cr-803 分流的动机是全文热扫描，索引精准定位后消解；**subcalls.jsonl 退役**（存量文件读兼容，M-v2 可选合并） |
| journal-inject | `inject` | label/injectionId/injectSource/requestId 快照全带；落位即消费点真序 |
| journal-settled | `run-end`（journal-settled 式标记行） | 终态 completed/interrupted/error/max-steps——回放闸门锚；fold 消费方据它判定区间闭合 |
| （新） | `compaction/*` | 见 §3.3 |

段行/终稿行的物化**停止**——「会话流」成为 fold 的输出而非文件的形态。

> **fold 必须索引辅助**（D-1 的配套约束）：subcall 全文内联后主日志显著变大，
> LLM 回放派生（轨迹展开只消费 step/* 与边界标记，不需要 subcall 全文）必须经索引
> 按类型定位行、跳过 subcall 载荷——否则每 run 重派生的顺序扫描成本随内联体积膨胀，
> cr-803 的问题换个形态回归。

### 2.2 run 概念再评估（2026-11-09 用户判断：单源后 run 意义不大）

拆开 run 的四个现存角色：

| 角色 | 第二刀后 | 判断 |
|---|---|---|
| 存储结构键（settlement 分段、journal 按 run 清理） | **消失** | 用户判断成立的部分 |
| 回放语义键（轨迹展开按 run 边界、悬空 tool_calls 闸门、空终稿跳过） | 弱化为事件流上的区间标记 | run-end 事件仍是闸门锚——中断 run 前缀保真、跨 run 轨迹边界都靠它 |
| 编排键（串行化门 runAddress、MAX_AUTO_WAKES、steer/next-run/next-turn） | **完整保留** | 投递语义，与存储无关——归 ac-shell-conversation，一个字不动 |
| 收敛信号（run-settled → 前端重拉） | 变为「run-end 事件 append+flush」单事实 | E-2 疑点根治 |

**结论：run 不是意义不大，是搬家**——出存储层（不再是文件的形态单元），留在编排层与回放闸门。
**D-2 已裁**：不引入 turn/step 双层编号（编排细节不入日志）；事件词汇 = 标记行
（run-end 一类）+ step/* 细粒度回放行族（§2.1）。

### 2.3 压缩事件化

- `compaction/start` → `compaction/summary`（摘要全文入事件）→ `compaction/end`；
- fold 三态：current（活跃上下文）/ shadowed（被压缩替换，仍在日志）/ log-only（机制行）；
- **物理回收只发生在归档**：归档时把 shadowed 前缀整段搬 history_N.jsonl 并单流压缩
  （tmp+rename + 整段 zstd——S5 白名单时机捎带压缩，预估压缩比远优于 DSH 帧式 2.4x）；
  主日志保留 compaction 事件 + 摘要，可审计可重建。
- 群 500k 轮转同构处理。

### 2.4 崩溃恢复

- settleOrphan 退役；撕裂/未闭合 run 的处理——**D-3 已裁：读方配平**：
  只读观察在内存配平（对未闭合区间合成 run-end(interrupted) 投影），不回写日志。
  与「宿主单进程 + 活壳自持」进程模型贴合，免掉写方修复与活壳的写竞态；
  日志允许存在未闭合区间（append-only 不补写），配平是 fold 的职责之一。

### 2.5 验收与回滚

- golden 等价测试升级：性质化——fold(全量重放) ≡ fold(历史快照 + 增量事件)；三方投影
  （LLM/webui/lite）同源断言；
- 回滚：读面回落 v1 词汇（段行/journal 双文件读兼容保留一个版本）；新事件行按未知 type
  安全忽略——判别行设计的前向兼容红利在此兑现。

## 3. 前端直播管线影响评估（专项——影响确实不小）

### 3.1 现状结构

L1 直播管线（ws-bridge 帧：llm/delta 30ms 微批、loop/step-started 等）与 L2 存储、
L3 历史 RPC（session/history）物理独立；前端 feed-core 双源合流，靠收敛协议
（run-settled 重拉 + after-run +500ms 兜底）+ 防御机制（吸收身份门/空载门 cr-106、
悬挂流探针 cr-107、发送 watchdog）维持最终一致。

### 3.2 事件日志化后的两个选项

| | 选项 A（保守） | 选项 B（激进，完全体） |
|---|---|---|
| 直播管线 | ws-bridge 帧不变，**信号源换成事件落盘通知**（run-end append+flush → 收敛重拉） | 直播帧 = 日志 append 事件的投影转发——直播与历史同源，收敛协议大部分退役 |
| feed-core 改动 | 小（收敛驱动换源，吸收/探针照旧） | 大（合流层重构；30ms/100ms 微批语义在事件→帧投影层重建） |
| ws-bridge / remote-link / wire-format | 零改动 | 全链重做（BRIDGE_EVENTS 目录重定义） |
| 风险 | 收敛时序仍依赖「落盘通知」的可达性（需兜底保留） | cr-106/107 防御是事故沉淀，需逐条重新论证后才能删；一次动四层 |

**D-4 已裁：不做过渡 A 案，B 案直接另立项**（升格为独立项目，见 §5 Phase 3）。
含义与边界：

- Phase 2（存储统一）期间**前端零改动**——收敛仍走现行兜底（after-run +500ms；
  E-2 的 run-settled 修复不落地，顺延进 B 案一次做对）；
- B 案成为本方案的**第三阶段独立项目**：直播帧 = 事件日志 append 通知的投影转发，
  直播与历史同源，收敛协议、吸收门、悬挂探针、watchdog 在单管线语义下**逐条重新论证**
  （cr-106/107 的事故教训必须在新结构里有等价物，不允许「架构变了所以旧防御作废」的
  默认假设）；
- B 案依赖 Phase 2 的事件词汇与落盘通知就位——排期上严格串行。

### 3.3 存储形态红线（实测背书）

不做 DSH 式小独立帧压缩（本机实测：515 会话 561MB，压缩比仅 2.2–2.9x，帧均 0.3KB——
「批小 × 帧独立」乘积性膨胀）。明文 jsonl 为主，压缩只在归档重写时机整段单流进行。

## 4. 裁决记录（2026-11-09 用户裁决，全部已裁）

| # | 问题 | 裁决 | 关键理由 |
|---|---|---|---|
| D-1 | subcall 全文随事件入主日志 vs 保留 subcalls.jsonl 分流 | **不分流，内联主日志** | 当年分流动机是全文热扫描；索引精准定位后消解。配套约束：fold 索引辅助（§2.1） |
| D-2 | 事件词汇形态 | **标记行（run-end）+ step/* 细粒度族**（step/reasoning · step/tool-call · step/tool-call-result · step/content） | 回放行按步内相位拆细，行序即步内序；textBeforeTools 字段退役；不引入 turn 双层编号 |
| D-3 | 崩溃闭合：写方修复 vs 读方配平 | **读方配平** | 配平是 fold 职责；免写方与活壳的写竞态 |
| D-4 | 直播管线 A/B | **不做 A，B 直接另立项** | 不为过渡期维护双收敛语义；B 案依赖 Phase 2 就位，严格串行 |

## 5. 实施清单（阶段化，每阶段独立验收）

### Phase 1 = 第一刀（§1）——✅ 已实施（cr-973，2026-11-09）

实施落点：`ac-ledger projectUserReplay`（viewer 停写后的终稿层读时投影单源）+
`packages/ac-session-index`（SQLite WAL 指针索引行：指纹跨互认 + subcall 定位 seek +
增量尾读/对账重建；行摘除 = 读面回落全扫，parity 测试对拍）；消费方迁移 =
cr-973 清单（user-stub 停写 / web-api 读面 view 参数化 chat·plain·lite / face-ops
计数与 runs 快照 / singles-row 身份源迁 meta 层 / prefix-snapshot 迁 meta 层 /
ac-import 物化退役）。存量 viewer 文件读面兼容一个版本。
1. ac-session-index 服务行（SQLite WAL + 尾读增量维护 + 打开对账 fail-loud）
2. web-api 读面改造（偏移分页 + projectRecord(viewer=user) + view 参数化 chat/plain/lite）
3. 指纹短路服务端半边落地（收口 P5）
4. viewer 文件停写 + 消费方迁移 + 存量兼容读
5. 验证：`pnpm typecheck && pnpm test:unit && pnpm check:deps` + 动了持久化/会话链路
   → `pnpm test:integration`；索引行摘除等价测试
6. 同步：README 架构面 + session-design §3.1/§7.3 改写（标注 cr-972 取代关系）

### Phase 2 = 第二刀：存储统一（§2；前端零改动——D-4 裁决）——◐ 实施中（cr-974，2026-11-09）

**已落地**：§2.6 实施细化（见下）；事件词汇 v2 + 归一化（ac-ledger events-v2.ts）+
fold 单源四投影 + 读方配平 + 性质化测试（fold.test.ts：parity / v1↔v2 等价 /
前缀稳定 / 配平零回写）；读面全切换（assembleSessionView / historyFor /
historyMessagesFor / userReplay）；writer v2（停物化、相位逐行落账、run-end
durable、cr-946 字段写面退役、v1 双文件停写）；settleOrphan / recoverOrphanRuns
退役（D-3 配平归 fold）；resume / hasInboundRow 改走 fold；索引事件列
（records.type / tool_call_id，旧库弃重建）；v2 回放估位补齐（face-ops）。
**待办**：压缩事件化 + 归档物理回收（§2.3，含 ac-archive-core 迁移）；
session-design.md 全面改版；v1 写面测试夹具随读兼容窗退役。

**§2.6 实施细化（cr-974，2026-11-09 设计定稿）**：

- **单文件**：`messages.jsonl` 头行升 `{version:2}`，即会话唯一事件日志；
  `journal/partials.jsonl` 与 `subcalls.jsonl` 停写（存量读兼容，不强制合并——
  M-v2 物理迁移经 ac-backup-core 快照通道择机，读兼容先行）。
- **v2 事件 schema**（全行带 `type` 判别；未知 type 安全忽略沿用）：
  - `message`（终稿/入站发言：role·agent_id·content·requestId?·run?·runMs?）
  - `context`（材料/通知/错误行：source 词表沿用 event/error/inject-源/直落源）
  - `step/reasoning` · `step/content`（run·step·stepId?·text；步末计量
    usage?/elapsedMs? 随末相位行；aborted 随步内末行）
  - `step/tool-call`（toolCallId·name·arguments）· `step/tool-call-result`
    （toolCallId·result·durationMs?；subcall 全文内联——D-1）
  - `inject`（cr-707 全字段快照）· `run-end`（finish: completed|interrupted|
    error；usage?/model?/errorMessage?/runMs?——落账即 durable，回放闸门锚）
  - `compaction/start|summary|end`（§2.3）
  - **cr-946 textBeforeTools 退役**：相位序 = 事件行序（v1 行读兼容保留该字段）
- **归一化层**（readEvents）：v1 messages 行（role 判别）+ v1 journal 行
  （journal-step 按 textBeforeTools 拆相位；journal-settled → run-end）+
  v1 段行（聚合 steps 直入 run 轨迹）+ subcalls.jsonl（subcall 结果事件）→
  统一 `SessionEvent[]`；fold 只认归一化词汇。
- **fold 单源**（fold.ts）：events → 会话模型（runs 轨迹表 + 消息流），
  三方投影 = 其纯读数：LLM 回放（轨迹展开 + injected 判重 + 概要头）/
  user 终稿层（cr-973 projectUserReplay 谓词）/ webui 视图（注入卡归口 +
  steps 联查 + 盲区→未闭合 run 配平 + 活投影门控 + view 参数化）。
  **读方配平（D-3）**：未闭合 run 不回写——投影层合成 run-end(interrupted)
  （webui partial 态；LLM 轨迹照常注入）。**索引辅助（D-1 配套）**：fold 的
  轨迹按类型定位行、跳过 subcall 载荷（session-index 事件表）。
- **writer**：journalStep 逐相位落账（受理聚合步 → 按相位序拆行）；
  tool/after-execute → step/tool-call-result；settleRun = 终稿 message +
  （error 时 context/error）+ run-end——**停物化/停 prune**；settleMechanism
  = run-end 单行；**settleOrphan/recoverOrphanRuns 退役**（配平归 fold）。

1. 事件词汇 v2（step/* 族 + inject + run-end + compaction/*；判别行 + version:2 +
   迁移集 M-v2：段行/journal 双文件 → 单事件日志；subcalls.jsonl 存量读兼容，不强制合并；
   经 ac-backup-core 快照通道，唯一重写许可）
2. writer 改造：停物化；step 内相位事件按到达序逐行落账；run-end 标记行落账即 durable
3. fold 单源实现（三方投影共用 + **索引辅助**：按类型定位行、跳过 subcall 载荷）+
   性质化 golden 测试（含读方配平语义：未闭合区间合成 run-end(interrupted)）
4. settleOrphan 退役（配平归 fold）
5. 压缩事件化 + 归档物理回收（整段单流 zstd）
6. 前端零改动（收敛走现行 after-run 兜底；E-2 修复顺延 Phase 3）
7. 验证：`pnpm test` 全量 + integration；KV 前缀回归（replayTrajectory 两态对拍）
8. 同步：session-design.md 全面改版（S1–S5 重述、三文件/subcalls 分流裁决链归档）

### Phase 3 = 直播管线 B 案（独立项目，依赖 Phase 2，另立计划文档）
1. 事件落盘通知 → 直播帧投影转发层（30ms/100ms 微批语义在投影层重建）
2. 直播与历史同源后的收敛协议重设计：吸收门 / 悬挂探针 / watchdog 逐条重新论证
   （每条要有新结构下的等价物或失效证明，逐条登记）
3. ws-bridge / remote-link / wire-format / feed-core 合流层全链改造
4. E-2（run-settled 收敛信号）在此一次做对

## 6. 被推翻裁决清单（每条：当年动机 → 现判）

| 裁决 | 当年动机 | 现判 |
|---|---|---|
| §3.6 SQLite/seek 不做 | 单机个人规模无查询压力 | 触发条件已显形（多视图/搜索/移动端分页）；且索引非事实源，风险面不同于当年否决的「SQLite 后端」 |
| cr-698 viewer 物化 | user 侧标准账本桶复用 | 写面兜底族复杂度已超收益；读时投影 + 索引更简 |
| cr-697 journal 收束即清 | 267MB 膨胀（针对「读侧重建」版 journal） | 事件化后 journal 即日志本体；膨胀治理移交归档压缩（cr-803 分流教训保留在 D-1） |
| 2026-09-20 三文件裁决 | 变体乙写侧切分三缺陷 | 单文件 + 事件判别行 + 索引回避了当年三缺陷的根源（终值误清/时点无保证/归位歧义——都源自「物化」而非「journal」本身） |
| cr-803 subcalls.jsonl 分流 | 重度会话 98.7% 体积拖垮主文件热扫描 | **D-1 推翻**：扫描问题由索引精准定位消解；防回归约束 = fold 索引辅助（§2.1），否则同一问题换形态回归 |
| §3.4 compact tmp+rename 重写 | 显式 replace、一次性、可审计 | 语义层换压缩事件；物理重写保留在归档时机（仍是显式 replace，白名单不变） |
| 2026-09-23 增量视图退役 | 双事实源两次漂移 | 本方案非增量缓存：fold 单源、无第二持久化投影；但风险同源——纪律 = fold 三方共用 + 性质化 golden（§2.5），缺此纪律即重蹈覆辙 |

## 7. 明确不做

- 不做 DSH 式小独立帧压缩（§3.3 实测背书）；
- 不做投影检查点缓存（§3.6 维持——fold 每次全量或从索引偏移起步，不做物化检查点）；
- 不做 per-view 索引（视图 = 读时纯函数，索引只管定位）；
- Phase 2 期间不动 ws-bridge / wire-format / feed-core（直播管线改造全部归 Phase 3 独立项目）；
- system / tool schema 不入日志（维持现裁决：system 每 run 现算 / singles prefix-snapshot）。
