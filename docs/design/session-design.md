# AgentChat Session 设计（域设计事实源）

> **定位**：Session 域的现行设计事实源——设计理念、消息定义（存储词汇 v2）、落盘格式（三文件分工）、
> 三种会话形态（Agent 对会话 / 独立会话 / 群组会话）、消息链路与收敛协议、Run 生命周期、KV 缓存分析，
> 以及**裁决链**（被取代的旧方案保留结论与裁决过程，勿按历史文本动手）。
>
> **事实源优先级**：`src/README.md`（轨道事实源）> 各包源码 > 本文。本文与源码冲突时改本文；
> 与 README 的链路事实冲突时以 README 为准、以本文的设计裁决为纲。
>
> **文档级裁决链**（本文自身的历史，逐条注明取代关系）：
> - 由 `m21-replay-prefix-cache-plan.md`（回放重构规划：实证档案 + 分阶段步骤 + 决策点 D1-D7）**重写**而成——
>   M21 是本文的落地计划与实证档案（2026-08-27 实测基线在彼），已归档至仓库外归档根，内容冻结。
> - 原稿写作于 `preview/` 轨道时期；「preview」即现 `src/` 轨道（2026-08-31 整体部署原地保留历史，见 `src/README.md` 轨道历史）。
> - 2026-08-27 裁决 ①：落盘采用 **src 中性语义**（`role: agent|system|tool|error|event` + `agent_id`）——取代初版「维持 baked 格式」取舍；
>   ② **轨迹回放开关**做成布尔两态（`settings.session.replayTrajectory`），K 截断档否决——取代 M21 D7「不实装」。
> - 2026-09-02~09-18：**存储词汇 v2**（role/source/label 三轴）——`error`/`event` 从一等 role 降为 `context` 行的 `source` 取值；
>   裁决链与迁移规范住 `skill-injection-and-storage-vocab.md`（本文 §2 依其收口）。
> - 2026-09-20：**partials 摘除**（三文件裁决）——`messages/partials/subcalls` 分工定型，vacuum 退役（§3.2）。
> - 2026-09-23：**视图增量层退役**——事件驱动增量投影退回「每 run 无条件从文件重派生」（§4.2）。
> - 2026-09-27 cr-4：**记忆归人格单时间线**（记忆内容出 system、走会话流 context 行）；**群聊派生视图改成员私有转录流**，
>   memoryOwner 全链与派生窗全族退役（§4.4 / §6）。
> - 2026-10-01/02 cr-94/95/106/107：**消息链路根修**——D1 收敛协议实施（§7.2）、D2 读投影单源化（§7.3）、
>   前端收敛 checkpoint 身份门/空载门 + B/C（§7.4 / §8）。
> - 2026-10-05 cr-231~251：KV 缓存率观测面上线（会话级走势图，步粒度），见 §9.4。
> - 2026-10-06 文档治理：`message-pipeline-analysis.md`（cr-87 双管线根因分析，其 D1/D2 方向均已实施）
>   有效结论压缩并入 §7，原文件归档 `src/docs/archive/`；`run-lifecycle-checkpoints.md` 保留独立（§8 引用其全景图）。
> - 双参照系：DSH `dsh-kv-cache-analysis.md`（前缀稳定纪律）+ `dsh-session-storage-format.md`（事件溯源落盘格式）。
>
> **状态标注约定**：正文描述**现状**（与源码同拍）；【设计】= 目标形态未落地；【已落地】= 与源码一致；
> 被取代的旧方案不删除，集中住 §10 裁决链表并标注裁决沿革。
>
> **规约**（跨域读写纪律）：规约 1 = `ac-session` 是会话文件的 owning service，跨域读写一律走服务方法；
> 规约 2 = 一切会话态按 `conversationId` 寻址，文件叶子目录名即键，零前缀/排序魔法；
> 规约 3 = 机制任务直调服务或 `sender='event'` 信封，痕迹自然进会话流。

---

## 1. 设计理念

Session 域回答一个问题：**一段对话的「事实」存在哪里，各参与者看到的「历史」从哪里来，每一步 LLM 请求的前缀如何保持字节稳定。** 五条支柱：

**S1 事件是真理，消息是投影。**
会话文件（append-only jsonl）是唯一事实源；一切「历史」——UI 回放、LLM 上下文、审计、统计——都是从文件的**确定性派生投影**。
LLM 上下文每 run 从文件重派生（2026-09-23 视图增量层退役：事件驱动的增量投影曾两次漂移——终稿 vs 轨迹、error 收束丢轨迹——
手写投影追不平文件投影是结构性双事实源，退役）。没有平行的「持久化消息类型」：写下去的行就是全部对话事实。

**S2 视角正确性：存储记话语事实，角色由回放按读者赋予。**
落盘行是**读者无关的中性事实**（词汇 v2，§2.2）：`role` 记消费通道（一切真实发言 = `agent`），`agent_id` 记说话人端点。
任何读者回放同一桶时由投影赋予角色：`agent_id === viewer → assistant`，其余 → `user`。
role 是 chat 模型最强的身份条件，视角错乱直接污染第一人称连续性——存储层永不烘死视角（写入侧不猜读者是谁）。

**S3 字节等价：进程内上下文 ≡ 文件派生（由构造保证）。**
同一读者、同一桶，进程内每 run 派生的上下文与重启后从文件重派生的视图**逐字节一致**——因为它们走**同一条派生路径**
（`session.history` → `records()` → 文件），不存在第二套投影代码。历史上增量视图时代此等价靠 golden 对拍两套实现维持，
两次漂移事故（2026-09-05 / 2026-09-23）证明不可靠；现等价由构造成立，对拍退化为回归锁定。

**S4 前缀稳定是一等架构约束。**
KV 缓存命中本身不是目标函数——**成本与 TTFT 才是**。每个 LLM 请求的前缀 = `[system][tool schema][history]`；
理想不变量是**每步请求 = 上一步的字节级前缀 + 纯追加后缀**，服务端自动前缀缓存除尾部全命中。
任何回放/注入相关代码必须能回答「我对请求前缀做了什么」（KV Cache effect 声明纪律：None / Append-only / Prefix-stable / invalidate-from-X）。

**S5 显式 replace：唯一的前缀破坏者。**
归档（对桶/独立）、群本体轮转、快照重拍（独立会话 system 前缀）、版本升级迁移是仅有的允许改变前缀的操作：
显式、低频、可审计，且触发视图重派生。除此之外一切对会话流的操作都是追加。

会话形态总览（一切按 `conversationId` 寻址，三种键形态）：

| 形态 | conversationId | 读者 | 事实源 |
|---|---|---|---|
| Agent 对会话 | `pairKey(a, b)`（`[a,b].sort().join('~')`）：直答 `viewer~agent`、委托 `a~b`、自会话 `a~a`（对角线，机制触发） | 桶内每个真实 Agent 各自独立 | `<root>/sessions/<convId>/messages.jsonl` |
| 独立会话 | `sid`（singles 名册消歧） | 引用的单个 Agent（会话级可换） | 同上（上架到 `sessions/singles/<ws|ungrouped>/<sid>/`） |
| 群组会话 | `gid`（禁 `~`） | 本体 = 真实发言流；每个成员另有**成员私有转录流** `gid~member` | 本体 `<root>/sessions/groups/<gid>/messages.jsonl`（仅真实发言）+ 成员流 `<root>/sessions/<gid>~<member>/`（§6.1） |

---

## 2. 消息定义（现状）

四层词汇，各司其职：

