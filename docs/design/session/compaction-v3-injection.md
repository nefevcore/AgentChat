# 会话压缩 V3：注入驱动整理轮 + session_digest 结构化提交（compaction-v3-injection）

> 性质：域深设计——压缩机制 V2（cr-1160）之后对「整理轮驱动方式」与「概要提交协议」的重设计（用户裁决 2026-11-21）。
> 状态：现行（设计定稿，待实施） · cr-1189 2026-11-21 · 承接 cr-1160（P1-P4 骨架保留）/ cr-1188（archive/completed 发射链保留）。
> 读者：动 ac-shell-rows archive 行 / ac-conversation 注入面 / ac-ledger 压缩事件 / session-index 入账白名单的人；实施前必读。

---

## 0. 结论速查

V3 换掉 V2 的两个环节，其余骨架（阈值检测、compaction 单事件、双维边界、物理回收解耦、三口径收敛）原样继承：

| 环节 | V2（cr-1160，现行） | V3（本稿） |
|---|---|---|
| 整理轮驱动 | `reviewRun` 机制投递面（archive-review 三不标记 + settleMechanismFor + 前端隐藏查表——cr-1188 刚补齐的整套特殊面） | **会话内注入行 + 普通 deliver run** |
| 概要提交 | 亲写 summary.md（已实证不可靠）→ 回退终稿文本 +「此前，」启发式形态校验（P3） | **`session_digest` 工具参数 = 结构化提交、零格式门槛**；无提交不压缩（本代无新概要态） |
| 触发检测 | token 阈值单机制（after-run 钩子内联） | **机制注册式**（§2.8）——token 阈值为缺省，可注册扩展场景（如 news~news 按回检任务次数） |

两条用户裁决（2026-11-21）贯穿全稿：

1. **摘要全文住注入行**——compaction 事件只做边界 + stats，不携带摘要全文（单一事实源）。
2. **工具命名 `session_digest`**——独特语义词形，避开常规用词（summary/summarize）防 Agent 会话内误调用。

## 1. 动机（V2 实施后的三处实证病灶）

### 1.1 writer 归档实跑（2026-11-21，user~writer，v1 会话）

| 事实 | 后果 |
|---|---|
| 提示词要求「写入本会话概要文件 summary.md（会话目录）」，writer 把概要写到了自己工作区 `summary/user~writer.md`（其工作区本就有同名目录） | 亲写路径语义对 Agent 不自明——「会话目录」是平台词，Agent 的世界只有工作区相对路径 |
| 亲写 miss → 回退终稿文本，终稿以「归档整理完成。」开头 → `summaryCommittable` 拒收 → summary=undefined | v1 路径 `compactFor` 概要不动——归档段写好、summary.md 永不生成，**归档后的会话回放无概要头，早期上下文凭空蒸发** |
| 整理 run 本身健康（12 步 finish=ok，memory/DONE/TODO 认真整理） | 病灶不在 Agent 能力，在提交协议——提取靠猜、路径靠猜，两头不可靠 |

### 1.2 V2 遗留的结构性重量

| 病灶 | 现行实现 | 代价 |
|---|---|---|
| reviewRun 机制面整套特殊路径 | archive-review 三不标记 / settleMechanismFor 特殊收束 / 前端 archiveReviewing 查表 + 壳侧 hiddenReviewRuns 过滤（cr-1188）/ runMeta 透传链 | 一套只为「隐藏机制 run」存在的平行机制面，每处帧链改动都要跟着维护 |
| 摘要提取靠启发式 | 「此前，」开头 + 元文本黑名单（P3） | 只能拒收、不能纠偏；拒收后 v1 会话直接丢概要（§1.1） |
| fs 依赖 | 亲写 summary.md 路径要求 write/fs 工具在场 | 最小行集 Agent（无 fs 行）整理轮必然走回退链——而回退链就是启发式 |

### 1.3 用户方案的对拍结论（2026-11-21 会话）

