# AgentChat Session 设计（preview 轨道 · 目标设计）

> 定位：本文是 Session 域的**目标设计文档**——设计理念、消息定义、
> 落盘格式、三种会话形态（Agent 对会话 / 独立会话 / 群组会话）、
> KV 缓存分析，以及当前 preview 轨道实现与设计的差异清单。
>
> 演化关系：由 `docs/m21-replay-prefix-cache-plan.md`（回放重构规划：
> 问题实证档案 + 分阶段步骤 + 决策点 D1-D7）重写而成——M21 是本文的
> **落地计划与实证档案**（含 2026-08-27 实测基线），实施步骤、测试门、
> 裁决记录见彼；本文回答"设计应该是什么、为什么"。
> 双参照系：DSH `dsh-kv-cache-analysis.md`（前缀稳定纪律）+
> `dsh-session-storage-format.md`（事件溯源落盘格式）。
> 事实源：`preview/README.md`；本文与其冲突时以 README 的链路事实为准、
> 以本文的设计裁决为纲。
>
> 状态标注约定：§1-§7 描述目标设计；已被 M19/M20 等落地覆盖的部分标
> 【已落地】，M21 尚未动工的部分标【设计】；§8 集中列出现状与设计的
> 全部差距及其落地步骤映射。
>
> 裁决记录（2026-08-27，用户）：① **落盘格式采用 src 中性语义**
> （`role: agent|system|tool|error|event` + `agent_id` 标记归属，
> §2.2），回放层 viewer 变换随之调整（§2.4）——取代本文初版"维持
> baked 格式"的取舍，也修正 M21"不动存量行格式"原则（迁移策略见
> §8-D13）；② **轨迹回放开关**：steps 是否进跨 run 回放做成
> ac-session 可配置项（`settings.session.replayTrajectory`——M24
> X1/A1 settingsOf 合成，插件库/Agent 插件配置页可调，§2.5；2026-08-30
> P2 收口，存量 config 键双读过渡；**2026-10 缺省翻转开**）——取代 M21 D7"不实装"裁决。布尔
> 两态；K 截断档
> 否决（截断预算使回放形状随内容前滑 → 缓存失效且费用反升，长对话
> 预算归归档阈值唯一属主）。

---

## 1. 设计理念

Session 域回答一个问题：**一段对话的"事实"存在哪里，各参与者看到的
"历史"从哪里来，每一步 LLM 请求的前缀如何保持字节稳定。** 五条支柱：

**S1 事件是真理，消息是投影。**
会话文件（append-only jsonl）是唯一事实源；一切"历史"——UI 回放、
LLM 上下文、审计、统计——都是从文件的**确定性派生投影**。进程内的
上下文视图只是投影的增量缓存，不允许成为第二事实源。没有平行的
"持久化消息类型"：写下去的行就是全部对话事实。

**S2 视角正确性：存储记话语事实，角色由回放按读者赋予。**
落盘行是**读者无关的中性事实**（src 语义，§2.2）：`role` 记话语类别
（一切真实发言 = `agent`），`agent_id` 记说话人端点。任何读者回放同一
桶时由投影赋予角色：`agent_id === viewer → assistant`，其余 → `user`。
role 是 chat 模型最强的身份条件，视角错乱直接污染第一人称连续性——
存储层永不烘死视角（写入侧不猜读者是谁），回放层必须保证"我看到的
历史里，我说的话都是我（assistant）说的"。

**S3 字节等价：进程内视图 ≡ 文件派生。**
同一读者、同一桶，进程内增量维护的上下文视图与重启后从文件重派生的
视图必须**逐字节一致**。破坏等价（如进程内行缺 `name`、多出固化字段）
= 每次重启全量缓存失效。等价性是可测的（golden 对拍），不是愿望。

**S4 前缀稳定是一等架构约束。**
KV 缓存命中本身不是目标函数——**成本与 TTFT 才是**。每个 LLM 请求的
前缀 = `[system][tool schema][history]`；理想不变量是**每步请求 = 上一步
的字节级前缀 + 纯追加后缀**，服务端自动前缀缓存除尾部全命中。任何
回放/注入相关代码必须能回答"我对请求前缀做了什么"（KV Cache effect
声明纪律：None / Append-only / Prefix-stable / invalidate-from-X）。

**S5 显式 replace：唯一的前缀破坏者。**
归档（对桶/独立）、轮转（群）、快照重拍（独立会话 system 前缀）是仅有的
允许改变前缀的操作：显式、低频、可审计，且触发视图重派生。除此之外
一切对会话流的操作都是追加。

与框架规约的衔接：**规约 1**（ac-session 是会话文件的 owning service，
跨域读写一律走服务方法）、**规约 2**（一切会话态按 conversationId 寻址，
文件叶子目录名即键，零前缀/排序魔法）、**规约 3**（机制任务直调服务或
`sender='event'` 信封，痕迹自然进会话流）、M19 全对键桶模型（user 只是
端点之一，桶/路由/统计零专属路径）。

会话形态总览（一切按 conversationId 寻址，三种键形态）：

| 形态 | conversationId | 读者 | 事实源 |
|---|---|---|---|
| Agent 对会话 | `pairKey(a, b)`（`[a,b].sort().join('~')`）：直答 `viewer~agent`、委托 `a~b`、自会话 `a~a`（对角线，机制触发） | 桶内每个真实 Agent 各自独立 | `<root>/sessions/<convId>/messages.jsonl` |
| 独立会话 | `sid`（singles 名册消歧） | 引用的单个 Agent（会话级可换） | 同上（上架到 `sessions/singles/<ws|ungrouped>/<sid>/`） |
| 群组会话 | `gid` | 每个成员（含 viewer 虚拟端点只读） | `<root>/groups/<gid>/messages.jsonl` 本体（仅真实发言） |

---

## 2. 消息定义

三层词汇，各司其职：

```
LlmMessage        传输/回放层（ac-llm owning）：进 provider 请求与 history 的形状
SessionRecord     持久层（ac-session owning）：messages.jsonl 的一行
SessionStepRecord 持久层内嵌：assistant 行的 ReAct 步记录
```

### 2.1 LlmMessage（回放产物）

`{ role, content, name?, tool_call_id? }`，role ∈ system / user / assistant /
tool。`name` 是可选的说话人标注——回放产物带 `name`（由存储行
`agent_id` 投影而来，§2.4），**由回放层统一保证，不依赖调用方记得带**。

