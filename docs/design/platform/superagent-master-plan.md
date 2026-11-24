# Super-agent 大计划（superagent-master-plan）

> 性质：实施计划——super-agent 能力线总纲：对标 OpenAI Dots 与 DeepSeek dsh/dsh-superagent-prototype 的差距研究结论，收敛为八线分批路线（底稿固化一批 + 安全/压缩硬前提两批 + 域层四批 + 体验一批）。
> 状态：现行 · cr-1038 2026-11-12 立项（plan）；依据与逐模块映射见 [superagent-increment-plan.md](superagent-increment-plan.md)（cr-835）与本档 §一调研底稿。
> 读者：立项与排期 super-agent 能力线的人；实施任一批次前先读本档定边界，再下潜对应批次的设计档。

---

## 〇、结论速查

| 问 | 答 |
|---|---|
| 底座够不够 | 够，且超配：信封投递/会话状态机/ReAct 编排/双进程韧性/KV-cache 纪律与对标物同构或更细（§二） |
| 差距在哪 | 域层（cr-835 四批全未实施）+ harness 两个硬前提（compaction、按 source 降档）+ 三个体验缺口（渐进披露、持久 shell、plan mode）（§三/§四） |
| dots 方向呢 | 云端执行/多信道/Agents API 均为已记录取舍；「共享产物空间（Spaces 形态）」是唯一未进任何计划的真空白（§五） |
| 先做什么 | P0 底稿固化 + 安全前置降档 → P1 compaction → P2 cr-835 B1-B4 → P3 体验线（§六） |
| 动不动底层 | 不动：所有批次都是能力行/域包/纯库增量，零信封路由/状态机/编排改动（§七不做清单） |

## 一、背景与依据

### 1.1 对标物

| 对标物 | 身份 | 证据来源 |
|---|---|---|
| DeepSeek dsh | cordis 4 系 super-agent CLI harness（npm `@deepseek-ai/dsh*`）；preset 体系（context-gate/tool-bootstrap/compaction/dev-tool-search/skill-search/plan-mode）是 harness 层对照物 | 本机 `~/.dsh/` 运行时 + 本机分析文档（KV cache / 会话落盘格式） |
| dsh-superagent-prototype | DeepSeek《Super-agent 设计探索》（2026-10-31）开源原型：Router/Worker 双层 + Trigger/Eval/Ticket/Mandate/Subscription/Watchdog 领域模型 | `sandbox/research/superagent-research-report.md`（本批 P0 固化进库，见 §五批表） |
| OpenAI Dots | DevDay 2026（2026-09-29）产品：持久 Agent（个人/Specialist Dots）+ Spaces（人机共享协作空间）+ Agents API（harness/多智能体控制/计算机操作开放给开发者） | web 检索（InfoQ / 4sysops 报道，2026-10 月） |

### 1.2 已有研究底稿（本计划的上游）

| 底稿 | 位置 | 状态 |
|---|---|---|
| cr-835 增量设计 | [superagent-increment-plan.md](superagent-increment-plan.md) | 现行·未实施（B1-B4 均未立项） |
| 原型调研报告 | `sandbox/research/superagent-research-report.md` | 不入库，gap-backlog §五.8 挂账 → 本计划批 P0 固化 |
| 能力面盘点 | `sandbox/research/ac-capability-inventory.md` | 同上 |

核心承袭裁决（cr-835）：**super agent 是 harness 之上的域插件，不是 harness 的替代品**——DeepSeek 原型本身即一个 DSH bundle 插件，替同类架构验证了命题。本计划不推翻、只增量：补 harness 硬前提与体验线，域层仍按 cr-835 执行。

## 二、底座已覆盖项（勿重复建设）

