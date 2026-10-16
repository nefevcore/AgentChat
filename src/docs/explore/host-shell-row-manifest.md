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
〈行资格判例〉。

# R1. 宿主树（47 行 = 基座 3 + 核心新增 3 + 身份编辑面 3 + 数据服务 5 + 传输/web 4 + 插件治理 3 + 远程 1 + ui 域行 25）

| 组 | 行 | 包 | 角色 | 来源 |
|---|---|---|---|---|
| 基座 | logger-console / timer / config | cordis-logger / cordis-timer / ac-config | 日志、fiber 定时（timers 依赖）、配置 | 沿用 |
| 新增 | post-office | ac-post-office | **邮局**：投递路由 + uuid 登记校验 + 群播扇出（吸收 group 拓扑的执行面）+ 发件箱滞留中继 | **新增**（ac-router 投递面 + ac-group 扇出面承接） |
| 新增 | guardian | ac-guardian | **监护**：按需拉起（三节拍，verify = 指纹对拍）/ 心跳监视 / idle-exit 收割 / 崩溃退避熔断 / 宿主重启入口 | **新增**（吸收 restart） |
| 新增 | auth-registry | ac-auth-registry | **授权注册表写者**：全局 + per-agent 两层、children 投影构造、凭据授予 / 轮换、授权目录数据 | **新增**（ac-security 裁决面 + credentials 写者面 + workspace 授权数据重组） |
| 编辑面 | agents | ac-agents | 身份编辑面：config / entries / 文档唯一写口 + 模板目录（吸收 agent-store 写引擎 + agents-dir 布局 + agent-presets 目录）；活注册表解体——配置轴 = 文件文集、在场轴 = guardian 可达表 | 改造 |
| 编辑面 | preset-builtin | ac-agent-presets-builtin | 内置模板数据行（包目录静态 Agent 配置文件集） | 改造——裁决簿〈注册表解体〉 |
| 编辑面 | agent-admin | ac-agent-admin | webui 写侧 RPC 编排（agent CRUD → agents 编辑面） | 沿用 |
| 数据服务 | timers | ac-timer | 定时唤醒（唤醒 = 投递信） | 沿用 |
| 数据服务 | usage | ac-usage | 计费聚合（对账 ledger 自报事件信；另收 job 观测快照镜像） | 改造 |
| 数据服务 | archive | ac-archive | 归档（枚举 agents/*/sessions/） | 改造 |
| 数据服务 | backup | ac-backup | 数据轴备份 + 快照链 GFS（分轴共行） | 改造（吸收 snapshot-chain） |
| 数据服务 | session-query | ac-session-query | 多根只读搜索 | 改造 |
| 传输/web | web-server / ws-bridge / webui / web-api | ac-web-* | 传输基座 + 桥接 + web 表面 + RPC 编排；**webui = 单包表面**（src/ 服务半边 + client/ 前端半边含骨架资产——裁决簿〈骨架归并〉）；会话历史读 = 文件直读，流式 token = 宿主转发（〈webui 读投影〉） | 沿用 |
| 插件治理 | plugin-registry | ac-plugin-registry | 装载裁决 + patch RPC + 熔断闸门 + 动态插件行集条目注入（install = 授权动作 → 壳行集，第三方代码零宿主驻留）+ client 半边 manifest 注入（〈插件 client 通道〉） | 改造（吸收 patch-rpc + plugin-gates） |
| 插件治理 | plugin-market / event-policy | ac-plugin-market / ac-event-policy | 市场 + 事件策略（全局治理门） | 沿用 |
| 远程 | remote-link | ac-remote-link | 远程链路 | 沿用 |
| ui | ui 域行 ×25 | ac-client-ui-* | 域卡片行（卸载 → 该域卡片回落文本渲染）；id 清单以 yml 为准（31 − 骨架 6；骨架经 ui 树解构为协议 3 件入 ac-webui，conversation/settings/tool 转模块资产——ui-tree.md §2） | 沿用（通道建成后续批收敛 manifest 声明——R7-9） |

# R2. 壳树（35 行 = 基座 2 + 账本会话 3 + 模型编排 3 + 装配链 3 + 任务追踪 2 + 工具面 16 + 域服务 5 + 评测 1）

| 组 | 行 | 包 | 角色 | 来源 |
|---|---|---|---|---|
| 基座 | logger-console / config | cordis-logger / ac-config | 日志、配置（timer 基座不进壳树——裁决簿〈timer 归属〉） | 沿用 |
| 账本会话 | ledger | ac-ledger | **账本**：messages.jsonl + journal + inbox 消费 + settlement + usage 自报（journal 计量 + 事件信） | **新增**（ac-session 机制改 per-agent 账本语义；吸收 usage-report） |
| 账本会话 | conversation | ac-conversation | 会话状态机：串行化门 + inbox 双队列（next-step / next-turn）+ 防自激 budget（信封携带）+ user 端点桩（激活仪式化，R-2） | 改造 |
| 账本会话 | tools | ac-tools | 工具注册基座 + **授权门**（ac-auth-core 投影，每 run 前重读） | 改造（吸收 security-exec） |
| 模型编排 | llm / llm-pool / agent-loop | ac-llm 族 / ac-agent-loop | 模型会话 + 连接池（凭据直读数据根，R-11 ③）+ ReAct 编排 | 沿用 |
| 装配链 | persona / system-prompt / memory | ac-persona 等 | 装配链（persona 身份数据只读；memory 经验数据本壳写） | 沿用 |
| 任务追踪 | goal / todo | ac-goal / ac-todo | 任务追踪 | 沿用 |
| 工具面 | 16 行 | fs-tools / fs-search / file-snapshots / str-replace-editor / shell-tools / run-code / math / web-tools / issue-tools / harness-tools / sap-adt / dev-tools / datetime / skill / collab-tools / mcp | agent 工具面（MCP 照 R-12；issue / harness 令牌链直读 credentials 纯库；sap-adt 吸收 preset 子行） | 沿用 |
| 域服务 | conv-settings | ac-conv-settings | 会话级覆盖读面（会话粒度运行时门） | 改造 |
| 域服务 | subagent | ac-subagent | 子 Agent（R-5：children 嵌套物化 + spawn ⊆ 授权投影） | 改造 |
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
| ac-rowset-core | 行集推导器：AgentConfig（tools 点名 + tag 展开）× 全局行集目录（cordis.yml 降格为全集目录）→ 壳行集派生清单；+ tag 目录静态投影（per-agent 化——装了 fs-tools 行才见 fs 词，编辑面与壳存活期解耦）；AgentConfig 入指纹输入 | 宿主 boot 现算（argv 传清单引用）+ CLI 本地派生；tags/catalog RPC 数据源；TagDeclaration 类型随迁 |
| ac-credentials（降格） | 行降格为注入纯库（R-11 ③ 物理单副本两侧共用） | 两侧共用（写者面 = auth-registry） |

## R3.2 壳 boot 编排骨架（编排代码，非行序）

```
acquire activation.lock（O_EXCL + pid 探活 / 陈锁接管，协议规格 C）
→ 读 argv 行集清单引用（宿主派生 / CLI 本地派生，ac-rowset-core）
→ 行集静态断言（档位/模式词不进 requiredTags、mode 通道不挂 tags——纯函数）
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
| patch-rpc / plugin-gates / sap-adt-preset | 本体包内 | 包内文件 / 小包 / 子行 |
| restart | guardian 行内 | 宿主进程生命周期 = 监护职责 |
| job-wakeup | 壳 jobs 行内（三投递策略随迁） | 唤醒面随 worker 父级走——裁决簿〈jobs 归属〉 |
| group | 解散：扇出 → 邮局；拓扑 → 数据根；编辑 → webui 卡片 | 群 = multicast 地址表（数据不配行） |
| workspace | 解散七面（ui-tree.md §7）：①引导→boot 编排；②沙箱推导→ac-sandbox-core 纯库；③⑤⑥文件/本机交互/类型→ac-files 模块（后端半=宿主行+client 半=ui 树）；④登记→auth-registry（能力语境目录）；⑦能力语境发现→壳行运行时读面 | 行资格三问皆否；工作区=第三输入源（ui-tree.md §6） |
| tag-registry | 解散：catalog → ac-rowset-core 静态投影；启动断言 → boot 编排；类型随迁 | 现算依赖宿主在场——裁决簿〈tag 目录静态化〉 |
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
| ac-conv-settings | 读面（run 装配） | 编辑面（webui） |

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
| 6 | 重工具行按需 boot | ◐ sap-adt / harness / issue 全量 vs 按需进默认壳集（裁剪两级已定向——裁决簿〈装配期派生〉） |
| 7 | patch 机制归属 | ◐ 宿主专属 vs 两树各持——与两形态同根断言（R-7）交互 |
| 8 | AgentConfig 变更生效路径 | ◐ 自然生灭 vs guardian 观察指纹变更主动优雅重拉——监护 spike |
| 9 | 插件 client 通道（ui 树装配） | ◐ 框架升格 → ui-tree.md（三树同构 + 骨架=协议持有者 + manifest 三树投影）；执行端 = ac-webui/client/；schema / 注入语义 / 拓扑贡献开放度（③ 级挂拓扑+换壳）/ 存量收敛批次待设计 |

# R8. 规模盘点与对账

- 现状 100 行 → **宿主 47 / 壳 35**（基座行两树各计；骨架六件已定向并入 webui
  本体——47 组件和不含骨架，对账 −6 生效，「并后 42」系算误已修）。
- **全新行 4**（邮局 / 监护 / 授权注册表 / 账本）；**新纯库 5 + 1 降格**；
  **归并 20 / 退役 3**（另过渡方案 2）。
- 对账恒等式：100 − 3 退役 − 1 降格 − 11 归并（ac-agents 注册表瓣为行内拆分
  不减行数）− 6 骨架（已定向并入 webui 本体）− 3 承接消失（router / session / security，功能由 4 个
  全新行与 tools 门承接）+ 4 新增 + 2 基座双计 = 82 = 47 + 35。

## 本档案纪律

- 探索档案（explore/）：设计规格，preview 开工输入；行集变更须回写本表（与
  yml / TREE 锁定测试同批）。正式立项时随两母档案迁 src/docs/。
- 引用规则：裁决依据写 R-n（per-agent）/ S-n（shell-model）/ D-n；本仓推演
  定向写裁决簿篇名；待钉项写 ◐。
- 立行流程：先过 R0a 树归属，再过 R0b 行资格——语义概念默认纯库 / 编排 / 数据
  形态，**立行是例外须在行表或归并表登记去向**。