### 2.2 SessionRecord（持久行）【中性格式——src 语义，2026-08-27 裁决】

| 字段 | 语义 | 备注 |
|---|---|---|
| `role` | `'agent' \| 'system' \| 'tool' \| 'error' \| 'event'` | **话语类别（读者无关的存储事实）**：一切真实发言（人类入站 / Agent 出站）= `agent`，归属由 `agent_id` 标记；`event` = 机制触发（UI 分隔符）；`error` = run 错误收束（§2.3）；`system`/`tool` 预留（概要不落行、对话级无顶层 tool 行——轨迹展开是回放投影非存储，§2.5） |
| `agent_id` | 说话人端点 id | **完备归属标记**（`'agent'` 行必有；viewer/人类/Agent 端点同词汇——M19 端点对等贯穿到存储层）；取代旧 `name` 字段 |
| `content` | 正文 | 工具参数/结果存原始 JSON 串（不二次编码） |
| `message_id` | 幂等固化 id（`msg-<ts>-<rand>`） | 同一消息对象重复入队产出同一 id 行；归档二次去重锚 |
| `timestamp` | ISO 时间 | 热力窗/审计数据源 |
| `source?` | `'event'` 等拓扑类 | 机制行携带；诊断用 |
| `reasoning_content?` | 整轮思维链（各步 reasoning 拼接） | `agent`（回复）行；刷新后恢复折叠栏 |
| `steps?` | `SessionStepRecord[]` | `agent`（回复）行；ReAct 各步正文/思考/工具调用对（`{id, name, arguments: 原始 JSON 串, result: ToolResult}`）。持久层全量落账；跨 run 轨迹回放经 `session.replayTrajectory` 开关按投影展开（§2.5——2026-10 起缺省开，可显式关） |

**版本锚点**：带 session-header 的文件按本表——header `version:1` **即
中性格式**（头行机制尚未落地、无存量头行文件，v1 直接定义为新词表，
不经过 baked 中间态）；无头文件 = 旧 baked 格式（user/assistant +
name），读取层宽容归一（§2.4 兼容路径；迁移见 §8-D13）。M21 步骤 7
原文"v1 = 现格式"的表述以此为准修正。

### 2.3 入账规则（谁写什么行）

| 投递形态 | 落盘行 | 说明 |
|---|---|---|
| 任何真实发言：入站 / 回复 / steer 注入 / 私信 | `role:'agent'` + `agent_id=说话人端点` | 视角无关——入账函数已备（record 的 agentId 参数即 agent_id，映射零成本）；回复附 reasoning_content 与 steps[]；中断/空回复不入账 |
| 机制触发（`source='event'`） | `role:'event'` + `source` + `agent_id=目标自身` | UI 渲染事件分隔符；LLM 回放按 user 喂回 |
| run 错误收束（`finish='error'`） | `role:'error'` + source 标注 | 中性词表一等成员（src error 语义吸收）：UI 错误分隔符；LLM 回放按 **user** 喂回（告知"出了错"而无自他归因污染；不采纳 src 的 `error→tool` 映射——无 tool_call_id 配对的 tool 行在严格 provider 侧有被拒风险）。现状 `[error] …` 伪装 assistant 文本落盘的行为随切换消灭 |
| 机制标记 run（`meta[ARCHIVE_REVIEW_META]`） | **不入账** | 归档整理是机制产物，非会话事实（三消费方：session 不入账 / usage 不记账 / conversation 不进视图） |

**随切换删除的特判**：ac-session 虚拟端点入账分支（`target.virtual
&& source==='agent'` → 记 assistant + name=说话人）——中性存储下
agent→viewer 私信就是 `role:'agent' + agent_id=说话 Agent`，无需猜
方向。baked role 模型"写入侧必须猜视角"的结构代价（该分支是第一个
症状）就此终结。

### 2.4 回放投影（视角变换）【设计，M21 步骤 1 + D13 格式切换】

存储中性（role 记话语类别、agent_id 记归属）⇒ **角色完全由回放投影
赋予**——变换不再"纠正"写入视角，而是从头构建读者视角，对任何桶
形态统一：

`session.history(conversationId, { viewer })` —— viewer 是**读者端点
id**（回 Agent 的那个 Agent；UI 审计面可传 undefined 取原始行）：

```
role='agent' && agent_id === viewer  → assistant  （我自己说的话）
role='agent' && 其他                 → user       （别人说的，无论对方是谁）
role='event' | 'error'               → user       （机制提示/错误的 LLM 语义位）
role='system'（概要头）              → system     （直通，不参与变换）
产物行 = { role, content, name: agent_id }（wire 形；name 供多方会话
说话人区分与 UI 渲染——确定性派生，不影响前缀稳定）
```

- 对 src 规则的**去特殊化改写**：src 的 `agent_id==='user'→user` 特判
  不需要——人类端点 id ≠ viewer（Agent），自然落 user；M19"端点对等"
  语义在中性格式下才真正贯穿到存储层；
- **兼容路径（迁移期）**：无 session-header 的旧文件按 baked 格式
  （user/assistant + name）宽容读取，等价变换（`name===viewer→
  assistant`、其余→user、event/error→user）产出与中性投影**同构**的
  输出——user⇄x 直答桶保持零回归；一次性迁移脚本（scripts/
  migrate-workspace 先例）改写存量行（user/assistant+name → agent+
  agent_id）+ 补头行后，旧路径退役；
- **UI/RPC 消费**：session/history RPC 增 viewer 参数（1v1/singles
  缺省 = 对话 Agent——气泡左右语义与现状一致；矩阵只读视角可取原始
  行或指定视角）。

### 2.5 轨迹回放开关（replayTrajectory）【设计，2026-08-27 裁决：布尔两态】

"steps 是否进 LLM 跨 run 回放"做成**用户可调的布尔开关**（K 截断档
已否决——见下"不设 K 档"）：

- **配置键**：`settings.session.replayTrajectory: boolean`（缺省 `true` =
  轨迹展开——**2026-10 缺省翻转**，原缺省 `false` 是成本优先取舍，现质量
  优先；两处（合成层 + 存量键）皆未配置才走缺省，显式 `false` 受尊重）
  ——2026-08-30 P2 词汇收口：落 M24 X1/A1 的 `settings[具名]` 层（全局默认层
  config `settings.session` ∪ Agent 差异层，读取经 `settingsOf(viewer,'session')`
  合成——viewer 即回读 Agent，per-Agent 语义天然成立）；存量 M21 键
  `config.session.replayTrajectory` **双读过渡**（新层显式值优先、未配置回落
  旧键——存量部署不静默翻转），`config/changed` 热生效；ac-session
  `history()` 消费（归档整理 run 的播种同口径）；
