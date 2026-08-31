# M20 规划：归档分支回归设计——会话内整理 run + 失控防线

> 状态：**✅ 已落地（2026-08-27）**。D1–D6 全按推荐执行，唯 D3 经用户裁决
> 改为 **maxSteps=128**（文档原推荐 16；src"不设上限"即 OOM 根因①，任何
> 有界值都已消除线性无界，128 为用户选择的宽裕预算）。落地记录与验收
> 见 `preview/README.md` 里程碑 M20；防回归测试落在
> `preview/ac-archive/tests/archive.test.ts`（闸①对抗 provider、排队不
> 并发、done 双侧、D4 文件概要）与 ac-session/ac-usage 的标记跳过用例。
> 顺手修复：ac-memory 工具体改 `ctx.get('memory')` root-traced 解析
> （M15 起 memory_append 在真实 run 内解析断链的潜在 bug）。
>
> 背景：2026-08-26 手工归档触发 **4GB 堆 OOM**（进程存活 ~21 分钟，
> exit 134，`Mark-Compact (reduce) 4094.8 → 4094.6 MB` 零回收）。
> 根因已定位并受控复现；session 内曾上过临时防线（工具收束至
> memory_append + maxSteps=4），因偏离"Agent 亲自整理"的原设计已
> **完整还原**——本修复以"回归原设计"的形态规划，不是恢复防线。

---

## 0. 事故档案（根因凭证，动手前必读）

### 0.1 复现数据（受控实验，mock provider + 2MB 输出工具）

| 步数 | 输入上下文 | heapUsed 增量 | rss |
|---|---|---|---|
| 5 | 16MB | +51MB | 133MB |
| 20 | 76MB | +191MB | 277MB |
| 40 | 156MB | +439MB | 525MB |

40 步 / **1.3 秒** → 线性无界。真实 LLM 每步 0.5~1s：4GB ÷ 300KB/步
（大 read/grep）≈ 6,000 步 ≈ **15~35 分钟**——与事故进程存活 ~21 分钟吻合。

### 0.2 根因 = 四要素乘积（缺一即不炸）

| 要素 | 代码位置（还原后现状） |
|---|---|
| ① 不限步：整理 run 不设 maxSteps（注释"src 语义"） | `preview/ac-archive/src/service.ts` runReview L246 附近 |
| ② 全工具：`agent.tools` 未配置时不传 `tools` → loop 缺省 = 全部已注册（几十个） | 同上 L239-241 |
| ③ 上下文累积：超阈值桶全量 history 起步，每步追加工具结果（messages + steps[] 双持有，~2.5 份/步） | `ac-agent-loop/src/service.ts` execute |
| ④ 不可见：`source:'event'` → ws-bridge 过滤 step/delta，UI 无感知；pending 的 10 分钟超时兜底**不中止 run** | `ac-ws-bridge`；`ac-archive` scanPending |

### 0.3 溢出与存储无关（已定量排除）

- 读取全按需（records/history/tail/stats 瞬态即弃）；实测空载 + GUI 同款
  3s 轮询 8 分钟稳定 ~105MB。1000 个满阈值会话 ≈ 2GB **磁盘**，常驻内存不变。
- 单满阈值桶（默认 1M 预算、500k 触发）实测：321 行 / 1.1MB 字符 /
  1.77MB 文件（steps[] 放大 ×1.3~1.6；246/321 行含 steps，最大行 129KB）。
- **唯一现实溢出路径 = 失控整理 run，1 个达阈值的会话就够，与会话总数无关。**

---

## 1. 原设计 vs 现状（偏离清单）

原设计（用户规约）：
- 正常会话：`system prompt → turn × N`
- 归档分支：`system prompt → turn × N → event 触发 Agent 归档处理，
  不流式输出、不落盘`
- 灵感：为高 token 缓存，让 Agent 在**会话最后**以**继续会话**的形式整理；
  继续会话分支天然具备 session 记忆，只需把关键信息整理进
  TODO/DONE/MEMORY/SUMMARY。

src 实装锚点：`src/svc/archive/src/index.ts` triggerReview L253-290
（提示词：Agent 亲自 write/read 追加 SUMMARY.md、**重写** memory.md
"合并重复、删除过时，不要只追加"、TODO.md/DONE.md/note 同理）；
`src/agents/router/src/router.ts` routeTrigger L1097 / prepareTriggerPlan
L1123（convKey = `chatDialogKey(target, agent)` **同会话键走 submit 标准入口**
→ 串行化门/busy 决策/loadHistory 同一文件；带 meta/maxSteps 的 trigger
placement 自动 'next-run' L1181）；不落盘三处消费
`META_ARCHIVE_REVIEW`（= 'archive-review'，`src/toolkit/.../namespaces.ts` L54）：
`agent-session/writer.ts` L145/L168、`session.ts` L388、`run.ts` L102/L240。