```
LlmMessage        传输/回放层（ac-llm owning）：进 provider 请求与 history 的形状
SessionRecord     持久层（ac-session owning）：messages.jsonl 的一行
SessionStepRecord 持久层内嵌：agent（回复）行的 ReAct 步记录
判别行（type 键）  持久层内嵌：非消息行——session-header / journal-step / journal-inject / tool-result / run-settled
```

### 2.1 LlmMessage（ac-llm owning）

`{ role, content, name?, tool_call_id?, attachments? }`，role ∈ `system | user | assistant | tool`。
`name` 是可选的说话人标注——回放产物带 `name`（由存储行 `agent_id` 投影而来，§2.6，**由回放层统一保证，不依赖调用方记得带**）。
`attachments`（image/video/file 引用）随行回放，base64 物化收敛在 provider 适配层。

### 2.2 SessionRecord（持久行）

**存储词汇 v2 三轴**（2026-09-18 收口，取代中性格式 v1 的「role 载语义类别 + source 复读」写法；规范出处 `skill-injection-and-storage-vocab.md` §2）：

- **`role` = 消费通道（封闭词汇，读者无关）**：`agent`（真实发言）/ `context`（上下文材料——LLM 回放 user 语义位，UI 按 source/label 呈现）；
  `system`/`tool` 预留（概要经 `summary.md`、轨迹展开是回放投影非存储）；`event`/`error` 为**存量旧词**（读侧回放等价，迁移后绝迹）；
  `user`/`assistant` 为旧 baked 格式兼容词（无头文件宽容读，§2.7）。
- **`source`（context 行携带）= UI 决策词（开放词汇）**：`event`（分隔符）/ `error`（红色语义）/ `skill`（技能注入 label 条）等。
- **`label`（可选）= UI 文案**，缺省按 `source` 回落（后台事件 / 运行错误）。

| 字段 | 语义 | 备注 |
|---|---|---|
| `role` | `'agent' \| 'context' \| 'system' \| 'tool' \| 'error' \| 'event' \| 'user' \| 'assistant'` | 消费通道（词汇 v2 三轴，见上） |
| `agent_id?` | 说话人端点 id | **完备归属标记**（`agent` 行必有；viewer/人类/Agent 端点同词汇——端点对等贯穿到存储层）；取代旧 `name` |
| `name?` | 旧 baked 格式说话人标注 | 仅读取兼容，新写不再产生 |
| `content` | 正文 | 工具参数/结果存原始 JSON 串（不二次编码） |
| `message_id` | 幂等固化 id（`msg-<ts>-<rand>`） | 同一消息对象重复入队产出同一 id 行；归档二次去重锚 |
| `timestamp` | ISO 时间 | 热力窗/审计数据源 |
| `source` / `label` | context 行的呈现决策词与文案 | 见三轴 |
| `reasoning_content?` | 整轮思维链（各步 reasoning 拼接） | `agent`（回复）行；刷新后恢复折叠栏 |
| `steps?` | `SessionStepRecord[]` | `agent`（回复）行；持久层全量落账，跨 run 回放经 `session.replayTrajectory` 开关按投影展开（§2.6） |
| `seq?` | 文件内单调序号 | writer 按文件分配；崩溃/丢行检测 + 归档二次去重序号锚 |
| `partial?` | 步级部分行标记 | run 进行中已完工具步的 checkpoint（结果未回）；结果到达由 `tool-result` 补行覆盖（§3.2） |
| `echoSeq?` | 归位锚（partials 行专用） | 落盘时刻主文件队列序；读侧合并按此归位（同毫秒 timestamp 歧义免疫） |
| `run?` | run 关联键 | 切段后同 run 可有多条段行（注入行是切分点） |
| `injected?` | journal 提升行标记 | 读侧合并把 journal 注入行排除在吸收对账外（注入行永不被吸收/去重） |
| `attachments?` | 多模态附件引用 | 只存引用（几十字节），UI 刷新后恢复附件 chips |

### 2.3 判别行（type 键：非消息行，同 `session-header` 机制）

writer/读侧以 `"type":"…"` 前缀判定，避免全量 JSON.parse；旧版本读到未知 type → 安全忽略（前向兼容）。

| 判别行 | 落点 | 语义 |
|---|---|---|
| `session-header` | `messages.jsonl` 首行 | `{type, version:1, createdAt}`——**version:1 即中性格式**（词汇 v2 是读侧词表扩展，不升版本号）；无头文件 = 旧 baked 格式宽容读 |
| `journal-step` | `partials.jsonl` | 一个已完成的步（工具步 result:null 由补行携带；`agentId` 为活投影归属源）——行序 = 模型消息数组实际序 |
| `journal-inject` | `partials.jsonl` | 注入消息按**消费点真序**落（steer / 事件 / 技能 context）；`ts` 快照注入时刻，settlement 提升时还原 |
| `tool-result` | `subcalls.jsonl`（subcall）/ `partials.jsonl`（模型直调补行） | 工具终值补记；读侧按 `(run, tool_call_id)` 覆盖到 `result:null` 的部分行/关闭行 |
| `run-settled` | `messages.jsonl`（提升批成员） | settlement 提升批的原子提交点：在场 = 本批完整落盘（恢复判定不单点依赖它）；同时是 `session/run-settled` 事件的落账面（§7.2） |
| `steer-stash` | `<root>/conversation/steer-stash-*.jsonl` | busy steer stash 即落盘（fsync，cr-250 durable steer）；消费/drop/兜底三清理点剔行，启动恢复重投 |

### 2.4 SessionStepRecord（`agent` 行的 steps[] 成员）

`{ id?, name?, arguments: 原始 JSON 串, result: ToolResult | null, content?, reasoning?/thinking? 等 }`——每步含正文/思考与工具调用对。
`history()` 的 LLM 回放只在 `replayTrajectory=true` 且 `agent_id === viewer` 时消费本字段（§2.6）；records/UI 展示始终消费。

### 2.5 入账规则（谁写什么行）

`source`（信封触发来源）是唯一的类别判据，忙（`conversation/steered`）/闲（`router/message-received`）两条入账路径同形：

| 投递形态 | 落盘行 | 说明 |
|---|---|---|
| 真实发言（入站 / 回复 / steer 注入 / 私信） | `role:'agent'` + `agent_id=说话人端点` | 视角无关；回复附 `reasoning_content` 与 `steps[]`；中断/空回复不入账 |
| 机制触发（`source='event'`） | `role:'context'` + `source:'event'` + `agent_id=目标自身` | UI 渲染事件分隔符；LLM 回放按 user 喂回；**hint 视点过滤**：投递目标非 viewer 的 context 行不进该读者回放 |
| 技能/材料注入 | `role:'context'` + `source:'skill'` 等 + `label` | 正文即语义（不折叠）；落位 = 正文进入消息数组的位置（§6 注） |
| run 错误收束（`finish='error'`） | `role:'context'` + `source:'error'` | v2 前是 `role:'error'` 一等行（D12，见 §10）；LLM 回放按 **user** 喂回（不采纳 src 的 `error→tool` 映射——无 tool_call_id 配对的 tool 行有被拒风险） |
| 机制标记 run（`meta[ARCHIVE_REVIEW_META]` / `GROUP_HINT_META`） | **不入账** | 机制产物非会话事实（三消费方：session 不入账 / usage 不记账 / conversation 不进视图） |

### 2.6 回放投影（视角变换，纯函数 `projectRecord`）

存储中性（role 记消费通道、agent_id 记归属）⇒ **角色完全由回放投影赋予**——变换不是「纠正」写入视角，而是从头构建读者视角，对任何桶形态统一：