- **展开语义**：开启时 `agent`（回复）行的 steps[] **全量**物化为回放
  序列——每步 `assistant(tool_calls)` + 对应 `tool` 结果行
  （tool_call_id 配对）→ 终 `assistant(content)`，复现 run 内消息序；
  关闭时维持对话级（现状）。展开只影响 LLM 回放（history 面），
  records/UI 展示不变；
- **前端**：插件库目录 ac-session 卡片「⚙ 可配置」弹窗（全局默认层，写
  `config/set → settings.session`）+ Agent 装配页差异层实例（2026-08-30
  P2 收口——原 SettingsPanel sys.session 全局面板退役）；
- **KV 注记（§7.3 核算的显式化）**：关 = 成本最优（省略 token 费用
  为 0 < 命中价 0.1×）；开 = 质量优先（跨 run 保留自己的工具轨迹
  记忆、少重复调用），但持久化 steps 是脱敏 + JSON 往返产物，与当轮
  实际发送字节漂移——历史 run 边界处仍 miss，"开 = 高命中"不成立，
  用户按质量需求自选。**开关本身 = 该会话回放形状整体变化的显式
  replace**（翻转即一次性全量失效）：低频、可接受，但翻开关不是
  免费操作；
- **不设 K 档（截断预算）的理由**：① 前缀稳定的前提是**每轮回放形状
  不可变**——任何"近 K 步"截断预算都会随新内容前滑（群滑窗同款
  结构性缺陷），历史首条每轮变化 ⇒ 前缀整体重建 ⇒ 无法命中，截掉的
  token 没省下、未截部分反而从命中变 miss，**费用不降反升**；② 长对话
  的预算控制已有唯一属主 = 归档阈值（显式 replace、可审计、触发视图
  重派生，M20）——机制一职，不为同一职责引入第二个旋钮；③ 两态使
  回放形状的 golden 锁定与 UI 都减半；
- **取代 M21 D7**（原裁决"维持不实装"）；false/true 两态的回放形状
  以 golden 测试锁定。

---

## 3. 落盘格式

### 3.1 目录布局（数据根 = 启动文件夹，`AGENTCHAT_DATA_ROOT`）

```
<root>/
├── sessions/<conversationId>/messages.jsonl   消息流（append-only 唯一事实源）
│                                             summary.md    概要（compact 产物）
│                                             history_N.jsonl  归档分段（N 递增）
├── sessions/singles/<ws|ungrouped>/<sid>/     独立会话上架（叶子名 = sid，
│                                             寻址不变；索引 .shelves.json）
├── singles/<sid>/session.json                 独立会话元数据（ac-singles owning）
├── groups/<gid>/group.json + messages.jsonl   群本体 + 成员表（ac-group owning）
│                archive/history_N.jsonl + summary_N.md   群轮转分段与机械摘要
├── conversation/pending-<handle>.jsonl        待投持久化（next-turn 队列）
├── archive/<convId>/…                         全量备份域归档（ac-backup 消费）
└── usage/usage-<date>.jsonl                   用量审计流水（cache hit/miss 在此）
```

会话键校验：conversationId 禁路径分隔/遍历字符——文件名即键，无
`chat~lo~hi` 排序魔法、无 `group~` 前缀判别（规约 2）。

### 3.2 messages.jsonl 行序与版本治理【设计，M21 步骤 7】

- **会话头行**：新会话首行写
  `{"type":"session-header","version":1,"createdAt":…}`——**version:1 即
  中性格式**（§2.2，D13；头行机制未落地、无存量头行文件，v1 直接定义为
  新词表，不经 baked 中间态）。读取时无头行 = 旧 baked 格式按 §2.4
  兼容路径**宽容解析**（个人数据宁可部分可用）；解析侧对未知
  `version` 留 fail-loud 口子（宁可拒绝也不误读）。成本一个字段，换未来
  一切格式演进的锚点（src 轨道教训已在预演：trigger 解包兼容层、两种
  tool_calls 形状并存，格式演进代价全堆在读取代码里）。
- **单调 `seq`**：SessionRecord 增可选 `seq`（writer 按文件单调分配）。
  三重收益：① 归档尾锚 = 末行 seq（或 sidecar 锚文件），替代"读末 8KB
  解析末行"——对 128KB 级大行（实测最大 128.6KB）8KB 窗口必然解析
  失败、锚静默丢失；② 崩溃/丢行检测（seq 断裂 = 有损，现在不可见）；
  ③ 归档二次去重从内容匹配变序号匹配。旧行无 seq 视为缺失，行为不变。
- 头行与 seq 落地时，`stats()` 行计数须排除头行（防消息数 +1 漂移）。

### 3.3 写入语义（writer 队列【已落地】）

- 按文件串行（单写者假设：ac-session 是会话文件唯一写口）；
- WeakSet 引用幂等：同一消息对象对同一会话只落盘一次；
- 幂等固化：入队时铸造 `message_id`/`timestamp` 并**固化到消息对象**
  （重复投递至少产出同 id 行）；
- append + fsync 批量写；quiescence barrier；失败批次保序回队首；
- **fail-closed checkpoint**：`tool/before-execute` 按执行身份
  `call.conversationId` 定向 flush，落盘失败则 veto 工具执行——入站消息
  先于工具副作用 durable；
- 卸载收尾 flushAll（优雅关闭）。

### 3.4 概要与重建（replace 的落盘面）

- `compact({summary, keep})`：flush → 写 summary.md → tmp+rename 原子
  重写消息流（Windows 主场，不做硬链接发布）→ 旧队列作废；
- `deleteMessage` / `truncateAfter`（行内编辑语义）同款原子重写；
- 归档分段（ac-archive-core：message_id 去重 + 尾部水位截断不拆工具对）
  写 `history_N.jsonl`，会话流由 compact 重建为尾部 keep。

### 3.5 崩溃语义

现状：mid-run 崩溃整轮丢失（回复在 run 收束才入账）、已执行工具副作用
零痕迹——已知最大落盘弱点。设计演进方向（M22 候选，本期不做）：
**step 级增量落盘**（assistant 的 tool_calls 决策先于工具副作用落盘）+
**崩溃闭合器**（重启发现未闭合轮时追加合成行补平日志：未答复工具调用
按风险分级合成 `TOOL_NOT_STARTED`/`TOOL_OUTCOME_UNKNOWN` 结果行 +
`turn/end{interrupted}`）。