| # | 维度 | src（设计） | preview（现状） | 后果 |
|---|---|---|---|---|
| 1 | **通道** | router.trigger 同会话键 → 串行化门（busy 时 next-run 排队） | `agentLoop.run` 直连旁路 | 与用户会话**并发**：共 steer 地址互相覆盖、compact 与在途写竞态丢消息、KV 缓存只是碰巧保住 |
| 2 | **输出物** | Agent 亲自用工具写 SUMMARY.md + **重写** memory.md + TODO/DONE/note | 概要=回复文本服务端代写；MEMORY=memory_append（只追加）；TODO/DONE/note 无对应物 | 整理语义缩水成"摘要" |
| 3 | **工具面** | Agent 正常生效集（写文件是任务的一部分） | 未配 tools → 全部已注册工具（放大失控概率与每步体积） | OOM 直接成因之一 |
| 4 | **记账** | （writer 三处跳过；usage 未对照） | `loop/after-run` 照发 → ac-usage 记整理 run 的账 | 巨型上下文顶掉该桶 lastContextPrompt，tokens 仪表失真 |

对齐了的不算偏离：event 触发 ✓、不流式（source='event' 过滤）✓、
会话文件不落盘（不经 router → ac-session 无感知）✓——但机制是"绕开"
而非"标记跳过"，通道回归后需要显式标记（见步骤 1）。

---

## 2. 目标形态（一句话)

归档分支 = **同一会话的一次"机制触发的继续会话"**：阈值/手工 → event
信封投递进串行化门（busy 时 next-run 排队）→ Agent 用自己的生效工具集
把关键信息整理进 TODO/DONE/MEMORY/SUMMARY → 完成标记驱动归档重建；
全程不流式、不落盘（**会话入账 / usage 记账 / conversation 上下文视图
三处**），且步数与时长有硬闸——失控的代价上限 = 一次中断的整理。

## 3. 分阶段落地（建议 4 步，每步独立可验证）

1. **信封不落盘标记**（纯增量）：`LoopRunRequest.meta?: Record<string, unknown>`
   （ac-agent-loop contract；loop 构造 llm meta 是显式字段——不会外漏进
   provider）。常量 `ARCHIVE_REVIEW_META = 'archive-review'` 从 ac-agent-loop
   导出（对齐 src META_ARCHIVE_REVIEW）。透传链：conversation.deliver
   options 加 `meta?` → router.send → 信封。三消费方：ac-session
   （message-received/reply-completed/steered 见标记跳过入账）、ac-usage
   （after-run 见标记跳过记账）、**ac-conversation**（startRun 的
   `context.push` 见标记不进上下文视图——否则整理提示词会泄漏进后续
   用户 run 的 history，这是 preview 特有缺口：src 下轮 run 从文件重载
   天然干净）。
   测试：三处不落盘断言（现有 ac-session/ac-usage 测试加用例）。
2. **通道回归**：runReview 的 `agentLoop.run` 直连改为
   `conversation.deliver(agentId, hint, { conversationId: 同桶, sender:
   agentId, source:'event', placement:'next-run', meta })`——串行化门
   排队（对齐 src triggerPlacementOf：带 meta 的 trigger 自动 next-run），
   steer 覆盖/竞态随并发消失。收尾改事件驱动：订阅 `loop/after-run`
   识别 `meta[ARCHIVE_REVIEW_META]` + agent + convId → 写 done 标记 →
   全参与者 done → archiveAndRebuild（pending/10 分钟兜底漏斗保留，
   兜底触发时先 abort 该 run 的 signal 再强制归档）。
   测试：用户 run 进行中触发归档 → 排队不并发；done 协议重建收尾。
3. **输出物与工具面回归**：提示词对齐 src（Agent 亲自 write/read
   SUMMARY.md、重写 memory、TODO/DONE/note 同理；路径 = `files/<agentId>/`
   既有布局，迁移数据已带 note/）。工具集 = Agent 生效集（机制回归设计）。
   已知缺口顺手补：ac-memory 只有 memory_append 工具，重写需新工具
   `memory_rewrite`（调 ctx.memory.set，服务面已有）；概要不再取回复文本，
   改读 Agent 写的 SUMMARY.md。附带观察：迁移遗留 src 记忆文件在
   `files/<agent>/memory/*.memory.md`，而 ac-memory 读 `<root>/memory/`
   ——是否搬迁列为低优决策（D6）。
