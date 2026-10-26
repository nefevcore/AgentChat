# 技能注入与会话存储词汇 v2（skill-injection-and-storage-vocab）

> **2026-10-06 文档治理重写为当前事实态**（逐项源码实测）。原档案起于 2026-09-18 会话裁决链：起点 = load_skill 在 run_code 程序化模式下失效；终点 = 会话存储词汇 v2（role/source/label 三轴）+ 技能注入三通道 + 版本升级数据迁移机制。
> 本版**保留裁决链**：被后续裁决取代的方案不删结论，逐条标注「谁取代谁、为什么」（§6）——历史裁决不是待办，勿顺手恢复。
> 关联：`session-design.md`（M21/D13 中性格式）、`tag-system-report.md`（标签域：load_skill 的 infra 门禁）、`src/README.md`（会话行/事件面）。

## 1. 结论速览（当前事实态，2026-10-06 实测）

- **存储词汇 v2 三条正交轴**：`role` = 消费通道（`'agent'` / `'context'`，`'event'`/`'error'` 仅存量）/ `source` = context 行的 UI 决策词（`'event'`/`'error'`/`'skill'`/开放）/ `label` = UI 文案（缺省按 source 回落）。
- **会话三文件分工**（`<root>/sessions/<conversationId>/`）：`messages.jsonl` 定稿流（append-only）/ `partials.jsonl` run 台账（收束即清）/ `subcalls.jsonl` 子调用永久档案。
- **技能注入三通道**：① 手势 `/name`（before-run 判定 + 落账 + 同字节双写）；② 直调 load_skill；③ run_code 子调用（登记 → run 级驻留注入 → 落账 → after-run 兜底）。
- **load_skill 返回值已轻量化**：`SkillLoadOutput = { name, scope, baseDir, status: 'injected' }`——正文不随返回值走（防"返回一份 + 注入一份"双份冗余与搬运诱饵）。
- **UI**：context 注入行渲染为注入卡（`ContextInjectCard.vue`），数据层挂轮（`Turn.injects` / `afterStep`），不走 event 分隔符通道。
- **数据版本迁移**：执行器 `ac-migration-core`，会话迁移集现为 **v1–v6**（§7），版本标记 `data/meta.json { dataVersion }`。

## 2. 问题链（历史起点，2026-09-18）

1. **load_skill 程序化模式失效**：工具描述「加载后按其指令执行」在传统模式成立（ToolResult 直接入对话历史），在 run_code 程序内子调用不成立——结果只留程序作用域，且 run_code 注入纪律要求「读文件/搜索结果取摘要不回传全文」，模型丢弃返回值 = 技能从未加载（当时首轮实测复现）。
2. **瞬态手势注入的 KV 账**：`/name` 手势注入当时是 run 内瞬态（`gestureServed` 账本按 run 翻页），每 run 重新服务 → 技能正文每 run 尾部重现、永不进入可复用前缀——每 run 全价重付；run 内每步尾部重注则每步 KV 重算（不影响计费，影响 TTFT）。
3. **结论**：注入必须持久化到会话历史（成为前缀的一部分），一次落账、跨 run 永久回放。

## 3. 注入三通道（裁决 #1 → 现状）

**前提（已实施）**：load_skill **不再返回技能正文**，返回轻量确认 `{ name, scope, baseDir, status: 'injected' }`（契约见 `src/ac-skill/src/index.ts` `SkillLoadOutput`）。程序内分析 SKILL.md 改走 read（baseDir 在返回值）。

| 路径 | 当前 run 内 | 跨 run 持久化 |
|---|---|---|
| 手势 `/name` | before-run 判定「当前触发消息」→ `recordContext` 落账（`source:'skill'`）+ **同字节 append 进 request.messages**（双写同源，当前 run 首步即可见） | 落账 context 行经 `history()` 永久回放 |
| 直调 load_skill | **无后置注入/落账钩子**——run 行 steps 只带轻量回执（现状核实，见下方"口径偏差"） | 同左（无新机制） |
| run_code 子调用 load_skill | tool/after-execute 登记 `subcallPending`（跨 run 去重：历史 context 行在场则不登记）→ `loop/before-step` 首见：`injectDurable` **run 级驻留注入**（进 execute 工作数组一次，后续步自然继承）+ `recordContext` 落账 | context 行永久回放；`loop/after-run` 兜底补落（本 run 无下一步/中断时，指纹未落过即补） |