### 3.6 明确不做（对 DSH 落盘设计的取舍）

SQLite/seek 后端与投影检查点缓存（单机个人规模无查询压力）；"未知必需
事件拒绝加载"全严格读（选宽容跳过，头行留加严口子）；zstd 帧串接/硬
链接原子发布（Windows 主场，tmp+rename 已够）；chunk 打包压缩（先做
末步文本双写消除；将来做须守"压缩是编码层词汇，不是事件词汇"原则，
不污染 SessionRecord 词表）。

---

## 4. Agent 会话（对桶）

### 4.1 桶模型与信封【已落地，M19】

一切双端会话都是对桶：`conversationId = pairKey(a, b)`，自会话 = `a~a`
（对角线，机制触发统一归此——timer 自唤醒/job 完成，与用户直答桶
分离）。信封身份/拓扑分离：`sender` = 发送方端点 id、`source` =
'user'|'agent'|'event' 拓扑词、`conversationId` = 会话键；`hooks[具名]`
不进信封（扩展插件自行经 agents 查询）。串行化门 handle =
`runAddress(agent, conversationId)`：同一会话同一 Agent 至多一个 run；
忙时 steer 注入 / next-run 等闲 / next-turn 链跑（MAX_AUTO_WAKES=3 防自激）。

### 4.2 上下文视图 = 按读者的派生投影【设计，M21 步骤 2】

目标形态（统一心法 S1+S2+S3）：

- ac-conversation 的会话视图改由 **router 事件投影驱动**：订阅
  `router/message-received` / `router/reply-completed` /
  `conversation/steered`，把每个文件事件（说话人 = sender / 回复
  Agent，即存储行的 agent_id）按
  `agent_id === viewer ? assistant : user` 投影进**该桶全部 handle** 的
  视图，行形态 `{role, content, name}` 与文件派生完全一致；
- 进程内视图 = 文件事件的增量投影缓存；**重启 = 重派生**（同一函数，
  golden 对拍字节等价）；startRun 现有手工 push 逻辑退役或退化为兜底；
- 归档联动：订阅 `archive/completed` 标记该桶全部 handle stale，下次
  startRun 重派生（stale-惰性，天然避开在途 run 竞态）——归档后视图
  收缩、上下文回落 keep 预算内；
- 机制标记 run（整理）不投影（meta 判定，M20 已落地）。

### 4.3 回放与消费方

- `history(conv, { viewer })`（§2.4）是唯一回放边界；全部调用方传
  viewer = 目标 Agent：collab-tools `send_agent`（委托桶）、timer（自会话
  桶）、web-api（直答桶/独立会话）、**ac-archive 整理 run**（同桶播种，
  "你与 X 的会话"提示词天然是整理 Agent 视角）。
- 整理 run 的缓存复用（M20 已达成的 DSH 8.3 形态）：整理提示词 = agent
  system + `history(conv, {viewer})` 逐字回放 + 尾部整理指令——结构上
  前缀全命中。保持。

### 4.4 system 抖动（本期显式接受）

memory（键 = conversationId）/ datetime（日更）/ 归档 rewrite 都会变
system → 该桶一次全量前缀 reset。失效面 = 单桶、频率 = 记忆变更/日更/
归档，实测无系统性低命中（§7.4），**本期接受、后续另议**（优化方向
预留：memory 挪尾部注入等）。归档触发比维持 0.5 本期不动（M21 D6）。

---

## 5. 独立会话（singles）

### 5.1 模型：会话 = 引用 + 覆盖，不是拷贝【已落地，M18-G】

`<root>/singles/<sid>/session.json` = Agent 引用（`agentId`）+ 会话级
模型覆盖（`model?`）+ 工作区挂载（`workspaceId?`）+ 标题/状态；消息流
归 ac-session（conversationId = sid，规约 2 零新写路径）。规则：**有消息
即锁 Agent**（未选 Agent 的空会话经默认预设 `__standard__` 路由）；空白
会话全局唯一（reuse）；模型覆盖随投递信封透传（预设默认无模型时必须
靠它）。自动标题：首 run 后 LLM 一句话标题（失败回落首条消息截断）。

### 5.2 system + tools 前缀快照【设计，M21 步骤 4】

singles 是最自包含的形态（无对端 Agent、模型覆盖恒定 = 路由/缓存域
恒定），是前缀绝对稳定的最佳试点位。目标：`[system + tool schema]`
前缀对该会话**跨轮、跨重启字节不变**：

- **快照持久化**（DSH EpochHeader 子集 + fold-latest）：快照 = `{ system
  全文, 规范化后 tools schema 全集, 修订键 }`，single 创建（或首跑）时
  组装并持久化到 singles 自有目录（`session.json` 新字段或 sidecar）；
  此后每跑字节复用快照，不再重组装。快照最新胜（重拍覆盖）——只服务
  前缀复现，审计由 usage 流水兜底。
  修订键必须覆盖**装配输入全集**（persona/system/hooks/工具集/模型），
  漏键 = 静默陈旧（fail-loud：修订键计算覆盖白名单）。"换了组合历史将
  无法复现"——与 DSH agentPreset 持久化同一论证。
- **易变件出 system、追加化**（DSH M3）：datetime → **每日一条 user
  快照行**（追加，日内幂等不再注入；跨日仅追加一行）；memory → 快照按
  memory 内容哈希作修订键，变更时重拍快照（一次显式失效；M21 D4 裁决
  ——保留 system 位指令强度优先）。
- **残余失效清单**（显式枚举接受）：Agent 档案/人设编辑、生效工具集
  变化、模型覆盖修改（换缓存域）、memory 修订。
- 上下文回放/视图与对桶同一套派生投影规则（§4.2）——sid 桶只是单
  读者特例。
- 归档照常走 M20 流程（显式 replace，低频）。

---

## 6. 群组会话

### 6.1 本体与投递【已落地，M15】

- 群本体 = **仅真实发言**的 append-only 内容流（`groups/<gid>/messages.jsonl`，
  500k token 轮转 → `archive/history_N.jsonl` + 机械摘要 `summary_N.md`，
  本体重建保留尾部 30k）——无思考/工具中间态，群事实源与对桶分离；
