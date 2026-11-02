# Super-agent 增量设计档案（cr-835，2026-11-01）

> 性质：**增量设计**（未实施）。依据 = DeepSeek Harness 团队《Super-agent 设计探索》（2026-10-31）
> 与开源原型 dsh-superagent-prototype 的调研结论（sandbox/superagent-research-report.md；
> AgentChat 侧能力面底稿 sandbox/ac-capability-inventory.md）。
> 核心裁决：**super agent 是 harness 之上的域插件，不是 harness 的替代品**——DeepSeek 原型本身即一个
> DSH bundle 插件，等于替同类架构验证了命题。本档案只做增量：三块后端 + 一块前端，零底层改动。

## 0. 为什么值得做：一个实验的启示

DeepSeek 对照实验（约 300 消息 / 20 工作请求 × 5 次）：**单 Session + subagent 工具 ≠ 双层架构**——
中性提示下模型 5 次全没委派 subagent（p95 = 29.5min），优先委派提示下仍有 1 次「任务很小自己干」成长尾；
Super-agent 双层架构 p50 = 12.4min / p95 = 15.7min。结论：**模型不稳定地委派，结构化分派要靠系统层**。
这正是本增量三块内容的公共动机：把「是否接活、派给谁、干得怎么样」从提示词纪律变成结构保证。

## 1. 外部 Source 行（事件入口，宿主树新行）

### 1.1 定位与形态

宿主树新行 `source-<kind>`（首期 `source-github`：GitHub notifications 轮询 → 信封投递；后续 `source-feishu` 等）。
职责单一：**把外部事件流翻译为信封，投进邮局**——不含任何研判/分派语义（那是域包的事）。

- **行归属**：宿主树（事件产生在宿主常驻进程，壳 idle 收割不影响轮询；与 timers-row 同位）。
- **注册中心**：`ctx.sources`（owning 包 `ac-source-core`，形态仿 ac-agents——Source 是数据不是插件）；
  每个 Source 实例 = `sources/<id>/config.json`，kind 对应实现行。实例配置 = 凭据引用（走 credentials 框架，不落明文）
  + 监听范围（仓库/话题过滤）+ 轮询周期与游标起点。
- **幂等与游标**：每 Source 持久化读游标（`sources/<id>/cursor.json`），重启不重放；Trigger 不可变，
  以 `requestId = source:<id>:<外部事件ID>` 幂等准入（信封 requestId 幂等面现成，零新增机制）。
- **翻译层纯库化**：kind 实现 = 纯库（协议/字段映射/游标推进算法，零 cordis 依赖），行内编排拉取→过滤→信封化→投递。

### 1.2 与既有机制的对齐（零底层改动的原因）

| 原型概念 | AgentChat 落点 | 既有机制 |
|---|---|---|
| Source 持有读位置 | sources/<id>/cursor.json | per-domain 数据根直读惯例 |
| Trigger = 不可变事件 + 幂等 | 信封 requestId 幂等准入 | ac-envelope-core（落账即确认）+ ac-ledger |
| Trigger fan-out 给已订阅 Ticket | 信封扇出（群聊成员流同构） | 邮局群播扇出 + groups 成员流 |
| Eval 超时重排 | Eval 超时 → 重投事件信 | goal-round 事件信同款（ac-goal 先例） |

### 1.3 首期范围

只做 `source-github` 一个 kind：notifications API（mention / PR 评论 / CI 结果）→ 信封。
IM（飞书/Telegram）暂缓——多租户凭据与人审门槛更高；GitHub 单租户、轮询式、最小可用。

## 2. Eval / Policy / Ticket / Subscription 域包（宿主树新行）

### 2.1 定位与形态

新建能力域 `ac-superagent`（宿主树行 `superagent`）：**授权工作流域包**——从 Trigger 到 Worker 的全链路领域模型。
形态对齐仓库「能力域 = 服务包 + 薄行」惯例：

- `src/core/` 纯域逻辑（零 cordis 依赖，可独立单测）——Engine 及五部件（Intake/Evals/Tickets/Assignments/Replies），
  每命令一事务；Trigger/Thread/Eval/Decision/Mandate/Ticket/Assignment/Subscription 七概念 + Rejected concepts 表。