`session.history(conversationId, { viewer })` —— viewer 是**读者端点 id**（回 Agent 的那个 Agent；审计/原始行走 `records()`）：

```
role='agent' && agent_id === viewer  → assistant  （我自己说的话）
role='agent' && 其他                 → user       （别人说的，无论对方是谁）
role='context' | 'event' | 'error'   → user       （机制提示/错误的 LLM 语义位，source 无关）
role='system'                        → system     （直通，不参与变换）
产物行 = { role, content, name: agent_id, attachments? }（wire 形；name 供多方会话说话人区分与 UI 渲染——确定性派生，不影响前缀稳定）
```

投影管线的其余现状（全在 `history()` 内，读侧单源）：

- **viewer 缺省 = 匿名读者**：中性行一律 user（无法判定自他，审计/矩阵只读视角用）；旧 baked 行按原 role 直通。
- **轨迹展开（`replayTrajectory`）**：`true`（**缺省**，2026-09-03 缺省翻转——质量优先；原缺省 false 是成本优先取舍，文档旧稿误记为 2026-09-23，以源码/测试头注为准）时，
  仅 `agent_id === viewer` 的回复行按 `steps[]` 全量物化（每步 assistant(tool_calls?) + 配对 tool 行 → 终 assistant(content)；reasoning 不回传，M4）；
  `false` = 对话级（工具中间态只服务 UI 展示与审计）。翻转 = 该会话回放形状的**显式 replace**（一次性全量失效）。
- **事件行折叠（`settings.session.eventReplay='journal'`）**：仅对角线自会话桶（`conversationId = viewer~viewer`）把旧 context+source:'event' 行折叠为一条计数摘要，
  保留最近 `eventJournalKeep`（缺省 6）条原文——治定时器自唤醒导致的机制行无限堆积（存量 records/UI 不动，只作用于 LLM 回放）。
- **部分行回放闸门**：run 未收束残留的 partial 行，工具结果补记齐全则视同普通 steps 行回放（中断 run 已见前缀**字节保真**，provider KV 命中 + 完成步记忆）；
  不齐（工具执行中进程死亡）→ 跳过（悬空 tool_calls 破坏 provider 消息序）；陈年 partial 由 `migrations.ts` 同源闸门判定（cr-44）。
- **空 content 的 agent 行**（内容全在 steps：中断/max-steps 收束）在无轨迹展开时跳过——回放层面与「不入账」语义一致。
- **回放对账**（2026-09-20 断网事故复盘）：run 首轮采基线，`history()` 相对基线骤缩/为空即告警（历史丢失信号，按会话 10 分钟去重）。

**兼容路径（迁移期）**：无 `agent_id` 的旧 baked 行按 `name===viewer→assistant`、其余→user、event→user 变换——user⇄x 直答桶保持零回归；assistant 行缺 name 时归属回落 conversationId（singles 旧行）。

### 2.7 版本治理与迁移

- **版本锚点**：`data/meta.json` 的 `dataVersion`（首启从 `.initialized` 推断 v0）；文件级锚点 = `session-header version:1`。
- **迁移集 v1**（纯库 `ac-migration-core`：注册表 + 执行器，按序/幂等/断点续跑；位置 = `ac-app/boot.ts` 运行锁后、行装载前；
  失败即拒绝启动；迁移前经 `ac-backup-core` 直调强制打快照——**append-only 历史的唯一重写通道，仅此一条**）：
  - `M-role-v2`：`event → context+source:event`、`error → context+source:error`；
  - `M-subcall`：主文件 `"subcall":true` 的 tool-result 行剥离 → 同目录 `subcalls.jsonl`（行序保持、seq 续起）；
  - `M-partials-split`：主文件 partial 行 + 模型直调补行 → `partials.jsonl`。
- 未知 `version` 留 fail-loud 口子（宁可拒绝也不误读），无头文件按宽容读（个人数据宁可部分可用）。

---

## 3. 落盘格式

### 3.1 目录布局（数据根 = 启动文件夹，`AGENTCHAT_DATA_ROOT`）

```
<root>/
├── sessions/<conversationId>/messages.jsonl   会话定稿流（append-only 唯一事实源）
│                             partials.jsonl   run 中间态（步行/注入行/直调补行——收束即清）
│                             subcalls.jsonl   run_code 子调用永久档案（不清理）
│                             summary.md       概要（compact 产物）
│                             history_N.jsonl  归档分段（N 递增）
├── sessions/singles/<ws|ungrouped>/<sid>/     独立会话上架（叶子名 = sid，寻址不变；索引 sessions/.shelves.json）
├── sessions/groups/<gid>/                     群本体上架（shelf='groups'，仅真实发言，§6）
├── sessions/<gid>~<member>/                   群成员私有转录流（cr-4，标准 session 桶，无 shelf）
├── singles/<sid>/session.json                 独立会话元数据（ac-singles owning）
│                   prefix-snapshot.json       singles system+tools 前缀快照（§5.2，本服务 owning）
├── groups/<gid>/group.json + archive/         群成员表（原子写）+ 轮转分段 history_N.jsonl + summary_N.md
├── conversation/pending-<handle>.jsonl        待投持久化（next-turn 队列；行 id 带 req: 前缀）
├── conversation/steer-stash-<handle>.jsonl    busy steer 暂存持久化（cr-250 durable steer）
├── conversation/.deliver-seen.json            deliver requestId 幂等键（cr-250：FIFO 200 跨重启短路，deduped outcome）
├── archive/<convId>/…                         全量备份域归档（ac-backup 消费）
└── usage/usage-<date>.jsonl                   用量审计流水（cache hit/miss 在此；KV 走势数据源）
```

会话键校验：`conversationId` 禁路径分隔/遍历字符与 `~`（群 id）——文件名即键，无 `chat~lo~hi` 排序魔法、无 `group~` 前缀判别（规约 2）。

### 3.2 三文件分工与 settlement（2026-09-20 裁决，取代「单文件 + vacuum」形态）

| 文件 | 定位 | 生命周期 |
|---|---|---|
| `messages.jsonl` | 会话定稿流（header/agent/context/关闭行/收束行） | append-only，零死重（vacuum 退役） |
| `partials.jsonl` | run 中间态：`journal-step` 步行 + `journal-inject` 注入行 + 直调 `tool-result` 补行 | run 收束由 settlement 剔除已提升行；**不进清理面**（关闭行 `result:null` 恒需补行覆盖） |
| `subcalls.jsonl` | `call.runCodeSubcall` 的子调用档案（UI 回放数据源） | 永久档案，不清理——与 journal 生命周期相反 |

**为什么拆三文件**：变体乙（写侧 run 切分——插入消息到达消费点时当前进度落「关闭行」、余下步走新 run 键，落盘自然顺序 = 回放顺序）首版实测暴露三缺陷：
关闭行终值可能被按「收束行带全量结果」旧假设清理、关闭行落盘时点无法保证工具完成、同毫秒 timestamp 归位歧义。
解法 = partials 独立成文件（终值档案如实保留）+ `echoSeq` 归位锚（读侧按「主文件 seq ≥ echoSeq 首行之前」归位）+ vacuum 退役。

**settlement（run 收束物化，两阶段）**：`router/reply-completed` → ① 提升批（段行 + 注入行 + 收束行）append 到 `messages.jsonl`（durable，含 `run-settled` 判别行）；
② 按行身份从 `partials.jsonl` 剔除已提升行。崩溃窗口（①后②前）由 `recoverJournal` 惰性幂等收口（`records()` / `loop/run-started` 触发）。