- 投递：`send(gid, from, content)` = post 入流 → 逐参与者
  `conversation.deliver(member, <msg>包装+时间, {sender: from, …,
  conversationId: gid})`；handle = `gid~member` 每参与者独立门
  （busy = steer、idle = 新 run；fire-and-forget）；
- GroupFeed：`readSince(anchor)`/`currentAnchor` —— busy 参与者的免重复
  增量注入通道（steer 注入与视图投影同一构造点）。

### 6.2 per-viewer 投影

每个成员看到的历史是本体的**按读者投影**：

- `<msg from="…" name="…" group="…">` 包装：**唯一构造点**
  `wrapGroupMsg`（ac-group/src/view.ts——四次消息重复事故的教训：包装
  格式只允许一个构造点，锚点增量/历史回放/触发通知共用）；
- own 消息原文回显（自己说过的话不包装）；peer 消息 `<msg>` 包装；
- **相邻 peer 纯发言合并**（连续 user 稀释注意力、多占 token 的 src
  教训）：相邻同向 peer 发言合成一条，`<msg>` 标签区分说话人；
- 轮转摘要注入为头部（长期记忆锚点："本群更早的消息已归档…"）。

### 6.3 派生视图与滑窗消除【设计，M21 步骤 5】

src 平移来的尾部 `loadLimitTokens` 截断（30k）**每次回放从尾重算**：
本体每增长，截断窗头前滑 ⇒ 每轮请求的历史首条都在变 ⇒ **群请求的
历史前缀每轮整体重建**——三形态中唯一"结构性永不命中"。修法：

- 成员视图首次触发时**派生一次**（`[轮转摘要头][按预算的尾窗投影]`），
  此后本体新事件**增量投影追加**（含尾部合并块的增量合并：新事件与
  尾块同说话人则并入尾块，否则开新块——前缀仅在尾块结束符处分叉，
  损失恒定为尾部一块）；
- 视图超阈值（0.8×模型窗口，M21 D5）→ 显式重派生（可配合本体轮转的
  新摘要），一次性失效；
- 重启 = 重派生，与进程内派生同一函数 ⇒ 字节等价（golden 可测）；
- **播种视角必须 per-member**：首跑种子按各自 viewer 派生（现状缺陷
  见 §8-F2）。

### 6.4 存储统一【设计方向，差异 D11——M21 步骤 5 一并落地或列 M22】

**现状（双事实源，§8-F6 实证）**：群同时存在两个消息文件——
`<root>/groups/<gid>/messages.jsonl` 本体（GroupMessageRecord：id/from/
content/timestamp，**无 steps**；UI 群历史 `group/history` 与 historyFor
回放读它）+ `<root>/sessions/<gid>/messages.jsonl` **影子桶**（群投递经
conversation→router 全链事件，ac-session 照常入账：`<msg>` 包装 hint 行
**按成员投递重复 N 次** + 各成员 assistant 回复含 steps[]——基本无人
消费但持续增长、进备份、无轮转无归档）。

**目标形态（用户方向采纳一半）**：

- **本体迁入 sessions 树**：借既有 shelf 机制 `setShelf(gid, 'groups')`
  （终位 = `sessions/groups/<gid>/`——shelf 参数不含叶子名，叶子名恒为
  conversationId）——寻址仍是 conversationId=gid（规约 2 不破），消息流归 ac-session 单
  owning（规约 1）；退役 `groups/<gid>/messages.jsonl`，影子桶扶正为唯一
  本体。本体行 = SessionRecord 形状（中性格式 §2.2）：`from → agent_id`、
  **原文不包装**（
  `<msg>` 包装是回放投影，唯一构造点不变——落盘包装会把视角烘死进事实
  层）、assistant 行内嵌 steps[]（群成员工具卡片刷新不丢，与对桶同构）；
  入站行**只入一次**（修重复 hint：post 入本体取代按成员投递入账）。
- **per-Agent 视角文件不采纳**：视角是按读者的派生投影（S1），进程内
  视图是缓存（S3）——落成文件 = 第二事实源 + 写入放大（一条消息 × N
  成员）+ 本体轮转后全成员视角重写；DSH"投影检查点缓存"也已明确不学
  （单机规模重派生廉价，golden 对拍保证等价）。用户直觉"本体消息内嵌
  steps 即可"正确——steps 内嵌消除了视角文件的全部存在理由。
- **轮转/摘要迁移**：群 500k 轮转/30k 保留/机械摘要改走 ac-session
  compact 域（归档分段与对桶同构），ac-group 保留编排（阈值检测/触发）
  ——与 M20 归档分工同款。
- **收益**：单事实源（UI 群历史/审计 grep_history/备份统一口径）、群
  成员工具卡片刷新不丢、归档域机制复用、消灭无人消费却无限增长的影子
  桶。**成本**：UI 群历史改读 records（含 name）、GroupFeed 锚点与
  message_id 对齐、存量本体迁移脚本、historyFor 换到 session.records
  派生——建议与 M21 步骤 5（群派生视图重设计）**同批落地**，避免先修
  滑窗再迁移的两次返工。

---

## 7. KV 缓存分析

### 7.1 缓存模型与目标函数

provider（DeepSeek 等）自动前缀缓存：请求前缀与近期请求字节级一致则
命中，命中部分按缓存价计费且 TTFT 大幅下降。**命中率不是目标函数，
成本与 TTFT 才是**——因此分析对象是"结构性前缀破坏点"，不是救火式
追命中率。

请求前缀解剖：`[system][tool schema][history]`。理想不变量（S4）：每步
请求 = 上一步的字节级前缀 + 纯追加后缀（新工具结果、新助手轮、新用户
输入），唯一合法破坏 = 显式 replace（S5）。

### 7.2 八机制对照（DSH 纪律 × 本设计落点）

| DSH 机制 | 本设计落点 | 状态 |
|---|---|---|
| M1 append-only 会话 + **派生**历史 | 文件 append-only【已落地】；视图派生化（§4.2） | ◐ 步骤 2 |
| M2a system 确定性组装 | persona/framework 分块拼接，输入不变则输出确定 | ✓ |
| M2b 工具顺序规范化 | toolSpecs 缺省按工具名**字典序**（与注册顺序/插件装卸解耦；落地即一次性全量失效，接受） | ✗ 步骤 3 |
| M3 易变内容追加化 | datetime 日快照行（singles §5.2）；agent 桶 system 抖动本期接受（§4.4） | ◐ |
| M4 条件 reasoning 回传 | run 内 assistant 轮不回传 reasoning_content；steps[] 缺省不进跨 run 回放（replayTrajectory 开关可开，§2.5） | ✓（切 thinking 系模型复核） |
| M5 请求可重建不变量 | 以 golden 等价测试做轻量版（视图 ≡ 重派生，字节级） | ◐ 步骤 2/6 |
| M6 compaction 唯一破坏者 + 自身复用缓存 | 归档 = 唯一显式 replace（§3.4）；整理 run 前缀全命中（§4.3）；群视图阈值重派生（§6.3） | ✓/◐ |
| M7 计量闭环 | cacheHit/cacheMiss 入 usage 流水（M15）+ 基线查询脚本化 | ✓ 步骤 6 |
| M8 不为不存在的语义留 API | 无显式缓存标记/预热 API | ✓ |

