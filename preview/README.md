# preview —— cordis 第一性原理轨道（双轨）

> **src 能力全景 → preview 重写地图**：`docs/src-to-preview-map.md`
> （四域深度审查合成：逐包映射 / 架构决策记录 ADR-1~7 / 事件目录演进 /
> 原样继承资产清单 / 里程碑 M9-M15 + M7 规划）。
> **M15 对账报告**：`docs/m15-reconciliation.md`（六轴逐项对照 +
> 补齐/缩水决策 + 切换策略结论）。
> **M7 开工简报**：`docs/m7-webui-plan.md`（WebUI/可视化下一里程碑）。
> **M17 开工简报**：`docs/m17-ui-parity-plan.md`（src/ui/webui 功能对账
> 与原生面补齐路线——M16 收窄面的恢复地图）。
> **M22（✅ P1+P2 已落地 2026-08-28）**：`docs/m22-ext-plugin-ui-plan.md`（扩展与工具/插件库
> cordis 原生化——presets 概念退位（B1 开关静默回退修复）、7-hook-kind 导航收敛
> 事件落点、扩展目录后端化、hooks 写口 per-name 合并语义、dev 扫描面补齐、市场页签摘除；
> D1 全局 extTools 叶子并入插件库「装配行」页签。P3 注册制目录另立项）。
> **M24（✅ 已落地 2026-08-30，P1-P6 全批）**：`docs/m24-global-defaults-plan.md`（词汇收口、全局默认层与
> **目录信息架构**）。落地形态：
> **X1 词汇收口**——`AgentConfig.hooks`→`settings` 全链改名（类型删除旧字段；
> RPC 线格式 `agents/assembly`·`assembly/update`·`update-config` 同批原子切换
> `settings:{enabled,configs}`/`patch.settings`；ac-agent-admin `ALLOWED_FIELDS`
> 换名）；双读归一只放 agent-store 加载边界（getAgent 旧 hooks 键归一 settings，
> 类型层之下；写侧只写新键）；存量迁移脚本 `scripts/migrate-hooks-to-settings.ts`
> （幂等+marker+--dry-run+恒等门测试）；ac-singles 前缀快照修订键/settingsOf
> 正确性风险点显式测试；webui 全链改名（shims/api/useSettings/AgentPane/
> ExtToolsPane/PluginLibraryPane）。
> **A1 全局默认层**——config.json 新白名单域 `settings`（CONFIG_KEY_PREFIXES
> 加键）+ 合成口 `AgentsService.settingsOf(id, name?)` =
> deepMerge(全局层, 差异层)（与 update-config 同源语义；preset/未知 id 回落
> 全局层；get() 保持差异层原样）；消费侧全量迁移（persona/skill/datetime/
> system-prompt/memory/security/archive/web-tools/singles/workspace/
> plugin-registry/web-api/session-tokens 全走 settingsOf）；冻结坑守卫测试
> （合成→get-config→update-config 回写后差异层不混入仅存全局层的键）。
> **X2 目录 IA**——`plugin/catalog` RPC（内置组=dev 扫描 preview/ac-*/ 的
> package.json 元数据，仅收声明 `agentchat.plugin: true` 的行包——纯库/
> 组合根 fail-closed 出局，npm 发现面=keywords "agentchat"；×cordis
> registry 装配交叉；生产 bundle 首期空+note 注明；
> 本地组=registry ∪ devScan ∪ 会话装载单一清单+待审暂存并入 pending 态）；
> 前端插件库重构两页签「目录|插件市场」+目录三视图左导航（插件[内置组
> patch 开关 entryId 锚点+配置弹窗全局默认层实例]/工具[schema 弹窗]/事件
> [@scope 分组+描述+治理开关]）+ M23 四页签退役；Agent 装配页同构（三视图；
> 配置弹窗差异层实例 ExtensionSettingsModal 双实例共享组件；事件视图=本
> Agent 生效链 × settings 门控态）；EXTENSION_CATALOG 条目赋 configNs +
> fields 补 enabled；plugin/rows 附 entryId。
> **X3 市场首期**——`ac-plugin-market` 行复活（market/search npm registry
> +github topic 双源搜索 / market/stage tarball 下载解包[tarball.ts 纯函数
> tar 解析]+manifest 校验+来源锚定 PluginSource 暂存人审）；前端市场页签+
> 安装确认弹窗（来源/权限/ui 高亮）→ 暂存进目录本地组待审徽章；fetcher
> 注入口测试零网络。
> **X4 能力收敛**——有效能力集 = {base, agent:<id>} ∪ tags ∪
> settings.security.capabilities（追加覆盖层只加不减）；ac-security 双轨
> 对账告警退役（覆盖层有值降级一次性 info 提示）；AgentPane 双写退役
> （emitTags 单写 tags）。
> **X5 audit 轮转**——appendAudit 写前大小检查（超 5 MiB 轮转 .1→.2 保留
> 2 份，串行队列内 rename）；readAudit 只读当前份。
> **M25（✅ 已落地 2026-08-30，P1-P3 全批）**：`docs/m25-event-governance-plan.md`（事件治理与运行时
> 行树治理）。落地形态：
> **P1 契约与门控基建**——`LoopStepCall.agent` 补齐（域内唯一身份缺口；
> 发射点 request.agent 在作用域）+ agentOf 读取器 11 个住 owning 包
> （ac-agent-loop×5 / ac-tools×3 / ac-router×1 / ac-llm×2 / ac-conversation×1，
> 类型锚定自家 contract + 单测）+ 全部 owning 包事件目录补 `@scope run|host`
> （15 文件；group/message-posted 按 N2 双语境 host 归）+ `ac-gate-core` 纯库
> （agentGate：waterfall 停用机械 return next()[末参函数判定]/emit 停用跳过/
> 软依赖 agents.settingsOf/facet 子键覆盖回落行为级——六形态测试）+ 目录锁定
> 测试（event-catalog.test.ts：@mode+@scope 全量标注/run 域清单对齐/emit 末参
> 永不为函数静态检查）+ event-row 模板升级 agentGate 用法 + 两技能同步。
> **P2 事件清单与治理**——EXTENSION_CATALOG 演进监听器级声明
> `{event, role, description, facet?, respectsEnabled?}`（12 条含 plugin-gates）+
> manifest provides.events 扩展 `string | {name, description?}`（校验兼容）+
> `events/descriptions` RPC（声明目录×执行链交叉；全量清单以声明目录为准）+
> **ac-event-policy 策略行**（internal/listener bail 吞注册[owner=fiber 名；
> 替代注册 ()=>true；internal/* 恒放行自锁守卫]+boot 末一次性清扫
> [boot.ts 组合根收敛后调用]+行 reload 自追清扫+停用键 config
> `events.disabled: string[]` owner 原文+双命中[fiber 名×聚合行名]+
> 热更只影响后续注册）+ `events/policy-list`·`policy-set` RPC + 目录·事件
> 视图（@scope 分组+描述+角色注释+治理开关+承重警示/保护行二次确认弹窗）+
> Agent·事件视图 facet 感知灰显；bail 单链纪律静态断言。
> **P3 行树治理（M23 P7 收编）**——fiber→顶层行聚合（aggregate.ts：loader
> entry 路径+程序化路径；聚合只改呈现不改键）/ events/listeners owner 裸名
> →row 聚合名 / 反依赖图 `plugin/dep-graph` RPC（fiber.inject 键集×reflect
> 提供面归一 + 传递闭包 dependents + 保护行标记 + ctx.get 盲区注明）/
> yml 行熔断（internal/status FAILED ≥3 写 patch disable；FAILED≠级联
> PENDING）/ **include 热通道**（setPatch 三态契约补全 hot：fiber.update
> 事务化行树变更、失败回滚、cordis.yml 字节不变——F10 守卫维持测试）。
> **M23（✅ 已落地，P7 已由 M25 P3 收编）**：`docs/m23-agent-plugin-plan.md`（Agent 自开发
> 插件能力：开发→测试→**免审安装**→回滚闭环。核心立场 = 装载即供给、选用在
> 数据面；免审安全不靠人靠无人值守补偿控制。落地形态：
> **P1 免审安装口**——`installFromDir` 复合口（stage→自动 approve→立即装载；
> 三态结果 installed+loaded/installed+failed/rejected；同 hash 幂等不重试装载、
> 改动必 bump version；保留字护栏 tools/llmProviders/agents 三面内置名常量表
> [一致性测试 boot 全树锁定]；approveStaging 可补偿分步 + registry 原子写 +
> 全 mutation 串行队列 + Windows rename retry）+ `install_plugin` 工具（interrupt
> 上报 + after-run 宿主半边；grants 去除、与 register_plugin 分工互引）+
> **回执与回触**（回执经 session.append M21 中性格式落账当前会话 →
> `sender:'event'` 回触 owner 自会话——闭环无人值守自驱动；金闭环 e2e 脚本化
> agent 走完 开发→安装→回执→回触→测试迭代）+ 审计流水 plugins/audit.jsonl
> （install/uninstall/reject/load 四类全入账）；
> **P2 owner-tag 归属**——capabilities = 显式 ∪ {base, agent:<调用方id>}（显式
> 排除 base 无效——收窄走 tools include/exclude）、无身份不合成 owner 段、
> tags/capabilities 双轨对账 warn once、共享 = 双写两处；manifest provides
> 对象形状 {tools,llmProviders,events,ui,agents}（前端 provides.hooks 错位修复）；
> **P5 熔断与安全模式**——.load-health.json 失败计数 + disabled 集（install/
> uninstall 强制清记录；skipped[] 透出第四态徽章）+ boot hash 复验（篡改已装
> 目录拒载）+ gates 就绪屏障（首扫不过空 waterfall）+ AGENTCHAT_SAFE_MODE/
> .safe-mode 安全模式；
> **P3-lite 行偏好层**——cordis.patch.yml（官方 PatchOptions；boot.ts 内联官方
> 16 行注入 patches；listPatches/setPatch 三态返回[hot 后置 P7]；写回守卫测试
> 锁死 cordis.yml 永不运行时写入）+ denyPaths 控制面黑名单（workspace.root
> 锚定绝对路径注入；workspace 不可用 fail-closed）；
> **P4 可视化**——events/listeners RPC（_hooks 有序读出 + prepend 标记，裸
> fiber 名归属）+ 前端执行链渲染；「插件」UI 调整（装配行三区 + Agent 开发行
> dynamic 分组 + 停用开关[重启生效] + 安全模式横幅 + 熔断第四态 + 装配页按
> 插件分组/过滤）；
> **P6 模板规约**——preview/templates/ 三骨架（tool-row[agentTool owner tag +
> tool-output 包裹]/provider-row/event-row[agentFilter]）+ agentchat-plugin-dev
> 技能更新（供给面/迭代/watch/共享输出框定/生命周期如实呈现）。
> P7 已由 M25 P3 收编（include 热通道/fiber→行聚合/yml 行熔断全落地）。
> **M20（✅ 已落地）**：`docs/m20-archive-review-plan.md`（归档分支回归
> 设计——会话内整理 run + 失控防线：2026-08-26 手工归档 4GB OOM 的事故
> 档案/根因、src 设计对照四处偏离、四步落地与 D1-D6 裁决点。落地形态：
> 整理 run 回归 `conversation.deliver` 同桶串行化门（placement next-run
> 排队不并发）；不落盘由"绕开通道"改显式标记跳过（信封
> `meta[ARCHIVE_REVIEW_META]`，ac-agent-loop 导出——ac-session 不入账/
> ac-usage 不记账/ac-conversation 不进上下文视图三消费方）；输出物回归
> Agent 亲自整理（write `summary/<会话>.md` 概要来源[服务端读文件，mtime
> 判新] + memory_rewrite 重写记忆 + TODO/DONE/note）；对桶双侧整理 done
> 协议收尾；失控防线三闸（maxSteps 硬上限 128[用户裁决，偏离 src 不设
> 上限]、超时 abort 后强制归档、步级日志观测+软阈值 16 告警）。
> 顺手修复：ac-memory 工具经 `ctx.get('memory')` root-traced 解析
> （M15 起 memory_append 在真实 run 内解析断链的潜在 bug））。
> **M19（✅ 已落地）**：`docs/m19-pair-bucket-plan.md`（user 去特殊化——
> 全对键桶模型：**一切双端会话都是对桶** `conversationId = pairKey(a, b)`
> （排序 `~` 连接，自会话 = `a~a`），user 只是端点之一，桶/路由/统计零
> 专属路径。信封身份/拓扑分离（`sender`=端点 id + `source`='user'/
> 'agent'/'event'）；机制触发统一归 Agent 自会话桶（D2）；web-api 边界
> 显式算直答对键（D3）；前端分区彻底统一 `pair:`（D4 废 direct:）；
> 存量数据自 src 轨道重迁移（D5，`scripts/migrate-workspace.ts` 产对键桶）。
> **Session 设计文档**：`docs/session-design.md`（Session 域目标设计：
> 设计理念/消息定义/落盘格式/三种会话形态/KV 缓存分析/现状差异清单——
> 含 M21 审核补充差距 F1-F5）。配套落地规划与实证档案：
> `docs/m21-replay-prefix-cache-plan.md`（回放视角正确性 + KV 前缀稳定
> 重构：a⇄b 三层回放失败实证、DSH 双参照系、分步 1-7 与 D1-D7 裁决）。
> **M21（✅ 已落地 2026-08-27）**：D13 中性格式（一切真实发言 =
> role:'agent' + agent_id；error 一等行；头行 v1 + 单调 seq + 迁移脚本
> `scripts/migrate-session-neutral.ts`）+ D1 viewer 投影（history 回放按
> 读者赋予角色——a⇄b 双侧正确、user⇄x 恒等）+ D2/D3/D7/F1 视图派生化
> （ac-conversation 视图 = 文件事件增量投影，字节等价 golden + 归档
> stale-惰性重派生 + 直答/独立会话重启上下文连续）+ D4 工具 schema 字典
> 序 + D5 singles 前缀快照（修订键锚点 + 终态核验 + datetime 日快照行）
> + D6/F2 群派生窗钉住 + per-member 播种 + hint 去重 + **D11 存储统一**
> （群本体迁 sessions/groups/ 经 shelf 上架——post→session.append/回复经
> 事件入账[GroupService 订阅 reply-completed 进内存 log，records/锚点
> 即刻可见——UI 群历史刷新不丢回复]/退役 groups 本体/视角桶不落文件
> [markStale + per-member 种子重派生]；singles 归位 sessions/singles/<ws>/；
> 整备脚本 `scripts/unify-group-storage.ts` + 迁移脚本同步产出统一布局；
> **前端契约同步**——GroupMessageRecord 透传 steps[]/reasoning[群成员
> 工具卡片/思维链刷新不丢]，webui fetchGroupHistory 按步展开[与 1v1
> toHistoryMessages 同构] + groupMessageToChatMessage 透传）+
> D9 KV Cache effect 声明纪律 + usage 基线脚本（`pnpm
> preview:usage-baseline`——95.3% 基线可复跑）+ D14 轨迹回放开关
> （session.replayTrajectory，SettingsPanel 可调）。
> **WebUI 适配器方案（✅ 全部完成——阶段〇归档 + 阶段一同源迁移 + 阶段二
> 六梯契约换血收口：适配器 A 已整体退役，UI 直连 preview 协议）**：
> **收口后人工回归问题清单（7 项，✅ 已全部修复——P2/P5/P7 查证小修 +
> P1/P6 迁移补齐 + P4 名册合成 + P3 ac-session 持久化增强，含
> portb-e2e 补真链路断言；逐项收口记录见文首"修复状态"节）**：
> `docs/webui-portb-issues.md`（池/定时任务迁移缺口、扩展工具空、
> 思维链与 event 持久化、名册排序摘要、prompt 预览空、tags 缺字段、
> 弦图/矩阵渲染——各含初步定位与修复方向）。
> `docs/webui-adapter-plan.md`（src UI 保真迁移 + 契约换血双轨过渡。
> 复刻路线五轮实证不收敛后，用户裁定目标为"完全复现 src 界面"，转
> 同源路线 + 防腐层；含现状盘点/数据面账本/阶段〇-三/决策记录 D1-D6。
> 执行期作战笔记：`docs/webui-adapter-notes.md`）。

与 `src/`（旧轨，冻结只修 bug）并行的新轨道：**不学习、不延用 src 的设计**，
把 cordis 基座与生态插件用到极致：核心四件套（`declare module` 类型声明 /
`apply` 行激活 / `on/emit/waterfall` 事件系统 / `effect/dispose` fiber 归属
可逆副作用）+ 生态四件套（plugin-loader 配置驱动装配 / plugin-hmr 模块热
重载 / plugin-timer fiber 定时器 / plugin-logger-console 控制台输出）。

## 契约归属（谁 emit 谁声明）

**没有独立的契约包**（对齐 DSH 形态，也修正旧轨 `@agentchat/contracts` 的
教训）：每个能力域的契约（服务接口、域类型、`domain/*` 事件目录）住在
**提供 `ctx.<key>` 的 owning package** 里，靠 cordis 声明合并分布式注册：

| 域 | 域类型 | 事件目录 |
|---|---|---|
| llm | `ac-llm/src/contract.ts` | `ac-llm/src/events.ts`（llm/*） |
| tools | `ac-tools/src/contract.ts`（M11：执行身份 agentId/conversationId/toolCallId + signal/onProgress + `ToolResult.interrupt` + `requires` 能力门禁） | `ac-tools/src/events.ts`（tool/*） |
| loop | `ac-agent-loop/src/contract.ts`（M11：`interruptReason.toolInterrupt`） | `ac-agent-loop/src/events.ts`（loop/*） |
| agents | `ac-agents/src/service.ts`（AgentConfig） | `ac-agents/src/events.ts`（M7：agents/updated——reassign/remove 写口 emit） |
| router | `ac-router/src/service.ts`（RouterInbound） | `ac-router/src/events.ts`（router/*） |
| conversation | `ac-conversation/src/contract.ts` | `ac-conversation/src/events.ts`（conversation/*） |
| group | `ac-group/src/contract.ts` + `src/view.ts`（`<msg>` 包装） | `ac-group/src/events.ts`（group/*） |
| config | `ac-config/src/service.ts` | `ac-config/src/events.ts`（config/*） |
| credentials | `ac-credentials/src/service.ts` | — |
| agentStore | `ac-agent-store/src/service.ts` | — |
| jobs（M11） | `ac-jobs/src/contract.ts`（JobStartSpec/JobHooks/JobSnapshot） | `ac-jobs/src/events.ts`（job/settled） |
| browser（M11） | `ac-web-tools/src/browser.ts`（守护进程命令配置） | — |
| durableInteraction（M11） | `ac-durable-interaction/src/types.ts` + `src/store.ts`（内存/JSONL 后端） | `ac-durable-interaction/src/service.ts`（durable-interaction/{opened,replied,closed}） |
| timers（M12） | `ac-timer/src/service.ts`（TimerRowOptions；TimerEntry 在 ac-timer-core） | — |
| archive（M12） | `ac-archive/src/service.ts`（ArchiveRowOptions/ArchiveBatchItem） | `ac-archive/src/events.ts`（M7：archive/completed——归档重建漏斗收尾） |
| usage（M12） | `ac-usage/src/index.ts`（UsageAggregate 双轨聚合桶） | — |
| backup（M12） | `ac-backup/src/index.ts`（BackupRowOptions；纯库类型在 ac-backup-core） | — |
| workspace（M12） | `ac-workspace/src/index.ts`（WorkspaceRowOptions/WorkspaceAdminOptions） | — |
| webServer（M13） | `ac-web-server/src/contract.ts`（RouteCall/RpcHandler/RpcCaller） | `ac-web-server/src/events.ts`（ws/ack + ws/connection-*） |
| webui（M13） | `ac-webui/src/service.ts`（PluginUiManifest/UiExtensionDescriptor） | `ac-webui/src/service.ts`（webui/extensions-changed） |
| uiExtensions（M13） | `ac-webui-extensions/src/service.ts`（UiSlotDef/UiExtensionDef——slot 白名单 + install 超时守护） | — |
| pluginRegistry（M13） | `ac-plugin-registry/src/service.ts`（PluginLoadCall/PluginLoadOutcome/LoadedPlugin；manifest/permissions/staging 类型在 ac-plugin-core） | `ac-plugin-registry/src/service.ts`（plugin/before-load(W) + plugin/installed·reloaded·catalog-changed(E)） |
| eventPolicy（M25） | `ac-event-policy/src/service.ts`（停用键/清扫/fiber→行聚合 aggregate.ts） | —（治理 seam = vendor internal/listener bail，非公开事件） |
| agentAdmin（M7） | `ac-agent-admin/src/service.ts`（AdminUpdateResult） | — |
| skills（M14） | `ac-skill/src/index.ts`（SkillRowOptions/SkillHooks；SkillManifest 在 ac-skill-core） | — |
| mcp（M14） | `ac-mcp/src/index.ts`（McpServerDef/McpRowOptions；MCP 域类型在 ac-mcp-core） | — |

纯库（零 cordis 依赖）：`ac-openai-completions`（协议；M12：usage 缓存字段归一化）、`ac-config-merge`（deepMerge/computeDiff 差异配置）、`ac-edit-core`（编辑引擎：三级模糊匹配/增量 diff/行尾保留/文件突变队列）、`ac-sandbox-core`（createSandboxResolver/bash 命令扫描/输出脱敏）、`ac-text-budget`（token 估算/代理对安全截断）、`ac-glob-core`（glob→RegExp + 有界 walk）、`ac-web-search-core`（5 搜索 provider 特型）、`ac-archive-core`（M12：归档阈值/尾部截断[不拆工具对]/二次归档去重分割——与 ac-session SessionRecord 共享格式）、`ac-timer-core`（M12：间隔解析[含 ms]/目标时间/5 模式标签/节假日[农历+调休配置]/时区 ISO/hint 模板）、`ac-backup-core`（M12：zip 打包/周期轮转/到期间隔——路径全显式）、`ac-ws-protocol`（M13：WS 帧编解码 + rpc/ack 控制帧 + 后台源判定）、`ac-plugin-core`（M13：manifest 校验[provides 对象形状 M23]/权限授予策略/契约版本兼容/staging 人审文件域[哈希/只读代理/备份轮换/可补偿 approve/原子写]；M23 新增：fsx[原子写/rename retry/串行队列]、audit.jsonl 审计流水、reserved 内置名保留字常量表[三注册面]、load-health 熔断存档、cordis.patch.yml 行偏好层文件域）、`ac-supervisor-core`（M13：42/78/0 退出码协议 + 退避熔断纯函数 + .runtime 单写者锁）、`ac-skill-core`（M14：SKILL.md frontmatter 解析/发现/`<available_skills>` 渲染/白名单过滤）、`ac-mcp-core`（M14：MCP 客户端——官方 SDK 包装[HTTP/stdio 双传输/insecure per-server dispatcher] + describeError cause 链展开 + 撞名命名空间策略）、`ac-memory-core`（M14：记忆注入 token 预算截断——尾部近期记忆保留 + 明确截断标记）、`ac-gate-core`（M25：agentGate 门控——waterfall 停用机械 next()/emit 停用跳过/facet 子键覆盖回落行为级，软依赖 agents.settingsOf）。

- 消费方一行 `import type {} from 'ac-llm'` 即获得服务类型 + 域类型 +
  事件目录的类型增强（type-only，运行时零依赖）。
- 跨域词汇（如 loop 用 `LlmMessage`）type-import 自 owning 包——类型层
  认识，运行时仍按服务 key 解耦。
- 防撞靠 `domain/action` 命名约定（cordis 惯例），不靠集中式唯一文件。

## 布局（扁平，每插件一包，`ac-*` 前缀）

```
preview/
├── ac-llm/                  LLM 纯路由（ctx.llm）：register 工厂（懒实例化）+ model 路由 + stream/chat + LLM 域契约
├── ac-openai-completions/   OpenAI 兼容纯库（SSE 流式 + tool_calls 分片 + chat 聚合，零 cordis 依赖）
├── ac-llm-openai/           薄行：inject ['llm'] 注册工厂（与另两个薄行互不依赖）
├── ac-llm-deepseek/         薄行：同上
├── ac-llm-glm/              薄行：同上
├── ac-tools/                工具注册中心（ctx.tools）：fiber 归属注册 + waterfall 拦截 + 工具域契约
├── ac-agent-loop/           ReAct 循环（ctx.agentLoop）：inject [llm, tools]，边界事件化 + 循环域契约
├── ac-agents/               Agent 注册中心（ctx.agents）：Agent 是数据不是插件
├── ac-agents-dir/           数据驱动行：<root>/agents/ 目录扫描物化进 ctx.agents（摘行回收；AgentLoader 大对象装配的消解）
├── ac-agent-presets/        预设 Agent 目录（ctx.agentPresets，src agent-presets 落地）：内置 __standard__/__dsh_minimal__ 数据定义 + 物化进 ctx.agents（preset 标志——名册过滤/send_agent 拒收/管理面写口拦截）+ 默认池模型解析（config/changed 热更新 reassign）；skip-if-present（盘上同 id 实体优先）；无记忆语义 = 预设 hooks 软停用 memory/skill/datetime（dsh-minimal 另停 system-prompt）
├── ac-agent-store/          Agent 数据目录 owning（ctx.agentStore）：config.json + 机制 entries + 文档实体（AGENT.md 等 saveDoc/readDoc，M14）——timer/skills 唯一写口，ADR-5
├── ac-config/               全局配置（ctx.config）：<root>/config.json 原子读写 + 热重载 + config/changed(E)
├── ac-config-merge/         配置 diff/merge 纯库（deepMerge/computeDiff——差异配置只存差异项）
├── ac-credentials/          凭据（ctx.credentials）：AES-256-GCM 机器绑定加密 + Agent→全局解析链 + listValues 脱敏清单
├── ac-router/               消息路由（ctx.router）：纯转发——agents 解析 AgentConfig 构建信封投递 agentLoop + 事件通知双通道 + 信封拓扑（M19：sender=端点 id + source 拓扑词 + conversationId 对桶）+ 路由域契约
├── ac-conversation/         会话状态机（ctx.conversation）：串行化门（handle=runAddress）+ inbox 双队列（next-step=steer / next-turn 链跑）+ placement + MAX_AUTO_WAKES 防自激（ADR-1，router 保持零会话状态）；M15 待投持久化（root 给定即启用：next-turn 落盘 pending-<handle>.jsonl、消费重写、boot 回放——崩溃/42 重启待投不丢）；M21 步骤 2 视图派生化：上下文视图 = router 事件（message-received/reply-completed/steered）经 projectRecord 按读者投影进该桶全部 handle 的增量缓存（行形态 ≡ history(conv,{viewer}) 文件派生，字节级 golden 锁定；startRun 手工 push 退役）+ 无视图/stale 时 session.history(conv,{viewer}) 重播种（F1 修复：直答/独立会话重启后首跑上下文连续）+ archive/completed → stale-惰性重派生（D7：归档后视图收缩回落 keep 预算内）
├── ac-group/                群拓扑（ctx.group）：成员表 + 单通道 v3 内容流 + GroupFeed 锚点增量 + 投递经 conversation（busy=steer / idle=新 run）+ `<msg>` 包装唯一构造点；**D11 存储统一（M21 落地）**：群本体迁入 sessions 树——sessions/groups/<gid>/messages.jsonl（session.setShelf 上架，post → session.append 中性行入账[行 id 返回对齐 GroupFeed 锚点]、成员回复经 reply-completed 事件入账[steps 内嵌]、hint 投递带 GROUP_HINT_META 不重复入账）——退役 groups/<gid>/messages.jsonl（groups/<gid>/ 只剩成员表 group.json + 轮转分段 archive/），本体读取（historyFor/GroupFeed/records）懒水合自 session.records（无 session 行 = 纯内存）；轮转 = 分段 + 机械摘要归本域 + session.compact 重建本体；post/轮转 → conversation.markStale（成员视图 per-member 单源派生：本体每增长即 stale，下次 run 由 send 的新种子重派生——不落视角文件）；M15 其余语义保持（500k 轮转/30k 保留 + M21 步骤 5 派生窗钉住[窗口头不动、增量吸收——滑窗消除] + per-member 播种[F2]）
├── ac-session/              会话历史（ctx.session）：事件积累（router/* + conversation/steered；M21/D13 中性入账：一切真实发言 = role:'agent' + agent_id=说话人端点——入站/回复/steer/私信同词汇，虚拟端点特判删除；机制触发 = role:'event'；run 错误收束 = role:'error' 一等行，不再伪装 assistant 文本）→ writer队列落盘（append+fsync/幂等 message_id[WeakMap 固化，不变异消息对象]/barrier/失败回队首）+ history() 回放（viewer 投影：agent_id===viewer→assistant、其余→user——a⇄b 双侧视角正确；旧 baked 行兼容读取，user⇄x 恒等）+ records()/append()/compact()（M12 归档与宿主写入口）+ 工具前 fail-closed checkpoint（M11 定向化：按执行身份 conversationId flush）+ steps[] 步记录持久化（M18：ReAct 各步正文/思考/工具调用对随回复行落盘——刷新后按步重建工具卡片；不进 history() 的 LLM 回放）
├── ac-singles/              独立会话元数据（ctx.singles，M18-G）：会话 = 引用 + 覆盖而非拷贝——<root>/singles/<sid>/session.json（Agent 引用 + 会话级模型覆盖 + 工作区挂载 + 状态）；消息流归 ac-session（conversationId = sid，规约 2 零新写路径）；空白会话全局唯一（reuse 复用 + create 前清理）；规则 1（src 同款）：有消息即锁（未选 Agent 的会话经默认预设路由，同样锁）；空 agentId 投递目标 = 默认预设 __standard__（前端 defaultPresetId 回退）+ 会话级模型覆盖随投递信封透传；跨域校验（agents/workspace/session）经 ctx.get 可选解析；singles/updated(E)；singles/* RPC（list/create/update/archive/delete）；M18：自动标题——loop/after-run 后为无标题会话 LLM 生成一句话标题（失败回落首条消息截断[跳过 datetime 日快照行]；fire-and-forget；经 update → singles/updated 即时刷新前端列表）；M21 步骤 4：[system+tool schema] 前缀快照（D5，§5.2）——before-run 按装配输入全集（persona/system/hooks/生效工具集 schema[ac-agent-loop normalizeToolSpecs 同口径]/模型/llmParams/memory 哈希）计算修订键，run-started 纯观察捕获终态 sidecar prefix-snapshot.json（最新胜）或对拍告警漂移（M5-lite 请求可重建）；键变 = 显式失效重拍（一次 replace）
├── ac-persona/              人设注入：loop/before-run 前置 <persona> 块（hooks['persona'] = string | {enabled?,text?,file?}——M14 文件装载：裸名走 agentStore 文档[AGENT.md]、路径走文件系统，frontmatter 剥离，file 优先 text 回退）
├── ac-system-prompt/        系统提示词分块装配器（M14）：框架块（M18 起无标签包裹——<persona> 标签归 ac-persona 专用）/系统环境（M18：工作目录缺省 = Agent 专用空间 files/<id>，绝对路径必给、工作区内相对形态附注；显式 security.workdir 最优先）/术语约定[协作工具门控]/指引[request.tools 门控]/后台任务/对话信息（M19：`[当前对话对象] <sender id> - <注册表显示名>`——委托方身份随信封直达（身份/拓扑分离的顺带修复）、机制触发标注自会话；群经可选 ctx.group 解析成员表带显示名）+ override 覆盖；hooks['system-prompt'] per-Agent 管控
├── ac-memory/               长期记忆（ctx.memory）：键=conversationId（与会话桶统一，M14）；<root>/memory/ 文件后端 + token 预算截断（ac-memory-core）；before-run 注入 <memory> 块
├── ac-datetime/             日期注入行（M14；M21 步骤 4 双形态）：独立会话（singles）走「每日 user 快照行」——追加在当前消息之前（尾部追加、每信封恰一行、日内字节恒定），不进 system（前缀绝对稳定试点位）；其余会话形态 before-run 追加仅日期行进 system（YYYY-MM-DD 周X——失效面单桶、日更频率，§4.4 显式接受）；无会话键不注入；hooks['datetime'].enabled
├── ac-skill/                技能行（ctx.skills，M14）：全局 <root>/skills/ 目录发现（懒扫描+refresh）+ before-run 追加 <available_skills>；hooks['skill'].whitelist per-Agent 白名单
├── ac-collab-tools/         协作工具行（M14）：send_agent（经 conversation：busy=steer/wait=next-run；M19 统一 pairKey(from,to)——目标为虚拟端点时天然落 viewer 对桶（与用户直答同桶）+ 返回"无自动回复"引导，不再整单拒绝）/send_group/list_agents/list_groups/list_tools/read_agent_info/update_agent_profile（agentStore 落盘 + persona 写 AGENT.md + admin 门）
├── ac-hello/                链路验证插件（最小完整样例：inject/apply/effect/on）
├── ac-jobs/                 后台任务注册中心（ctx.jobs）：owner 分桶 + 并发上限 + settle first-wins + job/settled(E)（M11）
├── ac-fs-tools/             文件读写工具行：read（行号分页 + token 预算截断）/write（突变队列串行）/edit（ac-edit-core 编辑引擎）
├── ac-fs-search/            检索工具行：glob（mtime 排序/上限 100）+ grep（正则/include 过滤/二进制跳过/上限 250）——ac-glob-core
├── ac-str-replace-editor/   四合一编辑器行：view/create/str_replace/insert（DSH 语义；写经突变队列——修 src 缺口）
├── ac-shell-tools/          命令执行工具行：bash（前台超时/signal/流式 onProgress + 后台 job 登记）+ job 管理（owner=执行身份）；Unix→PowerShell 翻译
├── ac-math/                 数学工具行：node:vm 沙箱求值（Math 白名单 + timeout 兜底）
├── ac-web-tools/            网络工具行：web_search（ac-web-search-core 5 provider + key 三源链 + hooks['web-tools']）+ browser（ctx.browser 守护进程 Service：请求队列 + dispose 杀进程）
├── ac-dev-tools/            开发辅助行：read_logs（logger exporter 环形缓冲）/ reload / reload_modules（语义化中断）
├── ac-restart/              system_restart 工具行（Supervisor 模式语义化中断）+ 宿主半边（M15：after-run 消费 interrupt → 优雅关闭 → exit 42 → supervisor 重拉）
├── ac-session-query/        会话查询门面行：grep_history / read_history（复用 ctx.session.history()）
├── ac-security/             安全行：能力门禁（requires AND vs 显式 ∪ {base, agent:<调用方id>}——M23 owner 合成；tags/capabilities 双轨对账 warn once）+ per-Agent 沙箱 + 控制面黑名单（M23：cordis.patch.yml/registry.json/audit.jsonl/.load-health.json/.safe-mode 按 workspace.root 绝对路径注入 denyPaths，workspace 不可用 fail-closed）+ bash 命令扫描（before-execute）+ 输出脱敏（transform-result——凭据明文 + sk-/api_key= 模式，结构化深走）
├── ac-subagent/             子 Agent 行：spawn = agentLoop.run 直连（agent:undefined 零会话污染；受控工具集）+ completed 缓存 + job 登记（kind=subagent）
├── ac-durable-interaction/  持久化交互行（ctx.durableInteraction）：write-ahead 状态机（open/reply/close 幂等）+ 三事件 + ask_questions 工具（correlationId=toolCallId；late-reply 走 source:'event'）
├── ac-usage/                用量统计（ctx.usage）：订阅 loop/after-run 记账（双轨 usage：覆盖=当次上下文/累加=总用量/cache hit-miss/react_steps）→ byAgent/byModel/byDay/byDayModel(日期×模型交叉，「按模型」堆叠图)/byConversation/byPair/totals 查询 + <root>/usage/usage-<date>.jsonl 审计流水 + boot 回读重建聚合（M15：重启不丢看板）
├── ac-timer-tools/          定时任务工具行（M15）：timer 工具 set/list/disable 三 action（映射 ctx.timers 服务；owner=执行身份）
├── ac-archive/              归档编排（ctx.archive）：after-run 阈值检测 → conversation.deliver 同桶整理 run（M20 回归：串行化门排队不并发 + meta[archive-review] 标记三处不落盘[session 入账/usage 记账/上下文视图] + 双侧 done 协议 + maxSteps 128 硬闸/超时 abort/步级观测三道防线；概要 = Agent 亲写 summary/<会话>.md，服务端读文件）→ 归档分段 + session.compact 重建；超时兜底 + archiveAll 批量（M12）
├── ac-backup/               数据备份（ctx.backup）：run（force/间隔检查）+ list——zip 全量 + 轮转保留 4 份（M12；纯库 ac-backup-core）
├── ac-timer/                定时任务（ctx.timers）：5 模式调度（叠官方 cordis-timer 的 ctx.timeout）+ 限定次/永久 + 停机补偿 + per-Agent 条目持久化归 ac-agent-store + 全局条目（sys.timer）归 config 'timer.tasks'（row chime 条目 builtin 保护；M17-A）+ 触发=conversation.deliver(source:'event'；M19/D2：个人自触发与全局条目统一落 Agent 自会话桶 `<id>~<id>`（对角线）——与用户直答对桶分离，sender=目标自身) + 机制任务直调（archive-all/backup-all，M12）
├── ac-workspace/            工作区初始化（ctx.workspace）：目录布局 + browser 守护脚本分发（files/browser_daemon.py）+ 默认 user(virtual)/admin 数据 register + 首启消息经 session append（M12）+ M18 本机目录浏览（browseRoots 快捷根 / browseDirs 子目录清单——路径穿透白名单的文件夹选择弹窗数据源，只列目录名不读文件内容）+ Agent 专用空间唯一事实源（agentWorkdir：常规 Agent = <root>/files/<id>、预设 = 工作区根；sandboxWorkdir：显式 hooks.security.workdir > 专用空间 > undefined——安全行校验、文件/命令工具行解析、提示词展示三处共用永不漂移）
├── ac-web-server/           Web 传输服务（ctx.webServer）：HTTP 路由注册中心（注册即归属 + :param/尾* 捕获）+ WS 广播/心跳 + requestId 幂等去重（deduped）+ ack + RPC 显式注册 + 静态托管/SPA（M13；Node 原生 http——零 express）
├── ac-ws-bridge/            WS 事件桥接订阅行：ctx.on(emit 面)→WS 帧（type=事件名直转，{args} 载荷）；零业务状态；后台会话过滤（source='event' 流式抑制、边界事件仍广播）
├── ac-webui/                Web UI 表面（ctx.webui）：插件 UI 扩展 entries 清单 + /ui-plugin/ 静态 + webui/extensions-changed(E)（M13）
├── ac-webui-extensions/     UI 扩展 slot 注册表（ctx.uiExtensions）：宿主先开口（内置六 slot 白名单）+ 插件后填空（fail-closed）+ install 15s 超时守护 + isolated 档（M13）
├── ac-plugin-registry/      插件注册中心（ctx.pluginRegistry）：staging 人审管（approve 哈希/权限快照）+ 装载管道（before-load waterfall → 动态 import → fiber 父=本行）+ plugin/* 事件 + register_plugin/install_plugin/unregister_plugin 工具（中断通道，after-run 宿主半边）（M13；M23：installFromDir 免审安装复合口[三态结果/同 hash 幂等/保留字护栏] + 回执 session.append + sender:'event' 回触 owner 自会话[闭环自驱动] + .load-health.json 熔断[计数/disabled 集/skipped[] 透出] + boot hash 复验 + gates 就绪屏障 + 安全模式[AGENTCHAT_SAFE_MODE/.safe-mode] + 行偏好层 cordis.patch.yml[listPatches/setPatch 三态，hot 后置 P7] + 审计流水只读面）
├── ac-plugin-gates/         插件装载 gate 策略行：plugin/before-load 上权限 + 契约双 gate（import 之前 fail-closed，代码不进进程）（M13）
├── ac-mcp/                  MCP 行（ctx.mcp，M14）：全局服务器注册（注册即归属/懒建连——对齐 ac-llm 范式）+ 发现工具注册进 ctx.tools（撞名 `${server}__${name}` 前缀）；行 Config.servers 放行；per-Agent 暴露走 AgentConfig.tools；协议住 ac-mcp-core
├── ac-job-wakeup/           后台任务完成唤醒行（M15）：job/settled → conversation.deliver(source:'event'，M19/D2 落 owner 自会话桶) 通知 owner（串行化门/链跑/MAX_AUTO_WAKES 由会话状态机承担；与 ws-bridge 同事件两订阅方）
├── ac-plugin-market/         插件市场行（M24 P5 复活）：market/search npm+github 双源搜索 / market/stage tarball 下载解包+manifest 校验+来源锚定暂存（第三方供应链人审，与免审流分立；fetcher 注入口测试零网络；tar 解析纯函数住本包 tarball.ts）
├── ac-event-policy/          事件治理策略行（ctx.eventPolicy，M25 §3.4）：internal/listener bail 吞注册（(插件×事件) 停用集 events.disabled，吞注册≠veto）+ boot 末一次性清扫 + 行 reload 自追清扫 + internal/* 自锁守卫；fiber→顶层行聚合（aggregate.ts——只改呈现不改键）
├── ac-gate-core/             agentGate 门控纯库（M25 §3.3，零 cordis 依赖）：waterfall 停用机械 return next()（末参函数判定）/ emit 停用跳过 / facet 子键覆盖回落行为级；软依赖 agents.settingsOf
├── ac-web-api/              WS RPC 业务方法注册行（M7，薄编排零业务逻辑）：conversation/deliver·interrupt·stats + interaction/list·reply + session/history·delete-message·archive·tokens（M18：补 maxContextTokens[archive hook 同口径]/usagePercent/avgTokensPerMsg/estimatedMsgsRemaining——会话头 Token 仪表分母）+ agents/list·tool-defs + group 全套（list/create/delete/join/leave/rename/send/history）+ usage/tokens——deliver outcome steered/queued→ack busy、next-run 等闲→预发 parked；archive 为可选能力（ctx.get 非 strict，摘行不拖垮 RPC 面）；M17-A 补齐 timer·backup·jobs·config·llm/providers·plugin 全套·system/version·restart；M18 补 plugin/rows（cordis 装配行清单——扩展面板内置能力数据源）+ workspace/browse-dirs（本机目录浏览，白名单弹窗）；M22 补 plugin/extension-catalog（EXTENSION_CATALOG 静态目录 ∩ registry——扩展目录归 owning 方，词汇表不住前端）+ plugin/dev-scan（owner 布局开发目录扫描 + 数据根透出）+ plugin/loaded 附 failed[]（装载失败运行态记录）；M23 补 plugin/loaded 附 skipped[]（熔断透出）+ safeMode（安全模式横幅）+ plugin/patch-list·patch-set（行偏好层三态）+ events/listeners（事件执行链 _hooks 有序读出 + prepend 标记）+ plugin/rows origin:'dynamic'（Agent 开发行分组判据 = registry ∪ loaded）；M24 补 plugin/catalog（目录 IA：内置组=包源清单[仅声明 agentchat.plugin 的行包，mtime 缓存]×装配交叉 + 本地组=registry∪devScan∪session∪待审）；M25 补 events/descriptions（声明目录×执行链交叉）+ events/policy-list·policy-set（治理停用集）+ plugin/dep-graph（反依赖图：行级闭包 dependents + 保护行标记；owner 聚合行名经 ac-event-policy）（详见"WebUI 接线"节）
├── ac-agent-admin/          Agent 管理面首期（ctx.agentAdmin，M7）：CRUD（sanitize 白名单 fail-closed + apiKey 剥离进 ctx.credentials + deepMerge 局部补丁 + computeDiff 变更报告 + agentStore 唯一写口 + reassign 热生效=agents/updated）+ saveDoc（空内容=删）+ system-prompt dry-run（before-run waterfall 干跑）+ 装配视图（M17-A：agents/assembly 读·写；M22/D5：assembly/update 的 settings 补丁改 per-name 浅合并 / null 删除——合并语义下沉服务端，前端免 read-modify-write）+ 写侧 RPC（agents/create·update-config·delete·get-config·save-doc·read-doc·set-credential·system-prompt·assembly·assembly/update——注册即归属随本行）
├── webui/                   前端本体（阶段一同源迁移：src/ui/webui 逐字节拷贝[117 文件，除 cordis 宿主半边] + adapter/ 防腐层[ws 帧+fetch→RPC 翻译] + @agentchat/protocol 自包含垫片；原生面已归档 archive/webui-native-m16 分支——阶段二逐模块换端口的对照物）
├── supervisor.mjs           宿主监护进程（进程层脚本，不经组合根）：spawn worker + 42/78/0 协议处置 + 信号转发 + .runtime 单写者锁（M13）
├── ac-app/                  组合根：行表 + bootTree（程序化）+ ecosystem.ts/cordis.yml（配置驱动）双路径
└── cordis.yml               配置驱动装配文件（plugin-loader + plugin-include；hmr 行默认 disabled）
```

## 两条装配路径

| 路径 | 入口 | 说明 |
|---|---|---|
| **官方（生产）** | `pnpm preview:boot` | boot.ts 内联官方 bin.js 的 16 行（Context → Loader → include 读 `./cordis.yml`；M23 起装载前读 `<数据根>/cordis.patch.yml` 行偏好层注入 patches——不存在/损坏 warn+空数组 fail-soft），零自研引导之外的唯一差异 |
| 测试/演示辅助 | `ac-app/src/ecosystem.ts` 的 `bootFromConfig()` | 官方路径之外的 initial 物化 / include patches / 独立测试 yml（vitest 用） |

**装载态四层（M23 A2；M25 P3 热通道已补全）**：`cordis.yml` 出厂态（git 管理，
永不运行时写入——F10 写回守卫测试锁定）→ `cordis.patch.yml` 本机行偏好层
（声明式 patch，{id, disabled}；M25 P3 起 setPatch hot 态——include 热通道
即时生效）→ `plugins/registry.json` 安装态（动态插件；boot 扫描恢复）→
`settings[具名]`（M24 X1）per-Agent 启用表达（全局默认层 ∪ 差异层，
settingsOf 合成）。

**Agent 插件开发分工（M23 B1，此前未记载）**：

| 目录 | 用途 | 装载方式 |
|---|---|---|
| `<数据根>/files/<agentId>/<name>/` | **Agent 自开发**（调用方沙箱，install_plugin 缺省约定位置） | `register_plugin` 临时试跑（会话级）/ `install_plugin` 永久安装 |
| `<数据根>/plugins/<agentId>/<name>/` | 用户手工开发扫描面（插件库「开发与会话」页签 devScan） | 宿主 UI 装载 / stage → 人审 approve |
| `<数据根>/plugins/<name>/` | 已安装态（install/approve 的落位） | boot 扫描自动恢复 |

模板骨架与规约：`preview/templates/`（工具行/provider 薄行/事件行 +
共享输出框定 + 生命周期说明）。

**数据根约定（M18）**：持久化目录 = **启动文件夹**（你敲 `pnpm preview:boot`
时所在的目录，不套 `data/` 壳）。pnpm/npm 运行脚本时会把脚本 cwd 切到
package.json 所在的包根（在子目录敲命令也会被抬到仓库根）——真·启动
文件夹经 `INIT_CWD` 取回。boot.ts/supervisor.mjs 在 chdir 前锚定它写入
`AGENTCHAT_DATA_ROOT`（已设则尊重），各持久化行（ac-config/session/
agent-store/singles/memory/usage/timer/archive/backup/skill/credentials/
plugin-registry/durable-interaction/workspace，及 group/conversation 的
持久化开关）缺省读它，回退 `./data`（测试兼容）。在哪个文件夹启动，数据
（sessions/agents/singles/…）就落在那个文件夹。

配置驱动要点（对齐 [cordis-tutorial](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/)）：

- **行 name = 裸包名**（官方形态）：`ac-*`（根 package.json 声明的 workspace
  链接）与 `@agentchat/cordis-*`（vendor 框架行）。解析锚点 = cordis.yml 所在
  目录（loader 的 `internal.import` 以 baseUrl 为 parentURL，沿目录树向上走
  node_modules 至仓库根命中）。本地插件写相对路径（教程同款 `'./my-widget.ts'`）；
- **可配置插件导出 Config schema**（Schemastery，教程 chapter 5）：loader 在
  apply 前校验并填默认值，非法配置 = 行 FAILED、boot 拒绝；
- **hmr 行默认 `disabled`**：其构造需要 `--expose-internals`；`pnpm
  preview:boot:demo`（带 flag）经 include `patches` 运行时启用，不写回 yml；
- 配置热刷新：`include.refresh()` 事务性增删行（改 yml → 保存 → diff 行集
  → 回滚式更新），运行时 patch 不落盘；
- 兼容约束（Node 原生 TS strip-only 加载器）：包内相对导入写显式 `.ts`
  扩展、类字段不用参数属性。

依赖形态（llm 域）：

```
ac-llm（纯路由）← ac-llm-openai / ac-llm-deepseek / ac-llm-glm（三个薄行，互不依赖）
                      └── ac-openai-completions（纯库，三行共用）
```

端到端链路（M3 起，M9 补全会话状态机与群拓扑）：

```
ctx.conversation.deliver(agentId, msg, {sender, source, conversationId, lane, placement})   会话状态机（ADR-1；M19：缺省对键 = pairKey(sender, agentId)）
  ├─ 空闲 → 开新 run（门注册同步完成）┐
  ├─ 忙 + placement steer → ctx.agentLoop.steer(handle, msg)  ← handle = runAddress(agent, convId)
  ├─ 忙 + placement next-run → 等空闲后独立 run               │
  └─ 忙 + lane next-turn → 入队（run 结束后链跑，MAX_AUTO_WAKES=3 防自激[source='event']）┘
        │
        ▼  每 run 经 router（纯转发，零会话状态）
ctx.router.send(agentId, msg, {history, sender, source, conversationId, signal})
  ├─ ctx.emit('router/message-received', agentId, msg, convId, sender, source)    通知通道（ac-session 按 convId 分桶积累）
  ├─ ctx.agentLoop.run(envelope)           能力调用（M19 信封：sender=端点 id + source 拓扑词 + conversationId 对桶；settings[具名] 不进信封）
  │    ├─ waterfall 'loop/before-run'      扩展装配链（全部按 AgentConfig.settings[具名] 管控，策略可 veto）：
  │    │                                   ac-persona（<persona> 前置——file 优先 text 回退）/ ac-system-prompt（分块装配：
  │    │                                   框架块[无标签] → 系统环境[工作目录给绝对路径] → 术语约定[协作工具门控] → 指引[request.tools 门控] →
  │    │                                   后台任务 → 对话信息[当前对话对象 src 格式；群经可选 ctx.group]；
  │    │                                   override 全量覆盖静态块）/ ac-memory（<memory> 键=conversationId，预算截断）/
  │    │                                   ac-skill（<available_skills> 全局技能目录 + hooks 白名单）/
  │    │                                   ac-datetime（仅日期行收尾——KV cache 友好）/ ac-mcp（首 run 懒建连同步 MCP 工具）
  │    ├─ emit 'loop/run-started'          run 开始通知（veto 不发；WS/UI Turn 分组订阅面）
  │    ├─ 每步：消费 steer 注入 → waterfall 'loop/before-step' → emit 'loop/step-started'
  │    ├─ ctx.llm.chat(...)                纯路由 → provider（懒实例化）；llm/delta-* 流式细分事件
  │    ├─ ctx.tools.execute(...)           执行身份随 call 装配（M11：agentId/conversationId/toolCallId + signal 透传）；
  │    │                                   同步工具并发 mapLimit(5)、结果按 tool_calls 序回填；
  │    │                                   ToolResult.interrupt → finish='interrupted'+toolInterrupt（语义化中断通道）
  │    ├─ waterfall 'loop/transform-step'  步记录安全审查/脱敏（入档/通知前的终值）
  │    ├─ emit 'loop/after-step'           （通知变换后终值）
  │    ├─ waterfall 'loop/transform-run'   轮结果安全审查/脱敏（router 回复/session 入账前的终值）
  │    └─ emit 'loop/after-run'            （通知变换后终值；signal 中止 → finish='interrupted'+interruptReason，ADR-2）
  └─ ctx.emit('router/reply-completed', agentId, text, run, convId, sender, source)  ac-session 入账

工具执行面（M11，tool/* 拦截链上的标准装配件）：
  tool/before-execute（waterfall 决策）
    ├─ ac-session   fail-closed checkpoint（按 conversationId 定向 flush 后放行）
    └─ ac-security  能力门禁（requires AND vs hooks['security'].capabilities）→
                    per-Agent 沙箱（路径类工具）→ bash 命令扫描（heredoc 剥离 + 段级启发式）
  tool/transform-result（waterfall 变换）
    └─ ac-security  输出脱敏（ctx.credentials.listValues() 明文 + sk-/api_key= 通用模式；结构化深走）
  工具体返回 { ok, output: <src data 形状> }（展示词汇由 web 表面自取）；
  宿主级行为（reload/restart/插件装卸）经 ToolResult.interrupt 上报 → loop 收束 → 宿主执行。

群拓扑（ac-group，单通道 v3）：ctx.group.send(gid, from, content)
  = post 入流（内容唯一事实源 + group/message-posted 事件；M15 持久化后
    本体落盘 <root>/groups/<gid>/messages.jsonl，超 500k token 轮转
    → archive/history_N.jsonl + summary_N.md 机械摘要）
    → 逐参与者 conversation.deliver(member, <msg>包装+时间, {sender: from, source,
      conversationId: gid, history: historyFor(gid, member)}——viewer 视角回放[peer 包装/own 原文/
      相邻合并/30k 截断/摘要头]作首跑种子；会话已有内存视图则零开销)
    （handle=gid~member 每参与者独立门：busy=steer、idle=新 run；fire-and-forget）
    + GroupFeed：readSince(锚点)/currentAnchor（busy 参与者的免重复增量通道）
    成员表/本体/轮转重启全恢复（M15）；群删除随目录清理

持久化基座（M10，ADR-5 owning service）：
  ac-session   事件积累（message-received/steered/reply-completed）
               → writer 队列（按会话文件串行/WeakSet 引用幂等/append+fsync/
                 quiescence barrier/失败批次回队首）→ <root>/sessions/<convId>/messages.jsonl
               · tool/before-execute fail-closed：排空队列后才放行工具（入站消息先 durable）
               · history() 回放（概要头部注入）供下一轮 options.history；
                 records()（行级含 message_id，归档去重口）+ append()（宿主直注入账，
                 workspace 首启用）+ compact({summary, keep})（M12：归档重建落盘口）
  ac-agent-store  <root>/agents/<id>/config.json + 机制 entries（timer/timer-archive 唯一写口）
  ac-agents-dir   目录扫描物化 → ctx.agents（数据驱动行）
  ac-config       <root>/config.json 原子读写 + config/changed(E) 订阅刷新
  ac-credentials  AES-GCM 加密凭据（Agent 级→全局级解析链）

服务编排（M12；ac-archive 链路 M20 回归"Agent 亲自整理"原设计）：
  ac-archive   loop/after-run →（M19 对桶门：run 的 Agent ∈ 对桶端点；阈值=会话消息估算 > hooks['archive']·行缺省）
               → requestArchive（pending 标记[含参与者清单] + 幂等）
               → 整理 run = conversation.deliver 同桶投递（sender/source:'event' +
                 placement:'next-run'——与用户 run 共串行化门，忙时排队不并发；
                 信封 meta[ARCHIVE_REVIEW_META]（ac-agent-loop 导出）三处不落盘：
                 ac-session 不入账 / ac-usage 不记账 / ac-conversation 不进上下文视图；
                 工具面 = Agent 生效集（router 解析）；对桶双侧整理[D5：两端非虚拟
                 各跑，虚拟端折叠单侧]；maxSteps 硬闸 128 + 步级日志观测）
               → done 协议收尾（loop/after-run 识别标记 → .done-<agent> 全到齐）
               → archiveAndRebuild：records() → splitForArchive（ac-archive-core：
                 去重[message_id 锚] + 尾部水位截断[不拆工具对]）→ <root>/archive/<convId>/history_N.jsonl
                 → session.compact({summary, keep})（概要 = Agent 亲写
                 files/<agent>/summary/<conv>.md，服务端读文件 mtime 判新；缺 write
                 工具回退"回复即概要"；max-steps 收束 → 概要降级、归档照常）
               · 超时兜底（懒扫描：有 pending 才有定时器；超时先 abort 该会话
                 在途整理 run 再强制归档）+ archiveAll()（timer 机制任务直调口）
  ac-timers    条目 = agentStore entry 'timer'（5 模式：time/delay/random/workday/holiday；
               限定次/永久；完成归档 'timer-archive'）+ 全局 chime（行配置 entries）
               · 排程叠官方 cordis-timer（ctx.timeout，fiber 归属）；懒心跳（有排程才跳，
                 空闲零定时器进程自退）；state.json 原子写 + 停机补偿（先记账后触发）
                · 触发 = conversation.deliver(source:'event', history=session 种子；M19/D2 统一落 Agent 自会话桶 pairKey(target, target))
               · 机制任务 entry.task（archive-all/backup-all）直调 ctx.get 服务——
                 淘汰 __xxx_all__ 字符串协议（规约 3）
  ac-usage     loop/after-run → 双轨记账（契约 LoopRunUsage：prompt/total 覆盖=当次上下文、
               promptAccumulated/completion/cache/steps 累加=总用量）→ 内存聚合
               （byAgent/byModel/totals）+ 日 jsonl 审计流水
                · M15：boot 回读全部 jsonl 重建聚合（重启不丢看板）+ byDay
                  + 流水行含 conversationId（byPair 维度数据基础）
  ac-backup    ctx.backup.run({force})：zip 全量数据根（含归档——归档也是记忆）+ 轮转保留
               4 份 + 7 天到期间隔（定时直调走间隔检查，手工 force 跳过）
  ac-workspace 初始化：目录布局 + browser_daemon.py 分发（→ <root>/files/shared/scripts/，
               ac-web-tools scriptPath 指向）+ 默认 user（virtual：router 只记事件不跑 loop）
               /admin（行配置给 model 才建）= agentStore 持久化 + ctx.agents 数据 register
               + 首启消息经 session.append（.initialized 标记防重复引导）

宿主与可视化（M13，src WebUIServer/WSHandler/PluginHost 的传输面拆分——ADR-6 中间层删除）：
  ac-web-server  传输基座（零业务知识）：HTTP 路由注册中心（route(method, pattern, handler)
                 → fiber.effect 注册即归属）+ WS 连接管理（广播/定向/30s 心跳）+
                 rpc/call 显式分发表（registerRpc——弃 src 反射全量）+ requestId 幂等去重
                 （deduped ack，src #53/#91 重连 flush 重复持久化教训原样继承）+ 静态/SPA
                 · ws/ack(E)：{requestId, kind: deduped|busy|parked}——deduped 传输层内置判定，
                   busy/parked 由投递方经 ack() 上报（conversation outcome steered/queued 映射）
  ac-ws-bridge   订阅行（inject webServer）：emit 面 → WS 帧（type=事件名直转，{args} 载荷）
                  · 后台会话过滤零业务状态化：delta/step 级事件自带 source 载荷（M13 增强
                    LlmChatInput.meta + loop step envelope——M19 身份/拓扑分离后按 source 判定）逐事件独立判定；
                    tool/* 无 source → run 边界登记表兜底（run-started 登记/after-run 清除）
                 · 边界事件（run-started/after-run）不过滤（前端渲染分隔符需要）
  ac-webui       UI 扩展资源宿主：entries 清单（/api/ui/extensions）+ /ui-plugin/ 静态 +
                 webui/extensions-changed(E)（前端宿主拉清单 diff → unload/reload）
  ac-webui-extensions  slot 注册表（与 fiber 语义同构——原样移植）：宿主先开口（内置六 slot）
                 + 插件后填空（未声明 slot → fail-closed）+ install 15s 超时回滚 + isolated 档
                 （不信任扩展不进 slot 注册表——src sandbox iframe 档的后端约束面）
  ac-plugin-registry  插件域 owning 服务：stage/approve/reject/uninstall（人审文件域住
                 ac-plugin-core：哈希/只读代理/权限快照/来源锚定原样）+ 装载管道
                 （plugin/before-load(W) → 动态 import[cache-busting] → ctx.plugin——
                 fiber 父=本行，行卸载全回收；同名替换失败回滚恢复旧实例）
                 · 三层分工：yml=出厂态、registry.json=安装态（永不写回 yml）、hooks=启用表达
                 · register_plugin/unregister_plugin 工具：上报意图（ToolResult.interrupt）
                   → loop 收束 → 本行消费 after-run 的 toolInterrupt 执行装卸（宿主半边住
                   owning 域行内）
  ac-plugin-gates     装载 gate 策略行：权限（manifest.permissions ⊆ grants）+ 契约
                 （manifest.contracts vs HOST_CONTRACTS_VERSION）双 gate——import 之前
                 fail-closed（代码不进进程）；拆行 = 安全策略随行组合演进
  supervisor.mjs 宿主监护进程（命运隔离：不 import 业务包）：42 主动重拉/78 启动失败不重拉/
                 0 一并退出/其他指数退避熔断（策略纯函数住 ac-supervisor-core）+
                 .runtime 单写者锁（wx 排他——消灭双启 TOCTOU，M12 遗留项落点）
```

扩展补全（M14）：
```
  ac-datetime     before-run 追加仅日期行（`[当前时间] YYYY-MM-DD 周X`——一天内 system 稳定，
                  前缀缓存跨轮命中，重建每日至多一次——资产 #12）；无会话键（子 Agent/
                  loop 直连）不注入；hooks['datetime'].enabled 软停用
  ac-skill        全局技能目录 <root>/skills/<dir>/SKILL.md（frontmatter name/description）：
                  SkillsService 懒扫描 + refresh 刷新口；before-run 追加 <available_skills>
                  （read 工具加载完整指令的路径提示）；hooks['skill'].whitelist per-Agent 白名单
                  （name/dirName 皆可命中）；发现/解析/渲染住 ac-skill-core 纯库
  ctx.memory      键 = conversationId（M19 对桶：直答/委托/自会话 = pairKey(a,b)、群 = 组 id——
                  与会话桶统一，规约 2）；<root>/memory/<key>.md 文件后端（本服务拥有——ADR-5）+ append 累积口；
                  注入预算 hooks['memory'].maxTokens ?? 行配置（ac-memory-core：尾部近期记忆
                  保留 + 明确截断标记）
  ac-collab-tools 协作七件（执行身份 call.agentId 取代 src 身份工厂烘焙——来源标签钩子族净删除）：
                   send_agent = conversation.deliver(sender=from + source:'agent'，桶 = pairKey(from,to)
                   ——M19 与直答同构；ADR-1 串行化门/steer 注入；wait=true → next-run 等独立 run）/ send_group·list_groups
                  = 可选 ctx.group / list_agents·read_agent_info = ctx.agents（model/hooks 仅自查
                  可见）/ list_tools = AgentConfig.tools 白名单过滤 / update_agent_profile =
                  agentStore 落盘 + ctx.agents 覆盖注册（persona 写 AGENT.md 文档唯一写口 +
                  hooks['persona'].file 挂载；改他人需 hooks['security'].capabilities 含 admin）
  ctx.mcp         MCP 服务器注册中心（对齐 ac-llm 范式）：registerServer 只存定义（重名抛错），
                  首 run before-run 懒建连 + tools/list 发现 → 注册进 ctx.tools（注册即归属；
                  撞名 `${server}__${name}` 前缀回退）；行 Config.servers = 进程级放行清单
                  （Agent 不能自行开新连接）；per-Agent 暴露走 AgentConfig.tools 白名单；
                  单服务器失败 warn 不炸行（下一 run 重试）；协议住 ac-mcp-core 纯库
                  （官方 SDK 包装：HTTP/stdio 双传输、insecure per-server dispatcher、
                  describeError cause 链展开——src 踩坑原样继承）
```

WebUI 接线与前端本体（M7 适配收编 → M16 原生重写 → **同源迁移阶段一回滚 M16**：
UI 代码即 src 代码，preview 协议差异全部隔离进 webui/src/adapter/ 防腐层——
契约归属消费方、适配器是可整体替换的运行时插件、锁测试双向钉死，
详见 docs/webui-adapter-plan.md + docs/webui-adapter-notes.md）：
```
  ac-web-api      WS RPC 业务方法注册行（薄编排零业务逻辑，注册即归属）：
                  69 RPC 方法 + 13 HTTP 路由 + webui/dist 静态托管——
                  方法面细目见 M7/M17-A 路线条目（conversation/session/
                  agents/group/singles/usage/runs/timer/backup/jobs/
                  config/llm/plugin/system + ac-agent-admin 写侧 10 方法）
  ac-agent-admin  Agent 管理面（ctx.agentAdmin + 写侧 RPC 随本行）：
                  sanitize（AgentConfig 字段白名单 fail-closed——src GLOBAL_ONLY_KEYS 的
                  preview 形态 + apiKey 侧信道剥离进 ctx.credentials）→ deepMerge 局部补丁 →
                  agentStore.saveAgent（唯一写口）→ agents.reassign 热生效（"写后触发"=
                  agents/updated emit——管理写路径无需整目录热重扫）→ computeDiff 变更键
                  报告（ac-config-merge 首个消费者）；saveDoc 空=删（src writeMDFile）；
                  system-prompt 预览 = loop/before-run waterfall 干跑（无 run 副作用）；
                  M17-A 装配视图 agents/assembly GET·assembly/update PUT（src AssemblyView
                  收编：plugins 已装载目录 + settings[具名] + tools include/exclude/生效集/
                  全量目录；presets 显式缩水——行组合决定装载，ADR-4）
  webui/          前端本体（src/ui/webui 同源保真迁移，阶段一）：
                  · src/ = src 轨道逐字节拷贝（117 文件：组件/stores/
                    composables/settings/ui 库/assets 零改动；cordis 宿主
                    半边 index.ts/plugin.ts 不搬）
                  · src/adapter/ = 防腐层（唯一新代码，无人依赖可整体替换）：
                    core.ts 帧翻译状态机（preview 事件帧 → src chat.* 合成——
                    dialogId 三形态键[chat~user~agent / single~sid /
                    group~gid~agent]·sender 透传·delta 三通道分流·
                    toolCalls 参数按 index 累积·工具 id 配对链）+ ws.ts
                    TranslatingWebSocket 门面（patch window.WebSocket——
                    src WebSocketClient 零改动拿到翻译传输）+ rest.ts
                    fetch 拦截（/api/* 三路分发：RPC 化 ~60 路由 · 显式
                    降级[版本更新/插件市场/预设/browse 原生对话框] ·
                    透传[workspace/upload/workspaces/头像/ui-extensions，
                    upload 响应旁听登记附件路径]) + dialog.ts（历史分页
                    游标换算：src 轮次 offset → preview 消息 offset，页内
                    viewer 数回校终止）+ install.ts（幂等安装 + ws 首开
                    singles/groups 名册预热）
                  · src/shims/@agentchat/protocol.ts 协议垫片（全部类型 +
                    isBackgroundRunSource 唯一运行时值；vite alias +
                    tsconfig paths + 根 vitest alias 三处同源映射）
                  · 入口 src/preview-main.ts（先装防腐层再动态挂 src
                    main.ts；index.html script 标签一行改——唯一构建环境改点）
                  · 锁测试三层：tests/adapter.test.ts（帧合成表 22 例：
                    全链路顺序/dialogId 三形态/中断错误/工具结果形状/
                    历史游标/ack 幂等/降级词汇）+ tests/adapter-e2e.test.ts
                    （node + ws 垫 + bootTree 真链路：REST 建档 → src
                    store 真发 → 流式帧翻译 → 历史回放 → subscribe 降级，
                    与浏览器运行路径逐环节同构）+ src 搬运测试 10 文件
                    （feed 状态机/并行工具/快速切换/resume 合并/积压
                    冲刷/池缺省/policy/CSP 审计）；后端缝由 ac-app/
                    tests/webui-e2e.test.ts 持续锁定
                  · 已知显式降级（不垫假数据，点击空态+说明）：chat.continue
                    注入续写指令进会话流；chat.session.resume 快照最小化
                    （stats 命中 → 空 active 快照，未命中 → active:false
                    无害）；事件触发（timer/archive）消息在历史里以 user
                    气泡呈现（preview SessionRecord 无 MessageSource）；
                    pair 格子历史按目标会话近似；90s 空闲重连（preview 心跳是协议
                     ping，浏览器不视为数据帧——src/原生两代共有行为）
                    · M19 对桶统一：全部 'a~b' 桶（user~agent 直答 / a~b 委托 /
                      a~a 自会话对角线）同一规则进矩阵 pairs；convKeyToId 对键
                      双向保留；assistant 行持久化 steps[]（ReAct 工具调用对）
                      ——历史回放按步重建 assistant+tool 气泡（toHistoryMessages，
                      键形 tool_calls 对齐 src 持久化约定），刷新后工具卡片不再
                      丢失；前端分区彻底统一 pair:<a>|<b>（D4 废 direct:——含
                      viewer 的对桶即可写直答会话，不含 viewer 为矩阵只读视角；
                      流式帧按 routeDialog 统一入桶，非 viewer 对桶也可见直播）
  阶段二（契约换血双轨过渡，进行中）：
  · 第一梯已迁 usage/system——src/api/ 三件新立：wire.ts（Port B 传输：
    懒连接/断线即拒/60s 超时；A/B 并存期由 adapter install 注入原生
    WebSocket 构造器，绕开翻译门面——其 send 会吞目录外帧型；收口后
    回落全局构造器）+ usage.ts（usage/tokens 直连 + UsageSummary 视图
    契约自有 + 日期范围客户端过滤[含 by_day_llm 同步过滤]；byDayModel
    日期×模型交叉维 → by_day_llm「按模型」堆叠图数据源，旧后端缺失 →
    空数组）+ system.ts（system/version·backup/run
    直连；changelog/更新检查显式降级）；消费方 TokenUsage/Sidebar/
    VersionDialog 改 import（src UI 零改动原则就此按模块让位——视觉
    签名不变、行为以测试为准，D5）；适配器对应五条 REST 路由与
    toUsageSummary 映射删除；锁测试 tests/port-b.test.ts（不依赖
    adapter，收口后原样存活）
  · 第二梯已迁 settings 域——settings/api.ts 整体重写为 Port B 直连
    （33 REST 端点 → 19 RPC 方法：config/get·save、agents 写侧全套
    [create/delete/get-config/update-config/set-credential/save-doc]、
    timer/entries·save、plugin 全套 [loaded/installed/stage·staging-*/
    approve·reject/uninstall/load·reload·unload/permissions]、
    tools/list、agents/assembly·update）；函数签名与返回契约对
    useSettings/组件层不变（迁移零消费方改动）；装配视图形状适配
    adaptAssembly（preview 行组合制 → src AssemblyView 合约，presets
    恒空）；hooks 目录 = PREVIEW_HOOK_CATALOG 内置扩展行词汇表（kind
    沿用 src 七分词汇；可开关 = 消费 settings[具名] 且支持 enabled 软停用（M24 X1 起 settings）
    的六行[persona/system-prompt/memory/skill/datetime/security]——
    saveAssembly 把启用清单翻译回 hooks['<名>'].enabled 全量替换并保留
    既有 per-Agent 字段；automatic = mcp/session/web-tools/archive/usage
    行级基础设施只读展示；presets 从 patch 剥离——后端白名单只认
    tools/hooks）；schema 三端点/市场四端点/browse-file 显式降级；适配器
    对应 plugins/config/agents-config/timer 全部路由删除；锁测试
    port-b.test.ts settings 组 6 例 + verify-settings-portb.mjs 真链路
    （真数据：31 工具装配/10 timer owner/AGENT.md 文档读取）
    【M22 P2 后上述适配层整体退场：adaptAssembly/PREVIEW_HOOK_CATALOG/
    hookOrderOf/hooksPatchOf 删除——前端直消费 agents/assembly preview
    形状（AssemblyData），扩展目录改 plugin/extension-catalog 后端词汇，
    saveAssembly 直发 per-name 合并补丁（无 read-modify-write），市场四
    端点随 D8 摘除】
  · 第三梯已迁 agents/groups 名册——src/api/roster.ts（agents/list+
    conversation/stats 汇聚 AgentInfo[name←description]/create·delete/
    models[providers 拼]/pools[config 域]/session/tokens 仪表 + 头像
    三端点浏览器直连 multipart）+ src/api/groups.ts（group/list→
    GroupInfo/create[返回 group_id 硬依赖]/update[rename+成员差量对账
    group/list 现值]/delete/history[from→agent_id·ISO 时间行]）；
    toAgentList 合成迁入 api/roster（adapter/core 反向引用——适配器
    退役时函数原地存活）；消费方 9 处 import 切换（stores/groups·feed·
    AgentList·ChatInput·CreateGroupDialog·DialogView·GroupDrawer·
    AgentPane·useSettings）；endpoints/agents.ts·groups.ts 删除；
    适配器 agents/groups 全部路由删除；锁测试 port-b 名册组 10 例 +
    verify-roster-portb.mjs 真链路（15 Agent 中文名/群历史/Token 仪表）
  · 第四梯已迁 singles/workspaces/文件面/presets/extensions——
    src/api/singles.ts（singles/* RPC 直连；sid 集合登记
    adapterState.knownSingles——A/B 桥，WS 侧 dialogId 合成依赖；
    src DELETE 语义分派：无 purge=archive、purge=1=delete；空 Agent
    会话语义（src 同款恢复）：agentId 空 → defaultPresetId（__standard__，
    ac-agent-presets 物化）路由 + 会话级模型覆盖随 conversation/deliver
    信封透传（修复存量缺口：覆盖只存元数据从不随投递发送——预设默认无
    模型时必须靠它）；single 模式渲染 busyFeedback（此前只 pair 有——
    投递失败不可见，表现为"发送无反应"）+
    src/api/files.ts（workspaces CRUD + workspace tree/file[注入
    binary=base64，FilePreviewModal 图片分支硬依赖]/raw/browseReadFile
    [workspace/file 别名]/upload[响应指纹→路径登记 uploadPaths，供
    chat.send 附件行合成——Map 移居 adapter/state 共写]/browseFolder
    显式取消降级；全部 preview 真实 HTTP 面浏览器直连）+ 预设空降级
    入 api/roster + api/extensions.ts（UI 扩展清单）；消费方 12 处
    import 切换；endpoints 层删除至仅剩 runs.ts（第五梯目标）；
    适配器 REST 重写为运行跟踪残留面（runs + /api/history，
    225 行）；锁测试 port-b singles 组 4 例 + adapter 残留面锁定
    2 例 + verify-singles-files-portb.mjs 真链路（CRUD 闭环/文件树）
  · 第五梯已迁运行跟踪 + **REST 防腐桥整体退役**——src/api/runs.ts
    （runs/snapshot+agents/list 聚合 → RunsSnapshot 矩阵契约[convKey
    ~ 三形态/热力窗口全零显式降级]/interruptRun[convKey→
    conversationId 换算]/fetchPairHistory[session/history 近似]；
    toRunsSnapshot·toHistoryMessages·convKeyToId 从适配器 shapes 迁入
    ——adapter/core 反向引用 api/runs）+ 消费方 4 处切换（stores/runs·
    feed、RunTracking、RunTrackingPanel）；endpoints/ 目录清零删除
    （client.ts 留存——extensions bridge/isolated 引用 request）；
    adapter/rest.ts 删除 + install.ts 拆除 fetch patch（五梯后全部
    REST/RPC 消费走 src/api/* 直连，防腐层只剩 WS 翻译面[阶段二-6
    目标]）；shapes.ts 缩至 WS 专用件（toToolDefs/stringifyToolResult/
    errText）；锁测试 port-b runs 组 4 例 + verify-runs-portb.mjs
    真链路（23 会话→14 pair 矩阵/群/历史/中断换算）
  · 第六梯已迁聊天面 + **适配器 A 整体退役（方案收口）**——
    src/api/wire.ts 升级完整传输（rpc/call+requestId 相关性+事件帧
    总线[args 解包]+ws/ack 订阅+断线自动重连 2s→30s 退避+onOpen
    通知[feed 重连清理依赖]）；src/api/chat-ops.ts 聊天共享件
    （chatPresence 存在集合/routeDialog 帧载荷路由[群桶过滤+sender
    判定]/工具参数按 index 累积[delta-end 统一建真 id 占位——
    preparing 升级链多工具并存时按 name 失配，弃用]/历史游标/
    stringifyToolResult/toToolDefs）；stores/feed.ts 换血——handleFrame
    直接消费 preview 事件帧（step-started/llm-delta 三通道/delta-end/
    tool-progress/after-execute/after-step/after-run/group-message/
    message-received 私信），状态机处理函数与三关语义原样保留，
    ingestFrame 测试入口+handleResume；stores/chat.ts 出站全部 RPC 化
    （deliver[requestId 幂等+deduped ack 恢复]/interrupt/continue
    [降级注入]/subscribeResume[stats→最小快照]/delete-message/
    interaction-reply/session-archive/system-prompt/tool-defs/名册
    首拉+恢复链）；agents·groups·singles·useSettings·DialogView·
    AgentList·RunTracking×2·extensions bridge/host/isolated 全部换
    wire 订阅；**删除**：adapter/ 整目录、stores+services/websocket
    （src WebSocketClient）、core/events/contract（WS 词汇）、
    core/registry/eventHandlers、core/api/endpoints/ 清零；
    preview-main 简化纯透传；锁测试换血——adapter.test·adapter-e2e·
    ws-backlog-flush 随适配器退役，feed 三测试改 preview 帧序列
    （并行工具/快速切换/resume 合并语义原样），portb-e2e.test.ts
    新增（真 WS 全链路：建档→发送→流式状态机→历史→resume）；
    verify-chat-portb.mjs 真数据面验证
```

## 第一性原理对照

| 原语 | 用法 | 位置 |
|---|---|---|
| `declare module` | owning package 声明本域 `Context { ... }` 服务类型 + `Events` 事件目录（分布式声明合并，谁 emit 谁声明） | 各服务包 `service.ts` + `events.ts`（归属表见上） |
| `apply` | 每行一个插件对象（`name`/`inject`/`apply`），组合根 `ctx.plugin()` 激活 | 所有薄行 + `ac-app/src/index.ts` |
| `on` | 监听器随注册方 fiber 自动撤销；拦截走 waterfall（不调 `next()` = veto） | `ac-hello`、测试 |
| `effect` | 注册中心内部用 `this.ctx.fiber.effect`（tracker 指向调用方插件）——注册即归属，标签进诊断树 | `ac-llm/src/service.ts`、`ac-tools/src/service.ts` |
| `dispose` | 卸载薄行 = 工厂/实例/监听器自动回收（provider 会调用 `close()`） | 热插拔测试 |

## 命令

```bash
pnpm preview:typecheck    # tsc -p preview（webui 除外——其 DOM 环境走自身 vue-tsc）
pnpm preview:test         # vitest run preview（798 测试：路由/拦截/生命周期/组合/配置驱动/扩展四件套/信封拓扑/流式细分/transform/steer·中断/会话状态机/群拓扑[含持久化]/持久化基座/执行身份·并发·语义化中断/jobs/编辑引擎·沙箱·脱敏纯库/工具九行/安全行/子 Agent/持久化交互/归档·定时·备份·工作区/usage 双轨[含回读+byConversation+byDayModel]/传输·桥接·webui·slot 注册表/插件域·gates·supervisor[含陈旧锁回收]/M14 扩展/M15 补齐/预设 Agent 目录[物化+软停用+默认池解析]/M7[web-api RPC 面+ack 映射/tool·progress/archive·agents 事件/interaction wire/admin 管理面/服务面 e2e]/M17[web-api 补齐面 timer·backup·jobs·config·llm·plugin·system·runs·session-tokens·session-truncate/timer 全局条目·config 面/workspace 文件面 HTTP·multipart·avatar/settings 单例状态机/时间分隔·竞态守卫·CSP 审计·积压不变量]/契约换血[Port B 模块锁测试 port-b + feed 状态机 preview 帧序列（并行工具/快速切换/resume 合并）+ portb-e2e 真 WS 全链路[singles 默认预设路由+无记忆] + src 搬运性能·池缺省·policy·CSP 审计]/M24[settingsOf 合成语义+冻结坑守卫/store 双读归一+迁移恒等门/plugin/catalog 内置清单×装配交叉×本地四态/audit 轮转/market 搜索形状+人审全流+来源锚定/X4 tags 单源]/M25[agentGate 六形态/loop·tools 读取器单测/事件目录锁定 @mode+@scope+emit 末参/event-policy 吞注册·清扫幂等·自锁守卫·bail 单链/fiber→行聚合/dep-graph 反依赖闭包/include 热通道 hot+F10 守卫维持]）
pnpm preview:smoke        # tsx 冒烟（程序化树；logger-console/timer 生效）
pnpm preview:boot         # 官方启动器（vendor cordis bin.js + cordis.yml 裸包名行；web-server 3830 + webui dist 静态托管；数据根 = 启动 cwd，见"两条装配路径"节）
pnpm preview:chat         # 对话 REPL（真实 provider 手测：DEEPSEEK_API_KEY=... 后连续对话+流式打印；CHAT_MODEL/CHAT_AGENT 可调）
pnpm preview:boot:demo    # 演示 boot（include patches 启用 hmr + reloadFiles 热重载）
pnpm preview:supervised   # supervisor.mjs 宿主监护（42/78/0 协议 + 退避熔断 + .runtime 单写者锁）
pnpm preview:webui        # WebUI dev server（vite 3831 + proxy → 3830；改前端即时热更）
pnpm preview:webui:build  # WebUI 生产构建（→ preview/webui/dist；boot 后 http://127.0.0.1:3830/）
pnpm --filter ac-webui-app typecheck  # 前端 vue-tsc（.vue SFC 全量类型检查）
```

## 设计铁律

1. **能力调用走 Service 方法，拦截/通知走事件**（waterfall/emit 分工见各域 owning 包的 `src/events.ts`，归属表见上）。
2. **注册即归属**：注册中心方法内 `this.ctx.fiber.effect(...)`，插件作者零 dispose 代码。
3. **懒实例化**：`register` 只存工厂；首次 `stream/chat` 才构造 provider。
4. **路由在拦截之后**：`llm/before-chat` 改写 `input.model` 即改写路由。
5. 应用层零 `EventEmitter`、零跨插件实例传递。

## 三层架构（目标蓝图）

```
L3  ac-agents + ac-router + ac-conversation + ac-group
                             信封投递：user⇄agent / agent⇄agent / group / event⇄agent
                             router=纯转发；conversation=会话状态机（门/双队列/预算）；
                             group=群拓扑（成员表/单通道内容流/GroupFeed）
L2  ac-agent-loop           编排：turn（本轮=run）→ [step（本步）→ 推理/工具 → 收束]；steer() 注入 + interrupted 中断；
                             工具并发 mapLimit(5) + 执行身份装配 + tool-interrupt 收束（M11）
L1  ac-llm (+openai/deepseek/glm 薄行)   一次 step 会话（stream/chat 聚合）
```

插件扩展全部走事件（src hooks → preview 事件映射见
`.dsh/skills/agentchat-framework-dev`）：persona/system-prompt =
`loop/before-run` 改 system；session = before-run 加载 + after-step/after-run
落盘；memory = before-run 注入。UI 走 emit 订阅面。

## 路线图

- M23 ✅ Agent 自开发插件能力（免审安装闭环 + 无人值守补偿控制；设计/裁决
  `docs/m23-agent-plugin-plan.md`；P1a/P1b/P2/P5/P6/P3-lite/P4 已落地，
  P7 热通道后置）：
  · P1a/P1b 免审安装口——installFromDir 三态结果 + install_plugin 工具
    （interrupt + after-run 宿主半边 + 回执 session.append + sender:'event'
    回触 owner 自会话[金闭环 e2e 锁定]）；register_plugin grants 去除统一
    回执；同 hash 幂等（不重试装载）+ bump version 引导；保留字护栏
    （三面常量表 + boot 全树一致性测试）；approveStaging 可补偿分步 +
    registry 原子写 + 全 mutation 串行队列 + Windows rename retry +
    copy/hash 排除集统一 + .backup 随机后缀；审计流水 audit.jsonl 四类
    事件；denyPaths 控制面黑名单（registry/audit 先行）。
  · P2 owner-tag 归属——capabilities = 显式 ∪ {base, agent:<id>}（E1）+
    无身份 guard（L2）+ 双轨对账 warn once（L1）+ 共享双写（E2）+
    provides 对象形状（E3/G4，前端 provides.hooks 错位修复）。
  · P5 熔断与安全模式——.load-health.json（F4 生命周期：install/uninstall
    强制清、成功清零、install 期失败立即计数）+ skipped[] 透出（G9 第四态）
    + hash 复验（F3）+ gates 就绪屏障（G5）+ 安全模式（L8）。
  · P3-lite 行偏好层——cordis.patch.yml（A2：boot.ts 内联官方 16 行 +
    fail-soft 读取；listPatches/setPatch 三态[F12]，hot 后置 P7）+
    F10 写回守卫测试（patch + 任意树操作后 cordis.yml 字节不变，含
    insert 场景）+ denyPaths 补全（G3：workspace.root 锚定 + 不可用
    fail-closed）。
  · P4 可视化——events/listeners RPC（_hooks 有序 + prepend 标记）+
    装配页按插件分组/过滤。
  · P6 模板规约——preview/templates/ 三骨架 + agentchat-plugin-dev 技能
    更新（H3 共享输出框定 / H4 生命周期如实呈现 / G6 工具分工描述）。
- M0+M1 ✅：llm 纯路由链 + tools + hello + 组合根
- M2 ✅：ac-agent-loop（ReAct 循环：before-run/before-step waterfall + after-run/after-step emit；工具执行复用 ctx.tools 拦截链）
- M3 ✅：ac-agents + ac-router（纯转发信封投递 + 双通道事件）
- 生态接入 ✅：plugin-loader / plugin-include / plugin-timer / plugin-logger-console / plugin-hmr
- M4 ✅ 扩展四件套（全部事件化，零框架 hook 机制）：ac-persona / ac-system-prompt / ac-session / ac-memory
- M5 ✅ 信封拓扑：sender（user/agent/event）+ conversationId（1v1 缺省 agentId；group 共享组键，session 按 conversationId 分桶、组内消息 name 标注来源）
- M6 ✅ 流式细分事件：llm/delta-start / llm/delta（正文/推理/工具分片同一通道）/ llm/delta-end（finally 保证）——UI 可视化前置
- M6.5 ✅ 工具结果变换：tool/transform-result waterfall（变换载体 payload.result；after-execute 通知变换后终值）
- M8 ✅ 对齐 src 语义三件：
  · maxSteps 双模式——>0 = trigger 上限（finish='max-steps'）；缺省/0 = receive 不限步（靠无工具调用收束）
  · loop/transform-step | loop/transform-run waterfall——步/轮记录的安全审查/脱敏 seam（after-* 保持 emit 纯通知，观察者无法破坏事实值；与 tool 域 transform-result 同款模式）
  · AgentConfig.settings[具名]——per-Agent 扩展管控（键=行名，值=插件自定配置；M24 X1 起 hooks→settings）；LoopRunRequest 移除 persona 专属参数（人设直接注入 system，经 settingsOf(id,'persona') 查询）
- M9 ✅ L3 补全：
  · ac-conversation（ADR-1）——串行化门（handle=runAddress(agent, conversationId)：1v1=agent、群=`gid~agent` 每参与者独立门）+ inbox 双队列（next-step=steer 注入活跃 run / next-turn 链跑）+ placement（steer|next-run）+ MAX_AUTO_WAKES=3 防自激；abort 经 signal 软中断
  · ac-agent-loop——steer() Service 方法（run 受理即注册，末轮注入不丢失）+ loop/run-started、loop/step-started（emit）+ finish:'interrupted' + interruptReason（ADR-2 最小中断；signal 在 step 边界检查）
  · ac-group——成员表（group/* 事件）+ 单通道 v3 内容流（本体唯一事实源）+ GroupFeed 锚点增量（readSince/currentAnchor）+ `<msg>` 包装唯一构造点（ADR-3）+ 投递经 conversation（busy=steer / idle=新 run）
  · RouterSendOptions 增 signal 透传
- M10 ✅ 持久化基座（ADR-5）：
  · ac-session 持久化后端——writer 队列语义原样继承（按文件串行/WeakSet 引用幂等/append+fsync/barrier/失败回队首）+ 幂等 message_id 固化 + history() 回放（重启可恢复）+ tool/before-execute fail-closed checkpoint + conversation/steered 入账（补 M9 缺口：steer 消息进会话流）
  · ac-agent-store——Agent 数据目录 owning（<root>/agents/<id>/config.json + 机制 entries 唯一写口，原子写）；ac-agents-dir——目录扫描物化进 ctx.agents（数据驱动行）
  · ac-config——<root>/config.json 原子读写 + 热重载 + config/changed(E)（订阅刷新替代 src 原地 mutate 保引用）；ac-credentials——AES-256-GCM 机器绑定加密 + Agent→全局解析链；ac-config-merge——deepMerge/computeDiff 纯库
  · 类插件以 (ctx, config) 构造：各持久化行经 yml config / bootTree configs 收 root（缺省 './data'）
  · 已知缺口：会话记录为对话级（src 1v1 含工具/思考全量，M15 对账）；checkpoint 是 flushAll 粗粒度（M11 工具执行身份落地后定向化）
- M11 ✅ 工具面：
  · ac-tools 契约扩展——ToolCall 执行身份（agentId/conversationId/toolCallId：loop 装配，per-Agent 沙箱/ask_questions 对账/job owner/hooks 查询依赖它）+ AbortSignal 透传 + onProgress 流式回调 + ToolResult.interrupt 语义化中断通道（loop 收束检测 → finish='interrupted' + interruptReason.toolInterrupt）+ ToolDefinition.requires 能力门禁
  · ac-agent-loop——同步工具并发执行 mapLimit(5)（结果按 tool_calls 序回填）；ac-session checkpoint 定向化（按 conversationId flush，无身份退回 flushAll）
  · ac-jobs——start/list/get/kill/read + job/settled(E)（替代 src onJobDone 私有 listener 数组；owner 分桶/并发上限/settle first-wins 原样）
  · 纯库五件——ac-edit-core（三级模糊匹配/增量 diff/行尾保留/突变队列）、ac-sandbox-core（createSandboxResolver 参数化 + bash 命令扫描 + 脱敏[修 src 两处 bug：赋值模式吞 JSON 引号致静默失效→结构化深走；Windows 反斜杠 deny 模式不可匹配]）、ac-text-budget、ac-glob-core、ac-web-search-core（tavily/serpapi/brave/duckduckgo/deepseek）
  · 工具九行——fs-tools（read token 预算截断）/fs-search/str-replace-editor（补突变队列）/shell-tools（bash 前台超时·流式·signal + 后台 job + Unix→PS 翻译）/math（vm 沙箱）/web-tools（web_search + ctx.browser 守护进程 Service：请求队列/dispose 杀进程/世代计数防旧 exit 抹新状态）/dev-tools（read_logs 环形缓冲 + reload/reload_modules 中断）/restart/session-query
  · ac-security 行——before-execute 能力门禁（AND）+ per-Agent 沙箱 + bash 扫描；transform-result 输出脱敏；hooks['security'].enabled 软停用
  · ac-subagent——spawn=agentLoop.run 直连（agent:undefined 零会话污染天然成立）；受控工具集=request.tools；completed 缓存（50）先于 ac-jobs 交付
  · ac-durable-interaction——直接平移（write-ahead 状态机/幂等 reply/JSONL torn-tail 恢复 + opened/replied/closed 三事件）+ ask_questions 工具（correlationId=toolCallId；事件驱动等待 + 轮询双保险；late-reply 走 source:'event'）
- M12 ✅ 服务编排：
  · usage 双轨进契约——LlmUsage 增 cacheHit/cacheMiss（provider 归一化：DeepSeek 顶层/OpenAI·GLM 嵌套推导）+ LoopRunUsage（覆盖轨 prompt/total=末步当次上下文供归档阈值；累加轨 promptAccumulated/completion/cache/steps=总用量展示）
  · ac-archive——"先整理后归档"：阈值检测订阅 loop/after-run（触发依据=会话消息估算而非 usage——src 大 AGENT.md 误触发教训）；整理 run=source:'event' 信封 loop 直连（单方整理：preview 会话按 conversationId 分桶；标记协议折叠单 pending）；截断/去重纯库 ac-archive-core 与 ac-session 共享行格式；落盘全经 owning 服务（session.records/compact，ADR-5）；超时兜底 + archiveAll 机制任务口
  · ac-timer——5 模式（time/delay/random/workday/holiday，农历节假日+调休配置）叠官方 cordis-timer 排程；timer-state.json 原子写+懒心跳+停机补偿（资产 #8 原样）；条目持久化归 ac-agent-store（消灭直写 config.json）；触发=conversation.deliver(source:'event')；机制任务直调（entry.task，淘汰 __archive_all__/__backup_all__ 字符串协议——规约 3）
  · ac-usage——after-run 双轨记账 + byAgent/byModel/totals + 日 jsonl 审计流水
  · ac-workspace——初始化行：默认 user（virtual——AgentConfig.virtual + router 只记事件不跑 loop）/admin=数据 register；首启消息经 session.append（不直写会话文件——消灭 src 越权写）；browser 守护脚本随包分发（M11 缺口补齐）；<root> 即各持久化行统一数据根锚点
  · ac-backup-core + ac-backup——zip 全量+轮转保留+到期间隔；路径全显式（修 src process.cwd() 怪味）；timer 机制任务 backup-all 直调
- M13 ✅ 宿主与可视化：
  · 载荷增强（地图 §2）——LlmChatInput.meta（agent/conversationId/sender；dispatch 剥离不进 provider body）+ loop/step-started·after-step 信封尾参：WS 桥接过滤后台会话的 source 细分
  · ac-web-server——HTTP 路由注册中心（:param/尾* 捕获、注册即归属、重注册抛错；Node 原生 http 零 express）+ WS（广播/定向/30s 心跳/2 拍判死 terminate）+ rpc/call 显式分发表（弃 src 反射全量）+ requestId 幂等去重（30s 窗口 deduped ack——src #53/#91 教训原样）+ ws/ack·connection-opened·connection-closed(E) + 静态托管/SPA fallback + 监听失败降级（EADDRINUSE 不炸进程）
  · ac-ws-bridge——零业务状态订阅行：emit 面（27 事件）→ WS 帧（type=事件名直转 + {args}）；后台过滤（source='event' 流式抑制、边界事件广播；tool/* 经 run 边界登记表兜底）
  · ac-webui + ac-webui-extensions——entries 清单 + /ui-plugin/ 静态 + extensions-changed(E)；slot 白名单（宿主先开口六 slot + 插件后填空 fail-closed）+ install 15s 超时回滚 + isolated 档（src P5 机制与 fiber 语义同构原样移植）
  · ac-plugin-core + ac-plugin-registry + ac-plugin-gates——staging 人审管（哈希/只读代理/权限快照/来源锚定原样）+ approve 安装 + 装载管道（plugin/before-load(W) gate seam → 动态 import → fiber 父=本行全回收；同名替换失败回滚恢复）+ plugin/installed·reloaded·catalog-changed(E) + register_plugin/unregister_plugin 工具（interrupt 上报 → after-run 宿主半边执行）；权限+契约双 gate 拆策略行（import 前 fail-closed）
  · ac-supervisor-core + supervisor.mjs——42/78/0 协议 + 指数退避熔断（资产 #6 原样）+ .runtime 单写者锁（wx 排他，M12 遗留项落点，资产 #7）；worker 空闲自退 → supervisor code=0 一并退出
  · 已知缩水：manifest.ui 不做发布期 esbuild 构建（要求预构建产物）；ac-plugin-market（github/tarball 源）延后 M14+；ws 帧词汇无独立 TS 客户端契约（事件目录文档即协议——机器可读目录的文档化动机）
- M14 ✅ 扩展补全：
  · ac-datetime——before-run 追加仅日期行（YYYY-MM-DD 周X；KV cache 友好——每日至多重建一次，资产 #12）；无会话键（子 Agent/loop 直连）不注入；hooks['datetime'].enabled
  · ac-skill + ac-skill-core 纯库——全局 <root>/skills/ 目录（src per-Agent 目录 → preview 全局共享 + hooks['skill'].whitelist 白名单）：frontmatter 解析/发现/渲染住纯库；SkillsService（ctx.skills）懒扫描 + refresh；before-run 追加 <available_skills>
  · ac-mcp + ac-mcp-core 纯库——形态重构落地：全局注册 + 懒建连（对齐 ac-llm 范式：registerServer 只存定义，首 run before-run 才连接发现）；发现工具注册进 ctx.tools（撞名 `${server}__${name}` 前缀）；servers 放行 = 行 Config（进程级授权）；per-Agent 暴露走 AgentConfig.tools 白名单；协议住纯库（官方 SDK 包装：HTTP/stdio 双传输、insecure per-server dispatcher、describeError cause 链展开）；clientFactory 注入口 = 测试零网络
  · ac-system-prompt 分块装配器——framework（行 Config ?? hooks per-Agent）/系统环境（hooks['security'].workdir·allowedPaths + 可选 workspace 根）/术语约定（协作工具门控）/指引（request.tools 门控：文件工作流/产出物引用/协作流/ask_questions/subagent）/后台任务（job·bash 门控）/对话信息（信封 sender+conversationId；群经可选 ctx.group 解析成员表；无信封不注入）+ override（SYSTEM.md 覆盖语义：替换全部静态块、对话信息仍追加）；hooks['system-prompt'] 六键管控
  · ac-persona 文件装载——hooks['persona'] 形状升级 string → {enabled?, text?, file?}（file 优先 text 回退；裸名走 agentStore 文档 AGENT.md、路径走文件系统；frontmatter 剥离）；ac-agent-store 增文档 API（saveDoc/readDoc/removeDoc——Agent 目录 Markdown 唯一写口）
  · ac-memory 扩展——键 = conversationId（1v1 缺省 agentId、群 = 组 id——与会话桶统一）；<root>/memory/ 文件后端（ADR-5 owning）+ append 累积口；ac-memory-core 纯库（token 预算截断：尾部近期记忆保留 + 明确截断标记）
  · ac-collab-tools 协作七件——send_agent（conversation.deliver source:'agent'；wait=true → placement next-run 等独立 run）/send_group·list_groups（可选 ctx.group）/list_agents/read_agent_info（model/hooks 仅自查）/list_tools（AgentConfig.tools 过滤）/update_agent_profile（agentStore 落盘 + persona 写 AGENT.md + admin 门）；执行身份 call.agentId 取代 src 身份工厂烘焙
  · 已知缩水 → M15 对账处置（详见 docs/m15-reconciliation.md §三）：ac-plugin-market 延后（staging 信任边界已平移）；ac-agent-admin HTTP 管理面归 M7（会话内修改面已覆盖）；ac-group-store 并入 ac-group 持久化 ✅；ac-pending-resume = ac-conversation 待投持久化最小闭环 ✅；read_agent_info 无 per-target 印象（键模型差异，显式缩水）；AgentConfig.tools include/exclude 对象形态 ✅ 收编
- M7 ✅ WebUI/可视化（2026-08-22，全量四块 A+B+C+D；开工简报 `docs/m7-webui-plan.md`）：
  · A 传输接线——ac-web-api 薄编排行（WS RPC 业务方法显式注册：conversation 投递[ack busy/parked/deduped 映射]/中止/快照、interaction 应答、session 历史回放/删消息[ac-session 增 deleteMessage 原子重写]/归档触发、agents 清单/生效工具集、group 全套[含 rename + records() 原始记录读取口]、usage 四维汇总——preview 风格命名 `domain/action`，与事件名两命名空间并存）
  · B 事件面——tool/progress（ToolsService 中央接线 onProgress→emit；桥接转发沿用 run 登记表过滤——bash 流式进 UI）、archive/completed（归档重建漏斗收尾 emit）、agents/updated（reassign/remove 写口 emit——src agent.profile.updated 补真实现）、durable-interaction/opened wire 整形（ask_questions questions 上提，bridge 端）、逐消息汇总取前端聚合路线（delta→message 前端合成，零服务端改动）
  · C 前端本体——src/ui/webui 全量移植 preview/webui（用户决策）：组件层零改动，传输层适配收编（services/websocket.ts 讲 preview 线协议合成 src chat.* 契约 + endpoints 层 RPC 化 + compat 协议垫片自包含）；vite 构建 dist 由 web-server staticDir 托管 + SPA fallback；dev 期 vite 3831 proxy → 3830；适配层合成表 + 服务面 e2e（TREE+scripted provider+真 WS 客户端：投递→全链路帧→历史→幂等去重）双测试锁定；preview 无后端面的视图（singles/workspaces/上传/版本/插件市场）优雅降级
  · D 管理面——ac-agent-admin 首期（ctx.agentAdmin + 写侧 RPC 随行）：CRUD（白名单 fail-closed + apiKey 剥离进 credentials + deepMerge 补丁 + agentStore 唯一写口 + reassign 热生效）/saveDoc（空=删）/system-prompt dry-run（before-run waterfall 干跑）；ac-config-merge 首个消费者接上（deepMerge+computeDiff）
  · 验收：typecheck（preview tsc + webui vue-tsc 双轨）+ 533 测试 + smoke + boot（3830 静态托管 + /api/ui/extensions + wscat rpc/call 手测）全绿
- M22 ✅ 扩展与工具/插件库 cordis 原生化（2026-08-28 P1+P2；设计/裁决/缺陷清单 `docs/m22-ext-plugin-ui-plan.md`；B1-B11 全核销，D1-D8 除 P3 外按推荐落地）：
  · P1 止血（纯前端）——B1 per-Agent 插件开关 → 只读徽章 + decl/patchDecl 拆掉 presets；
    B7 legacy 通道删除（assemblyOf legacy 分支/迁移横幅/保存迁移段）；B5+D8 市场页签
    摘除（api.ts 四桩函数删）；B2 registerSessionPlugin 发 agentId（字段名错配修正）；
    B3 getSessionPlugins 过滤 sessionOnly；B4/B6 dev 空态与卸载/注册文案去虚构语义。
  · P2 原生化——D4① EXTENSION_CATALOG 静态常量（11 条，row 补齐 + 落点修正：
    security 双落点 tool/before-execute+transform-result、web-tools 纯能力供给）住
    ac-web-api + `plugin/extension-catalog` RPC（∩ cordis registry：行摘除 → 条目隐藏）；
    前端删 PREVIEW_HOOK_CATALOG/hookOrderOf/hooksPatchOf/adaptAssembly 适配层，
    ExtToolsPane 重构「装配」页（扩展|工具 两分区 + 三组落点徽章 + 参数弹窗编辑
    hooks['<名>'].*——fields 由目录声明，D3 拖拽排序/推荐排序删除：执行序=注册序）；
    D5④ agents/assembly/update hooks 改 per-name 浅合并 / null 删除（服务端合并语义，
    前端 saveAssembly 去 read-modify-write；修复 computeDiff 检测不到键删除致
    null 删除不落盘）；D7② pluginRegistry.devScan()（<root>/plugins/<agentId>/<name>/
    布局；平铺已安装目录与保留目录跳过、损坏 manifest 不阻断）+ `plugin/dev-scan`
    RPC（附数据根透出）+ 前端 dev 卡片接线 + 手动注册表单（dir/owner/grants/watch）；
    D6③ 装载失败内存态记录（load 管道 rejected 记因/成功清除/boot 扫描目录缺失记因，
    不写 registry.json）+ `plugin/loaded` 附 failed[] + 已安装卡片三态徽章；
    D1 设置树删 extTools 叶子，PluginLibraryPane 四页签（装配行=行清单+扩展目录
    只读+工具目录+全局默认参数入口 / 已安装+装载徽章 / 待审暂存 / 开发与会话），
    AgentPane 第 5 页签改名「装配」。
  · 验收：preview tsc + webui vue-tsc 双轨零错误 + 706 测试（新增 registry
    devScan/listFailed、web-api extension-catalog/dev-scan/loaded.failed、
    agent-admin 合并/null 删除、portb-e2e M22 全链路[真 bootTree RPC：11 条目录
    全可见/per-name 合并/null 删除/tools 意图回归]）+ smoke 全绿。
    P3 注册制目录（扩展行 apply 时注册元数据，消灭静态表）另立项。
- M20 ✅ 归档分支回归——会话内整理 run + 失控防线（2026-08-27；事故档案/根因/裁决 `docs/m20-archive-review-plan.md`；D1-D6 全按推荐、D3 用户裁决 maxSteps=128）：
  · 事故与根因——2026-08-26 手工归档 4GB 堆 OOM（进程 ~21 分钟，线性无界）；四要素乘积：
    不限步（整理 run 不设 maxSteps）× 全工具（tools 缺省 = 全部已注册）× 上下文累积
    （messages + steps[] 双持有）× 不可见（source='event' 过滤流式，UI 无感知且兜底不中止 run）
  · 通道回归（D1）——runReview 的 agentLoop.run 直连旁路改为 conversation.deliver 同桶投递
    （sender:'event' + placement:'next-run'）：与用户 run 共串行化门，忙时排队不并发，
    steer 覆盖/在途写竞态随并发消失；收尾事件驱动（loop/after-run 识别标记 → done 协议，
    对桶双侧整理 D5 全到齐才重建；兜底超时先 abort 在途整理 run 再强制归档——闸②）
  · 不落盘标记（D2）——LoopRunRequest.meta 透明通道 + ARCHIVE_REVIEW_META 常量
    （ac-agent-loop 导出，对齐 src META_ARCHIVE_REVIEW）透传链 deliver→send→信封；
    三消费方见标记跳过：ac-session（message-received/reply-completed/steered 不入账）、
    ac-usage（after-run 不记账——巨型整理上下文不再顶掉桶 lastContextPrompt）、
    ac-conversation（startRun 不进上下文视图——整理提示词不泄漏进后续用户 run）
  · 输出物与工具面（D4）——提示词对齐 src triggerReview：Agent 亲自 write/read
    files/<agent>/summary/<会话>.md（概要来源，服务端读文件 + mtime 判新 + 预算截断；
    缺 write 工具自适应回退"回复即概要"；finish='max-steps' → 概要降级、归档照常）；
    memory_rewrite 重写记忆（ac-memory 新工具，"合并重复、删除过时，不要只追加"）；
    TODO/DONE/note 同理；工具面 = Agent 生效集（router 解析，写文件是任务的一部分）
  · 失控防线（D3=128）——闸① maxSteps 硬上限 128（deliver options 透传 run 级覆盖；
    对 src"不设上限"的显式偏离——src 同形状潜伏同款 OOM）；闸② 超时 abort + 强制归档；
    闸③ 步级日志观测（step-started 步号+上下文估算；软阈值 16 告警——流式被过滤，
    日志是唯一观测面）；对抗 provider 防回归测试（每步 256KB 工具输出 → 断言步数 ≤ 上限、
    归档完成、零污染）
  · 顺手修复——ac-memory 工具体改 ctx.get('memory') root-traced 解析（M15 起
    memory_append 在真实 run 内"cannot get property without inject"断链的潜在 bug）；
    D6 遗留 files/<agent>/memory/*.memory.md 维持不动（ac-memory 未消费，待 memory 域对账）
  · 验收：preview tsc 零错误 + 671 测试（archive 12[排队不并发/done 双侧/D4 文件概要/
    闸① 对抗/三处不落盘] + session/usage 标记跳过 + memory_rewrite）+ smoke + boot 真数据全绿；
    grep agentLoop.run preview/ac-archive/src 仅剩注释
- M19 ✅ user 去特殊化——全对键桶模型（2026-08-26；规划与裁决 `docs/m19-pair-bucket-plan.md`）：
  · 模型——一切双端会话都是对桶：conversationId = pairKey(a, b)（[a,b].sort().join('~')，
    ac-agent-loop 导出 owning），自会话 = a~a；user 只是端点之一，桶/路由/统计零专属路径。
    桶形态三态：对桶 a~b / 群 gid / 独立会话 sid（singles·groups 靠名册消歧，对桶含 ~ 天然可辨）
  · 信封（D1）——身份/拓扑分离：sender = 端点 id（viewer 虚拟 Agent / 委托 Agent / 机制触发 =
    目标自身）+ source = 'user'|'agent'|'event' 拓扑词（ws-bridge 后台过滤 / MAX_AUTO_WAKES /
    session 事件行三消费方改读 source）；router/*、conversation/steered、loop envelope、
    llm meta 全线加位；Agent id 禁 ~ 升级承重墙（agents.register/reassign + admin sanitize +
    group id 黑名单——runAddress 从右解析无歧义）
  · 机制触发（D2）——timer 全局条目与个人自触发统一落 Agent 自会话桶 pairKey(a,a)
    （矩阵对角线）；job-wakeup 同规；archive 阈值门切对桶端点判定（原 conv===agentId 门失效）
  · 边界（D3）——web-api conversation/deliver 显式算直答对键 pairKey(VIEWER, agentId)
    （VIEWER_AGENT_ID 单点声明；服务层不猜 viewer，前端直答透传不传键）；session/tokens
    改 byConversation 键 + agentOfPair 解析；ac-workspace 首启消息落 admin⇄user 对桶
  · 前端（D4）——分区彻底统一 pair:<a>|<b>（废 direct:）：routeDialog 对桶统一路由
    （含 viewer 可写直答 / 不含 viewer 矩阵只读且流式直播可见）；feed agentKeyOf/streamAgent、
    未读/名册摘要（toAgentList viewer 对桶映射）、runs.ts toRunsSnapshot·convKeyToId 对键统一、
    toHistoryMessages user 行 name 说话人、chat.ts 投递/中断/归档/编辑全链对键；
    message-received 统一走 routeDialog（#14 特判删除）
  · 入账（#6）——ac-session 对桶统一：入站 role:user + name=说话人、回复 role:assistant +
    name=回复 Agent（与群桶同构）；虚拟端点 + source='agent' 分支 = agent→viewer 私信按说话人
    assistant 入账（send_agent 统一 pairKey(from,to)——与直答同桶）
  · 统计（#7/#8）——usage byPair 对键统一解析（user 端点不再排除，弦图过滤 = 纯视图选择 #15；
    旧 agentId 桶/委托行双读兜底）；system-prompt 对话对象行 = sender id + 注册表显示名
    （委托方身份缺失顺带修复）
  · 数据（D5）——preview 存量清空（备份 data.bak-m19/），scripts/migrate-workspace.ts 升级
    产对键桶：chat~a~b 全量迁移（user 对/agent 对/自会话；说话人 name 标注 + tool_calls/tool
    行重建 steps[]——工具卡片迁移后不丢）+ usage 行 conversationId = pairKey(counterpart 推导)
  · 验收——preview tsc + webui vue-tsc + 664 测试全绿（新增 user2 第二虚拟 Agent 直答零代码
    走通验收）；boot 真数据（15 Agent/91 对桶/9127 用量行/80 pair 矩阵格）+ WS 探针
    （名册/矩阵/历史/byPair/tokens/system-prompt 对话对象行）+ 虚拟端点投递探针（viewer 自投
    user~user、agent→viewer 私信 neko~user 同桶 assistant 入账）；grep 审计 === 'user' 仅剩
    role/source 词表校验（非端点特判）
- M18 ✅ 布局与风格全量对齐（2026-08-23；迁移地图 `docs/m18-layout-style-parity-plan.md` + 三份逐视图侦察 `docs/m17-recon/style-parity-*.md`；用户指令：以 src 实际布局样式为准，`docs/archive/*` 不参考）：
  · 地基实证——四份 CSS（base/main/markdown/tokens）+ ui 组件库 14 件与 src 逐字节一致；`--color-*` 别名层已桥接 L0 单一来源（两体系视觉等价）；差异全部收敛到视图层版式
  · M18-B 工坊层——ChatView（头部 48px+backdrop blur/消息撑满去 840 居中/纯文字时间分隔/gauge Token 进度条/气泡 6px+70%）；TurnItem 去卡片化（裸行链头 sticky 吸附 + 竖线 7px 缩进 + 头像左列 32px）+ Message/UserMessage + AssistantMessage 组件化（内部流式分块渲染器/hover 显现动作行）；ToolCard 裸行化 + 纯文字状态 + 分段滚动；ChatInput 星港（icon 发送方块/思考强度下拉[本地 ref 待接信封]/附件主色药丸）；InteractionBar 非全宽；FilePreviewModal（hljs 高亮+行号列/棋盘格/iframe sandbox/语言标签/路径栏）
  · M18-C 星群层——AgentGroupList（行密度/头像 36/`--role-selected-bg` 选中/3×3 群头像拼图/未读徽章贴头像/零宽滚动条/lastActivity 浮顶）；ActivityRail（`--color-bg-subtle`/40×40/左缘指示条）；App（拖拽 3px、移动抽屉 left:0 + z 110/120 + pointer-events 语义）；GroupView 成员抽屉（280px/4 列网格/「我」徽章/搜索/群名编辑/底部删除）
  · M18-D 面板层——UsagePanel 重写（左 216px 侧栏+日期筛选+缓存命中率进度条+竖向页签+柱图 src 视觉主题[去图例/柱顶圆角 6/仅横网格/11px 刻度]）；设置 accent 竖条 + 树选中态 `color-mix` 描边 + footer ui-Button 统一；ConfirmDialog 换 ui/Button；AgentPane 信息页密度 + 模型页分组左竖线；RunTrackingView 浓度色阶五档 + 格子内描边；CreateGroupDialog 洗 NEW + 已选徽章
  · M18-E 收尾——流式点/呼吸/打断脉冲随视图落地；空态文案对齐 src；§8.1 防漂核对法（令牌计数审计/MD5 地基防漂/观感清单）
  · ④ 设置面板视觉对齐——SettingsPanel 壳（Modal 尺寸/导航树/footer/放弃确认）+ AgentPane（页签条/表单密度/分组竖线/readonly）+ AgentListPane 重写（src agent-pool 形态：搜索/新建/头像列/hover 删除）+ AgentPane 头像上传/删除/预览（/api/agents/:id/avatar 三端点已有，multipart 上传）；差距注释标注（模型池 CRUD/tags·allowedPaths/hook 拖拽/插件 presets/schema 驱动——preview 后端无面）
  · 验收——webui vue-tsc + preview tsc 零错误 + 589 测试（新增 ac-singles 8 + web-api singles 2 + reducer 分类器 3）+ vite build + CSP 审计 + smoke 全绿
- 同源迁移 ✅ 阶段〇+一（2026-08-23；方案 `docs/webui-adapter-plan.md` + 作战笔记 `docs/webui-adapter-notes.md`）：
  · 阶段〇——原生面归档：`archive/webui-native-m16` 分支保存 M16-M18G 全部 120 文件（阶段二逐模块换端口的对照物与搬运源，不删）；M16"原生重写"决策正式回滚——架构纯度让位于"完全复现 src 界面"目标（目标函数变化后的决策更新，非对错翻案）
  · 阶段一——保真迁移：src/ui/webui 117 文件逐字节拷贝（组件/stores/composables/settings/ui 库零改动，cordis 宿主半边不搬）+ adapter/ 防腐层六件（core 帧翻译/ws 门面/rest 桥/dialog 游标/state/shapes——详见"WebUI 接线"节）+ @agentchat/protocol 自包含垫片 + preview-main 入口；组合根与后端零新行
  · 锁测试（完成标准=契约被钉死而非"能用"）：adapter.test.ts 帧合成表 22 例 + adapter-e2e.test.ts 真 WS 全链路（bootTree + src store 真发 + REST 桥实跑）+ src 搬运测试 10 文件；webui-e2e（后端缝）持续锁定
  · 考古修正——dialogId 合成表以现行 src 代码为准（`chat~lo~hi` 排序对 / `group~gid~aid` / `single~sid`，README M7 节的 `chat~user~aid` 记载已过时）；已知硬伤顺手修（AgentInfo.name←description[15 Agent 中文名验证]/头像 404→首字母回退链/toolCallId=LLM 调用 id 配对）
  · 验收——webui vue-tsc + preview tsc 零错误 + 622 测试 + vite build + smoke + boot 3830 真数据验证（15 Agent/23 会话/1 群/3 singles/8768 用量行——scripts/verify-adapter-realdata.mjs）
  · 同源迁移 ✅ 全部完成（2026-08-23）：阶段〇归档 + 阶段一保真迁移 +
    阶段二六梯契约换血收口——**适配器 A 已整体退役，UI 直连 preview 协议**
    （wire 传输 + src/api/ 各模块 + stores 换血；"适配器先行"纪律随之解除）。
    验收：vue-tsc 零错误 + 77 文件 624 测试 + build + smoke + boot 真数据
    验证全绿；人工全页面回归清单待浏览器过一遍（最终验收）
- M17 ✅ UI 对账与功能面补齐（2026-08-23；开工简报 `docs/m17-ui-parity-plan.md`，M17-B 实现简报 `docs/m17-recon/m17b-brief.md`）：
  · M17-A 后端 RPC 补齐（ac-web-api 薄行扩面）：timer/list·entries·save·trigger（per-Agent 经 agent-store；全局 owner __global__ 落 config 'timer.tasks'——ac-timer 增 config inject + builtin 保护 source:'builtin'）、backup/run·list、jobs/list·get·read·kill、config/get·set·delete·save（白名单键 + 掩码 sanitize）、llm/providers、tools/list（含 requires）、plugin 全套 12 方法 + permissions 词汇表、system/version·restart（ac-restart 提炼 requestSystemRestart + system/restarting 事件广播）、runs/snapshot·interrupt、session/tokens（usage lastContextPrompt 近似）、session/truncate（ac-session truncateAfter 行内编辑语义）；ac-agent-admin 增装配视图 agents/assembly GET·PUT（plugins 目录 + settings[具名] + tools include/exclude/生效集）
  · M17-B 设置面板全件（settings/ 域：types + useSettings 单例状态机[快照 dirty + agentLoadSeq/catalogSeq 竞态守卫] + ConfirmDialog + 9 组件）：左导航树（agents/llmPools/extTools/pluginLibrary/sys.timer + settings-tab:global slot 渲染口消费）+ AgentListPane（新建/搜索/删除）+ AgentPane 五页签（信息/模型[llmParams 白名单分组]/定时/安全[缩水说明]/扩展工具 + agentSettingsTabs）+ TimerPane 5 模式 + PoolManager 查看态 + ExtToolsPane 双模式（三态开关 → updateAssembly）+ PluginLibraryPane 三页签 + StagingReviewModal（文件树/内容/requiredGrants 强制勾选/stagingSeq）+ GlobalTimerPane（builtin 保护）
  · M17-C 聊天面细节：行内编辑（truncateAfter + 重发）/继续生成/时间分隔条（insertTimeSeparators 纯函数 + 测试）/头像星色（StarAvatar + starColor 列表/消息，running 光环 = 忙闲）/lastContext 恢复（localStorage）/列表交互（lastMessage 摘要 + lastActivity 浮顶排序[未读优先] + 指针冻结 + 宽度拖拽持久化）/移动端 ≤768px 抽屉（ui.isMobile/sidebarVisible）
  · M17-D 运行跟踪：runs/snapshot（会话文件扫描 stats + running + groups + usageTotals，纯读）+ RunTrackingView（矩阵 3s 轮询 + 运行树 + 软中断 + 只读历史展开 = pair 视角收编）+ 会话 Token 仪表（ChatView 头，四档 status）
  · M17-E 文件与工作区：web-server multipart 解析（M17-E 通用传输能力）+ workspace 文件面（tree/file/raw/upload/workspaces CRUD——ac-workspace owning 方法：路径守卫 + 二进制 base64 + workspaces.json 登记）+ 头像三端点（agentStore saveAvatar/avatarPath/removeAvatar）+ 前端 FilePreviewModal（file-path-link 点击委托 + fallback 重试）+ ChatInput 附件 chips（multipart 上传 → 路径行进消息）
  · M17-F 收尾：SystemPanel（版本/备份/重启三合一）+ UsagePanel 协作流量（byConversation = byPair 收敛，排行条）+ 测试面搬运（ws-backlog-flush 三不变量补全/loadHistory 竞态守卫 + conversations-race 测试/csp-audit 产物审计——pool-default 两测试条件性不搬：preview 无 config 内联池）
  · 显式缩水记录：模型列表代理（agents/models）→ llm/providers stats 取代；弦图 byPair → 按会话排行条；browse 原生对话框 → 前端 input 选择器 + workspace/file 读取；插件市场四页签 → 三页签（市场/开发目录扫描不建）；搜索池/预设/池 CRUD/effective 双视图/schema 驱动 → 字段直连
  · 验收：preview tsc + webui vue-tsc 双轨 + 576 测试（web-api 26[含 M17-E HTTP 全链]/webui 35[format/race/csp/backlog]/timer/workspace/usage 等）+ smoke + boot（3830 真连探测：WS RPC agents/list·runs/snapshot·system/version + HTTP tree/workspaces/avatar 404 语义）+ 生产构建
- M16 ✅ 原生 WebUI 重写（2026-08-23；开工简报 `docs/m16-native-webui-plan.md`）：
  · 旧壳处置——按 §四打捞清单搬运（ui 令牌组件 14 件/assets css/useMarkdown·useChunkedMarkdown·useToolResult/abap-hljs·streamingMarkdown·starColor·logger/扩展宿主/注册表范式/env.d.ts/index.html/ui-plugin-iframe.html/public/），死件随壳删除（stores·services·core/api·compat·settings·adapter.test 全退），无悬空引用（scripts/yml 路径复用零改动）
  · wire 层——connection（连接半边：身份守卫/重连退避/积压上限/半开看门狗，协议无关）、rpc（requestId 相关性 + 60s 超时 + ws/ack 双通道）、events（类型化事件目录手抄 27 事件参数序，前端自包含）+ bus（帧 type=事件名直转分发）+ rpc-methods（27 方法类型面）；MockWebSocket 泵帧单测（测机制不测适配）
  · 状态层——conversations 纯 reducer（run-started 开 turn/step-started 开 step/delta 三通道分流[reasoning·delta·toolCalls index 聚合]/after-step 终值修正/tool-progress→after-execute 工具卡配对/after-run 收束；origin 标记区分 run·message·reply 轮；惰性补开重连中途帧）；agents/groups/interaction/usage/ui（主题 localStorage + html class + theme-changed；选中会话/未读按 conversationId）；wire 组合根（幂等重建钩子：连接恢复重拉 history/stats/interaction/agents）
  · 视图层——Sidebar（Agent/群混排+未读角标+忙闲）/ChatView（历史分页+live turns：思考折叠+分块 markdown 流式+工具卡注册表）/GroupView（message-posted 唯一内容源+群历史分页+成员表）/InteractionBar（ask_questions 逐题作答）/SettingsPanel（admin RPC 建档/补丁/凭据只写不读/AGENT.md/system-prompt dry-run/生效工具集）/UsagePanel（四维+chart.js 按日柱状）
  · 后端配套——session/history 服务端分页（limit/offset 从尾部往回取 + total/hasMore）；ac-supervisor-core 陈旧锁回收（Windows 残留 .runtime 导致 supervised 永久 78 的修复：死 pid 判定 + 回收重试一次）
  · 验收——webui vue-tsc + preview tsc + 546 测试（wire 12 + reducer 13 新增，adapter 11 随壳退）+ smoke + boot（3830 真连探测：/api/ui/extensions + WS rpc/call 全链路[建档→投递→帧流→历史分页→删除]）+ supervised 全绿
- M15 ✅ 对账收官（2026-08-22）：六轴逐项对照（工具清单/事件面/配置面/会话粒度/usage 回读/群归档持久化），补齐 13 项（ac-group 持久化/usage 回读/timer 工具行/job 唤醒行/待投持久化/tools include-exclude/llmParams/memory_append+归档联动/reassign/system_restart 宿主半边/门禁与参数修正），显式缩水与切换策略见 `docs/m15-reconciliation.md`。完整路线与决策记录见 `docs/src-to-preview-map.md`