注入驱动 + 工具提交与 V2 骨架同构（阈值→整理轮→剪裁→新起点不变），实质变化集中在驱动与提交两层。工具化提交是 P3 的根治版：cr-1160 「不强制 LLM 结构化输出」的裁决理由（强结构化改 loop 面）对工具调用不成立——工具参数本来就是结构化面，零 loop 改动。注入驱动则让 reviewRun 族特殊面整体退役。

## 2. 终态规格

### 2.1 流程总览

```
run 收束（loop/after-run）
  → 触发检测（机制注册式——见 §2.8；token 阈值是缺省机制，可注册扩展场景）
  → 【新】落压缩请求注入行（source='archive-review-request'，见 §2.3）
  → 【新】普通 deliver 唤醒压缩轮（排队/steer 语义免费——busy 时 next-turn 排队）
  → Agent 整理，调 session_digest(text)（结构化提交；工具面守卫见 §2.2）
  → run 收束 → 【新】从 run 事实捞 session_digest 调用参数
      捞到 → 落摘要注入行（source='archive-summary'，全文住此——单一事实源）+ compaction 事件（边界+stats）
      没捞到 → 「无新概要压缩」：compaction 事件照落（边界+stats），摘要注入行不落——回放头沿用上一代摘要
  → 物理回收（独立 shadowed 水位触发——现行 V2 P1 解耦语义，不动）
回放（下次 run）：
  fold 双维边界过滤（现行谓词不动）→ 摘要注入行天然在新代头部（context 行，非 shadowed）
```

### 2.2 session_digest 工具

| 设计点 | 裁决 |
|---|---|
| 命名 | `session_digest`（用户裁决）——独特词形防误调用；不用 summary/summarize/recap 等高频会话用词 |
| 注册方 | archive 行（压缩插件）——工具随行装配；archive 行在 shell 骨架必装面（cr-1118），全 Agent 恒有 |
| 参数 | `{ text: string }`——总结全文。**不设格式门槛**（无意图词/开头要求），长度上限放宽 + 提示引导（见 §2.4） |
| description | 写死使用条件：「仅在归档整理轮调用——收到压缩请求注入后，把整理结果作为唯一参数提交。会话内其他场景勿调用。」 |
| **工具面守卫** | 非压缩轮上下文调用 → 返回提示「session_digest 仅在归档整理轮可用（当前无进行中的压缩请求）」，不产生副作用——防 Agent 会话中被名字诱骗误调用 |
| 压缩轮识别 | archive 行维护 pending 标记（conversationId → requestedAt）——注入请求落行时置位，run 收束时消费清除；工具执行时查标记判上下文 |
| requiresInteraction / 权限 | 不需要（机制工具，无敏感面） |

### 2.3 两条注入行（新 context 行 source 词汇）

| 词汇 | 语义 | 落点 | 回放 |
|---|---|---|---|
| `archive-review-request` | 压缩请求（注入指令文本） | 阈值触发时落账 | **不进回放**（机制请求非会话事实；旧代行随边界 shadow） |
| `archive-summary` | 摘要全文（Agent 整理产物，单一事实源） | 压缩轮收束、digest 捞到时落账（紧跟请求行之后、compaction 事件之前） | **进回放**（context 行；非 shadowed——天然落在新代头部，取代 V2「fold 摘要置首」特判） |

回放头变化：V2 `foldSummaryOf` 从 compaction 事件取摘要置首 → V3 摘要即注入行，fold 正常遍历自然置首（该行在边界之后落账，永不被 shadow）。`foldSummaryOf` 保留为存量兼容读（v2 单事件摘要 / v1 summary.md），不再服务新代。

### 2.4 概要提交协议（P3 的 V3 形态）

```
提交 = 压缩轮 run 事实里的 session_digest 调用参数（唯一提交面）
校验（用户裁决 2026-11-21 同日：松绑——工具参数已是显式提交意图，格式门槛无存在必要）:
  意图词（「此前，」开头）—— 不校验（V2 启发式整体退役，连软断言也不留）
  长度 —— 不截断不拒收；超过建议值（缺省 4k token，per-Agent settings['archive'] 可调）时
           工具返回体带引导提示「总结偏长，已收录；下次可更精炼」——提示引导而非门槛
兜底:
  无 digest 调用 = 「无新总结压缩」（合法态）：边界照落、总结行不落、回放头沿用上一代
  禁止回退「从终稿文本猜」——启发式提取随 V2 P3 退役
```