### 3.3 写入语义（writer 队列）

- 按文件串行（单写者假设：ac-session 是会话文件唯一写口）；三文件各有独立队列（`flush(conv, kind)`）；
- WeakSet 引用幂等：同一消息对象对同一会话只落盘一次；
- 幂等固化：入队时铸造 `message_id`/`timestamp` 并**固化到消息对象**（重复投递至少产出同 id 行）；
- append + fsync 批量写；quiescence barrier；失败批次保序回队首；
- **fail-closed checkpoint**：`tool/before-execute` 按执行身份 `call.conversationId` 定向 flush（M11），落盘失败则 veto 工具执行——入站消息与 journal 先于工具副作用 durable；
- 卸载收尾 `flushAll()`（优雅关闭）。

### 3.4 概要与重建（replace 的落盘面）

- `compact({summary, keep})`：flush → 写 `summary.md` → tmp+rename 原子重写消息流（Windows 主场，不做硬链接发布）→ 旧队列作废；
- `deleteMessage` / `truncateAfter`（行内编辑语义）同款原子重写；
- 归档分段（ac-archive-core：`message_id` 去重 + 尾部水位截断不拆工具对）写 `history_N.jsonl`，会话流由 compact 重建为尾部 keep；
- 群本体轮转：500k token 阈值 → `groups/<gid>/archive/history_N.jsonl` + 机械摘要 `summary_N.md`，本体重建保留尾部 30k（§6.1）。

### 3.5 崩溃语义（现状：step 级 checkpoint 已落地）

原「mid-run 崩溃整轮丢失、已执行工具副作用零痕迹」的落盘弱点**已由 run journal 消解**（2026-09-21 partials 泛化）：

- **步级增量落盘**：`loop/after-step` → `journal-step`（决策先于工具副作用落盘）；`tool/after-execute` → `tool-result` 补行；
- **崩溃闭合**：孤儿 journal 由 `loop/run-started` / `records()` 惰性恢复（`recoverJournal` 幂等）；run 未收束时 partial 行保留，刷新后历史首屏据此恢复思维链/工具卡；
- **悬空调用合成**：中断 run 中 `result` 为 null 的调用在轨迹展开时合成 tool 行（防 provider 消息序被悬空 tool_calls 破坏）；
- **残留缺口**（显式枚举）：工具执行中进程死亡的步无结果 → 该 run 不进 LLM 回放（只服务 UI）；跨进程崩溃的 steer stash 由启动恢复重投（cr-250）。

### 3.6 明确不做（对 DSH 落盘设计的取舍）

SQLite/seek 后端与投影检查点缓存（单机个人规模无查询压力）；「未知必需事件拒绝加载」全严格读（选宽容跳过 + 头行 fail-loud 口子）；
zstd 帧串接/硬链接原子发布（Windows 主场，tmp+rename 已够）；chunk 打包压缩（压缩是编码层词汇，不污染 SessionRecord 词表）。

---

## 4. Agent 会话（对桶）

### 4.1 桶模型与信封

一切双端会话都是对桶：`conversationId = pairKey(a, b)`，自会话 = `a~a`（对角线，机制触发统一归此——timer 自唤醒/job 完成，与用户直答桶分离）。
信封身份/拓扑分离：`sender` = 发送方端点 id、`source` = 'user'|'agent'|'event' 拓扑词、`conversationId` = 会话键；`hooks[具名]` 不进信封。
串行化门 handle = `runAddress(agent, conversationId)`：同一会话同一 Agent 至多一个 run；忙时 steer 注入 / next-run 等闲 / next-turn 链跑（MAX_AUTO_WAKES=3 防自激）。

> **投递幂等与 durable steer（cr-250，2026-10-05）**：`deliver` 带 `requestId` 时按下沉水位短路（`.deliver-seen.json` FIFO 200 跨重启，deduped outcome——多端重试不重复入账）；
> busy steer stash **即落盘**（`steer-stash-*.jsonl` + fsync），消费/drop/兜底三清理点剔行，启动恢复重投（经标准 deliver，失败回落留痕；机制标记/event 行跳过）。
>
> **timer 会话维度增量（2026-09-26）**：条目带 `conversationId`（timer 工具 set 时从执行身份烘焙）时触发回投该会话桶（sid / 对桶 / 群 id 皆可），`sender='user'`；
> 缺省保持自会话对角线语义。目标会话消亡（独立会话归档/移除、群解散）→ 跳过本轮不计数。

### 4.2 上下文视图 = 每 run 从文件重派生

**现行为（2026-09-23 增量层退役）**：`startRun` 每 run 无条件经 `session.history(conv, { viewer })` 从文件重派生（链跑轮间亦然——群 blindspot/D11 语义由构造保持）；
归档/轮转后无需任何失效标记（下轮派生自然反映）。调用方显式种子与群 `historyFor` 优先路径保留。

> **被取代的方案（历史裁决，勿恢复）**：曾设计「router 事件投影驱动 + 进程内增量视图 + `archive/completed` stale 标记」的懒重派生形态。
> 退役理由：手写投影必须永远追平文件投影，两起同构漂移（2026-09-05 终稿 vs 轨迹、2026-09-23 error 收束丢轨迹致断网续聊失忆）证明该结构性双事实源不可维护。

### 4.3 回放与消费方

`history(conv, { viewer })` 是唯一回放边界；调用方全部传 viewer = 目标 Agent：
collab-tools `send_agent`（委托桶）、timer（自会话桶）、web-api（直答桶/独立会话）、**ac-archive 整理 run**（同桶播种，「你与 X 的会话」提示词天然是整理 Agent 视角）。
整理 run 的缓存复用：整理提示词 = agent system + `history(conv, {viewer})` 逐字回放 + 尾部整理指令——结构上前缀全命中。

### 4.4 system 抖动的现状（cr-4 后已大幅收敛）

请求前缀的易变件现状：

- **datetime**：其余会话 = system 尾部日期行（`loop/before-run-last` 尾档——序与装配顺序无关，跨日只失效日期行自身）；独立会话 = 每日 user 快照行（进 history 不进 system）；
- **memory**：cr-4 起**彻底出 system**——记忆内容走会话流 context 行（checkpoint 快照 + delta 尾部追加，KV 零失效），system 侧只剩恒定静态指引；
- **技能注入**：不再每 run 尾部重付——手势 pre-run 落 context 行、run_code 子调用收束落账（一次落账、跨 run 永久回放，成为前缀的一部分）；
- **归档 rewrite**：显式 replace（§3.4），低频可审计。

失效面 = 单桶、频率 = 日更/归档，实测无系统性低命中（§9.4）；本期接受、后续另议。

---

## 5. 独立会话（singles）

### 5.1 模型：会话 = 引用 + 覆盖，不是拷贝

`<root>/singles/<sid>/session.json` = Agent 引用（`agentId`）+ 会话级模型覆盖（`model?`）+ 工作区挂载（`workspaceId?`）+ 标题/状态；
消息流归 ac-session（`conversationId = sid`，规约 2 零新写路径）。规则：**有消息即锁 Agent**（未选 Agent 的空会话经默认预设 `__standard__` 路由）；
空白会话全局唯一（reuse）；模型覆盖随投递信封透传。自动标题：首 run 后 LLM 一句话标题（失败回落首条消息截断）。

### 5.2 system + tools 前缀快照（已落地：修订键锚点 + 终态核验）