4. **失控防线**（与设计共存的三道硬闸，缺一不可）：
   闸① `maxSteps`（推荐 16：概要 + 写文件 + 记忆整理的合理预算；
   finish='max-steps' → 概要降级、归档照常）；
   闸② 超时 signal 中止（pending 兜底超时时 abort 该 run →
   finish='interrupted' 收束，不再让失控 run 越过兜底继续跑）；
   闸③ 可观测性：整理 run 每步 logger.info 步号+上下文估算（source
   过滤了流式，日志是唯一观测面）；超过软阈值（如 8 步）告警。
   测试：**对抗 provider 防回归**（整理轮无视提示词每步调 256KB 输出
   工具 ×30）→ 断言步数 ≤ maxSteps、归档完成、（可选）heap 增量上限。

每步验收：`pnpm preview:typecheck && pnpm preview:test`；步骤 2/4 后
加跑 `pnpm preview:boot` 真数据手测（对 news~news 手工归档：观察排队、
日志步数、归档产物、内存平稳）。

## 4. 决策点（动工前需用户拍板）

- **D1｜整理 run 通道**：推荐 `conversation.deliver` 同桶（串行化门/
  排队/防并发，回归设计）。备选：保留 loop 直连（改动小，但偏离 ① 的
  并发/竞态/缓存问题全部保留，不推荐）。
- **D2｜不落盘标记载体**：推荐 `LoopRunRequest.meta` 透明通道
  （加法、零改名；三消费方各查常量键）。备选：`source` 新值
  `'archive-review'`（少一个字段，但污染拓扑词表——ws-bridge/MAX_AUTO_
  WAKES 等全部消费方要加分支，不推荐）。
- **D3｜maxSteps 上限值**：~~推荐 **16**~~ → **用户裁决 128**（落地值；
  设计所需动作的宽裕上限；这是与 src"不设上限"的**显式偏离**——src 同形状
  本就潜伏同款 OOM，事故证明了必须有闸）。备选：不设（回到 src 语义 =
  接受单会话可 OOM 整个进程，强烈不推荐）。
- **D4｜概要产出方式**：推荐 Agent 亲自写 SUMMARY.md（服务端读文件，
  对齐设计"继续会话式整理"）。备选：保留回复文本代写（少一次文件读，
  但 Agent 的整理成果与注入上下文脱节）。
- **D5｜双侧整理**：src 对 agent⇄agent 触发**双方**各自整理 run
  （虚拟端仅 agent 侧）。推荐对齐：对桶两端非虚拟各跑（done 全到齐才
  重建）。备选：仅 owning agent 单侧（省一半整理成本，牺牲对端记忆）。
- **D6（低优）｜遗留记忆文件**：`files/<agent>/memory/*.memory.md`
  （src 迁移遗留）是否并入 `<root>/memory/`。推荐暂不动（ac-memory
  未消费该目录，无功能影响；待 memory 域对账再议）。

## 5. 风险与不做的事

- **风险**：① 上下文视图剔除的竞态（标记 run 结束时 context 视图已
  push？——剔除点放在 deliver 入口分流而非事后回滚，测试锁定）；
  ② done 协议与 pending 超时兜底交互（兜底先到 → 强制归档 + abort；
  done 后到 → 识别 pending 已清即自清理，对齐 src L335-346 语义）；
  ③ 对抗 provider 测试对真实模型行为的代表性有限——闸①②是硬保证，
  测试只是预警网。
- **不做**：ac-archive-core 归档算法重写（线性无嫌疑）；群会话归档；
  存储上限治理（磁盘自然增长，backup 轮转 4 份兜底）；多 viewer。

## 6. 完成判据

- §1 偏离清单 4 行清零（通道/输出物/工具面/记账）。
- 防回归测试（对抗 provider）绿：步数 ≤ maxSteps、归档完成、进程无
  失控；复用本次复现脚本形态重跑，堆增量有界。
- 不落盘三处断言绿：session 无整理行 / usage 不记整理账 / 后续用户
  run 的 history 不含整理提示词。
- `grep -n "agentLoop.run" preview/ac-archive/src` 仅剩注释（直连旁路
  消失）；`pnpm preview:typecheck && pnpm preview:test` 全绿。