松绑理由：结构化提交（工具调用）已是 Agent 的显式意图表达，不存在「误把汇报当摘要」的提取歧义（V2 病根）；格式校验在提交面结构化后只剩防御幻觉的价值，而幻觉由内容自证（Agent 自己下次回放要读），不需要平台把关。长度同理——上限的本意是控回放开销，交给提示引导 + per-Agent 配置（有真实大总结需求的会话可放宽），不做硬闸。

### 2.5 机制面退役清单

| 退役项 | 现行位置 | 退役后替代 |
|---|---|---|
| `reviewRun` + 三不标记投递 | ac-shell-conversation `service.ts`（meta.archive-review） | 普通 deliver（注入行为入站消息） |
| `settleMechanismFor` / `settleMechanism` | ac-ledger writer/service | 压缩轮走普通 settle（终稿落账）——整理轮的汇报文本本身进会话流（透明性） |
| 整理 run 前端隐藏（archiveReviewing + markArchiveReview） | ac-client-ui-conversation feed-core | 注入卡可见（透明性裁决）——压缩轮在会话流里可见为「收到压缩请求 → 整理 → 提交摘要」 |
| 壳侧 hiddenReviewRuns 过滤 | apps/shell boot.ts（cr-1188） | 随压缩轮走普通 run 语义，流式帧正常广播（会话流可见整理过程） |
| runMeta 透传链 | ac-envelope-core stream.ts + stream-bridge.ts（cr-1188） | **保留**——archive-review 旗标退役后无消费方，但通道留作后续机制旗标通用面（不拆） |
| 亲写 summary.md 路径（fs 探测 + mtime 判新鲜） | ac-shell-rows archive.ts | 整段删除——提交面唯一化（session_digest） |
| `summaryCommittable` 启发式校验 | ac-archive-core | 退役为 §2.4 软断言（warn 日志） |

### 2.6 首轮压缩的上下文膨胀缓解

首轮（无既有摘要、活跃代巨大）压缩轮 prompt 可能撞模型上限。裁决：**注入指令写明「基于当前上下文与既有概要整理，不必逐条回读」**；不做 history 策略截断（V3 首批不做，观察首轮实测再裁——记入 §5 开放问题）。

### 2.7 术语分层（用户裁决 2026-11-21 同日）

机制现存三词（归档 / 压缩 / 总结）语义重叠混用——前端符号 `compressSession` 配「归档」文案、`compressPending` 与 `pendingArchiveConv` 并存、「压缩」与归档段的 gzip 物理压缩撞词。裁决：**不消灭词汇，分层定界**——三词各管一层，互不越界：

| 层 | 中文词 | 英文锚 | 覆盖面 | 边界 |
|---|---|---|---|---|
| 编排层（用户可见） | **归档** | archive | 机制总称、UI 入口与全部文案、行/RPC/编排符号（archive 行 / session/archive / archive/completed / pendingArchiveConv） | 不用于指逻辑边界或摘要产物 |
| 机制层（技术文档） | **压缩** | compaction | 逻辑边界事件、阈值口径、代（generation）、设计稿标题 | 不出 UI；不与 gzip 物理压缩混指（物理面叫「物理回收」） |
| 整理层 | **总结** | digest | 整理轮、摘要产物、session_digest 工具、注入行 source（archive-summary 的用户语 = 总结） | 「概要」仅存于存量词汇（summary.md / foldSummaryOf 兼容窗），新面不再产生 |

自洽叙述：用户发起**归档** → Agent 整理并写**总结** → 系统落**压缩**边界 + 旧消息物理回收进 `archive/` 段。

落实面（随 B1/B3 批顺手做，不单开批）：