singles 是最自包含的形态（无对端 Agent、模型覆盖恒定 = 路由/缓存域恒定），是前缀绝对稳定的最佳试点位。
落点 `<root>/singles/<sid>/prefix-snapshot.json`（ac-singles owning），快照 = `{ system 全文, 规范化后 tools schema 全集, 修订键 }`：

- **机制（M5-lite「请求可重建」轻量版）**：`loop/before-run` gate（零变异、位置无关）按**装配输入全集**计算修订键——
  persona/system/settings/生效工具集 schema/模型/llmParams/memory 哈希（白名单显式枚举，漏键 = 快照静默失效）；
  键未变 → **verify**（run 终态比对 system/tools 字节，漂移即告警「KV 前缀可能失效」）；键变/无快照 → **capture**（重拍覆盖）。
- **为什么不是运行时覆盖**：装配链是顺序敏感的监听器组合，强行末位置覆盖需行序保证；输入确定 + 修订键覆盖 + 字节对拍告警达成同一不变量。
- **残余失效清单**（显式枚举接受）：Agent 档案/人设编辑、生效工具集变化、模型覆盖修改（换缓存域）、记忆修订。
- **易变件出 system、追加化**：datetime → 每日一条 user 快照行（追加，日内幂等不再注入）；memory → cr-4 起走会话流 context 行（不再进 system，§4.4）。
- 上下文回放/视图与对桶同一套派生路径（sid 桶只是单读者特例）；归档照常走显式 replace。

---

## 6. 群组会话

### 6.1 本体 + 成员私有转录流（cr-4 现行形态）

| 通道 | 落点 | 内容 |
|---|---|---|
| **群本体** | `sessions/groups/<gid>/messages.jsonl`（shelf='groups' 上架，ac-session 域） | **仅真实发言**的 append-only 内容流（SessionRecord 中性行，原文不包装——`<msg>` 包装是回放投影，落盘包装会把视角烘死进事实层）；`post` 是唯一入账口 |
| **成员私有转录流** | `sessions/<gid>~<member>/`（标准 session 桶，无 shelf） | 每个成员的对话转录：post 按 viewer 投影扇出行 + 该成员 run 的转录（journal/settlement/步级/崩溃恢复/回放/压缩**全套复用**）。键形 `gid~member`（member 恒最右，右起解析无歧义；gid 禁 `~`） |
| 成员表 / 轮转分段 | `<root>/groups/<gid>/group.json`（原子写）+ `archive/history_N.jsonl` + `summary_N.md` | 成员表与本体轮转产物（ac-group owning） |

- **投递**：`send(gid, from, content)` = post 入本体 → 逐参与者 `conversation.deliver(member, <msg>包装+时间, {sender: from, conversationId: gid})`；handle = `gid~member`（busy = steer、idle = 新 run，fire-and-forget）；hint 只唤醒不携消息（投影行已入账）；busy 参与者经 `GroupFeed.readSince(anchor)` 免重复增量注入；
- **本体轮转**：500k token 阈值 → 机械轮转（archive 分段 + 摘要），重建保留尾部 30k；群共享记忆概念已随 cr-4 消失；
- **KV Cache effect**：成员流 Prefix-stable by construction——只做尾部追加（扇出投影 + run 转录），无就地变异、无重派生。

### 6.2 per-viewer 投影

- `<msg from="…" name="…" group="…">` 包装：**唯一构造点** `wrapGroupMsg`（`ac-group/src/view.ts`——四次消息重复事故的教训：包装格式只允许一个构造点，扇出投影/入群种子/触发通知共用）；
- own 消息原文回显（自己说过的话不包装）；peer 消息 `<msg>` 包装；
- 轮转摘要注入为头部（长期记忆锚点：「本群更早的消息已归档…」）；
- **群聊行为契约**（M26）：`GROUP_CONTRACT_TEXT` 经 `loop/before-run` 注入历史尾部、触发消息之前（「回/不回」决策点）——
  两次真实事故（空转、回声链雪崩）沉淀的文案，**勿回退到系统提示词位置**（最长上下文场景注意力稀释）。

> **裁决链（历史，勿按旧文动手）**：原设计（M21 D6 一期）为「本体 + 每 run 派生视图 + 增量合并」并显式否决 per-Agent 视角文件（理由是写放大 + 第二事实源）。
> 后果是派生窗全族（windowOf/deriveWindow/tailScan）、相邻 peer 纯发言合并、尾部滑窗截断——**cr-4（2026-09-27）推翻 D11 S1/S3 与派生视图路线**：
> 改裁为成员私有转录流（写放大换简单性 + 全套 session 机制复用），派生窗全族与相邻 peer 合并退役，`historyFor` 降级为入群种子（不再是成员 run 的上下文源）。
> KV 论证随之反转：原「写放大 + 第二事实源」担忧被「只追加、无重派生、前缀由构造成立」买单。

---

## 7. 消息链路（四层 + 收敛协议）

> 本章吸收 `message-pipeline-analysis.md`（cr-87 根因分析）的有效结论——其 D1/D2 两方向已实施（cr-94/95），
> 原文件 2026-10-06 归档 `src/docs/archive/`；主根因已消解，F/D 的裁决沿革见 §7.5。

### 7.1 四层链路

```
L1 写路径   ac-conversation(状态机/串行化门/inbox) → ac-agent-loop(事件) → ws-bridge(帧桥)
            产出：emit 事件流（delta/step/run 边界）——「直播管线」
L2 存储     ac-session：partials.jsonl(journal 台账) → settlement 切段物化 → messages.jsonl(定稿流)
            subcalls.jsonl 子调用永久档案并行；三文件分工见 §3.2
L3 读路径   ① LLM history()（每 run 上下文重派生，viewer 投影）
            ② web-api session/history（webui 首屏/分页，records() 活投影；lite 投影归 ac-session）
            ③ remote-link forwardRpc（手机端：钳页 + lite 投影 + 加密帧）
L4 前端     ac-client-ui-conversation：feed-core(分区 ingest + 历史分页) + feed.ts(纯函数合流层)
            → buildTurns → 渲染；席位/视图归行包（message:final-view 等）
```

- **下行线格式共享纯库 `ac-wire-format`**（cr-85/108/112）：`llm/delta` 瘦身投影（`wireLlmInput`：帧面只留 `{model, meta}`）+ 30ms 微批（`LlmDeltaBatcher`）；
  `BRIDGE_EVENTS` 目录（cr-108，42 事件全量）为 ws-bridge 与 remote-link 的共用桥接策略源；单批器漏斗 `WireBatcher`（cr-112，全事件 100ms 微批，首帧直发保交互；`durable-interaction/`、`ws/`、`remote/`、`system/` 前缀原生直发）。
- **关键事实**：直播流（WS 事件）与历史投影（RPC）仍是两条物理独立的管线，最终视图是两者在前端合并的结果——
  但**替换不再是时序赌注**（§7.2 收敛协议）。

### 7.2 收敛协议（cr-94 D1，已实施）：显式信号取代赌窗

**后端**：settlement 物化完成后 emit `session/run-settled`（载荷 `conversationId`/`agentId`，meta.runId）——此时刻起 `records()`/`history()` 必已可见权威收束行/段行；
只在 journal settlement 路径发（直落收束行无 journal run 不发——读侧在 `reply-completed` 时已可见）。事件目录声明住 `ac-session/src/events.ts`（另含 `session/context-injected`）。

**前端两驱动（`feed-core.ts`）**：