| 能力 | AgentChat 落点 | 对标物对应 | 判定 |
|---|---|---|---|
| Worker 层 | `packages/ac-shell-subagent`（物化子壳 + 信封投递 + 终稿轮询） | worker-Session + 专属目录 | ✅ 基座现成 |
| 异步全双工 | steer 注入 + inbox 双队列 + jobs 唤醒 + ask_questions 挂起 | start()/stop() 异步工具 | ✅ 形态不同、语义等价 |
| 存算分离（进程/状态层） | 状态全落盘 + 壳无状态 + idle 收割 + remote-link 远程面 | 状态进库、执行留原机 | ✅ |
| KV-cache 纪律 | datetime 表尾收尾 / memory checkpoint·delta / todo·goal 消息面 / run-code-core 字典序投影 | dsh 每包 KV Cache effect 声明 | ✅ 同一纪律 |
| 事件溯源账本 | `ac-ledger` messages.jsonl append-only + settlement 两阶段 | dsh session.jsonl.zstd seq 连续 | ✅ 同构 |
| 进程韧性 | guardian + supervisor + host-revive | dsh runtime 换代 | ✅ 各有千秋 |
| 外部 harness 委托 | `ac-harness-tools.run_harness`（Claude Code/Codex CLI） | Dots「个人 Dot 调 Codex」 | ✅ 形态已能表达 |
| 审批链路 | needPermission 双轴 + durable-interaction approval kind + UI 审批卡 + write-ahead | dsh approval 栈 | ✅（复核项 gap-backlog §A.2c 仍开放） |

## 三、差距清单（按层）

### 3.1 域层（cr-835 已设计、未实施）

| 批 | 内容 | 缺口性质 |
|---|---|---|
| B1 | ac-superagent 域包（Trigger→Thread→Eval→Decision→Ticket→Assignment→Worker 领域模型 + superagent/ 数据根子树） | ❌ 未建包 |
| B2 | source-github 行 + ctx.sources 注册中心（notifications 轮询→信封） | ❌ 外部事件入口零命中 |
| B3 | 任务级 Watchdog（停滞/循环/预算检测，nudge→escalate→stop） | ❌ 基础设施级监护已在，任务进展级缺 |
| B4 | ac-client-ui-superagent 前端行 + ActivityBar 面板 | ❌ |

依据：DeepSeek 对照实验（约 300 消息/20 工作请求 ×5 次）——单 Session + subagent 工具 ≠ 双层架构（中性提示下 5 次全没委派，p95 29.5min vs 双层 15.7min）；结构化分派必须靠系统层。

### 3.2 harness 层硬前提（cr-835 未覆盖）

| # | 缺口 | 对标物 | AgentChat 现状 | 为何是硬前提 |
|---|---|---|---|---|
| H1 | 会话压缩 compaction | dsh compaction-basic + tool-result-pruner + epoch 感知（compaction 后「第二个首请求」重走锚定，状态从持久事件推导） | `ac-archive-core` 是归档（移出上下文）非压缩（折叠成摘要、任务继续） | Worker 长任务几百轮工具循环、Router 常驻跑数天的共同硬前提；归档丢任务中间态，压缩保连续 |
| H2 | 按 source 降档 | 原型 Gate/Policy 结构化准入；dsh approval 栈 | gap-backlog §A.1 开放：full 档 Agent 被 source=agent 消息触发的 run 不降档，只有 prompt 级软缓解——「系统整体强度 = 可达 Agent 最高档」 | 外部 Trigger 驱动 Router→Worker，信封来源不构成降档依据 = Mandate 授权语义被架空；seam 现成（router/before-deliver / loop/before-run） |

### 3.3 harness 层体验缺口

| # | 缺口 | 对标物 | AgentChat 现状 | 独立收益 |
|---|---|---|---|---|
| E1 | 工具/技能渐进披露（tool-search 模式） | dsh dev_tool_search + skill_search/skill_load（catalog 全量注入在场 0/9 锚定 vs 去掉 ~81% 锚定，issue #6 实测） | 技能目录 cr-1249 起改 before-run 指纹注入（变化才落 context 行——已非 system 常驻）；llmToolFace 全量给模型；run_code 投影全量 | 特性面增厚（133 包、工具数十）下每轮 schema+catalog 成本线性涨；目录当索引用、正文按需取（cr-1284 实施档：[tool-schema-progressive-disclosure-plan.md](tool-schema-progressive-disclosure-plan.md)） |
| E2 | PTY 持久 shell | dsh bash-persistent（PTY 会话跨调用、terminal 注册中心；Windows 降级 custom-bash） | bash/pwsh 每次 spawn 独立进程（grep PTY 零命中），env/cd/venv 每轮重来 | 编码型 Worker 体验 + token 成本；沙箱词法扫描需新增「状态逃逸」防御面 |
| E3 | plan mode | dsh plan-mode（只读探索→exit_plan_mode 提交→人批→动手；工具目录跨模式不变保 KV） | 全仓 grep `plan.?mode|exit_plan` 零命中；ask_questions 不等价（无只读约束、无模式状态机） | 人的注意力管理：先看计划再授权比看结果再收拾便宜；可与 Ticket person/review 阶段合并设计 |