- B1：注入行指令与 session_digest description 用「归档整理」「总结」措辞；
- B3：前端符号统一 `compressSession` → `archiveSession` 族（符号改动，行为零变）；UI 文案统一「归档」系；
- 词汇例外（不改）：`compaction` 事件 / `compactFor` / `foldSummaryOf` 等已定型技术符号；存量 summary.md 文件名。

### 2.8 触发机制注册式（用户裁决 2026-11-21 同日）

V2 触发 = token 阈值单机制（after-run 钩子内联 `activeTokensOf(uuid) <= threshold`）——会话形态多样（news~news 自会话定时任务堆机制行、编辑型会话长文少消息），单一 token 口径不总适用。V3 改**机制注册式**：

```
archive 行持有触发器注册表（shell 内服务面）：
  registerTrigger({ id, description, appliesTo(uuid): boolean, shouldTrigger(ctx): boolean })
  ctx = { uuid, activeTokens, runCount 自上次压缩, lastRunAt, …可扩展 }

缺省注册：token-threshold（activeTokens > thresholdOf(budgets)——现行口径平移）
扩展例：run-count（news~news 场景——自上次压缩累计 run 数 > N 触发，适合机制行多而 token 计量失真的自会话桶）

eval 时机：run 收束（loop/after-run）——遍历注册表，任一触发器命中即进入压缩流程（同一会话同拍至多一次）
```

| 设计点 | 裁决 |
|---|---|
| 注册面形态 | 沿 registerPromptSection / registerToolMode 范式（cr-881/cr-1104 先例）——ctx.archive.registerTrigger，注册随行 fiber 归属自动回收 |
| appliesTo | 会话键谓词——触发器自声明适用面（如 run-count 注册器只 appliesTo 自会话桶 a~a）；缺省全适用 |
| ctx 数据面 | 首版字段：activeTokens（现行口径）/ runCountSinceCompaction（fold 读 compaction 事件计数）/ lastRunAt。新字段按需加（注册式扩展点即在此） |
| 多触发器 | OR 语义（任一命中即触发）；同拍去重（pending 标记已在） |
| 手工触发 | session/archive RPC（cr-1188 受理语义）不经过触发器——用户显式指令恒直达 |
| 与阈值口径的关系 | token-threshold 仍是缺省注册——「三口径收敛」（V2 P4/C5 根修）语义不变，只是从「唯一机制」变「机制之一」 |

## 3. 与代码的映射点（实施批切分）

| 批 | 改动面包 | 内容 |
|---|---|---|
| B1 | ac-shell-rows archive.ts | `session_digest` 工具注册（pending 标记守卫）+ 请求注入落行 + digest 捞取（run 事实读面）+ reviewRun 调用改普通 deliver + **触发器注册面**（§2.8：registerTrigger + token-threshold 缺省注册平移） |
| B2 | ac-ledger | `archive-review-request`/`archive-summary` context 行词汇（若需 writer 侧词表）+ `settleMechanism` 退役标记（存量读兼容保留） |
| B3 | ac-client-ui-conversation | archiveReviewing 查表退役 + 注入卡形态适配（archive-review-request 请求卡 / archive-summary 摘要卡）+ archive/completed 收口不变 |
| B4 | ac-session-index | 摘要注入行入账白名单（archive-summary 行进 records 但带机制标记——或直接排除出 ts_num 聚合，沿 cr-1160 §2.4 聚合白名单先例） |
| B5 | 退役清理 | hiddenReviewRuns（boot.ts）/ settleMechanismFor 消费面 / summaryCommittable 调用点——全仓求证后移除 |
| B6 | docs | session-design.md §3.4 并入 V3 结论 + 本档状态行更新 |

依赖序：B1 → B2 → B3/B4 并行 → B5 → B6。B1 是核心（工具 + 注入 + 捞取闭环），可独立验证。

## 4. 明确不做（裁决存档）