| 驱动 | 触发 | 行为 |
|---|---|---|
| `session/run-settled` | settlement durable 落盘后端确证 | `delay = 0` 即时重拉首屏——构造保证下无赌窗 |
| `loop/after-run` +500ms | 事件丢失 / 旧后端 / 无 journal 直落 run | 兜底（原 `TURN_DONE_DELAY` 300ms 路径降级为兜底） |

两驱动均**无条件重拉**（始终开着的会话直播行从未经过历史合并，不重拉永远换不成权威收束行 → 分支/编辑/删除按钮要刷新才出现）；
期间新 run 开跑无害（合并自带 live-wins 对齐）。收敛写口 = `convergeDialog(id, force)`（群分区早退——群内容源是 post 行，无 run 临时态）。

**两道前线闸门（cr-106 / cr-107 B）**：

1. **指纹短路双门**（`session/history` 首屏带分区指纹，文件未变时服务端回 `unchanged` 轻载荷）：
   **live 分区**（`streaming` / 占位 / 未闭合工具行）一律禁用短路——切回时点 = 确定性收敛点，服务端真相覆盖本地（对齐合并归 `mergeHistory`）；`force`（判死收敛）必拿权威行；
2. **吸收双门**（前缀互验吸收，cr-106 2026-10-02 吸收事故根修）：
   **身份门**——中性格式下用户落盘行同为 `role:'agent'`，`agent_id` 不同的行永非「同一步」（否则用户正文灌进 Agent 占位 = 气泡镜像用户消息）；
   **空载门**——占位先建、内容后到（`step-started` 先于首 delta），空占位是任何历史行的前缀，两侧任一无内容 = 无对齐证据，不吸收（宁重不丢，收束重拉兜底；`stepId` 键控路径不受此门约束——键即身份）。

**悬挂流探针（cr-107 checkpoint-C）**：`streaming` 分区静默超 `STREAM_STALE_PROBE_MS = 180_000`（3min）→ 查 `conversation/stats` 权威判死活：
判活（慢 run）刷新基线顺延再探；判死（登记表无此 run）关停全部临时态 + `convergeDialog(id, true)` 强制收敛；**RPC 失败不定罪**（后端不可达与悬挂不可区分，恢复归重连链路）。
动机：收尾帧永远缺席的悬挂 run 会让占位与忙态无限期残留，而发送看门狗（30s）只救「无占位」形态、有占位恒判活（盲区）。

**遗留纵深防御**：`mergeHistory` 的对齐猜测保留（B 的重拉到达前仍有一屏窗口）；发送侧 watchdog 触发即权威化。

### 7.3 读路径单源化（cr-95 D2，已实施）

同一存储被三种口径读取（LLM history / web-api records / remote lite），曾靠人工同步、无构造保证。
现状：**lite 截断投影归位 ac-session**（`records(conv, { view:'lite' })` → `liteProjectRecords`，包内单源导出），web-api / remote-link 只剩传输层参数透传——
消除「投影逻辑放错层」类风险（cr-55 lite 投影直接变异 records() 共享缓存对象污染 LLM 回放读侧，即此病理）。
viewer 投影同样单源：`history()` 与 web-api 展示投影共用 `projectRecord` / `expandSteps`（轨迹形状单一事实源，防两处漂移）。

### 7.4 前端合流器现状

- **已有构造保证**：双键去重（`persistedMsgId|id`——同锚多步行共享收束行 message_id 但渲染 id 各异，单键会吞掉同轮第二条起的步行）、指纹短路、cr-85/108 线格式并源、cr-94 收敛信号、cr-106/107 门与探针；
- **合流纯函数层**：`feed.ts`（统一信息流纯函数层）承载 `mergeHistoryPage` / `buildTurnsIncremental` / `lastStreaming` / `closeAllStreaming` 与包装透传；**双源合并语义已有单点落点**；
- **未落地**：`feed-core.ts` 仍是约 135KB 单体，同域承载帧路由、ingest 状态机、历史分页、resume 合并、未读持久化、run 计时、归档标记等关切（**原 D3「按关切切分」未实施**——仅在出包归位（M27.2）时把纯函数与传输参数化拆出）。

### 7.5 原根因分析的结论与裁决沿革（2026-10-06 压缩存档）

| 编号 | 原结论 | 现状 / 裁决 |
|---|---|---|
| F1 | 双管线无收敛协议 = 主根因（替换依赖 300ms 时序赌注） | **已消解**：cr-94 显式收敛事件 + cr-106/107 门与探针（§7.2） |
| F2 | 三读路径口径漂移（无构造保证） | **已消解方向**：cr-95 lite 投影单源（§7.3）；viewer 投影复用 `projectRecord`/`expandSteps` |
| F3 | feed-core 单体承载合流（2315 行，七关切同作用域） | **未消解**：仍约 135KB 单体（合流纯函数已抽出，详见 §7.4） |
| F4 | 存储层设计健康（排除项）——问题在投影与合流层 | **维持有效**（三文件 + settlement + 恢复机制持续证明价值） |
| F5 | 部分补丁已是正确方向（fingerprint 短路、双键去重、线格式并源） | **维持有效**（并在 cr-94/106/107 中被收敛协议收编为门/探针） |
| D1 | 收敛协议显式化（方案 a 后端补齐 / 方案 b 前端去赌）——推荐 a | **a 已采纳实施**（cr-94） |
| D2 | 读投影单源化（收进 ac-session 参数化投影） | **已实施**（cr-95） |
| D3 | feed-core 按关切拆分（配合 D1 做） | **未实施**（见 §7.4；拆分仍成立但非阻塞项） |
| D4 | 不建议：重写存储层 / 继续打时序补丁 | **维持否决**（修复史证明打补丁是移动窗口而非消除窗口） |

衔接记录：D1 落地走 after-* 观察通知 + ac-session 事件目录登记（`session/run-settled` 已过事件目录静态锁定）；
D2 属服务方法演化，不涉新事件；二者均符合插槽-插头可逆性验收（摘掉改动能零改动恢复）。

相关后续：`2026-09-24` 会话流身份贯通根治方案（`feed-identity-overhaul-plan.md`，已归档）为身份维诊断；cr-106 的身份门是其实证补强之一。

---

## 8. Run 生命周期与收敛 checkpoint

全景图与临时态清单住 **`run-lifecycle-checkpoints.md`**（现行架构描述，2026-10-06 治理核实：cr-106/107 的 B/C 已实施并有回归测试，A/D 为已裁决不做项）。
要点（细节以该文为准）：

- **checkpoint-1 `loop/after-run`**（帧边界，final 物化/closeAllStreaming）→ **checkpoint-2 `session/run-settled`**（durable 落盘）→ 重拉首屏权威替换；
- **第三个一等收敛点**：切回会话（live 分区禁指纹短路，cr-107 B）；**第四个**：悬挂流探针判死强制收敛（cr-107 C）；
- **临时态清单**（本地乐观用户行 / 流式占位 / preparing 工具卡 / final 悬置 / 步终值校准锚 / 吸收合并 / journal 活投影行 / watchdog 兜底）逐项标注产生与拉直时刻——悬挂 run 期间哪些会「永悬」是 cr-106 吸收事故的教训面；
- 本文 §3.2/§3.5 的 journal 物化与崩溃恢复即该图 S 侧（session）的机制底座。

---

## 9. KV 缓存分析（现状）

### 9.1 缓存模型与目标函数