**手势判定收窄（显式签收的行为变更）**：只判 before-run 时的「当前触发消息」= 尾部连续 user 块（已服务者与后续消息之间有 context/reply 行天然分界）；历史手势消息不二次判定；同名技能已在历史 context 行 → 跳过（不追加尾部 = 不动前缀，KV 与 token 双优）。`gestureServed` 账本**整个退役**（注入体持久在场即天然去重）。

**落账时序**：手势 = pre-run（run 行之前落账，防正文随会话增长漂移远离手势消息）；run_code 子调用 = **注入时刻**（before-step 指纹变化才落新行，落位 = 正文进入消息数组的位置）；after-run 兜底在 run 收束后直落（split 语义由 session 内部路由，调用面参数保留兼容）。

**运行期驻留要点**（2026-09-21 裁决 / 子调用通道 2026-09-22 定稿）：注入体经 `injectDurable`（loop 服务新通道，SteerQueue durable 槽，步边界 splice 进工作数组）。`step()` 内 before-step waterfall 返回后**本步立即消费**（双写 stepCall.messages + 工作数组）——否则注入体晚一步可见，模型会在 reasoning 里困惑"正文到底在不在"并浪费一次核查推理（实测修正）。不参与 steer 的 sealed 丢弃语义（run 收束后到达 = 无消费点静默不入，持久性由 context 行落账承担）。

**口径偏差（本次核实发现，待后续裁决）**：原档案 §1 表「直调 load_skill：run 行 steps 携带结果，replayTrajectory 缺省展开即正文在场」的说法，在返回值瘦身之后**已不成立**——返回值只有轻量回执，steps 回放不含正文；而 after-execute 钩子显式要求 `call.runCodeSubcall === true` 才登记（直调直接 return）。源码注释（`loadSkill` 函数体）与工具描述「正文由注入机制随后进入上下文」仍按旧口径措辞。**按源码为准记录现状**：经典模式下直调 load_skill 不落账、不注入，正文进场由手势通道或程序内 read(baseDir) 承担；此为文档↔代码注释口径不一致点，交后续裁决（未在本次治理中改代码）。

## 4. 存储词汇 v2：role / source / label 三轴（裁决 #2 → 现状）

**裁决前的现状**：role 载语义类别（agent/event/error），存储 source 是 role 的 1:1 复读（`event⇔event`、`error⇔error`，全仓无第三取值、零消费者）——判死刑后改判正名。v2 三轴正交：

- **role = 消费通道（封闭词汇）**：`agent`（真实发言，`agent_id` 归属）/ `context`（上下文材料——LLM 回放 user 语义位，UI 按呈现）；`event`/`error` 退役，由 context + source 表达；`system`/`tool` 预留不变（`user`/`assistant` 仅 baked 存量读兼容）。
- **source = UI 决策词（开放词汇）**：`'event'`（机制行 → 分隔符）/ `'error'`（红色语义）/ `'skill'`（技能注入 → label 条）/ 未来按需。
- **label = UI 文案（可选）**：缺省按 source 回落（后台事件/运行错误）。

```
{role:context, source:event}              ← LLM 回放 + UI 分隔符
{role:context, source:error}              ← LLM 回放 + UI 红色语义
{role:context, source:skill, label:...}   ← LLM 回放 + UI label 条（点击展开正文）
```

**消费方（现状实测）**：

- `projectRecord`：`context`（以及存量 `event`/`error`）→ 恒 user 语义位（**source 无关**）；未迁移/未知词表行按 user 喂回（防御兜底，语义等价）；`agent` 行按 `agent_id===viewer` 判自他（assistant/user）。
- journal 折叠：`context + source:'event'`（含存量 `event` 词）组合判定——技能行（`source:'skill'`）**不折**（正文折叠即语义丢失）；折叠范围还按 `agent_id === viewer` 视点过滤（机制行带投递目标，对端不重复计入）。
- hint 视点过滤：context/机制行按 `agent_id` 过滤【行为变更：旧 error 行读者无关 → 现按视点过滤，共享桶对端不再看到对方 run 的错误行】。
- 服务侧活投影（journal → UI）：`'agent'`（steer 等真实发言）或 `'context'` + source/label；前端 `ChatMessage` 词汇仍保留 `event`/`error`（与 `agentchat/protocol` 对齐），注入卡以 `context`/`source` 判别并读 `contextContent` 展开正文。
- 落盘行词汇（`SessionRecordRole`）= `agent | context | system | tool | error | event`（后两词仅存量读兼容；迁移 M-role-v2 改写后绝迹）；`KNOWN_ROLES` 另收 `user`/`assistant`（baked 旧文件宽容解析）。