## 四、产品形态差异（对照 Dots）

| Dots 特性 | AgentChat 现状 | 判定 |
|---|---|---|
| 云端自己的计算机（Dot 云上跑，不依赖用户机器） | 本机进程（desktop/mobile 壳）；remote-link 方向相反（远程访问 AgentChat） | 有意不做（cr-835 §6 排除，待真实需求重启裁决） |
| 异步多信道（Slack/Teams/邮件，身份跨信道连续） | Source 行（B2 首期仅 GitHub，IM 暂缓：多租户凭据与人审门槛） | 缺、已规划、范围保守；跨平台身份映射原型明确拒绝（与 Dots 取舍相反但自洽） |
| Spaces（人 + Agent 共享页面/任务/文档/原型） | 群聊（对话态协作）+ workspace（文件浏览），无产物级共享空间 | **真空白**——唯一未进任何计划的缺口，开放裁决（§八.4） |
| 全天候工作、主动建议 | timer 定时/随机巡检 + goal 自动逐轮 + idle 归档 | 部分覆盖：缺环境事件驱动（=B2）与投机执行 observation 模式（=B1 裁决 4） |
| Agents API（harness/多智能体控制开放给开发者） | 插件 v2.1 开放的是扩展面（包即插件 + ac plugin CLI + npm 分发），非消费面 | 方向差异（终端用户产品 + 插件生态 vs 开发者基础设施），非缺口 |

## 五、批次切分（P0→P7 八线）

> 依赖图：P0 独立；P1 → P3（安全前置）；P2 ⊥ 域层（可与 P3 并行）；P3→P4→P5→P6 串行（cr-835 既定序）；P7 三子项独立。

| 批 | 内容 | 依赖 | 测试标准（过程门） | 验证目标（目的态） |
|---|---|---|---|---|
| P0 底稿固化 | 调研报告与能力盘点自 `sandbox/research/` 固化进 `docs/design/platform/`（-survey 体裁，头部三行 + 结论速查节），gap-backlog §五.8 闭环 | 无 | `node scripts/cr.mjs check`；新文档路径全仓 grep 无断链 | 底稿入库、换机不丢；cr-835 立项依据可追溯；gap-backlog §五.8 标 ☑ |
| P1 安全前置（H2） | 按 source 降档：full 档 Agent 被 source=agent/event 信封触发的 run 降档执行（seam：router/before-deliver / loop/before-run）；降档事实入账本可观测 | 无 | typecheck + test:unit + check:deps + 定向 eslint；动会话链路 + test:integration | gap-backlog §A.1 可标 ☑；外部信封无法驱动 full-access 执行；降档事实账本可查 |
| P2 compaction（H1） | 新纯库 ac-compaction-core（折叠算法 + 阈值 + KV 边界处理）+ 壳树新行（compaction/end 边界事件 + 手动命令 + 自动触发）；epoch 语义：压缩后注入面重走门控，状态从持久事件流推导、重启安全 | 建议 P1 后 | typecheck + test:unit + check:deps + 定向 lint；动行集 + `pnpm test` 全量 + gen-row-catalog（动基座文档） | 数百轮工具循环会话可续跑不撞窗口；压缩边界事件入账本可回放；压缩后首轮注入面与首请求同构（无静默漂移）；Router 常驻会话前提成立 |
| P3 域层 B1 | ac-superagent 域包（cr-835 §2 全量：core 纯域 + Engine + 存储 + 事件目录） | P1（授权语义闭合） | cr-835 §5 B1 验收清单（注册/回收/重名、每命令一事务、Gate 全分支、Mandate 重校验、Subscription 扇出不授新权、Ticket 中断恢复） | 原型领域模型全量落地；手工投递信封即可驱动全链路（不依赖 B2） |
| P4 域层 B2 | source-github 行 + ctx.sources 注册中心（cr-835 §1） | P3 | 同上风格 + gen-row-catalog | GitHub mention/PR 评论/CI 结果可触发信封→Engine；游标持久化重启不重放；requestId 幂等准入生效 |
| P5 域层 B3 | watchdog 行 + ac-watchdog-core（cr-835 §3） | P3 | 同上风格 | 停滞/循环/预算三类检测各有事件驱动路径；nudge/escalate/stop 全走信封投递零内部操纵；介入留痕可审计 |
| P6 域层 B4 | ac-client-ui-superagent + uiStore/ActivityBar 扩容 + WS RPC 面（cr-835 §4） | P3 | 同上 + webui:typecheck + build:channel | Overview / Ticket 详情 / Thread 三视图可用；「awaiting person」置顶——注意力管理 UI 直译 |
| P7 体验线（E1/E2/E3） | E1 渐进披露（先 run_code 投影按需展开，再工具面解锁机制）；E2 PTY 持久 shell（含沙箱状态逃逸设计）；E3 plan mode（可与 person/review 合并设计） | 独立；E1 建议先行（最小落差） | 各子项独立立项，测试标准随子项 | 模型首请求 schema 面可收敛；长会话 shell 状态跨调用保持；「先计划后实施」成为可授权工作流 |

