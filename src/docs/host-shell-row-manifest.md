# 宿主树 × 壳树 · 行集清单 v3（设计规格）

> 性质：设计规格（preview 开工输入），只陈述终态。定向论据 / 判例 / 推演 /
> 演进史住裁决簿：host-shell-decisions.md——正文不重复「为什么」。2026-10-15
> v3（设计 / 裁决分离重写，v2 废弃）。依据：per-agent-instance-architecture.md
> （R-1…R-12、D1–D10）+ shell-model-unification.md（S0–S5、M1–M6）。现状
> 事实源：src/cordis.yml（活跃 100 行）与 ac-app TREE（两表锁定一致）。行集
> 口径：基座行两树各计；拆分件按「面」计。重构期不保持旧行集兼容——行集
> 按新架构自由重排。

# R0. 分类判据

## R0a. 树归属（决策树，按序问）

1. 行内有 **LLM 循环 / 工具执行 / run 编排**吗？→ 有：**壳**（agent 代码零宿主驻留，S2）。
2. 行是 **webui / 传输 / 可视化** 吗？→ 是：**宿主**（webui = 宿主自有服务）。
3. 行是 **授权资产的写者面**（授权变更 / 凭据授予 / 插件装载裁决）吗？→ 是：
   **宿主**（授权注册表宿主单写，D3 修订）。
4. 行是 **agent 数据的编辑面**（人格 / 档位 / 会话设置的用户编辑入口）吗？→ 是：
   **宿主**（谁塑造谁写，R-6）——数据本体在数据根，壳侧直读。
5. 行是 **账本 / 会话状态机** 吗？→ **壳**（写权 = 所有权，D4；宿主侧只读投影 =
   webui 读面，走文件系统只读，无需驻留行）。
6. 行是 **定时唤醒 / 群播扇出 / 计费聚合 / 归档备份** 吗？→ **宿主**（宿主自有服务，D3）。
7. 两面都有（工具面在壳、数据 / 执行在宿主）→ **拆分件**（R5）。

## R0b. 行资格（立行充要条件）

三问按序，**任一「是」即立行**；皆否 → 纯库 / boot 编排 / 行内模块 / 数据：

1. **服务插槽**：提供跨行消费的运行时服务（ctx.&lt;key&gt; 注入面 / RPC 端点），
   存在独立消费方？（纯库的 import 消费不算。）
2. **良定义降级**：摘除该行，依赖方以明确定义的降级形态继续运行？（插槽-插头
   验收：摘一行 = 摘一个能力域，不是搞坏系统。）
3. **独立装载档位**：按行粒度选择装 / 不装，是有意义的产品或工程决策？

判例五则（锁 / 指纹 / 授权投影 / 群拓扑 / Agent 在场性）与原理：裁决簿
〈行资格判例〉。tag 机制解体判例（七职能归位）：裁决簿〈tag 机制解体〉。

# R1. 宿主树（48 行 = 基座 3 + 核心新增 3 + 身份编辑面 3 + 数据服务 6 + 传输/web 4 + 插件治理 3 + 远程 1 + ui 域行 25）