### 7.3 各会话形态的前缀稳定性

| 形态 | system | tool schema | history | 结论 |
|---|---|---|---|---|
| 对桶（直答/委托/自会话） | persona/framework 确定；memory/datetime/归档 rewrite 会抖动（§4.4 接受） | 随注册顺序抖动 → 字典序修复 | 视角修复 + 派生等价后，逐步纯追加 | 修两处后达标 |
| 独立会话 | **快照持久化，跨重启字节不变**（§5.2） | 进快照修订键 | 同对桶 | 最佳试点位 |
| 群 | 组名/成员表确定（低频变） | 同上 | **滑窗缺陷 → 派生视图 + 增量合并消除**（§6.3） | 三形态中唯一结构性破坏，步骤 5 修复 |

**"steps 不进 LLM 回放"的 KV 成本核算（结论：不会导致低命中，反而是
成本最优解）**：

- **run 内**：ReAct 各步的 assistant(tool_calls) + tool 行**就在请求里**
  （循环内消息流逐步追加——这是 ReAct 的机制要求），步内/步间前缀完全
  共享，零损失；
- **跨 run**：对话级回放省略工具中间态。成本账：省略的 token 费用 =
  0，命中价 ≈ 0.1×，未命中 1×——**省略永远比"包含为命中"便宜**。以
  一轮 10k token 工具中间态 + 500 token 终文本为例：对话级下轮重放仅
  500 miss；轨迹级（理想字节稳定）是 10.5k 全命中 ≈ 等效 1.05k——
  命中率数字更好看，绝对成本反而更高（命中率不是目标函数，§7.1）；
- **轨迹级回放的隐性门槛**：持久化的 steps 含 transform-result 脱敏后
  的结果与 JSON 往返——与当轮实际发送的字节**必然漂移**，直接回放 =
  全量 miss + 脱敏内容回注；要做到字节稳定需 DSH M5 式请求可重建
  机制（成本远超收益）；
- **实证**：95.3% 基线中稳态 miss = 本轮新工具输出（run 内新 token，
  架构不变量）；1% 全量 miss 簇 = 空闲逐出 + §8.2-C 字节分叉——均与
  steps 省略无关；
- **真实代价是质量而非成本**：跨 run 失去自己的工具轨迹记忆（重复调
  用风险）——已按 2026-08-27 裁决升格为**可配置布尔开关**
  `session.replayTrajectory`（§2.5：**2026-10 缺省翻转开 = 质量优先
  全量展开**；显式关 = 成本最优），用户自选，取代 M21 D7"不实装"；
  K 截断档否决（截断
  破坏命中且费用反升，预算归归档阈值）。

### 7.4 实测基线（2026-08-27，`<root>/usage/*.jsonl`）

全局 9,140 run 命中率 **95.3%**；news（2,191 run）91.3%、均 miss/run
≈16k。news 逐 run 双峰：稳态定时轮 95–99%（miss = 本轮新工具输出，
架构不变量）；1% 全量 miss 簇 = 9.5h 空闲 provider 逐出 + 重启后的字节
分叉（§8-D3）。**结论：无系统性低命中，修复对象是结构性破坏点
（字节分叉、工具顺序、群滑窗、直答重启丢史），不是整体策略。**

### 7.5 观测与声明纪律

- usage 流水含 cacheHit/cacheMiss（provider 归一化：DeepSeek 顶层 /
  OpenAI·GLM 嵌套推导）；基线查询脚本化（命中率/miss 分布），每步
  落地后以真实数据对拍 §7.4；
- **KV Cache effect 声明纪律**：回放/注入相关行（session/conversation/
  group/persona/system-prompt/memory/datetime/skill）头注释声明自己对
  请求前缀的作用（None / Append-only / Prefix-stable /
  invalidate-from-X）。

---

## 8. 当前 preview 轨道与设计差异说明

### 8.1 差异总表（设计点 × 现状 × 差距 × 落地映射）

> **落地状态（2026-08-27，M21 实施）**：D1/D12/D13（步骤 1）、D2/D3/D7/F1
> （步骤 2）、D4（步骤 3）、D5（步骤 4）、D6/F2 + F6①（步骤 5 精益版）、
> D9（步骤 6）、D8 + D13 迁移脚本（步骤 7）、D14（已落地）——全部
> `pnpm preview:typecheck && pnpm preview:test` 全绿。**D11 亦已落地（当日
> 二批）**：群本体迁 sessions 树（sessions/groups/<gid>/ 经 shelf 上架，
> post → session.append[行 id 返回对齐锚点]、回复经 reply-completed 事件
> 入账[steps 内嵌]、hint 投递 GROUP_HINT_META 不重复入账）；退役
> groups/<gid>/messages.jsonl（groups/<gid>/ 只剩成员表 + 轮转分段）；
> 本体读取懒水合（historyFor/GroupFeed/records）；轮转分段归本域 +
> session.compact 重建；post/轮转 → conversation.markStale——成员视图
> per-member 单源派生（本体每增长即 stale，下次 run 由 send 的新种子
> 重派生，不落视角文件——写放大与第二事实源双双消除）。singles 归位
> sessions/singles/<ws|ungrouped>/（与运行时 syncShelves 同款）。存量
> 整备脚本 preview/scripts/unify-group-storage.ts（三源合并去重 + 归位
> + 视角桶清理）；migrate-workspace.ts 同步产出统一布局。**前端契约
> 同步落地**：GroupMessageRecord 契约透传 steps[]/reasoning（群成员工具
> 卡片与思维链刷新不丢——§6.4 收益项）；群回复经 reply-completed 订阅
> 进 GroupService 内存 log（records/锚点即刻可见，UI 群历史刷新不丢
> 回复）；webui 侧 fetchGroupHistory 按步展开（与 1v1 toHistoryMessages
> 同构：agent 步气泡[tool_calls/thinking] + 配对 tool 气泡）+
> groupMessageToChatMessage 透传 tool_calls/reasoning。实现备注：
> ① singles 快照采用「修订键锚点 + run-started 终态核验」（M5-lite）
> 而非运行时覆盖——装配链是顺序敏感的监听器组合，强行末位置覆盖需
> 行序保证；输入确定（M2a）+ 修订键覆盖 + 字节对拍告警达成同一不变量。
> ② 群 datetime 日快照行取「每信封恰一行、尾部插入」形态（内容日内
> 恒定，跨日换行），持久化累积留给 D11 单源化。③ history() 的
> viewer 缺省 = 匿名读者（中性行一律 user；旧 baked 行原 role 直通，
> 与既有行为一致）——审计/原始行走 records()。