**教训（写入词汇表纪律）**：新词汇必须带着消费者出生。source v1 是「先造字段后找用途」的反例；v2 的 source/label 自带 UI 决策与文案职责。

## 5. 三文件分工与 run journal（现状）

```
messages.jsonl = 会话定稿流（header/user/agent/context 段行/run-settled，append-only；run 期间静默）
partials.jsonl = run journal（瞬态台账：journal-step 步行 / journal-inject 注入行 / tool-result 直调补行；行序 = 模型消息数组实际序；收束即清）
subcalls.jsonl = run_code 子调用永久档案（UI 回放数据源，不清理——与 journal 生命周期相反）
```

**settlement（收束物化，loop 事件 reply-completed，全终态含 error/interrupted）两阶段**：① 同步入队（事件段内构造提升批——段行 + 注入行 + `run-settled` 判别行；行序锚定，先于后续入站消息）+ 异步 durable flush；② journal 剔除（按行身份 `type|run|seq` / `tool_call_id`）。崩溃窗口（①后②前）由 `recoverJournal` 惰性幂等收口（`records()` / `run-started` 触发；有收束行 → 直接剔除；孤儿 run → 投影为中断形态再剔除；本进程 activeRuns 在册者排除）。

**关键裁决细则（现行）**：

- **切段规则（KV 友好）**：注入行是切分点——`[段行(steps), 注入行, 段行(steps), …, 终文本]` 自然序物化；无注入 = 整 run 单行直落（steps 以 result 为权威源 `stepsFromRunResult`；result 无步的中断/孤儿用 journal 步行回退）。
- **全行 run 键**：提升批成员（段行/注入行/run-settled）统一携带 run 键 = 「本行产生于该 run 周期」；settled 判定与读侧 `absorbedRuns` 均按【同 run 非 partial 行存在性】判定（无单点锚）。**纪律：run 外行（入站/群 post/直落行）不硬造 run**——假 settled 会污染恢复对账。
- **`run-settled` 判别行**：提升批尾的轻量提交标记（`type + run + seq`）——显式原子提交点 + 批截断诊断信号；恢复判定不单点依赖它；旧版本读到安全忽略（前向兼容）；统计/RPC 计数面排除（无 role 行）。事件面另有 `session/run-settled`（settlement durable 后 emit，前端事件驱动重拉）。
- **注入行 ts 快照**：`journal-inject` 落 journal 时快照注入时刻（`ts`），settlement 提升行还原为 timestamp——修复"注入行 ts = 落账时刻导致前端步级排序把注入排到队尾"的错序。
- **`records()` 活投影保留**：未收束 run 的 journal 行在读侧重现（步行 → partial 行、注入行 → context/agent 行），`ask_questions` 等待期刷新不丢思维链。
- **读侧**：`absorbedRuns` 吸收排除 injected 行（注入行是独立会话事实，永不被吸收/去重）；`echoSeq`/run 吸收归位仅剩存量文件兼容价值（稳态零合并逻辑）。
- **reasoning 单份存储**：正源 = `steps[].reasoning`（步级粒度，UI 步级 thinking 卡直读）；独立收束行的 `reasoning_content` 不落盘（整轮视图由前端投影拼接；适配层请求体无此键，存储纯服务 UI）。膨胀 ~40% 消除。

## 6. 裁决链：被取代的方案（历史裁决，勿顺手恢复）