| 组 | 行 | 包 | 角色 | 来源 |
|---|---|---|---|---|
| 基座 | logger-console / timer / config | cordis-logger / cordis-timer / ac-config | 日志、fiber 定时（timers 依赖）、配置 | 沿用 |
| 新增 | post-office | ac-post-office | **邮局**：投递路由 + uuid 登记校验 + 群播扇出（吸收 group 拓扑的执行面）+ 发件箱滞留中继 | **新增**（ac-router 投递面 + ac-group 扇出面承接） |
| 新增 | guardian | ac-guardian | **监护**：按需拉起（三节拍，verify = 指纹对拍）/ 心跳监视 / idle-exit 收割 / 崩溃退避熔断 / 宿主重启入口 | **新增**（吸收 restart） |
| 新增 | auth-registry | ac-auth-registry | **授权注册表写者**：全局 + per-agent 两层、children 投影构造、凭据授予 / 轮换、授权目录数据；**preview 侧落地（cr-545，2026-10-19）= ac-host-rows/auth-registry-row.ts（grant 信受理协议 E + 凭据写面 + F2 分立 auth/* 编辑面六方法；写者面纯库 = ac-auth-core write.ts + mcp.ts；HostInbox 收信扇出组合器与 usage 行共存）** | **新增**（ac-security 裁决面 + credentials 写者面 + workspace 授权数据重组） |
| 编辑面 | agents | ac-agents | 身份编辑面：config / entries / 文档唯一写口 + 模板目录（吸收 agent-store 写引擎 + agents-dir 布局 + agent-presets 目录）；活注册表解体——配置轴 = 文件文集、在场轴 = guardian 可达表；**preview 侧落地（cr-540，2026-10-19）= ac-host-rows/agents-row.ts（AgentsEditService：config/entries/文档/头像唯一写口 + 模板创建 skip-if-present + transient 合成）** | 改造 |
| 编辑面 | preset-builtin | ac-agent-presets-builtin | 内置模板数据行（包目录静态 Agent 配置文件集）；**preview 侧落地（cr-540）= ac-host-rows/templates/ 静态配置集 + preset-builtin.ts 读面（行缺席 = 模板面良定义降级）** | 改造——裁决簿〈注册表解体〉 |
| 编辑面 | agent-admin | ac-agent-admin | webui 写侧 RPC 编排（agent CRUD → agents 编辑面）；**preview 侧落地（cr-542，2026-10-19）= ac-host-rows/agent-admin-row.ts（六方法 agents/get-config·create·update-config·delete·save-doc·read-doc——写面词汇住 ac-agents-core/write.ts；cr-552 收口装配面三方法：agents/system-prompt 装配预览〔装配链住壳进程——经编排面控制帧往返壳内三档链干跑，boot control preview 帧〕+ agents/assembly 视图〔壳内工具目录投影 + 宿主 plugins/settings 合成〕+ agents/assembly/update 写口〔applyAssemblyPatch 纯函数住 ac-agents-core/write.ts，宿主本地落盘〕；编排面缺席 = 预览读面 fail-loud、六 CRUD 照常〔良定义降级〕）** | 沿用 |
| 数据服务 | timers | ac-timer | 定时唤醒（唤醒 = 投递信） | 沿用 |
| 数据服务 | usage | ac-usage | 计费聚合（对账 ledger 自报事件信；另收 job 观测快照镜像） | 改造 |
| 数据服务 | ~~archive~~ | — | **已改树（cr-546，2026-10-19，裁决 D11「全壳内」）**：归档编排（阈值检测/整理 run/归档重建）全链住壳——整理 run = LLM 编排只能住壳（R0a 判据 1，与 session-query 同判据）、归档重建 = 写归属 agent 账本（D4 写权 = 账本所有权）；宿主零 archive 职责，timer 的 archive-all 机制任务改批量唤醒信（宿主只发信——A13/D11）。已移入 R2 域服务（宿主 46→45 / 壳 35→36，总数 81 恒等） | 改树（D11） |
| 数据服务 | singles | ac-singles（preview 形态 = ac-host-rows/singles-row.ts + ac-ledger 管理面） | **独立会话元数据写面**（cr-566）：owns `users/user/sessions/<sid>/session.json`（agentId / title / workspaceId / status / 时间戳——模型覆盖仍走 conv-settings，D12）；`singles/list|create|update|fork|archive|delete` 六方法 + `singles/updated` 帧广播（args=[session, created|updated|archived|removed]）；fork = 锚点前账本恒等拷贝（ac-ledger manage.ts）；删除 = 该会话全部账本 + 元数据 + 覆盖一并清 | **新增**（cr-566——会话工作面补全） |
| 数据服务 | conv-settings | ac-conv-settings | **会话级覆盖写面**（模型 / 工具档 / 实验键）：写者单源 = 宿主 web RPC（输入框模型菜单、设置面板），壳经数据根垫片只读直取（cr-565，2026-10-22）。模型覆盖经 deliver 合并点随信封投递（显式入参 > 存盘覆盖），壳内 run 装配按信封 model 取 provider/model | 改树（cr-565——写权 = 用户动作面住宿主；读面壳垫片） |
| 数据服务 | group | ac-group（preview 形态 = ac-host-rows/groups-row.ts + ac-post-office 扇出） | **群存储写面**（cr-576，2026-10-22）：owns `groups/<gid>/group.json`（GroupConfig 成员表 + 名称/简介）；`group/list|create|delete|join|leave|rename|set-description|send|history` 九方法 + 六变更帧广播（group/created 等 → 前端列表刷新）+ group/message-posted；send = **信封扇出**（除发送者外每成员一封，uuid = 成员流键 `gid~<member>`——主线 memberStreamKey 同形；不可达走发件箱 + ensureHook 拉壳转投）；history = 全成员流合并读面（跨流同 requestId 去重 + 成员终稿各留各）；多发送方 uuid 登记 = 群行按全名册（members ∪ user）预登记每条成员流 + registry 子集一致校验（cr-576——conflict 只拦名册外端点） | **新增**（cr-576——group 域 RPC 收口） |
| 数据服务 | backup | ac-backup | 数据轴备份 + 快照链 GFS（分轴共行） | 改造（吸收 snapshot-chain） |
| 数据服务 | ~~session-query~~ | — | **已改树（cr-544，2026-10-19）**：会话查询是**工具行**（grep_history / read_history），按 R0a 判据 1 工具执行只能住壳——已移入 R2 工具面（宿主 47→46 / 壳 34→35，总数 81 不变） | 改树 |
| 传输/web | web-server / ws-bridge / webui / web-api | ac-web-* | 传输基座 + 桥接 + web 表面 + RPC 编排；**webui = 单包表面**（src/ 服务半边 + client/ 前端半边含骨架资产——裁决簿〈骨架归并〉）；会话历史读 = 文件直读，流式 token = 宿主转发（〈webui 读投影〉） | 沿用 |
| 插件治理 | plugin-registry | ac-plugin-registry | 装载裁决 + 熔断闸门 + 动态插件行集条目注入（install = 授权动作 → 壳行集，第三方代码零宿主驻留）+ 宿主行集偏好急救 RPC（写偏好文件，恒冷生效——〈patch 机制退役〉）+ client 半边 manifest 注入（〈插件 client 通道〉）；**preview 侧落地（cr-543，2026-10-19）= ac-host-rows/plugin-registry-row.ts（PluginRegistryHostService：staging 人审复用 ac-plugin-core 纯库 → 批准物化 `<dataRoot>/plugin-rows.json` 插件行集条目 → 壳 boot 合并派生化 → 壳内动态装载；熔断 fail-closed 剔除行集条目 + `rows/*` 急救 RPC 恒冷生效 + `plugin/updated` 变更帧；本行不 import 任何插件代码）** | 改造（吸收 patch-rpc + plugin-gates；patch 热通道与 patch-rpc 形态退役） |
| 插件治理 | plugin-market / event-policy | ac-plugin-market / ac-event-policy | 市场 + 事件策略（全局治理门）；**plugin-market preview 侧落地（cr-543）= 零改动导入（inject ['webServer','pluginRegistry']——市场安装流= staging 人审入口，装载裁决归 plugin-registry 行）** | 沿用 |
| 远程 | remote-link | ac-remote-link | 远程链路 | 沿用 |
| ui | ui 域行 ×25 | ac-client-ui-* | 域卡片行（卸载 → 该域卡片回落文本渲染）；id 清单以 yml 为准（31 − 骨架 6；骨架经 ui 树解构为协议 3 件入 ac-webui，conversation/settings/tool 转模块资产——ui-tree.md §2）；**25 域行已 manifest 声明化上通道（cr-533，2026-10-19）——preview/apps/ui/channel/ 通道包 + channelImports 深路径外部化（共享基座 importmap 单例契约），生成器 --check 对账** | 已声明化（cr-533） |

# R2. 壳树（36 行 = 基座 2 + 账本会话 3 + 模型编排 3 + 装配链 3 + 任务追踪 2 + 工具面 16 + 域服务 6 + 评测 1）

> cr-520（2026-10-18）勘误：dev-tools 行剔除（宿主开发工具——热重载/日志导出属
> 宿主运维面，R0a 判据 6 归宿主；壳行集无对应消费面）。工具面 16→15。

| 组 | 行 | 包 | 角色 | 来源 |
|---|---|---|---|---|
| 基座 | logger-console / config | cordis-logger / ac-config | 日志、配置（timer 基座不进壳树——裁决簿〈timer 归属〉） | 沿用 |
| 账本会话 | ledger | ac-ledger | **账本**：messages.jsonl + journal + inbox 消费 + settlement + usage 自报（journal 计量 + 事件信） | **新增**（ac-session 机制改 per-agent 账本语义；吸收 usage-report） |
| 账本会话 | conversation | ac-conversation | 会话状态机：串行化门 + inbox 双队列（next-step / next-turn）+ 防自激 budget（信封携带）+ user 端点桩（激活仪式化，R-2）+ 信封面 → ctx.agentLoop 全量真身驱动（M8.2/cr-523：preview 侧 ac-shell-conversation 服务面落地；主线 router 的请求装配半边吸收进壳内；M8.4/cr-525：终稿回复恒投回 sender〔R-2 一次普通 send〕——user 终稿经邮局 local 通道回链 user 账本） | 改造 |
| 账本会话 | tools | ac-tools | 工具注册基座 + **授权门**（ac-auth-core 投影，每 run 前重读；M8.6/cr-527 preview 侧落地：gate.ts 伴生件——loop/before-run 投影缓存失效 + tool/before-execute MCP 服务器资产硬闸 fail-closed；「装了即可见」= 第一方行工具无第二闸〔声明面 = 行集引用，A7〕；children 物化快照域直读） | 改造（吸收 security-exec） |
| 模型编排 | llm / llm-pool / agent-loop | ac-llm 族 / ac-agent-loop | 模型会话 + 连接池（凭据直读数据根，R-11 ③）+ ReAct 编排 | 沿用 |
| 装配链 | persona / system-prompt / memory | ac-persona 等 | 装配链（persona 身份数据只读；memory 经验数据本壳写） | 沿用 |
| 任务追踪 | goal / todo | ac-goal / ac-todo | 任务追踪 | 沿用 |
| 工具面 | 16 行 | fs-tools（含 file-snapshots 服务并入——cr-520 装配伴生）/ fs-search / str-replace-editor / shell-tools / run-code / math / web-tools / browser（web 同包双行）/ issue-tools / harness-tools / sap-adt / datetime / skill / collab-tools / mcp / **session-query**（cr-544 改树入壳：只搜自己——本 agent 账本只读回放，D10 收口；preview 侧 ac-shell-rows/session-query.ts） | agent 工具面（MCP 照 R-12；issue / harness 令牌链直读 credentials 纯库；sap-adt 吸收 preset 子行；tag 门禁词全链退役——装载 = 行集引用，行内档位 = 行自身词汇，裁决簿〈tag 机制解体〉） | 沿用 |
| 域服务 | ~~conv-settings~~ | — | **已改树（cr-565，2026-10-22）**：会话覆盖的写权 = 用户动作面（输入框模型菜单 / 设置面板）→ 行移宿主数据服务组；壳侧改由数据根垫片（shims.ts 的 ConvSettingsShim）提供只读 get / registerKey / listKeys——harness-tools 的 harnessTier 注册面照旧，壳不写盘（宿主 45→46 / 壳 37→36，总数 82 恒等） | 改树（cr-565） |
| 域服务 | archive | ac-archive-core + 壳内编排 | **归档编排**（D11 全壳内，cr-544 前住宿主数据服务组——cr-546 改树）：阈值检测（loop/after-run 订阅 + estimateReplayTokens 回放口径）→ 整理 run（conversation.reviewRun 机制投递面——不落账不进上下文、meta[archive-review] 三不语义、maxSteps 硬闸）→ 归档重建（splitForArchive 分割 + ledger.compactFor——分段 archive/history_N.jsonl + 尾锚 sidecar + B1 窗口基线 + summary.md 概要滚动〔Agent 亲写优先 / 回退回复文本〕）；archive-all = 唤醒信（payload.mechTask 键）触发壳内 archiveAll（枚举本域 sessions/ 逐桶判定）；preview 侧落地 = ac-shell-rows/archive.ts（ArchiveShellService；算法复用主线 ac-archive-core 纯库零改动） | 改树（D11——cr-546） |
| 域服务 | subagent | ac-subagent | 子 Agent（R-5：children 嵌套物化 + spawn ⊆ 授权投影；M8.3/cr-524：preview 侧 ac-shell-subagent 落地——真子壳进程 + 信封投递多轮 + subagent 工具面，主线行 cutover 退役回收名） | 改造 |
| 域服务 | plugin-dev | ac-plugin-registry（工具面）+ ac-plugin-core（纯库） | **插件开发三件套**（cr-553，8.9 前置余件②收口——cr-540 遗留②）：register_plugin / install_plugin / unregister_plugin 三工具住壳（R0a 判据 1 工具只能由壳内 agent-loop 执行；主线 ac-plugin-registry 行拆两半——工具面归本行，安装态写者归宿主 plugin-registry 行）。形态：register = 会话级装载壳内自持（ctx.plugin dynamic import——cr-543 assemblePluginRow 同款，重启即失零宿主参与）；install/uninstall 永久档 = M11 语义化中断上报意图 → loop/after-run 收束检测 → plugin-request 信封（envelope-core 新 schema）→ 宿主 HostInbox 受理（免审安装 = stage+approve 主线 installFromDir 文件域语义 + 幂等对账；卸载 = uninstall）→ 回执信（receipt 落原会话）+ 续跑信（message 驱动下一轮——主线 receiptAndRetrigger 同义）；本壳内 install 后立即会话级装载（装好即可测试主线产品语义保住）。preview 侧落地 = ac-shell-rows/plugin-dev.ts + ac-host-rows/plugin-registry-row.ts 受理面；壳 36→37（总数 81→82——全新行） | **新增** |
| 域服务 | durable-interaction / ask-questions | ac-durable-* | 交互承重（数据化 boot；审批 = user 端点消息） | 改造 |
| 域服务 | jobs | ac-jobs | 后台任务基座（worker = 壳子进程；完成 = 进程内事件直投 inbox；跨壳走邮局信；观测自报快照信——裁决簿〈jobs 归属〉） | 沿用（吸收 job-wakeup） |
| 评测 | bench | ac-bench | 评测域（影子壳跑 bench 门，R-8 快速通道） | 沿用 |

# R3. 非行形态

## R3.1 纯库（5 + 1 降格）

| 纯库 | 内容 | 消费方 |
|---|---|---|
| ac-envelope-core | 信封 schema + requestId 去重 + budget 语义 + 确认状态机（协议规格 A）；ipc 长度前缀帧（B2，或并入 ac-ws-protocol 扩展） | post-office / conversation / ws-bridge |
| ac-fingerprint-core | Merkle 内容树 + 规范化 + 子指纹（R-7）——两形态同根断言的物理载体 | guardian verify 节拍（宿主）+ 壳 boot stdout 自报 |
| ac-auth-core | 授权投影算法（授权草稿 C） | 壳 tools 门（每 run 前重读现算） |
| ac-agents-core | AgentConfig 契约 owning + 词汇纯函数（tierOf / toolModeOf / resolveToolNames / narrowToolsByMode / displayNameOf）+ settingsOf 纯函数化 + agents/&lt;id&gt;/ 树直读 + children 嵌套解析（R-6 直读第四层） | 壳 run 前重读（装配链 / 门 / subagent）+ 宿主编辑面词汇共用 |
| ac-rowset-core | 行集推导器：AgentConfig（tools 点名 + 行引用——tag 展开退役，行集谓词：点名工具 ∨ 引用行名；fs / infra 类捆绑词在派生内消解）× 全局行集目录（cordis.yml 降格为全集目录）→ 壳行集派生清单；+ 行目录静态投影（per-agent 化——目录只出现该 agent 行集内的词，编辑面与壳存活期解耦；承〈tag 目录静态化〉改投影对象）；AgentConfig 入指纹输入 | 宿主 boot 现算（argv 传清单引用）+ CLI 本地派生；tags/catalog RPC 数据源；TagDeclaration 类型随迁 |
| ac-credentials（降格） | 行降格为注入纯库（R-11 ③ 物理单副本两侧共用） | 两侧共用（写者面 = auth-registry） |

> preview 开发期包名裁决（cr-491，2026-10-17）：主线 src/ac-credentials（插件行）占名且 R-10 要求
> cutover 前原样保留，而 pnpm workspace 不允许重名——preview 轨纯库以避让名 **ac-credentials-core**
> 建（与五纯库 -core 后缀族同构），cutover 时随主线旧行退役回收 ac-credentials 名。R-11 ③ 实质
> 裁决（纯库两侧共用 + 数据根物理单副本）不变。
> 同族裁决（cr-504，2026-10-17）：壳树 conversation 改造行同理撞名（主线 src/ac-conversation 占
> 名）——preview 以避让名 **ac-shell-conversation** 建，cutover 随主线退役回收名。

## R3.2 壳 boot 编排骨架（编排代码，非行序）

```
两树同形（清单驱动装配，cr-485）：宿主 = 宿主行集偏好文件（数据根，形状 {id,
disabled} 沿用）→ ac-rowset-core 派生宿主清单；壳 = argv 派生清单。cordis.patch.yml /
loader patches / 热通道全退役。
acquire activation.lock（O_EXCL + pid 探活 / 陈锁接管，协议规格 C）
→ 读 argv 行集清单引用（宿主派生 / CLI 本地派生，ac-rowset-core）
→ 行集静态断言（行引用存在性、行 config 自洽——纯函数；requiredTags 断言面已随 tag 退役消解；requires 闭包〔cr-521〕：目录行标注硬依赖行 id，点名子集经派生闭包自动并入依赖行——装配满足性在派生层断根；boot 装配终检〔fiber 排空 + ACTIVE 断言〕兜底闭包缺口与显式排除矛盾）
→ ledger（写权随锁）
→ conversation / tools（门装配）
→ 其余行按 inject 声明自行激活（cordis PENDING 机制）
→ stdout TSV boot.ready（guardian adopt）
```

壳内定时纪律：内禀定时（心跳 / run 超时 / 防自激监测）用 unref 本地原语（绑
fiber dispose、不钉事件循环）；持久定时唤醒恒宿主 timers 投递信（裁决簿
〈timer 归属〉）。

# R4. 归并表（虚拟行 8 + 现状行 12）

| 被归并 | 去向 | 依据 |
|---|---|---|
| activation-lock / fingerprint ×2 / agents-readonly / user-stub / usage-report / snapshot-chain / security-exec（v1 虚拟行） | boot 编排 / 共享纯库 + guardian 节拍 / ac-agents-core / conversation 行内 / ledger 行内 / backup 行内 / ac-auth-core + tools 门 | 行资格三问皆否——裁决簿〈新增件资格判定〉 |
| agents-dir / agent-store | agents 行内（物理布局 + 写引擎） | 编辑面内部实现 |
| patch-rpc / plugin-gates / sap-adt-preset | 本体包内 | 包内文件 / 小包 / 子行。patch 机制终态补钉（cr-485）：patch-rpc 形态与热通道整体退役，急救能力转宿主行集偏好 RPC（写偏好文件）——裁决簿〈patch 机制退役〉 |
| restart | guardian 行内 | 宿主进程生命周期 = 监护职责 |
| job-wakeup | 壳 jobs 行内（三投递策略随迁） | 唤醒面随 worker 父级走——裁决簿〈jobs 归属〉 |
| group | 解散：扇出 → 邮局；拓扑 → 数据根；编辑 → webui 卡片 | 群 = multicast 地址表（数据不配行） |
| workspace | 解散七面（ui-tree.md §7）：①引导→boot 编排；②沙箱推导→ac-sandbox-core 纯库；③⑤⑥文件/本机交互/类型→ac-files 模块（后端半=宿主行+client 半=ui 树）；④登记→auth-registry（能力语境目录）；⑦能力语境发现→壳行运行时读面 | 行资格三问皆否；工作区=第三输入源（ui-tree.md §6） |
| tag-registry | 解散：catalog → ac-rowset-core 静态投影；启动断言 → boot 编排；类型随迁。终态补钉：tag 词汇本身全链退役（requiredTags / AgentConfig.tags / AssetRef.tag），行目录投影替代 tag 目录投影——裁决簿〈tag 机制解体〉 | 现算依赖宿主在场——裁决簿〈tag 目录静态化〉+〈tag 机制解体〉 |
| ac-agents 注册表瓣 | 活注册表退役；物化拆 create-from-template + transient boot；reassign 被 R7-8 裁向覆盖 | 两轴分离——裁决簿〈注册表解体〉 |
| ac-agent-presets | 目录静态化归并 agents 编辑面行 | 模板目录 = 静态数据 |

# R5. 拆分件（一面两面，按现行包）

| 现行 | 壳侧面 | 宿主侧面 |
|---|---|---|
| ac-router | （无——壳 inbox 直收） | 邮局行 |
| ac-session | ledger 行（写者） | webui 只读投影（文件直读，无驻留行） |
| ac-conversation | 会话状态机 | （无——串行化在 activation 内） |
| ac-security | tools 门 + ac-auth-core | auth-registry |
| ac-usage | ledger 自报 | usage 聚合对账 |
| ac-agents 族 | ac-agents-core 直读 | agents 编辑面（webui 写侧） |
| ac-credentials | 纯库直读（两侧共用，R-11） | auth-registry 写者面 |
| ac-timer-tools | 工具面（注册 timer 工具） | timers（任务执行 = 投递信唤醒） |
| ac-persona / ac-system-prompt | 装配执行 | 身份数据编辑面（宿主 webui） |
| ac-conv-settings | 只读垫片（run 装配 / 实验键注册面） | **写面单源**（conv-settings 行 + web RPC；cr-565） |

# R6. 退役件

| 现行 | 理由 |
|---|---|
| ac-singles | 独立会话 = 端点通例（D4：形态进 header 开放词汇） |
| ac-hello | 样例行（范例归测试资产） |
| cordis-hmr（已 disabled） | 换版本 = 重启壳（S5） |
| runtime 字段 / loop-only 过渡方案 | M1 / M5 |

# R7. 待钉状态板（✅ 已定向 → 裁决簿；◐ 未决，细节展开）

| # | 项 | 状态 |
|---|---|---|
| 1 | timer 基座 | ✅ 不进壳树 → 裁决簿〈timer 归属〉 |
| 2 | 宿主 jobs 基座 | ✅ 不设 → 裁决簿〈jobs 归属〉 |
| 3 | webui 读投影 | ✅ 三拆齐定向 → 裁决簿〈webui 读投影〉（user 账本聚合 = 形态二） |
| 4 | ui 骨架六件归并 | ✅ 并入 webui 本体（phase:'base' 退役）→ 裁决簿〈骨架归并 webui 本体〉；后续解构修订：协议 3 件入包 + conversation/settings/tool/markdown 管线转模块 → ui-tree.md §2 |
| 5 | workspace 残留面核查 | ✅ 七面解散收口（③⑤⑥ 重组 ac-files 模块 / ② 纯库化 sandbox-core / ⑦ 工作区语境面）→ ui-tree.md §6-7 + 裁决簿〈ui 树定调〉 |
| 6 | 重工具行按需 boot | ✅ 消解（tag 机制解体连锁）——装载信号 = AgentConfig 引用行即声明，无特例；「默认胖瘦」降格为默认预设模板含哪些行的产品题 → 裁决簿〈tag 机制解体〉 |
| 7 | patch 机制归属 | ✅ 整体退役，两树同形 boot（清单驱动装配：宿主 = 偏好文件 → 派生，壳 = argv 派生清单）→ 裁决簿〈patch 机制退役〉 |
| 8 | AgentConfig 变更生效路径 | ✅ 自然生灭（cr-528）——shell-model S5 换版本 = 重启壳；变更在 boot 时点读取（boot 内 config 直读一次，无热重载面）；guardian 不观察指纹变更（主动重拉 = 编排越权——宿主邮局/监护不持 agent 定义知识）；显式换装走 evolve（M6.4 换装编排已有线）。重拉三节拍时 config 新读即生效 |
| 9 | 插件 client 通道（ui 树装配） | ◐ 框架升格 → ui-tree.md（三树同构 + 骨架=协议持有者 + manifest 三树投影）；执行端 = ac-webui/client/；schema / 注入语义 / 拓扑贡献开放度（③ 级挂拓扑+换壳）/ 存量收敛批次待设计 |

# R8. 规模盘点与对账

- 现状 100 行 → **宿主 47 / 壳 34**（基座行两树各计；骨架六件已定向并入 webui
  本体——47 组件和不含骨架，对账 −6 生效，「并后 42」系算误已修；壳 35→34 =
  dev-tools 勘误剔除，cr-520）。
- **全新行 4**（邮局 / 监护 / 授权注册表 / 账本）；**新纯库 5 + 1 降格**；
  **归并 20 / 退役 3**（另过渡方案 2）。
- 对账恒等式：100 − 3 退役 − 1 降格 − 11 归并（ac-agents 注册表瓣为行内拆分
  不减行数）− 6 骨架（已定向并入 webui 本体）− 3 承接消失（router / session / security，功能由 4 个
  全新行与 tools 门承接）+ 4 新增 + 2 基座双计 − 1 勘误剔除（dev-tools）= 81 = 47 + 34（cr-520）；
  cr-553 起 + 1 全新增（plugin-dev）= 82；cr-565 起 conv-settings 改树入宿主
  = 82 = 宿主 46 + 壳 36；cr-566 起 singles 全新增 = 83 = 宿主 47 + 壳 36；
  cr-576 起 group 全新增 = **84 = 宿主 48 + 壳 36**。
- M8.2（cr-523，2026-10-18）：8.1 收敛完毕——34 壳行全部可装配（collab-tools
  随 conversation 服务面落地导入；subagent 归 8.3 spawn 工具面）。M5 替身
  ac-shell-loop 退役删除（全量 loop = 主线 ac-agent-loop 真身，boot 直装）。
- M8.3（cr-524，2026-10-18）：34 壳行全数可装配（subagent 行 preview 实现
  ac-shell-subagent——R-5 修订版单形态：真子壳进程〔--parent-id --persist〕+
  信封投递多轮 + spawn/send/await/list/stop/delete 工具面；boot 控制帧通道
  〔interrupt/bench/tool 三帧——stdin 行协议 + TSV 回执〕；bench 门 = 拉起方
  控制帧面〔R-8 快速通道，evolve bench-gate 适配器〕；影子子壳账本嵌套域修复
  〔ledger agentDirOverride〕+ 物化剥减并入会话基座〔conversation 行恒在集〕。
  行集派生词形消歧：工具名与行名同名时行名优先（A10 声明面单位）。
- M8.4（cr-525，2026-10-18）：user 壳半边落地——R-1 签发面（envelope-core
  issue.ts：UUIDv7 + issueConversationId——「webui → 宿主代 user 签发」物理
  载体）；邮局投递执行器（PostOffice：dispatch 三通道 + local:<endpointId>
  进程内直调 hint〔D2「通道多种、协议层恒一」——user 端点传输形态裁决〕+
  outbox 滞留转投 + ipc 监听中继）；user 壳桩（UserStub：send 签发+own 落账+
  投递 / 终稿 writeThrough 写穿——R-2 webui 形态 = 宿主进程内极薄 user 壳，
  R-2a 单写者）。ipc.ts 三件根因修复：异步 onFrame / close 强制断连（常驻
  连接致 server.close 永挂）/ 谓词等待 request（旁带 stream 帧混走不误配
  ack——谓词 waiter 收帧分发模型）。
- M8.6 第一批（cr-527，2026-10-18）：A8 门禁链数据化壳侧第一件——tools
  授权门落地（gate.ts：ac-auth-core 投影 per-run 现算 + tool/before-execute
  MCP 服务器资产硬闸 fail-closed + children 物化快照域；主线 ac-mcp 增
  serverOfTool 反查面〔additive〕；subagent spawnOp 补 M6.5 deriveChildAuth
  接线——child auth.json ⊆ 父投影物化）。授权资产轴 v1 裁断面：mcp-server
  硬闸；credential 不经门（resolve 链即消费面）；row-load 双闸已在行集派生
  层生效。plugin-gates/auth-registry/usage 聚合面归宿主树（8.8 装配面）。
- M8.6 第二批（cr-528，2026-10-18）：A8 门禁链数据化壳侧第二件 +
  监护 spike 收口——durable-interaction per-agent 域锚定（rowOptionsFor 增
  agentDir：jsonl 落 agents/<id>/interactions.jsonl，D4 单写者——多壳不
  共写数据根根；影子随物化域）；监护三参数钉（协议 F 表：心跳 30s×3 拍 /
  idle-exit 15min 四条件 / 熔断 60s 窗内 3 次——warden idle 10min→15min
  对齐、熔断补时间窗语义 + 窗滚动测试）；壳侧物理面（boot 常驻段：
  guardian.ping setInterval 30s unref + idle 探针 30s 周期查四面
  〔run busy / inbox 盘面扫描〔ledger agentDirOf public 化〕/ durable
  listOpen / jobs 活跃〕，全空 15min → 退码 0 收割）。R7-8 收口：
  AgentConfig 变更生效路径 = 自然生灭（S5 换版本 = 重启壳；guardian 不
  观察指纹——宿主监护不持 agent 定义知识；显式换装走 evolve 线）。
- 8.5b 第一批（cr-530，2026-10-18）：webui 本体包解构起批——ac-ui-app
  （终态 ac-webui 单包的 preview 避让形态；主线 ac-webui〔服务行〕/
  ac-webui-app〔前端壳〕双占名，cutover 随旧树退役回收名——cr-491/504
  同族先例）。src/ 服务半边（webui-row：boot graph **manifest 单源**
  〔<dataRoot>/plugins/ 目录扫描——ac-webui-core assembleBootGraph 接线，
  R7-9 第一方与第三方同走唯一通道〕+ /ui-plugin/ 静态面同源直读）+
  client/ 前端半边（boot.ts 装配序列：骨架 3 件 **in-bundle** import
  主线行包〔theme/renderer/layout——phase:'base' 退役〕→ sealFactory 封印
  → 通道装载器 URL 动态 import〔逐条隔离〕→ main.ts mount）。host-web
  装配换行（web-server → webui 本体行 → web-api）；catalog webui 行 path
  数组化盖本体+骨架三包（指纹面）；BootGraphEntry 增 platform（additive）。
  preview 268/268 绿（49 文件）+ 双 tsconfig 0 错 + lint 清零，主线
  typecheck/check:deps 零扰动。
- 8.5b 第二批（cr-531，2026-10-18）：四份模块资产上通道——preview/apps/ui/
  channel/ 四子包（conversation/tool/settings = re-export 主线行包
  clientPlugin〔零副本，物理迁出归 cutover〕+ markdown-render = owning 声明
  〔ui-tree §2 新划分，资产 re-export 主线 renderer markdown 管线〕）。
  通道装载机制产品化：UiManifest/BootGraphEntry 增 channelImports（外部化
  裸包名清单——构建面 external 与装载面注入单源）；boot.ts 外部化装载
  （moduleHost 共享基座注册表〔vue/pinia/cordis/runtime/slots 单例契约〕+
  installChannelImportmap〔blob-URL re-export 模块 + 动态 importmap——
  Chrome 89+ 多 importmap 语义〕+ channelImports 缺键逐条隔离 fail-loud）；
  rpc host 最小面（client/rpc-host.ts——域件公共依赖 inject rpc 的提供面，
  wire 注入，缺省拒绝桩 fail-loud；真面 main.ts→/ws 归 8.5e）；构建脚本
  build-channel.mjs（vite lib 模式 + channelImports external + 产物落
  preview/sandbox/ui-plugins/ 直构 pluginsDir 形态；target esnext——Windows
  esbuild renderChunk 临时文件删除 Access denied 降级路径规避，chrome92
  降级归 8.5e）。tests：四模块真装载（sessions 服务+talk 视角+tool 席位
  真到位）+ channelImports 缺键隔离 + moduleHost 注册表。setupFiles 垫桩
  面（jsdom matchMedia 先于 import 链）。preview 271/271 绿（49 文件）+
  双 tsconfig 0 错 + lint 清零（顺带修存量 9 处：host evolve/orchestrate
  + shell/boot 冗余判定），主线 typecheck/check:deps 零扰动。
- 8.5d（cr-532，2026-10-19）：ws-bridge 旁带接线收口——宿主桥接半边
  ShellStreamBridge（ac-post-office stream-bridge.ts：B3 StreamFrame →
  主线同形前端帧——LlmDeltaBatcher 复用〔llm/delta-batch 30ms 微批 +
  首帧直发〕+ end→flushNow 保序 + llm/delta-end；wireLlmInput 投影同源，
  前端 wire.ts/feed-core 零改动消费）；StreamFrame 增可选 meta 路由键
  （agent/conversationId/stepId——additive，B3 语义不变；壳发射面
  streamFrameFromDelta 纯函数化，meta 全套随帧携带）；host-web 增
  tapAgent/untapAgent 管理面（per-agent tap + 桥接件，B3 断连即丢）；
  **顺带根因修复**：壳 uplink 单插槽 → 连接集合（单 uplink 被后到连接
  覆盖 = 先到订阅者静默失流——tap 与邮局投递连接并存场景暴露）；catalog
  ws-bridge 行 path 钉主线包（8.8 零改动导入）。e2e：真子进程壳 mock run
  流式全链（user 桩投递驱动 → 壳旁带 → tap → broadcast → 真 WS 客户端
  收 delta-batch/delta-end，帧形对拍断言）+ 单测 4。preview 277/277 绿
  （51 文件）+ typecheck 0 错 + lint 清零，主线 typecheck/check:deps 零扰动。
- 8.5c（cr-533，2026-10-19）：**25 域行 manifest 声明化收口**（R1 ui 组
  「通道建成后续批收敛」兑现）——channel/ 增 25 域行通道包（re-export
  主线 ac-client-ui-* clientPlugin，物理迁出归 cutover；生成器
  gen-domain-channels.mjs——内嵌 DEPS/EXPORTS 快照 + --check 重扫对账）；
  **channelImports 深路径扩展**（校验面放行子路径说明符——46 深引/56 去重
  键：chatStore/uiStore/themeStore/rosterAccess 等被跨行深引的状态面与
  纯函数面 = 事实共享基座；单例契约物理载体 = client/shared-modules.ts
  56 键宿主注册表并入 moduleHost，importmap 原生子路径映射解析）；
  8.5b 四包 manifest 同步升级（conversation 22 键/settings 6 键——bundle 内
  打包骨架深引的双实例违例修复）。主线顺带 additive：ac-client-ui-remote
  exports 补 ./client（其余 24 包同形漏网）。29 通道包全量构建过
  （preview/sandbox/ui-plugins/）。tests：channels-domain 5 用例（数量
  对账/catalog 同名一一/manifest 校验+re-export 形态/深路径键宿主覆盖/
  deps 最小面）。preview 282/282 绿（52 文件）+ preview:typecheck 0 错 +
  lint 清零，主线 typecheck/check:deps/remote 定向零扰动。
- 8.8 前置第一批（cr-537，2026-10-19）：宿主行装配起批——ac-host-rows 包
  （对称壳侧 ac-shell-rows：IMPORTED_ROWS + rowOptionsFor 数据根锚定）。
  零改动导入 7 行（logger-console/timer/config/event-policy/remote-link/
  backup/ws-bridge——全无主线宿主服务硬依赖；timer 为 vendor Service 包行
  形态）。宿主 boot 入口 apps/host/boot.ts：偏好文件 <dataRoot>/host-rows.json
  × 目录 → deriveHostRowset（A9 宿主侧首次接线）→ cordis 装配 + web 环
  （bootHostWeb）。47 行口径钉：22 cordis + 25 ui 域行（manifest 声明面，
  webui 行 boot graph 装载——非 cordis 插件，boot 分流）。catalog 9 行补
  path（7 导入行 + post-office/guardian preview 包）。**顺带根因修复**：壳
  boot.ts 主体指纹构造补树限定（基座双计行 host 版补 path 后混入壳指纹树
  ——cr-519 预言的双计行对拍风险兑现，壳侧只认 tree=shell 版）。preview
  287/287 绿（54 文件）+ typecheck 0 错 + lint 清零，主线零改动。
- 8.8 前置第二批（cr-538，2026-10-19）：**usage 自报链落地**（R1 usage 行
  「对账 ledger 自报事件信」× R2 ledger 行「usage 自报（journal 计量 +
  事件信）」兑现——per-agent D3 修订 L112-113 物理载体）。三件：① journal
  计量 = JournalSettled 增 usage/model（additive；ledger 订阅 loop/after-run
  缓存聚合，settleRun 消费即清）；② 事件信 = envelope-core usage-report.ts
  （schema owning，receipt.ts 同构位；kind=receipt/budget=0/uuid=
  usage-<agentId> 计量流键——不复用会话 uuid 避让邮局登记校验）+ ledger
  reportUsage 邮局 ipc 投 host（at-least-once，失败不阻塞收束）；③ 宿主
  usage 行 = usage-row.ts（主线 UsageService 聚合并导入〔additive
  reportMeter 公开入口——与 record 共用 mergeIntoMaps+审计流水单源〕+
  host 端点 registerLocal 收信面〔UserStub 同构〕+ requestId 幂等 + 非法
  payload 拒收 + 非 usage 信直过）。宿主 boot：邮局先行单例 + bootHostWeb
  postOffice 注入复用 + HOST_ROW_FACTORIES 装配分流。cordis 接缝两坑存档：
  插件 inject 声明 = 服务访问闸（ctx.<key> 未 inject 即 throw）且同 fiber
  自注册场景 inject 等待死锁——服务实例经构造器捕获直引；ctx.plugin 不收
  Service 实例（类形态注册）。e2e：真子进程壳 mock run 收束 → journal
  计量 + 事件信 → 宿主聚并入账全链。preview 297/297 绿（57 文件）+
  typecheck 0 错 + lint 清零，主线 typecheck/check:deps/ac-usage 17 用例零扰动。
- 8.8 前置第三批（cr-539，2026-10-19）：**timers 宿主行落地**（R1 timers 行
  「定时唤醒（唤醒 = 投递信）」× A13 持久唤醒恒宿主投递信 × D10 机制照搬
  兑现）。timers-row.ts（HostTimersService extends Service，键 timers——
  不重复 declare〔主线 ac-timer 占键，ac-shell-conversation 同款先例〕）：
  主线 955 行排程状态机语义照搬（5 模式/限定次/停机补偿三 case/gate
  预检/日历重排地板/重启防重/在途守卫/完成归档/简化形状归一化——算法住
  ac-timer-core 纯库），四服务依赖换轨：ctx.agents → agents-core 直读
  （listAgentIds + config 过滤 virtual/preset/model）；ctx.agentStore →
  agents/<id>/entries/{timer,timer-archive}.json 直读写；ctx.conversation.
  deliver → 邮局信封投递（唤醒信：uuid = entry.conversationId ∨ 对角线
  pairKey〔确定性键——不签发新会话，R-1 签发权归首条消息发送方〕；sender
  = conversationId 在场时 user〔提醒落用户视线〕否则 target；budget=3
  满额起跳）；ctx.config 保留（同树 config 行，timer.tasks/agents.settings）。
  settingsOf 分层纯函数化消费。**adoptShell flushOutbox 节拍落地**（协议
  D2 节拍 2 语义补接）：adopted 即转投 outbox 滞留信——timers 是第一个常态
  化产 outbox 信的宿主行（定时信投 idle 收割壳必滞留）。conversationAlive
  换轨：singles/group 注册表缺席 → sid 是否有任何 agent 域账本目录近似。
  seedHistory 省略（preview conversation run 面每轮 historyFor 自回放）。
  catalog timers 行 path 钉。preview 303/303 绿（59 文件）+ 双 typecheck
  0 错 + lint 清零，主线 typecheck/check:deps 零扰动。

- 8.8 前置第四批（cr-540，2026-10-19）：**身份编辑面两行落地**（R1 agents
  编辑面 + preset-builtin 静态模板集——裁决簿〈注册表解体〉「文件即注册 /
  模板直读、无独立承载机制」兑现）。① preset-builtin：包目录静态配置集
  （ac-host-rows/templates/<模板键>/{config.json,meta.json}；三模板 standard /
  dsh-minimal / creator——tag 词全链换轨为行集引用词形，主线 tag 族按行落点
  翻译：fs→fs-tools+fs-search+str-replace-editor、infra→shell-tools+run-code、
  shell→shell-tools、web→web-tools、delegation→subagent、issue-report→
  issue-tools，另有 ask-questions / skill）+ 零 cordis 读面（preset-builtin.ts：
  listTemplates / readTemplate，按 order 再 id 排序，未知/非法键 = undefined）。
  行本体是静态数据面（boot 归 HOST_OWN_ROWS——无插件面），目录 path 钉
  ac-host-rows。② agents 行：agents-row.ts（AgentsEditService extends Service，
  服务键 agents）+ 装配工厂 makeAgentsHostRow——配置轴 agents/<id>/config.json
  原子写（agents-core writeAgentConfig 单源）+ entries/<key>.json（param-case
  词法闸；与 timers 行直读同路径）+ 文档 <NAME>.md（尾换行归一）+ 头像
  avatar.<ext>（扩展名归一/旧残留回收）+ removeAgent 删整树（父删除级联杀子
  = agents 树自含语义）+ createFromTemplate（preset 标志剥除〔创建物是真实
  身份〕、skip-if-present = 用户数据优先、overrides 叠模板之上）+
  transientConfigOf（不落盘合成——宿主 argv 面）。读面零归一：开发期零兼容
  （R-10）——旧键（hooks/conductor）翻译归 cutover 导入脚本。③ 模板目录派生：
  宿主 boot 按派生行集是否含 preset-builtin 注入 templatesDir（缺席 = 模板面
  不可用而 CRUD 照常——行资格「良定义降级」验收面）。④ 顺带根因修复：壳侧
  AgentStoreShim entries 布局单源化（扁平原 <id>/<key>.json →
  <id>/entries/<key>.json——壳写口与宿主写口分家即同一 agents 树数据分裂）。
  ⑤ catalog 两行 path 钉 + 宿主 boot 就位行基线 16 行（未就位 6：agent-admin /
  archive / session-query / auth-registry / plugin-registry / plugin-market）。
  测试：模板集 4 用例（含「模板词形全部命中行集目录」= deriveShellRowset 零
  warnings 防漂移）+ 编辑面 6 用例 + 宿主 boot 装配断言（写口活 + 模板注入）。
  preview 313/313 绿（60 文件）+ 双 typecheck 0 错 + lint 清零，主线
  typecheck/check:deps 零扰动。
- 8.8 前置第四批遗留（cr-540 登记，交后续批）：① **agent-admin 行不可机械
  平移**——agents/system-prompt（装配预览 = before-run waterfall 干跑）与
  agents/assembly（装配视图读 ctx.tools 目录）两方法的装配链在新架构住壳内
  进程，需跨进程 dry-run 设计（信封请求 + 壳内装配试跑回执），归 8.9 产品面
  收敛批；CRUD 六方法（get-config / create / update-config / delete /
  save-doc / read-doc）可在本批写口就位后直落（写侧取代 assertNotPreset 闸
  = 预设不进 agents 树本体，名册语义由 preset-builtin 模板集承载）。
  ② creator 模板的 dev/admin 工具面（插件装卸三件套）在新架构 = 宿主
  plugin-registry 行工具面，壳行集内无对应行——模板 system 提示词暂保留原文，
  工具面收敛归 8.9。③ timers 行 entries 仍自带直读写（同布局、未经 agents
  写口）——唯一写者纪律收口归 8.6 清账余件。④ **agents 目录 entries 布局
  换轨需迁移**：主线 agent-store 形态是扁平 `<id>/<key>.json`（timer.json /
  goal.json …），新布局 = `<id>/entries/<key>.json`（本批与 cr-539 timers
  行同源钉死）——真实数据根迁移责任归 cutover B 段：ac-import 现只扫
  sessions 四域，须扩 agents 树域（entries 归拢 + 旧键 hooks/conductor 归一），
  否则旧条目前后不可见。
- 8.8 前置第五批（cr-542，2026-10-19）：**宿主单树装配 + agent-admin 写侧
  RPC 编排**。① **根因修复：宿主双 ctx 的静默半激活面**——web 环原由
  bootHostWeb 自建 ctx（web-server/webui/web-api 在环内 ctx，宿主服务行在
  外层 ctx），而宿主行集里 ws-bridge / remote-link（inject ['webServer']）
  在外层 ctx 永 PENDING：cordis 语义 PENDING fiber 的 await 立即返回不报错，
  「行已装配」是假的（探针实证：装 web-server 前 ac-ws-bridge=PENDING
  ac-remote-link=PENDING；装后转 ACTIVE）。修复 = 单树装配：bootHostWeb 拆
  两段装配原语 assembleWebServer（传输基座先行）/ attachWebSurface（user 桩
  + webui + web-api，装进调用方 ctx）+ 宿主 boot 在同一 ctx 装全部 cordis
  行；装配终检（壳 boot 同款 FiberStates.ACTIVE 断言）让行集矛盾 fail-loud；
  装配失败逆序收割（不留半态端口/监听）。顺带：remote-link 行 options 增
  root 数据根锚定（缺省 './data' 回落违隔离红线）、catalog usage/agent-admin
  两行 path 补钉（R-7 指纹单源）。② **agent-admin 行落地**（R1 编辑面）：
  agent-admin-row.ts（inject ['webServer','agents']——两服务同树才激活；写口
  单源 = agents 编辑面，本行零落盘）；写面词汇纯库化 ac-agents-core/write.ts
  （sanitizeAgentInput 白名单 + model 引用归一 + id 派生 / applyConfigPatch /
  changedConfigKeysOf / configFromPatch）——三处语义订正：变更键改并集 JSON
  比较（主线 computeDiff 只从 subject 侧比较，键删除恒漏报且靠调用点兜底）、
  清除词形 = null 标记 + 合成时删键单轨（主线「null 覆盖落盘 + 消费侧 falsy
  回落」双轨退役）、缺 model 不物化默认连接；预设写口闸退役（预设 = 静态
  模板集，不进 agents/ 树本体——撞名类结构上不存在，非遗漏）。③ 测试：写面
  词汇 11 例 + agent-admin 行 4 例（六方法在册 / CRUD 全链落盘 / 零变更不
  落盘 / 文档空内容=删 + 未知身份 fail-loud）+ 宿主 boot 三例重构（17 行
  对账 + 全 fiber ACTIVE + webServer 消费者活性回归锁 + RPC 全链 + 终检
  fail-loud）。preview 329/329 绿（62 文件）+ preview:typecheck 0 错 + 定向
  lint 清零，主线 typecheck/check:deps 零扰动。
- 8.8 前置余件（cr-542 登记）：archive / session-query（D10 双选项待裁决）/
  auth-registry / plugin-registry / plugin-market 五行 + 8.8 级联验收本体；
  agent-admin 的装配预览（agents/system-prompt = before-run 三档链干跑）与
  装配视图读面（agents/assembly + assembly/update 写面）归 8.9 产品面收敛
  批（装配链住壳进程，跨进程干跑需信封请求 + 壳内装配试跑回执设计）。

- 8.8 前置第六批（cr-543，2026-10-19）：**插件治理面两行落地**（R1 插件治理组）。
  ① **形态差的实质（改造不是缩水）**：主线装载 = 把第三方代码 dynamic import
  进宿主进程（ctx.plugin），故注册表行住宿主；新架构装载 = 授权动作（A7/A10）——
  批准安装后**插件行集条目**物化为 `<dataRoot>/plugin-rows.json`，装载发生在壳进程
  （壳 boot 目录 ∪ 插件行合并 → 派生化 → 动态 import 装配）。**第三方代码零宿主
  驻留**（R0a 判据 1）：宿主行只做文件域与裁决。
  ② **plugin-registry 行**（ac-host-rows/plugin-registry-row.ts）：服务键
  `pluginRegistry` —— staging 人审（哈希/只读代理/权限快照/来源锚定全复用
  ac-plugin-core 纯库，零改动）+ 安装态 + 卸载（旧版本进 .backup）+ 熔断
  （壳侧 `plugin/load-failure` 回报 → 阈值 3 熔断 → 行集条目剔除 fail-closed）
  + 行集偏好急救 RPC（`rows/list` · `rows/set` · `rows/reset` 写
  `<dataRoot>/host-rows.json`，restartRequired 恒 true = 恒冷生效）+ client
  manifest 注入（安装目录即 boot graph 源，变更广播 `plugin/updated`）。
  RPC 面 16 方法在册（plugin/* 13 + rows/* 3）。
  ③ **plugin-market 沿用零改动导入**（inject [webServer, pluginRegistry]）：市场
  搜索/暂存 RPC 直接可用，安装落点 = 本行的 staging 人审。
  ④ **新增纯库面**：ac-rowset-core/plugin-rows.ts（manifest.rows schema + 三条
  判据——树归属恒 shell〔manifest 自述忽略〕/ 路径恒安装目录单源 / 撞名出厂行丢弃
  〔保留字护栏 F13/G1〕+ 目录合并 + 文件域原子写）。
  ⑤ **顺带根因修复**：ac-webui-core assembleBootGraph 原扫插件目录全部子目录——
  插件库的 `.staging`（未审暂存）/ `.backup`（旧版本）含 manifest.json，**未审
  代码会被下发浏览器**；修复 = 通道源恒非隐藏目录（暂存/备份不是通道面）。
  ⑥ 测试：插件治理行 6 用例（人审全链 / 撞名丢弃 / 熔断 ×3 / 卸载 / 偏好急救 /
  RPC 面与变更帧）+ plugin-rows 纯库 4 用例 + 壳侧插件行 3 用例（未安装点名
  fail-loud / 合并后行集命中 / 动态装载 + path 数组 fail-loud）+ boot graph 隐藏
  目录 1 用例 + 宿主 boot 就位基线 19 行（47 − 25 ui − 3 未就位）。preview 343/343
  绿（65 文件）+ preview:typecheck 0 错 + 定向 lint 清零，主线 typecheck/check:deps
  零扰动。

- 8.8 前置余件（cr-543 登记）：archive / ~~session-query~~（D10 已于 cr-544 裁为
  agent 只搜自己并改树入壳，本条余件收口）/ auth-registry 两行 + 8.8 级联验收本体；**壳侧装载失败回报未接线**（plugin-registry
  行的 `plugin/load-failure` RPC 已就位，壳 assemblePluginRow 失败尚无宿主回报路径——
  归 8.9 产品面收敛批，与 guardian 心跳面同批）；插件 client 通道的高危席位替换
  人审载荷（highRiskSlotsOf）随市场 UI 收敛批。

- 8.8 前置第八批（cr-545，2026-10-19）：**auth-registry 行落地**（R1「授权注册表
  写者」——ac-security 裁决面 + credentials 写者面 + workspace 授权数据重组的新增行）。
  ① **信封面**：envelope-core grant.ts（协议 E：grant/revoke payload schema +
  受理回执 subject=grant-applied/grant-rejected；资产面收窄 credential/mcp-server
  ——row/inline 恒拒〔A10 插壳即授权 = 用户域动作〕；回执与受理信 uuid/requestId
  同值对账）。② **写者面归纯库**：ac-auth-core write.ts（全局层 additive 追加 +
  墓碑吊销幂等 + per-agent grants/denials 读改写——原子写；AssetRef 键单源）+
  mcp.ts（F1 裁决：mcp.json 独立文件，授予时宿主同步补写清单）。③ **宿主行**：
  ac-host-rows/auth-registry-row.ts（grant 受理编排：requestId 幂等 → 预检〔global
  scope 需 user 审批 R-9——现阶段拒收，审批卡归 webui 产品批〕→ priorFingerprint
  对拍〔E 节乐观锁，不匹配拒收〕→ 写者 → 回执投 agent 经验流；凭据写面
  writeCredential〔ac-credentials-core 单源〕；**F2 分立编辑面**——auth/* RPC 域六
  方法：deny/allow/agent-view/global-view/credentials/write-credential）。④ **HostInbox
  收信扇出组合器**（host-inbox.ts）：邮局 local 通道单 receiver 的多宿主行共存——
  usage 行独占 'host' 端点的形态退役，任一 handler 抛错 = 投递失败滞留重试
  （at-least-once；幂等时点 = 全部 handler 成功后——usage 行原「非法 payload
  warn+ack 吞错」同步改 fail-loud）。⑤ 装配：boot 建 HostInbox（邮局 listen 后）、
  HOST_OWN_ROWS 摘 auth-registry 归 HOST_ROW_FACTORIES、宿主就位基线 19→20 行
  （余 archive 1 行）；catalog auth-registry 行 path 数组钉四包。⑥ 授权草稿 F 节
  三待钉全钉（F1 独立文件 / F2 分立〔用户裁决 2026-10-19，「授权位置与壳读取」
  推导：壳只读两层直读 → 唯一结构约束 = 写口单源 → 两入口一写口〕/ F3 缺省空）。
  测试：grant schema 3 组 + 写者面 3 组 + 行 8 用例（受理全链/指纹对拍/幂等/
  revoke/扇出共存/编辑面六方法）。preview 367/367 绿（69 文件）+ preview:typecheck
  0 错 + 定向 lint 清零，主线 typecheck/check:deps 零扰动。

- 8.8 前置第七批（cr-544，2026-10-19）：**session-query 改树入壳 + D10 收敛落地**。
  ① **裁决**（用户裁定 2026-10-19）：D10「多根搜索或收敛为 agent 只搜自己」取**收敛**
  支——工具面只有本 agent 账本（`agents/<id>/sessions/<uuid>/`，影子 = 物化域），
  跨 agent 历史改走文件只读（与 webui 读面同义）；论据全文见裁决簿
  〈D10 会话查询收敛〉。② **树归属 host → shell**（R0a 判据 1）：grep_history /
  read_history 是工具，工具只能由壳内 agent-loop 执行——宿主无 loop，旧的
  「宿主数据服务·多根只读搜索」记法在装配面不可兑现。行集总数 81 不变
  （宿主 47→46 / 壳 34→35；本档案 R1/R2 与 spec §1 同批回填）。
  ③ **preview 侧落地** = `ac-shell-rows/session-query.ts`（`makeSessionQueryRow`：
  服务注入面只要 tools；读面 `replayConversation` 直读本域 `messages.jsonl` +
  `summary.md`，回放语义与主线 `session.history` 恒等——概要头部 system 消息置首、
  viewer 投影〔自己 assistant / 对端 user + name = 对端 id〕、机制行〔context/event〕
  不入回放）；会话键词法闸禁路径分隔/遍历，本域无该会话 = fail-loud
  （「只搜自己」明确文案，不静默空集）；grep 截断 166 tokens（UTF-16 安全，cr-415
  防线）与 250 命中上限、read 500 单页上限均按主线原值。
  ④ **目录面**：session-query 行 tools 声明 [grep_history, read_history] + requires
  [tools]（壳行集闭包——点名工具即并入基座行）；catalog 树归属改 shell、path 钉
  ac-shell-rows；rowset 对账测试 46/35。
  ⑤ 测试：会话查询行 4 用例（投影/概要头/机制行排除、grep 命中与空集、read 分页、
  他域/非法键/空 pattern fail-loud）。preview 347/347 绿（66 文件）+
  preview:typecheck 0 错 + 定向 lint 清零，主线 typecheck/check:deps 零扰动。

- 8.8 前置第九批（cr-546，2026-10-19）：**archive 改树入壳 + D11 全壳内裁决落地**
  （8.8 前置全部收口——46 宿主行 / 35 壳行全就位）。① **裁决 D11〈归档全壳内〉**
  （用户裁定 2026-10-19，三选一取 A）：归档全链（阈值检测/整理 run/归档重建）住壳，
  宿主零 archive 职责；timer 的 archive-all 机制任务改批量唤醒信（宿主只发信）。
  论据：整理 run = LLM 编排只能住壳（R0a 判据 1，与 D10 session-query 同构）；
  归档重建写归属 agent 账本（D4 写权 = 账本所有权——账本写者恒为归属 agent 的壳）；
  否决备选 B（宿主枚举 + 壳内整理）因估算口径宿主化引入跨进程口径耦合面。
  ② **ledger 归档物理面**：writer.compact（串行队列内重写 messages.jsonl tmp+rename
  + 分段 archive/history_N.jsonl + 尾锚 sidecar〔seq/message_id 二次归档去重锚〕+
  B1 窗口基线〔快照后新落账行重读并入〕+ summary.md 概要滚动）；settleMechanism
  （机制 run 收束变体——journal-settled 落 journal、messages 不落行）；historyFor
  概要头 system 置首（注入与估算同源）。③ **conversation 机制投递面**：reviewRun
  （与用户 run 共串行化门；不落账不进上下文——meta[archive-review] 三不语义；
  source='event' 自会话语义）。④ **行本体** ac-shell-rows/archive.ts（阈值检测
  订阅 loop/after-run + estimateReplayTokens 回放口径 + 整理投递 + 归档重建 +
  archiveAll 批量面）；boot 收信面 mechTask 分发；timers-row archive-all 分支改
  批量唤醒信（virtual/无 model 过滤 + 对角线 uuid + budget 1）。⑤ 测试：archive
  行 4 用例（全链/亲写概要优先/批量面/二次归档去重）+ timers archive-all 唤醒信
  1 用例。行集总数 81 不变（宿主 46→45 / 壳 35→36——archive 从宿主数据服务组移壳域服务组；catalog 对账 45/36 同批更新）。

- 8.8 级联第一批（cr-547，2026-10-19）：**B 段导入脚本扩域收口（cr-540 遗留④）+ 8.8
  级联验收 e2e 落地**。① **agents 树域迁移**（ac-import/agents-tree.ts）：config
  换轨（tags 装载词 → tools 行引用——TAG_TO_ROWS 数据驱动快照〔主线 requiredTags
  实况扫描 + 真实数据根词频全对账〕；档位词留 tags；行内档位词 observe/manipulate/
  inject/dev/admin → settings——〈tag 机制解体〉七职能③归位）+ 机制 entries 归拢
  （扁平 <key>.json → entries/<key>.json）+ 身份文件（AGENT[S].md/avatar.*）恒等
  拷贝。② **user 账本投影**（user-projection.ts）：kind=user 会话 agent 侧账本 →
  users/user/sessions/<uuid>/ 终稿层（〈webui 读投影〉形态二兑现——此前 webui
  读面对导入历史恒盲）。③ **根因修复三件**：importSession 幂等护栏行数比对 →
  全内容比对（真数据根实测 sid 3abe307a 双位分叉〔根直下 12 行/shelf 11 行〕投影
  rows 恰同 9——行数护栏静默放行，违 R-10 信息无丢失）；singles 同 sid 双位
  fail-loud + ADJUDICATED_SINGLES 裁决表（3abe307a 裁保留根直下位 = 事实终态）；
  projectUserLedger pathSegment 双重转义（remote%3A 形态读不到）+ deliver await
  落盘契约（void 丢弃 = 同步调用方在落盘前拿返回值）。④ importRoot 编排扩
  （agentsTree/userProjection 选项）+ import-cli --full。⑤ **8.8 e2e**（e2e-cutover.
  test.ts）：恒等门（fixture 全链零问题 + 树迁移断言）+ 宿主 boot 回放对齐
  （agents/list 换轨身份 / singles/list 投影会话 / session/history 与 agent 侧
  账本条数+内容恒等 / 导入后续聊 deliver 续 uuid）。真数据根全量重导预演
  949→948 会话（裁决去重 1）+ 27 agent 树 + 812 user 投影全对账。preview
  383/383 绿 + typecheck 0 错 + lint 清零，主线 typecheck/check:deps 零扰动。

- 8.8 级联第二批（cr-548，2026-10-19）：**8.8 级联验收收口（壳半边全链合流）+ 三项根因修复**。
  ① **adoptShell 编排参数面**（orchestrate.ts）：SpawnFn 增 write 控制帧通道（stdio
  pipe 化）+ mockProvider/postOffice→argv 透传（邮局地址单源 listeningAddress）+
  AdoptResult 暴露 pid/shutdown()/kill()（resolve 后 exit 监听移交——settled 旗防
  早退误报）；dev.ts 同步真参数（此前注释称 mock 壳而 argv 未传——漂移修正）。
  ② **会话基座单源化**（ac-rowset-core/rowset.ts）：点名形态恒并 conversation 行
  （cr-524 物化面同裁的派生层单源——「点名 ≠ 裁基座」，导入换轨后的点名集
  不再产出「能 boot 不能收信」的静默半激活面）；deriveChildConfig 并入逻辑
  退役（身份面回归纯剥减，语义不再两处重复）。③ **壳 close 链两处挂点修复**：
  conversation outbound 常驻 ipc 连接随 fiber dispose 收割（ctx.fiber.effect 注册
  即归属——主线 web-server 同款）；boot close 强制断连 uplinks（邮局投递连接池
  常驻连接使 server.close 回调永挂——M8.4 listenIpc 连接跟踪同款语义）。
  ④ **inbox 孤儿信封根因修复**（ac-shell-conversation/service.ts）：plan=run/steer
  的信封不再进 inbox（inbox = busy 排队面，收束链跑只消费机器队列成员——
  plan=run 本轮直接消费，入 inbox 即孤儿〔idle 探针恒忙根因〕）。⑤ e2e-cutover
  壳半边用例：fixture 导入 → bootHost 全宿主 → adoptShell 真子进程 mock 壳 →
  web RPC deliver → run 终稿 → user/agent 双账本回链对拍 + session/history 回放
  对齐；idle-exit 用例随 reply→late-reply 唤醒链真实生效改等收束断言。preview
  384/384 绿（72 文件）+ typecheck 0 错 + 定向 lint 清零，主线 typecheck/
  check:deps/test:unit 2748 全绿零扰动。

- 8.9 前置收敛第一批（cr-550，2026-10-20）：**宿主常驻监护面 + 插件装载
  失败回报 + supervisor 物理外置件**。① supervise.ts（preview/apps/host/）：
  guardian 行的常驻执行面——warden.tick 心跳判死（3 拍 → kill）/ idle 收割
  清表 / 壳退出三分支（respawn 重拉同链 / broken 熔断 / done 按需拉起）；
  adoptShell 增 onLine/onExit 持续订阅面（此前 adopted 后行流即弃——常驻
  监护无数据源的结构缺口）。② 壳 boot 插件行 fail-closed：装载失败 emit
  plugin.load-failed TSV + 跳行（熔断归宿主裁决，壳不被第三方插件拖死），
  宿主 supervise 消费转发 pluginRegistry.reportLoadFailure（cr-543 遗留
  「壳侧装载失败回报未接线」收口）。③ preview supervisor.mjs（D6 回退通道
  物理外置件，cr-527 归 8.9 落点）：与主线同构（ac-supervisor-core 策略
  纯函数 + 42/78/0 + 退避熔断 + .runtime 单写者锁），worker = 宿主 boot.ts；
  数据根不读 env（红线违例冒烟实证——显式 --data-root > preview/sandbox
  缺省两档）。④ 顺带根因修复：host-inbox.ts 类参数属性（cr-501/518/526
  同族第五例）。preview 390/390 绿 + typecheck 0 错 + lint 清零，主线零扰动。
- 8.9 前置第二批（cr-551，2026-10-20）：**宿主编排面**——orchestrator.ts
  （apps/host/）：supervise 句柄池 + ensureAgent 按需拉起（幂等——死态重拉/
  活态复用）+ 邮局 ensure 钩子（dispatch 判不可达 → fire-and-forget 拉起，
  投递路径不变恒落箱，D2 节拍 2 转投）+ onAdopted re-tap（B3 新壳新连接，
  tapAgent 幂等收旧）。boot.ts 接线（orchestrate 开关缺省开 + mockProvider
  档；HERE 提模块顶层）。**respawn 指数退避档**（cr-550 遗留收口）：主线
  supervisor-core decideOnExit 语义同构——存活驱动 streak（活过 bootOkMs
  归零基档 / 窗内即崩累计），base×factor^streak cap 60s + jitter ±20%；
  respawned 事件带 delayMs。**timers entries 单写者收口**（cr-540 遗留）：
  timers 行 entries 读写换轨 agents 编辑面（EntriesEditFace 窄接口注入——
  boot agents 行先行装配 + capture 面传实例；缺省自带直读写 = 测试/独立
  形态降级）；requires 语义辨析：timers→agents 是 options 注入 + 良定义降级
  （disable agents → timers 回落直读写），非 cordis inject 硬依赖——catalog
  不标 requires（行集闭包 = cr-521 壳树机制，宿主偏好裁剪不被连带摘行）。
  dev.ts 换轨生产链（bootHost + supervisors——dev 与 supervisor.mjs worker
  同链）。真进程冒烟：邮局投递不可达信 → 落箱 + ensure 拉起 → 壳 boot 抢锁
  → 转投 → 壳收信落账 → ack 出箱全链过。preview 395/395 绿 + typecheck
  0 错 + lint 清零，主线 typecheck/check:deps 零扰动。
- 8.9 前置第四批（cr-553，2026-10-20）：**creator 模板工具面收敛——插件装卸三件套 preview 形态**（cr-540 遗留②收口，8.9 前置余件清 2）。主线 ac-plugin-registry 行按 R0a 判据 1 拆两半：工具面 → 壳树**新行 plugin-dev**（ac-shell-rows/plugin-dev.ts：register_plugin / install_plugin / unregister_plugin 三工具——M11 语义化中断上报意图，loop/after-run 收束检测消费 toolInterrupt）；安装态写者 → 宿主 plugin-registry 行既有面扩展。通道分档：register = 会话级装载壳内自持（ctx.plugin dynamic import——assemblePluginRow 同款链，重启即失零宿主参与，主线「宿主进程装载」形态在新架构自然消解）；install / uninstall 永久档 = plugin-request 信封（ac-envelope-core 新 schema plugin-request.ts：payload {action, dir?, name?, conversationId} + 回执 payload 三 subject + 免审面校验）→ 宿主 HostInbox 受理（plugin-registry-row：applyPluginRequest 编排——installFromDir 免审三态〔stage → 自动批准 manifest permissions 全集 + hash 幂等对账——主线 G8/F14 语义〕/ uninstall 永久卸载）→ 回执信（receipt → ledger-only 落原会话经验流）+ 续跑信（message → budget 1 驱动下一轮——主线 receiptAndRetrigger 同义）；壳内 install 后立即会话级装载（「装好即可测试」主线产品语义保住——宿主回执线与壳内装载线独立，装载失败不阻断安装态）。行集：壳 36→37（plugin-dev 新行，总数 81→82 全新增）——catalog / 本档案 R2 / spec 同批回填；creator 模板 tools 增 plugin-dev + system 提示词第 3 节机制描述换新架构语义（模板防漂移测试恒过——词形命中目录）。宿主行 options 增 inbox + postOffice（缺席 = 信封面下线良定义降级，RPC 照常）。
- 8.9 前置第三批（cr-552，2026-10-20）：**agent-admin 跨进程 dry-run 收口**
  （cr-540/542 遗留——装配链住壳进程，R0a 判据 1）。通道定向 = boot 控制帧
  （stdin JSON 行 → 壳 control() → stdout TSV ctrl.done/ctrl.error 回执，
  cr-524 bench/tool 先例；管理面只读请求——非信封数据面，不落账不占串行化
  门无 budget 语义）。① 壳内半边：ac-shell-conversation 增 readConfig（run
  链与预览共用直读）+ previewSystemPrompt（三档链干跑——主线
  systemPromptPreview 同构，请求装配口径与 driveRun 同源）+
  assemblyToolsView（注册目录 + 行集投影现算）；boot ControlFrame 增
  preview 帧（system-prompt/assembly-tools 两形态）。② 宿主半边：
  adoptShell 增 control()（行拦截 ctrl.* TSV → FIFO pending 配对 + 60s 超时
  + 壳退出 reject pending）+ supervise/AdoptedShellFace 透传（无活壳按需
  拉起同 restart 语义）+ admin-preview.ts（createAdminPreview——ensureAgent →
  控制帧往返编排面）；agent-admin-row 三 RPC 落地：system-prompt（预览往返）
  / assembly（壳目录 + 宿主 plugins/settings 合成）/ assembly/update
  （applyAssemblyPatch 纯函数住 ac-agents-core/write.ts——tools 意图 +
  settings per-name 合并语义主线 M22 D5 形态，宿主本地落盘无需壳往返）；
  预览面缺席（orchestrate:false）= 两读面 fail-loud、六 CRUD 照常（良定义
  降级）。③ 顺带根因修复：toolFaceOf 首算永续缓存（长命壳 config 可变——
  换 per-config 值缓存键 JSON.stringify(tools)，写口落盘后天然失效）。e2e：
  真宿主 bootHost（编排面缺省开）→ RPC system-prompt → 壳按需拉起 → 控制
  帧三档链干跑 → 回执断言 + assembly 写后预览见新意图。preview 414/414 绿
  + typecheck 0 错 + 定向 lint 清零，主线 typecheck/check:deps 零扰动。

- 8.5 收尾批（cr-555，2026-10-20）：**isolated 档（iframe）通道装载接线**
  （8.5b 遗留项——「第三方条目现跳过」收口）。① 白名单纯函数平移进纯库：
  ac-webui-core isolated-policy.ts（isAllowedIsolatedRequest / isAllowedIsolatedEvent
  ——主线 p5.5-policy 的 isolated 白名单段，两侧共用单源；rewriteGlobalStyle 段留
  主线 webui 应用层）。② 宿主半边 ac-ui-app/src/isolated.ts（主线 isolated.ts 的
  preview 平移：request 代理走 ctx.rpc.call〔rpcMethodFor = /api/ 前缀剥离——preview
  web-api 薄 RPC 面即传输〕+ 事件转发经 rpc wire onEvent；订阅引用计数协议与 iframe
  runtime 对齐）。③ 装载接线三件：ui-plugin-iframe.html（CSP 同主线）+ vite 双入口
  （'ui-plugin-iframe' 入口——主线同款）+ boot.ts isolated 分支（iframe sandbox 容器
  创建 + BootUiResult.isolated 句柄暴露——cleanup 收割）。④ 测试 +4：容器属性 +
  cleanup 收割 + request/event 白名单纯函数两族。preview 435/435 绿 + typecheck 0
  错 + 定向 lint 清零，主线 typecheck/check:deps 零扰动。同批：preview sandbox 旧
  预演目录清理（import-rehearsal / cutover-rehearsal〔cr-547 产物〕/ tmp / dbg-stream /
  构建日志 / CDP 探针——保留 cutover-rehearsal-20261020 作 8.9 级联输入 + dev-home /
  ui-plugins 活跃消费）。

## 本档案纪律

- 探索档案（explore/）：设计规格，preview 开工输入；行集变更须回写本表（与
  yml / TREE 锁定测试同批）。正式立项时随两母档案迁 src/docs/。
- 引用规则：裁决依据写 R-n（per-agent）/ S-n（shell-model）/ D-n；本仓推演
  定向写裁决簿篇名；待钉项写 ◐。
- 立行流程：先过 R0a 树归属，再过 R0b 行资格——语义概念默认纯库 / 编排 / 数据
  形态，**立行是例外须在行表或归并表登记去向**。