provider（DeepSeek 等）自动前缀缓存：请求前缀与近期请求字节级一致则命中，命中部分按缓存价计费且 TTFT 大幅下降。
**命中率不是目标函数，成本与 TTFT 才是**——因此分析对象是「结构性前缀破坏点」，不是救火式追命中率。
请求前缀解剖：`[system][tool schema][history]`。理想不变量（S4）：每步请求 = 上一步的字节级前缀 + 纯追加后缀（新工具结果、新助手轮、新用户输入），唯一合法破坏 = 显式 replace（S5）。

### 9.2 机制对照（DSH 纪律 × 本设计落点）

| DSH 机制 | 本设计落点 | 状态 |
|---|---|---|
| M1 append-only 会话 + **派生**历史 | 三文件落盘（§3.2）；每 run 从文件重派生（§4.2） | ✓ 已落地 |
| M2a system 确定性组装 | persona/framework 分块拼接，输入不变则输出确定 | ✓ |
| M2b 工具顺序规范化 | `normalizeToolSpecs` 按工具名**字典序**（与注册顺序/插件装卸解耦；测试锁定） | ✓ 已落地（原 2026-08-27 为 ✗，M21 步骤 3 收口） |
| M3 易变内容追加化 | datetime：其余会话 system 尾档日期行（只失效自身）、singles 每日 user 快照行；**memory cr-4 起出 system**，走会话流 context 行（checkpoint+delta 尾部追加，KV 零失效） | ✓ 已落地 |
| M4 条件 reasoning 回传 | run 内 assistant 轮不回传 `reasoning_content`；跨 run 轨迹**缺省展开**（`replayTrajectory` 缺省 true，§2.6），关切即关 | ✓（切 thinking 系模型复核） |
| M5 请求可重建不变量 | singles 修订键锚点 + run 终态核验（M5-lite，§5.2）+ golden 等价测试（进程内派生 ≡ 重派生） | ◐ 轻量版已落地 |
| M6 compaction 唯一破坏者 + 自身复用缓存 | 归档/群轮转 = 唯一显式 replace（§3.4）；整理 run 前缀全命中（§4.3）；版本迁移是另一条显式通道（§2.7，频率更低） | ✓ |
| M7 计量闭环 | `usage/usage-<date>.jsonl` 记 cacheHit/cacheMiss；基线查询脚本 `src/scripts/usage-baseline.ts`；会话级/步级观测面见 §9.4 | ✓ 已落地 |
| M8 不为不存在的语义留 API | 无显式缓存标记/预热 API | ✓ |

### 9.3 各会话形态的前缀稳定性

| 形态 | system | tool schema | history | 结论 |
|---|---|---|---|---|
| 对桶（直答/委托/自会话） | persona/framework 确定；datetime 尾档日更、归档 rewrite（§4.4 接受） | 字典序确定 | viewer 投影 + 每 run 重派生，逐步纯追加 | 达标（两处结构性破坏已修） |
| 独立会话 | **快照持久化 + 修订键核验，跨重启字节不变**（§5.2） | 进快照修订键 | 同对桶 | 最佳试点位 |
| 群 | 组名/成员表确定（低频变） | 同上 | **成员流只追加 by construction**（cr-4，§6.1）——原「尾部滑窗导致历史前缀每轮整体重建」的结构性缺陷已消除 | 三形态齐平（本体轮转 = 显式 replace） |

**跨 run 轨迹展开的 KV 账（结论：质量优先取舍，成本差异已显式签收）**：

- **run 内**：ReAct 各步的 assistant(tool_calls) + tool 行本就在请求里（循环内消息流逐步追加），步内/步间前缀完全共享，零损失；
- **跨 run（缺省展开）**：以一轮 10k token 工具中间态 + 500 token 终文本为例——对话级下轮重放仅 500 miss；轨迹级（理想字节稳定）是 10.5k 全命中 ≈ 等效 1.05k。命中率数字更好看，绝对成本反而更高（命中率不是目标函数）；
  且持久化 steps 是脱敏 + JSON 往返产物，与当轮实际发送字节必然漂移，历史 run 边界处仍 miss——「开 = 高命中」不成立；
- 因此缺省翻转（2026-09-03，质量优先：跨 run 保留自己的工具轨迹记忆、少重复调用）是**质量取舍**而非成本优化；成本敏感场景显式置 `false`；
- **K 截断档否决理由（维持）**：① 前缀稳定的前提是每轮回放形状不可变，任何「近 K 步」截断预算都会随新内容前滑 ⇒ 前缀整体重建，截掉的 token 没省下、未截部分反而从命中变 miss，**费用不降反升**；② 长对话预算控制已有唯一属主 = 归档阈值（显式 replace、可审计）；③ 两态使 golden 锁定与 UI 都减半。

### 9.4 实测基线与现行观测面

**历史基线（2026-08-27，`<root>/usage/*.jsonl`）**：全局 9,140 run 命中率 **95.3%**；news（2,191 run）91.3%、均 miss/run ≈16k。
news 逐 run 双峰：稳态定时轮 95–99%（miss = 本轮新工具输出，架构不变量）；1% 全量 miss 簇 = 9.5h 空闲 provider 逐出 + 重启后的字节分叉。
**结论：无系统性低命中，修复对象是结构性破坏点（字节分叉、工具顺序、群滑窗、直答重启丢史），不是整体策略**——四类破坏点现状见 §9.2/§9.3。

**现行观测面（cr-231~251，2026-10-05 起）**：

- **`session/tokens`**：上下文占用（四段堆叠条：工具定义/系统提示/会话上下文/余量）+ 缓存区摘要；
- **`session/kv-timeline`**：会话**步级**缓存率序列（ac-usage 行级 timeline 留存；每点 = 一次有计量的 LLM 调用；cr-232 步粒度、cr-236 懒加载全量返回 limit 退役）；
  弹层打开时拉取，配 95% 健康基准虚线（cr-243/245：50% 弱参考线已删）；
- **run 进行中即可见**（cr-251）：ac-usage 加订 `loop/after-step` 写 pending 临时步流，`conversationTimeline` 拼接 pending 尾段，after-run 正式记账接管并清尾——不再等整轮收束；
- 基线查询脚本化（命中率/miss 分布），每步落地后以真实数据对拍本节历史基线。

### 9.5 观测与声明纪律

- usage 流水含 cacheHit/cacheMiss（provider 归一化：DeepSeek 顶层 / OpenAI·GLM 嵌套推导）；
- **KV Cache effect 声明纪律**：回放/注入相关行（session/conversation/group/persona/system-prompt/memory/datetime/skill）头注释声明自己对请求前缀的作用
  （None / Append-only / Prefix-stable / invalidate-from-X）——现行实例见 `ac-session/src/index.ts`、`ac-group/src/service.ts`、`ac-datetime/src/index.ts` 包头。

---

## 10. 裁决链（设计点 × 现状态 × 裁决沿革）

> 读法：本表是**历史裁决的存档**，不是待办清单。原稿（2026-08-27）的 ✗ 标记已按源码现状更新；被取代的方案保留结论与取代原因。