| 方案 | 裁决 | 结局与原因 |
|---|---|---|
| 变体甲：注入行纯 steps 内嵌 | 2026-09-18 | **否决**——丢 durable（steer 挂内存，进程死即丢，违背 send_agent 教训） |
| 变体乙：写侧 run 切分（关闭行 + 新铸 run 键 + offset 切片） | 2026-09-18 追加裁决 → **2026-09-21 退役** | 给 append-only 文件强加「中途保序」语义，关闭行/新 run 键/切片/pendingCalls 继承全是为它服务的簿记，任何时序缝隙即丢行/错位；改为「写侧如实按序记，保序收敛到收束时刻」 |
| 独立收束行（终稿行） | 2026-09-21 二次裁决 **退役**（journal 路径） | 四职责（吸收锚/终文本载体/settled 判定锚/无 journal 整行落账）中只剩对账锚是真需求，且由「全行 run 键」更优承载；终文本回落尾段末步（消除双份）。无切分形态仍保留整 run 单行直落 |
| partials 摘除（partials = 关闭行终值覆盖源，不进清理面） | 2026-09-20 落地 → **2026-09-21 被泛化取代** | 泛化为 run journal：partials.jsonl = 瞬态台账**收束即清**（原「终值档案如实保留 + vacuum 退役」的定位被改写；主文件零死重的结论保留） |
| 每步重现注入（before-step 每步尾部重注技能正文） | 2026-09-21 | **退役**——旧论证「每步重现字节稳定、KV 前缀不击穿」是错的：KV 严格前缀匹配，注入体在每次请求尾部（分叉点之后）→ 等于每步重算整块正文（实测 11KB 技能 ≈5K tokens/步 × 6 步 ≈ 3 万 tokens 浪费）；改 `injectDurable` run 级驻留 |
| 存储 source v1（role 的 1:1 复读字段） | 2026-09-18 | 判死刑后改判**正名**为 v2 的 source（UI 决策词）+ 新增 label；role 改为消费通道 |
| reasoning 双份存储（步级 + 收束行全文） | 2026-09-20 二次反转（用户拍板） | 正源收敛为 `steps[].reasoning`，收束行 `reasoning_content` 不落盘 |
| `gestureServed` 账本（按 run 翻页服务手势） | 2026-09-18 | **退役**——落账 context 行在场即天然去重 |
| 信封 source（`LoopSource` = 'user' / 'agent' / 'event'） | 不动 | 运行时拓扑，与存储 source 同词不同义，按所在对象区分 |
| vacuum（主文件死重物理剔除） | 2026-09-21 | 主文件零死重后无清理对象，整个退役（少一个原子重写路径） |

## 7. 数据版本迁移机制（当前 v1–v6）

- **位置**：`src/ac-app/src/boot.ts`（运行锁后、行装载前）——迁移是顺序敏感的启动逻辑，行激活序（PENDING 等依赖）无法保证先于 session 首写，故非行、非服务。
- **形态**：纯库 `ac-migration-core`（迁移注册表 + 执行器：按序应用 / 幂等 / 断点续跑）+ 会话迁移体 `src/ac-session/src/migrations.ts`。
- **版本标记**：`data/meta.json { dataVersion }`（首启从 `.initialized` 推断 v0）；未来版本告警（降级运行检测）。
- **安全网**：迁移前经 ac-backup-core 直调打快照（`backups/migrations/`——与常规备份轮转隔离）。
- **失败语义**：任一迁移失败 = 拒绝启动；meta.json 原子写，每迁移完成即落版本。
- **红线声明**：append-only 会话历史可被「版本升级迁移」重写——显式例外，仅此一条通道；迁移前快照强制，不可跳过。

| 版本 | id | 内容 |
|---|---|---|
| v1 | `role-v2-subcall-split` | 同一 pass 每文件读一次写一次：`event → context+source:event`、`error → context+source:error`；主文件 `\"subcall\":true` 行剥离 → `subcalls.jsonl`（行序保持、seq 目标文件末行续起） |
| v2 | `partials-split` | 主文件 partial 步行 + 直调补行 → `partials.jsonl`（三文件裁决） |
| v3 | `subagents-dir` | 子 Agent 会话目录整理 |
| v4 | `partial-rematerialize-purge` | 重新物化遗留形态清理 |
| v5 | `legacy-journal-purge` | partials.jsonl 内旧形态行（无 type 字段）按「run 已定稿」剔除——v2 拆分到 journal 泛化之间的夹缝窗口写入行：行身份解析恒 undefined（宁重不丢 → 永久保留）而读侧仍按 run 活投，死数据无限累积 |
| v6 | `stale-partial-purge`（cr-44，2026-09-29） | 陈年（>7 天）未收束 partial 行物理清除（阈值/判定 `isStalePartial` 与读侧闸门同源）——09-25 双进程并发写丢收束行事故：孤儿行被读侧活投为「中断恢复源」喂幻觉 |

## 8. UI 形态（context 注入卡）