| # | 设计点 | 现状 | 差距 | M21 步骤 |
|---|---|---|---|---|
| D1 | 回放按读者投影（§2.4，变换基址 = `agent_id`） | `history(conv)` 无 viewer 参数；a⇄b 桶回放视角颠倒（§8.2-A） | ✗ | 步骤 1 |
| D2 | 视图 = 文件事件派生投影（§4.2） | 双 handle 双视图独立积累、播种一次后永不再同步；进程内行与文件派生行字节不等价（§8.2-B/C） | ✗ | 步骤 2 |
| D3 | 重启重派生 = 字节等价 | 直答/独立会话路径**无人播种**：重启后首跑 LLM 上下文为空（§8.3-F1） | ✗✗ | 步骤 2（顺带修复） |
| D4 | 工具顺序字典序（§7.2 M2b） | toolSpecs 按 `ctx.tools.list()` 注册顺序（插件加载时序产物，HMR/装卸即变） | ✗ | 步骤 3 |
| D5 | singles system+tools 快照（§5.2） | 每跑重组装；datetime 在 system（日更失效）；memory 变更即失效 | ✗ | 步骤 4 |
| D6 | 群派生视图 + 增量合并（§6.3） | `historyFor` 逐轮全量重投影 + 尾部滑窗 ⇒ 历史前缀每轮整体重建；播种视角错位（§8.3-F2） | ✗✗ | 步骤 5 |
| D7 | 归档后视图收缩 | `archive/completed` 后内存视图不 stale（长活进程预算失效，v1 版 P2） | ✗ | 步骤 2 |
| D8 | 会话头行 + seq（§3.2；header v1 **即中性格式**，见 D13） | messages.jsonl 零版本治理；归档尾锚 8KB 窗口对 128KB 大行解析失效（锚静默丢 null） | ✗ | 步骤 7 |
| D9 | KV effect 声明 + 基线脚本（§7.5） | usage 已记 hit/miss；无声明纪律、无对拍脚本 | ◐ | 步骤 6 |
| D10 | 视角/字节/追加语义（§1-§3） | 落盘 append-only、writer 队列、幂等固化、归档唯一 replace、整理 run 前缀复用、群 `<msg>` 唯一构造点等 | ✓【已落地】 | — |
| D11 | 群存储统一：本体迁 sessions 树 + steps 内嵌、退役影子桶（§6.4） | 已落地（2026-08-27 二批）：本体 = sessions/groups/<gid>/（shelf 上架，post→append + 回复经事件[steps 内嵌]，hint 不重复入账）；groups/<gid>/ 只剩成员表+轮转分段；成员视图 = markStale + per-member 种子重派生（不落视角文件）；UI 群历史 records() 换 session.records 派生（形状不变） | ✓ | 已落地 |
| D12 | 错误行一等化 `role:'error'`（§2.3） | 错误折叠为 `[error]` 文本伪装 assistant 落盘并喂回 LLM（F7） | ✗ | 随 D13 词表一并 |
| D13 | **中性格式切换（src 语义：role agent\|system\|tool\|error\|event + agent_id，§2.2）+ viewer 变换调整（§2.4）+ 迁移** | baked user/assistant + name；虚拟端点入账特判；`[error]` 折叠；无版本锚点 | ✗ | 步骤 1+7 合并（写入侧词表/特判删除；头行 v1 = 中性；无头兼容读 + 一次性迁移脚本） |
| D14 | 轨迹回放布尔开关 `replayTrajectory`（§2.5，2026-10 缺省翻转为开；K 档否决） | 已落地：config 白名单键 + history() 消费即读（热生效）+ viewer 自己的行展开 + SettingsPanel 会话回放页 + 两态 golden。**2026-08-30 P2 收口**：键迁 `settings.session`（settingsOf 合成 + 存量键双读），UI 面收口为插件可配置项。**2026-10**：缺省翻转为开（质量优先；两处皆未配置才走缺省，显式 false 受尊重） | ✓ | 已落地（D13 后） |

### 8.2 已核验的三层回放失败（M21 §1 实证，代码复核属实）

**A｜桶内角色按"投递目标"写死，对端发起的半段对话角色颠倒。**
入账规则：入站记 `user`+name=sender、回复记 `assistant`+name=回复
Agent（ac-session/src/index.ts L180-199）。a⇄b 共享桶内，b 回放时：
b 自己发起的话是 `user name=b`（应为 assistant）、a 的回复是
`assistant name=a`（应为 user）——恰好颠倒；a 对称错另一半。user⇄agent
桶不受影响（虚拟端点永远是读者侧的"对方"，写死角色恰等于读者视角），
**这正是问题长期未暴露的原因**：主路径语义正确，委托路径才触发。

**B｜双 handle 双视图，播种一次后永不再同步。**
M19 对桶模型下 a、b 在同桶各有独立门与独立视图（`a~b~a` / `a~b~b`）；
`send_agent` 首次投递以 `session.history(convKey)` 播种（ac-collab-tools
L117-128），`contextFor` 只在视图不存在时播种一次（ac-conversation/src/
service.ts L387-394）——b 的视图此后只积累 a→b 入站 + b 的回复；b 发起
的方向进了桶文件，**永不进 b 的视图**（长活进程失忆，重启才重新播种）。

**C｜视图行与文件派生行字节不等价（跨重启缓存全丢）。**
进程内 push `{role, content}`（无 name）；且 record 固化的
message_id/timestamp 变异进消息对象，随信封 `...bodyParams` 直达
provider 请求体（ac-openai-completions L118-121）；文件回放
`{role, content, name}`。重启后首个请求在 name/固化字段处分叉 → 全量
miss（通用问题，不限 a⇄b）。