| # | 设计点 | 现状态与证据 | 裁决沿革 |
|---|---|---|---|
| D1 | 回放按读者投影（变换基址 = `agent_id`） | ✓ `projectRecord` viewer 变换（`history(conv,{viewer})`） | 原 ✗（a⇄b 桶视角颠倒）→ 2026-08-27 落地 |
| D2 | 视图 = 文件事件派生投影 | ✓ 但形态改变：每 run **无条件重派生**（无进程内增量视图） | 原设计「事件投影 + stale 标记」→ **2026-09-23 退役**（两次漂移事故，§4.2） |
| D3 | 重启重派生 = 字节等价 | ✓ 由构造保证（单一派生路径） | 顺带修复直答/独立会话「重启后首轮上下文为空」（原 F1 差距） |
| D4 | 工具顺序字典序 | ✓ `normalizeToolSpecs`（ac-agent-loop）+ 测试锁定 | 原 ✗（注册顺序 = 插件加载时序产物） |
| D5 | singles system+tools 快照 | ✓ `prefix-snapshot.json` + 修订键锚点 + 终态核验告警 | 原 ✗（每跑重组装）；形态由「运行时覆盖」改裁为「修订键 + 核验」 |
| D6 | 群派生视图 + 增量合并 | **改裁**：成员私有转录流（标准 session 桶，只追加） | 原「派生视图 + 增量合并」→ **cr-4（2026-09-27）推翻**（派生窗全族/相邻 peer 合并退役，§6） |
| D7 | 归档后视图收缩 | ✓ 自动成立（下轮派生自然反映，无 stale 标记需求） | 随 D2 形态变更消解 |
| D8 | 会话头行 + `seq` | ✓ `session-header v1` + writer 单调 seq；stats/窗口计数排除头行与判别行 | 原 ✗（零版本治理、归档尾锚 8KB 窗口对 128KB 大行失效） |
| D9 | KV effect 声明 + 基线脚本 | ✓ 包头声明纪律 + `src/scripts/usage-baseline.ts` + cr-231~251 观测面 | 原 ◐ |
| D10 | 视角/字节/追加语义 | ✓ 落盘 append-only、writer 队列、幂等固化、归档唯一 replace、整理 run 前缀复用、群 `<msg>` 唯一构造点 | — |
| D11 | 群存储统一：本体迁 sessions 树 + steps 内嵌、退役影子桶 | ✓ 本体 = `sessions/groups/<gid>/`（shelf 上架，ac-session owning），`groups/<gid>/` 只剩成员表 + 轮转分段；**保留部分** = 成员私有转录流（cr-4） | 原「本体迁入 + 退役影子桶」已落地；per-member 视角「不落文件」裁决 → 被 cr-4 改裁为成员流（§6） |
| D12 | 错误行一等化 | **改写**：`role:'error'` → v2 的 `role:'context' + source:'error'` | 原「error 是词表一等成员」→ 2026-09-18 词汇 v2 取代（三轴，§2.2）；行为面不变（UI 红色语义 / LLM 按 user 喂回） |
| D13 | 中性格式切换 + viewer 变换 + 迁移 | ✓ 迁移 `M-role-v2` 后写侧不再产生旧词；旧 baked 文件宽容读 | v1 词表定义被 v2 扩展（role 收敛为消费通道，source/label 承载呈现） |
| D14 | 轨迹回放布尔开关 | ✓ `settings.session.replayTrajectory`（settingsOf 合成 + 存量键双读，热生效）；**缺省 true（2026-09-03 缺省翻转）** | 取代 M21 D7「不实装」；K 截断档否决（§9.3）；文档旧稿把翻转日记为 2026-09-23，按源码/测试头注更正 |

### 10.1 历史实证存档（原 §8.2/§8.3 的三层回放失败与审核差距——结论保留，均已消解或有现行对应）

- **A 视角颠倒**（桶内角色按投递目标写死）：已消解——存储中性 + `agent_id` 投影（§2.6）。
- **B 双 handle 双视图**（播种一次后永不再同步，长活进程失忆）：已消解——每 run 无条件重派生（§4.2）。
- **C 视图行与文件派生行字节不等价**（跨重启缓存全丢）：已消解——同源派生 + 幂等字段只进落盘行、绝不进请求体。
- **F1 直答/独立会话重启丢史**（web 主路径无种子）：已修（同 B/C 的形态变更）。
- **F2 群播种视角错位**（一份种子发全部成员）：已消解——cr-4 成员私有转录流（每成员各自回放）。
- **F3 viewer 调用方清单漏 ac-archive**：已列（§4.3 四消费方）。
- **F4 头行污染行计数**：已处理——`countWindowMessages` / stats 排除 header、`tool-result`、`run-settled`、partial 行。
- **F5 投影对 system 行的直通语义**：已处理——`projectRecord` 直通 system、context/event/error 恒 user。
- **F6 群双事实源（影子桶 + 本体）**：已消解——D11 落地 + cr-4 成员流（§6.1）。
- **F7 错误折叠为 assistant 文本**：已消解——词汇 v2 `context+source:'error'`（§2.5、D12）。

---

## 附录 A · 术语表

| 术语 | 含义 |
|---|---|
| 对桶 / pairKey | 双端会话键 `[a,b].sort().join('~')`；三态：直答 `viewer~agent`、委托 `a~b`、自会话 `a~a` |
| handle / runAddress | 串行化门键 = (agent, conversationId)；同门至多一个 run |
| viewer | 回放读者端点 id；视角变换的基准 |
| 消费通道（role） | 词汇 v2：`agent` = 真实发言，`context` = 上下文材料（source/label 决定呈现） |
| 判别行 | `type` 键非消息行：session-header / journal-step / journal-inject / tool-result / run-settled |
| run journal / partials | run 周期台账（步行/注入行/补行）；settlement 提升入 messages 后剔除 |
| settlement | run 收束物化：提升批 append（durable）+ journal 剔除，两阶段 |
| 收敛协议 | `session/run-settled`（cr-94）+ 前端驱动重拉 + 指纹双门/探针（cr-106/107） |
| 本体（群） | 仅真实发言的 append-only 内容流（`sessions/groups/<gid>/`） |
| 成员私有转录流 | `sessions/<gid>~<member>/`，成员自己的对话转录（cr-4，标准 session 桶） |
| 显式 replace | 归档/轮转/快照重拍/版本迁移——仅有的允许前缀破坏的操作 |
| golden 对拍 | 等价性测试：进程内派生 ≡ 全量重派生 / 迁移前后投影输出，逐字节比较 |
| KV Cache effect | 行级声明：本代码对请求前缀的作用（None/Append-only/Prefix-stable/invalidate-from-X） |
| 整理 run | 归档前 Agent 亲自整理的机制 run（meta 标记三处不落盘） |
| 匿名读者 | `history()` 未传 viewer：中性行一律 user（审计/矩阵只读视角） |

## 附录 B · 相关文档

| 文档 | 关系 |
|---|---|
| `src/README.md` | 轨道事实源（三层架构/契约归属总表/纯库清单）——冲突时以它为准 |
| `run-lifecycle-checkpoints.md` | Run 生命周期临时态与收敛 checkpoint 全景（§8 引） |
| `skill-injection-and-storage-vocab.md` | 存储词汇 v2 + 技能注入三通道 + 迁移机制（§2 的规范出处） |
| `src/docs/archive/message-pipeline-analysis.md` | 消息链路根因分析（cr-87，2026-10-06 归档；有效结论已并入 §7） |
| `src/docs/archive/message-pipeline-d1-convergence-plan.md` | D1 收敛协议实施计划（cr-94 已实施，冻结） |
| `message-pipeline-graph.html` | 消息处理链路全景图谱（cr-87 可视化，四层泳道） |
| `src/docs/archive/memory-timeline-plan.md` | cr-4 记忆时间线/群成员流改裁的计划与实证（§4.4/§6 依据） |
| `src/docs/archive/feed-identity-overhaul-plan.md` | 会话流身份贯通根治方案（2026-09-24，已冻结） |
| `src/scripts/usage-baseline.ts` | KV 基线查询脚本（§9.4） |