- **原裁决**：label 条（收起态）+ 点击展开正文（max-height ~40vh + 滚动）。中间态（v2 落地时缩水）：渲染为 event 分隔行、正文在前端即丢弃、不可展开。
- **2026-09-26 注入卡修订（挂轮形态）**：注入型 context 行（source 非机制词）渲染为工具卡样式的注入卡（`ContextInjectCard.vue`）——label 收起行 + 展开体（注入体原文纯文本，`--card-viewport-max` 统一限高令牌 ≈40vh 裁决落位）。
- **挂轮不占位（数据层归位）**：`buildTurns` 把注入卡挂进**注入时刻在场的 agent 轮**（`Turn.injects`，`afterStep` = 已积步数——mid-run 注入原位落在两步之间还原落盘序；`cur` 为空 / viewer 轮 → 暂存挂下一 agent 轮头部；无轮可挂 → system 空轮降级承载，渲染层转独立卡 item）。**为什么不走渲染层缝合**：注入行此前走 event 分隔符通道会在 buildTurns 被 flush 拆轮——同一个 run 拆成两个"思考过程"轮、折叠态割裂（2026-09-26 流式实测反馈）；数据层不拆轮则流式/刷新一致、折叠态天然联动，Subagent 视图等经共享管线自动继承。`turnContentSig` 覆盖 injects（防增量复用漏判）。
- **机制行（source:event）与错误行（source:error）** 维持原分隔符 / 红条通道不变。
- **正文贯通**：`toHistoryMessages` 对注入型行携带 `contextContent`（展示期不再丢弃）；直播帧维持不广播正文（瘦身纪律），settlement 重拉权威行补——窗口期注入卡仅收起态（不可展开）。

## 9. 行为变更清单（显式签收）

1. 手势 mid-run steer 进来的消息不再被服务（判定收窄为 run 触发消息；边缘场景由下轮 run 或技能菜单补）。
2. 手势未命中（技能尚不存在）不再补偿（一次性判定；旧「不销账保留中途创建技能被拾起」语义退役）。
3. 手势跨 run 重新服务 → 一次性服务（去重依据 = 历史 context 行在场）。
4. error 行读者无关 → hint 视点过滤（共享桶对端不再看到对方的 run 错误行）。
5. load_skill 返回值瘦身：`content` 删除（`SkillLoadOutput` 契约变更；消费面查证：仅 webui 工具标签取 name 渲染，无 content 依赖）。
6. read 回落：程序内分析 SKILL.md 改走 read（baseDir 在返回值）。
7. 技能注入 = run 级驻留（每步重现退役）：模型每步不再收到重复正文提醒（"Agent 表示收到"的行为噪音消除），注入点进前缀、后续步全量命中。
8. 注入行 timestamp = 注入时刻（非 settlement 铸造时刻）：前端步级稳定排序不再把终稿步排到用户追问之前。

## 10. 不做与遗留

- **直调 load_skill 的注入口径**：见 §3"口径偏差"——现状无后置注入/落账钩子，源码注释与工具描述仍按旧口径措辞；待后续裁决（本次治理只改文档，不动代码）。
- 信封 source（`LoopSource`）不动——运行时拓扑，与存储 source 同词不同义。
- subagent 会话桶内的注入同 run_code 通道（会话隔离天然覆盖，无额外改动）。
- source 供给侧细分（timer/job/goal-round 真语义标注）不预铺——消费者出生再扩。
- 跨 run 同名技能重复落账的去重由「历史 context 行在场跳过」规则覆盖（登记时判定）。
- 旧形态数据（收束行形态/无 type 的 partial 行）读侧兼容与 v5/v6 清理各按自身口径处理，不新增机制。

## 11. 定位索引（改前必查）

| 想看/想改 | 去 |
|---|---|
| 会话存储/词汇/三文件/journal/settlement/迁移体 | `src/ac-session/src/index.ts`（词汇与文件约定在文件头注释）、`src/ac-session/src/migrations.ts`、`src/ac-session/src/events.ts` |
| 迁移执行器（注册表/幂等/快照） | `src/ac-migration-core/src/index.ts`；调用段 `src/ac-app/src/boot.ts` |
| 技能注入三通道 / load_skill / 手势判定 / 驻留注入 | `src/ac-skill/src/index.ts`（before-run / tool:after-execute / loop:before-step / loop:after-run 四段） |
| 驻留注入通道（injectDurable / SteerQueue durable 槽） | `src/ac-agent-loop/src/service.ts` |
| run_code 子调用标记 | `src/ac-run-code/src/tool.ts`（`runCodeSubcall: true`）；子调用档案分流 `src/ac-session/src/index.ts` |
| 注入卡与挂轮 | `src/ac-client-ui-conversation/client/Message/ContextInjectCard.vue`、`TurnDisplayItem.vue`、`feed.ts`（buildTurns/`turnContentSig`）、`types.ts`（`Turn.injects`） |
| 相关测试 | `src/ac-session/tests/`（journal-recover / journal-replay-order / insert-split / steer-split / partial-rematerialize / stale-partial-gate / records-cache 等）、`src/ac-skill/tests/skill.test.ts`、`src/ac-client-ui-conversation/tests/inject-card.test.ts` |