- `src/contract.ts` / `src/events.ts`：域契约与事件目录（superagent/* 事件，@mode/@scope 标注、emit 末参永不为函数）。
- `src/service.ts`：`ctx.superagent` 注册中心 + 行 apply。
- 持久化：数据根 `superagent/` 子树（文件形态，对齐全仓无 sqlite 纪律）——triggers/threads/tickets/decisions JSONL 追加式。

### 2.2 核心域概念（借原型、按 AgentChat 词汇重述）

领域流：`Trigger →(Gate+Assessment=Eval)→ Decision → Ticket(带 Mandate) → Assignment → 壳 Agent（Worker）`

| 概念 | AgentChat 落地形态 |
|---|---|
| Eval = Gate + Assessment | Gate = 程序准入（白名单/准入表，确定性代码，Fast Path）+ Assessment = 委托主 Agent（Router）研判——**研判即一次信封投递**，Router 回答经会话面回投 Engine |
| Ticket | 授权工作单元，状态自定义（不跟随会话状态）；不映射为 Agent 或会话——是域包里的数据 |
| Assignment | Ticket ↔ 壳 Agent 绑定（pending→running→ended，一个 Ticket 可多次）；**Worker = 既有 subagent 能力面**（物化子壳 + 信封投递 + 终稿轮询） |
| Mandate | 授权凭证：Policy 版本 + scope + strength(explicit/inferred) + matched rules；不可变；只有人的 stop 撤回；恢复前按当前 Policy 重校验 |
| Subscription | Ticket↔Thread 多对多；后续人的消息直通所属 Ticket（不再过 Eval）；bot/CI 消息只作上下文、不授新权 |
| Outbox | 域内单写者，事务内 enqueue、commit 后投递——与 ac-ledger settlement 两阶段同纪律 |

关键裁决（承原型，定调即锁）：

1. **Mandate 与 Subscription 正交**：授权（能做多少）与上下文（知道多少）分离——堵「群里谁说话都驱动 Agent」的权限漏洞。
2. **Ticket 状态不跟随会话状态**：执行体可换可中断恢复，域状态自定义——与既有账本/会话分离同向。
3. **Assessment inline 进 Router 会话，不单开 LLM 调用**：AgentChat 主会话已是常驻 Router 语义，省一次独立路由
   （原型 MasterAssessor 是独立调用；此处取长——Router 批处理积压合并的特性同样适用）。
4. **proactive 默认 observation 模式**：inferred strength 接单只记录「会做什么」不执行，策略验证后再开 auto——投机执行的安全阀。
5. 不做跨 Source 身份映射（人是 Trigger 元数据；跨平台身份对应关系是提示词文本，不是实体）。
6. 不做「追加到 Ticket」的 Decision（追加 = Subscription 扇出，无需 Eval）；不从报告自由文本推断「等人」（结构化字段）。

### 2.3 接线（全部走既有面）

```
source-github 行(宿主) ──信封──▶ 邮局 ──▶ superagent Engine(宿主)
                                        │ Gate 准入（程序，快）
                                        │ Assessment = 信封投 Router 主会话（慢）
                                        ▼
                              Ticket + Mandate + Subscription
                                        │ Assignment
                                        ▼
                        Worker = 子壳 Agent（ac-shell-subagent 既有面）
                                        │ Report(progress/waiting/ready/blocked/failed)
                                        ▼
                        Replies → Outbox → 原信道回复（经 Source 行回写）
```

## 3. 任务级 Watchdog（宿主树新行，系统内嵌）

### 3.1 定位

与原型差异：原型是「主系统之外的外部 Control Loop」（独立 Watchdog Session，定时消息驱动）；AgentChat 选**系统内嵌**
形态——基础设施级监护三层（guardian 壳心跳判死 / supervisor 宿主退出码退避 / host-revive 壳拉起宿主）已在，只补
**任务进展级**一层。DeepSeek 文章的洞察：Agent 异常多数不是进程崩溃，而是模型陷入无效循环或偏离目标——进程存活
探测发现不了，需要盯「任务本身」。

### 3.2 形态：事件驱动 + 定时器，零常驻轮询

宿主树新行 `watchdog`（owning 包 `ac-watchdog`，判定逻辑纯库 `ac-watchdog-core`）：

- **进度事件订阅**：订阅 superagent/* 域事件（assignment.started / report / ticket.ended…），无事件不唤醒——
  事件驱动主路径；配合 timer 行做兜底节拍（长任务超期核查），遵守「常驻定时器懒拉起、收敛即 dispose」纪律。
- **停滞检测（纯库，阈值可配）**：event-time 停滞（超时无 Report / 超时无 turnEnded）、循环检测（同错误码重复 N 次 /
  同一步骤反复执行）、预算护栏（同 Ticket 累计 token 超阈值）、步数护栏（assignment 内步数超限）。
- **介入动作分级（全部走既有面）**：① nudge——向 Worker 投事件信「报告当前状态」；② escalate——向 Router 投
  attention 信「Ticket X 停滞，建议重派或停止」；③ stop——人的 stopTicket 语义（撤 Mandate；仅当策略允许自动停止）。
  三级都是信封投递，Watchdog 不直接操纵任何 Agent 内部状态。
- **Watchdog 自身 Agent 化**：对它投自然语言问诊信（「为什么 Ticket X 卡了」）——它读 superagent 只读投影 +
  健康面数据回答诊断；行为修正（阈值/规则调整）经 settings 面而非直改行内配置。这与 DeepSeek「Watchdog 本身是
  满配 Agent Session、可自然语言问诊」同构，但落在宿主行内。
- **诊断留痕**：每次介入在 `superagent/tickets/<id>/watchdog-log.jsonl` 追加一行（时间/触发规则/动作/结果），
  跨 Watchdog 重启可审计。
- **配置面**：settings 独立节「superagent 守护」——停滞时长/步数/token 上限/是否允许自动 stop。

## 4. 前端：superagent 面板入口（与 Agent 列表 / 会话列表同级）

### 4.1 落点（全部走既有扩展点，壳零域知识）

主侧边栏三面板机制 = `primary-sidebar:domain` 选举席（PrimarySidebarHost 按 `ui.primaryPanel × meta.panel` 选举，
零域知识；现状 agents ← ui-agents 行、sessions ← ui-singles 行）。增量：

1. **前端行 `ac-client-ui-superagent`**：新行贡献 `primary-sidebar:domain` 席位条目（`meta.panel = "superagent"`）
   + 面板组件（对齐 ui-singles/ui-runview 的贡献姿势）。
2. **uiStore 面板枚举扩容**：`ListPanelId` 加 `superagent`（activity-bar 按钮 + 持久化键校验函数同步——
   这两处是壳件内的既有硬编码面，属既定扩展点而非底层改动）。
3. **ActivityBar 按钮**：与「Agent 列表」「会话列表」同级（首个版本徽章可先接「awaiting person 的 Ticket 数」，
   口径 = Ticket stage 表 person/* 计数）。MobileTabBar 同步加 tab。
4. **数据链**：走 WS RPC（web-api 面加 superagent/* 方法组：tickets/list、ticket/detail、threads、decisions、
   watchdog/log）+ ws-bridge 下行帧（superagent/* 域事件），对齐 group/todo 的前后端接线姿势。

### 4.2 面板内容（第一版）

按原型 Panel 的「三问」组织，核心是 **只展示需要人的东西**：

- **Overview**：awaiting person 的 Ticket（stage = person/answer、person/review、person/blocked、person/failed）置顶；
  系统健康（Source 在线状态 / Watchdog 近期介入）次之；活动计数殿后。
- **Ticket 详情**：origin Trigger、Decision 与理由、Mandate scope、Assignment 历史、Report 时间线、Subscription 列表、
  Watchdog 介入记录；动作 = stop / retry（人的动作面）。
- **Thread 视图**：Thread 的 Trigger 流 + Decision 历史 + 订阅关系（谁在听这条线）。

展示词表对齐原型 stage 表（person/delivery、person/answer、person/review、person/blocked、failed、working/queued、
idle、working）——第一列等待谁的表，正是「注意力管理」的 UI 直译。

## 5. 实施顺序与验证阶梯

| 批次 | 内容 | 依赖 |
|---|---|---|
| B1 | ac-superagent 域包（core 纯域 + Engine + 存储）+ 单测 | 无——纯新增，可先以手工投递信封驱动 |
| B2 | source-github 行 + ctx.sources 注册中心 | B1 |
| B3 | watchdog 行 + ac-watchdog-core | B1（订阅其域事件） |
| B4 | ac-client-ui-superagent 前端行 + uiStore/ActivityBar/MobileTabBar 扩容 + WS RPC 面 | B1 |

- B1 单测覆盖：注册/回收/重名；Engine 每命令一事务；Gate 准入表全分支；Mandate 重校验；Subscription 扇出
  不授新权；Ticket 中断恢复。事件目录进 event-catalog 静态检查。
- 每批走验证阶梯：`pnpm typecheck && pnpm test:unit && pnpm check:deps` + 定向 lint；B4 加 `pnpm webui:typecheck`；
  动行集（row-catalog 增行）加 `pnpm test` 全量。
- 同步义务：根 README 布局段 + 本档案随实施更新；宿主/壳 boot 装配由 row-catalog 自动推导（catalog↔装配漂移测试锁定）。

## 6. 不做清单（本增量明确排除）

- 不动信封路由 / 会话状态机 / ReAct 编排——Thread 订阅留在域包内，群聊扇出已证明信封面足以表达 fan-out。
- 不做存算分离的云端形态（BYOM 远程执行环境）——remote-link 是「远程访问 AgentChat」方向相反；待真实需求出现再议。
- 不做多 Router 水平切分 / 多层过滤——单常驻 Router + 批处理在团队规模内够用（原型实验结论），超限再议。
- 不引入 sqlite——全仓文件形态纪律；JSONL 追加式已满足 Trigger/Report 的写吞吐。