## 六、优先级依据

1. P0 最便宜且解 gap-backlog §五.8 挂账——先做。
2. P1 安全前置不修，P3 的 Mandate 授权语义是漏的——域层之前闭合。
3. P2 与域层无依赖冲突，Worker 长任务与 Router 常驻的共同前提——可与 P3 并行推进。
4. P3-P6 按 cr-835 既定序（B1→B2→B3→B4）。
5. P7 三子项独立收益、不与主线互卡；E1 落差最小先做。

## 七、不做清单（本计划明确排除）

承 cr-835 §6 全部条目，增量排除：

- 不动信封路由 / 会话状态机 / ReAct 编排——Thread 订阅留域包内。
- 不做云端执行环境（BYOM 云 VM/沙箱供给）——待真实需求重启裁决。
- 不做多 Router 水平切分 / 多层过滤——单 Router + 批处理在团队规模内够用。
- 不引入 sqlite——全仓文件形态纪律；JSONL 追加满足 Trigger/Report 吞吐。
- 不做跨 Source 身份映射——人是 Trigger 元数据，身份对应是提示词不是实体（原型 Rejected concepts）。
- 不做 Agents API 消费面——产品定位差异，非缺口。

## 八、开放裁决

| # | 事项 | 缺省取向 |
|---|---|---|
| 1 | P2 compaction 行归属（壳树拦截行 vs 新能力域）与 KV 边界细节 | 实施批定；对齐 ac-archive 行位次与「状态经消息面」纪律 |
| 2 | P1 降档的档位映射（source=agent / event 各降到哪档） | 实施批定；保守取向 = agent 触发降至审批档、event 触发降至 base，除非会话键 grants 显式提权 |
| 3 | E1 渐进披露的解锁状态持久化形态（账本事件 vs 会话键） | 实施批定；对齐 dsh「解锁记录进持久事件流、resume 安全」语义 |
| 4 | Spaces 形态共享产物空间是否立项 | 缺省不做；触发条件 = 用户真实协作场景出现（群聊 + workspace 已覆盖单机对话态与文件态） |

## 九、同步义务

| 动作 | 同步点 |
|---|---|---|
| 本档立项 | cr-log（cr-1038，plan）；实施批动工时逐批翻 doing |
| P0 落地 | 底稿新路径回写本档 §1.2；gap-backlog §五.8 标 ☑ |
| 各批立项 | 本档批次表注 cr 号；cr-835 状态行随 B1-B4 实施更新 |
| 实施完成 | 本档归档 `archive/platform/`；cr-835 同批处置（已实施待归档） |

> 变更登记：cr-1038 2026-11-12 立项（plan）。