| 不做 | 理由 |
|---|---|
| 摘要双写（注入行 + compaction 事件全文） | 单一事实源（用户裁决 1）——双写两份真相走散是红线 |
| 无 digest 时从终稿文本猜摘要 | 启发式提取正是 V2 病灶（§1.1）；「无新概要压缩」是更诚实的态 |
| 压缩轮 history 策略截断 | 首批不做——注入指令引导优先，实测撞限再裁（§2.6） |
| `session_digest` 会话内开放使用 | 工具面守卫硬闸——仅压缩轮 pending 标记在场时生效 |
| 触发时机改 idle-exit / 会话关闭 | 保持 run 收束 + 阈值（V2 语义）——壳退出后无人跑压缩轮，且下次唤醒可能已爆 |
| 摘要分级 / 分层记忆 | 沿 V2 §4 裁决不变 |

## 5. 开放问题（实施时裁）

| # | 问题 | 备注 |
|---|---|---|
| Q1 | 首轮压缩实测是否撞模型上限 | news~news 型会话（70 万 token 活跃代）验证；撞限则补 history 截断或分代整理 |
| Q2 | archive-summary 行的 token 计量 | 是否计入 activeContextTokens（倾向计——它是新代头部事实）；口径与 est_tokens 同源 |
| Q3 | 存量 v2 会话（compaction 事件带摘要）的读面 | foldSummaryOf 兼容读已覆盖；新代起不再产生事件摘要 |
| Q4 | 压缩轮被用户 steer 插话 | deliver 排队语义应已覆盖；验证用例锁定 |

## 6. 测试标准与验证目标

### 测试标准（过程门）

每批按改动面走验证阶梯（typecheck / test:unit / check:deps / 定向 lint；涉前端加 webui:typecheck + build:frontend；契约面 pnpm test 全量）。

### 验证目标（目的态断言）

| # | 断言 | 判据 |
|---|---|---|
| V1 | 结构化提交闭环 | 压缩轮收束后摘要注入行落账且全文 = digest 参数；compaction 事件无 summary 字段 |
| V2 | 无提交退化 | Agent 不调 digest → 边界照落、摘要行缺席、回放头 = 上一代摘要 |
| V3 | 透明性 | 压缩轮在会话流可见（请求注入卡 + 摘要卡）；前端无隐藏机制 run 残留 |
| V4 | 工具守卫 | 非压缩轮调用 session_digest → 无副作用提示返回；pending 标记生命周期正确 |
| V4b | 触发器注册式 | 注册 run-count 触发器（appliesTo 自会话桶）→ 命中触发；token 阈值缺省行为与 V2 等价（回归）；手工 RPC 不经触发器 |
| V5 | fs 无关性 | 最小行集 Agent（无 fs 行）完整走通压缩闭环 |
| V6 | 存量兼容 | v1（summary.md）/ v2（事件摘要）会话回放头不回退；新代摘要注入行正常置首 |
| V7 | 索引口径 | archive-summary 行不污染 ts_num 聚合；activeContextTokens 含摘要行（若 Q2 裁定计入） |

## 7. 裁决链

| 日期 | 裁决 | 取代关系 |
|---|---|---|
| 2026-11-20 | cr-1160 V2：P1-P4（单事件 / 双维边界 / 启发式提交协议 / 索引首席） | 取代 cr-974 §2.3 压缩三态 |
| 2026-11-21 | cr-1188 受理语义 + archive/completed 发射链 + archive-review 透传 | 修 V2 实施的运行时断点（保留，V3 沿用其广播链） |
| 2026-11-21 | **本稿 V3**：注入驱动 + session_digest 结构化提交；摘要全文住注入行；工具命名裁决 | 取代 V2 的驱动面（reviewRun 族）与提交面（P3 启发式）；P1/P2/P4 骨架与三口径收敛不动 |
| 2026-11-21 同日 | 提交协议松绑（无意图词校验 / 长度不限 + 提示引导）+ 触发检测改机制注册式（token 阈值为缺省，可扩展 run-count 等场景）+ 术语分层（归档/压缩/总结） | §2.4 / §2.8 / §2.7 增补 |