### 8.3 审核补充差距（M21 未点名，实施须一并覆盖）

- **F1（P0）｜直答/独立会话重启丢史**：web-api `conversation/deliver`
  不传 history、router 纯转发不读 session、ac-conversation 无文件兜底
  ——web 驱动的直答与 singles **重启后首跑 LLM 上下文为空**（UI 仍显示
  历史，更隐蔽）。send_agent/timer/group/archive 四路径有种子，恰是
  web 主路径没有。M21 步骤 2 的"重启 = 重派生"顺带修复，但 §8 验收门
  须补"直答/独立会话跨重启上下文连续"断言，防只修缓存不修正确性。
- **F2（P1）｜群播种视角错位**：`send` 只按 `historyFor(gid,
  targets[0])` 算一份种子发给**全部成员**——非首成员首跑以他人视角
  播种（自己的话被包成 peer `<msg>`）。步骤 5 的 per-viewer 派生视图
  修复之，测试须点名。
- **F3（P2）｜viewer 调用方清单漏 ac-archive**：M21 步骤 1 列了
  collab-tools/timer/web-api，遗漏第四个 history 消费方 triggerReview
  （ac-archive L337/L360，"你与 X 的会话"提示词天然需要 viewer=整理
  Agent）——正是 M21 风险①"视角变换漏点"的自我应验。
- **F4（P3）｜头行污染行计数**：D8 落地时 `stats()` 的 messageCount
  按行数统计会把 session-header 计入（+1 漂移）；tail() 对头行
  role 校验失败返回 undefined（无害）。步骤 7 实施清单须含 stats 排除。
- **F5（P3）｜投影规则对 system 行的直通语义**：§2.4 已补——概要头
  （role:'system'）不参与 viewer 变换；event → user；M21 §5 步骤 1 只
  写了 event 行，实施时以本文 §2.4 为准。
- **F6（P1）｜群双事实源（审核二轮新发现）**：群投递经 conversation→
  router 全链，ac-session 按 conversationId=gid 照常入账——`<root>/
  sessions/<gid>/messages.jsonl` 影子桶与 `<root>/groups/<gid>/
  messages.jsonl` 本体并存：① hint 行**按成员投递重复 N 次**（每次
  deliver 从字符串新建消息对象，WeakSet 引用幂等失效）；② 影子桶基本
  无人消费（仅 grep_history/read_history 触及）却持续增长、进备份、
  无轮转无归档（gid 无 `~`，ac-archive participantsOf 判空）；③ UI 群
  历史读本体（GroupMessageRecord 无 steps）——**群成员的工具卡片刷新
  即丢**（steps 在影子桶里，UI 不读）。修法 = §6.4 存储统一（D11）。
- **F7（P3）｜错误折叠为 assistant 文本**：`finish='error'` 时
  `[error] …` 以 assistant 身份落盘（router L145 / conversation L347）
  并进上下文视图喂回 LLM——模型自归因失真 + UI 无错误分隔符。修法 =
  §2.3 错误行一等化（随 D13 中性格式切换落地，error 是词表成员）。

### 8.4 落地顺序与验收

实施顺序 = M21 §5 步骤 1-7（回放视角 → 视图派生化 → 工具字典序 →
singles 快照 → 群派生视图 → 观测固化 → 头行/seq），每步独立可验证：
`pnpm preview:typecheck && pnpm preview:test` + 真实数据对拍 §7.4 基线。
**D13 中性格式随步骤 1（写入侧词表 + viewer 变换基址）+ 步骤 7（头行
v1 = 中性 + 迁移脚本）合并落地；D14 轨迹开关其后；D11 群存储统一并入
步骤 5 或列 M22。**关键验收门（M21 §8 + §8.3 补充）：

- a⇄b 双侧视角正确（name=自己的行全 assistant）；user⇄x 桶回放与现状
  逐字节一致（恒等门，零回归）；
- 进程内视图 ≡ `history(conv, {viewer})` 重派生（字节级；覆盖 steer/
  链跑/私信/a⇄b 双向/归档后）；**直答/独立会话跨重启上下文连续**（F1 门）；
- 归档完成不重启，同桶下一轮 ctx 回落 keep 预算内；在途 run 不截断；
- singles 跨重启 system+tools 前缀字节不变；datetime 跨日仅追加一行；
- 群连续两轮，第二轮请求前缀包含第一轮完整字节（除尾部合并块）；
  播种视角 per-member（F2 门）；
- 工具 schema 序与插件装卸/注册顺序无关；
- 新会话首行 session-header；无头行旧文件回放行为不变（兼容门）；
  seq 连续可检测；归档尾锚在 >8KB 大行下不失效；stats 计数排除头行（F4 门）；
- **中性格式（D13）**：新写文件 role 词表 = agent|system|tool|error|event
  + agent_id；迁移脚本改写后，同一桶迁移前后的 `history(conv,{viewer})`
  投影输出逐字节同构（迁移恒等门）；无头旧文件兼容读取（legacy 门）；
  虚拟端点入账特判代码删除（grep 门）；error 行不再以 assistant 文本落盘；
- **轨迹开关（D14）**：replayTrajectory false/true 两态回放形状 golden；
  config 热生效；SettingsPanel 可调可持久；无 K 档（截断即结构性 miss，
  见 §2.5）。

---

## 附录：术语表

| 术语 | 含义 |
|---|---|
| 对桶 / pairKey | 双端会话键 `[a,b].sort().join('~')`；三态：直答 `viewer~agent`、委托 `a~b`、自会话 `a~a` |
| handle / runAddress | 串行化门键 = (agent, conversationId)；同门至多一个 run |
| viewer | 回放读者端点 id；视角变换的基准 |
| 本体（群） | 仅真实发言的 append-only 内容流（群事实源，与对桶消息流分离） |
| 派生视图 | 由文件/本体事件按读者投影增量维护的上下文缓存；重启重派生，字节等价 |
| 显式 replace | 归档/轮转/快照重拍——唯一允许的前缀破坏操作 |
| golden 对拍 | 等价性测试：进程内派生 ≡ 全量重派生 / 迁移前后投影输出，逐字节比较 |
| KV Cache effect | 行级声明：本代码对请求前缀的作用（None/Append-only/Prefix-stable/invalidate-from-X） |
| 整理 run | 归档前 Agent 亲自整理的机制 run（meta 标记三处不落盘，M20） |
