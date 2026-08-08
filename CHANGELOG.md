# Changelog

All notable changes to AgentChat are documented in this file.

---

## [0.5.1] - 2026-08-08

### Added
- **配置迁移到 plugins 装配形态**：Agent config.json 移除 `tools`/`pre_hooks`/`post_hooks` 字段与兼容层，统一由 `plugins[].runStart/runEnd` 声明（build-system-prompt / load-memory / load-history / save-session / update-memory 等）；hooks 挂载点在 plugins 形态下全链路验证无损
- **list_tools 返回全量工具**：按 tags→requires 装配后含平台内置工具全量展示（艾吉 29 个），不再只列 plugins 自定义工具
- **list_groups 按归属过滤**：只返回调用方所在群组（不在任何群组时返回空）
- **router pending 落盘**：关机模式下 pending 消息立即落盘 `<ws>/.router_pending.jsonl`，进程级重启后 flush 恢复，不丢消息
- **read/edit/bash 工具增强恢复**：read lineHash 输出 + recordSnapshot；edit Hashline v2 DSL（三级模糊匹配/冲突重叠检测/快照校验，edit-diff/hashline-executor 等 7 文件回归）；bash background 后台执行（detached+PID+log_file）+ killProcessTree 杀进程树（超时+abort 双链路）
- **ArchiveService 迁移（L4 门面）**：归档编排收敛 services 层——archive-service.ts（handleRunEnd 统一入口 / requestArchive / archiveAndRebuild / scanPendingArchives / idleArchive / archiveAllActiveSessions / dispose），app 装配层通过 services 门面注入 runEnd 统一出口与 __archive_all__ 批量归档；scanPendingArchives 残留清理逻辑回归

### Fixed
- **PluginRegistry.setServices 引用语义**：此前浅拷贝导致 registry 与 loader 各持一份 services，spawn_subagent 永远读不到父 Agent LLM（报"父 Agent 无 LLM"）；改为首次直接引用 + 后续原地合并后，子 Agent 创建/执行/回收全链路打通
- **重启后继续消息 trigger 语义**：system_restart 后系统注入的"请继续"以 `role=trigger` 落盘（此前误记为 `agent_id=user` 的用户消息），前端/统计可区分系统注入与用户真实发言
- **工具开发指引可达性**：tool-dev-guide.md 移入工作区 `files/shared/`，read 工具沙箱内直达（此前指向仓库根 docs/，read 越界需绕道 bash）
- **16 个旧测试迁移**：import 路径对齐新结构（14 迁 2 删——pendingArchiveCleanup/truncateTail 新架构无等价符号）；全量 47 套件过 / 381 tests 通过
- **归档整理轮 meta 通道修复（繁忙丢标志）**：归档整理轮触发在会话繁忙时降级为 steer 导致 `archiveReview` 标志丢失、整理轮消息落盘污染会话；改为通用 meta 通道（META_ARCHIVE_REVIEW 常量）+ router 不降级 steer 直接等待空闲后独立 run 重试（190s 上限 + 10 分钟 pending 超时兜底）
- **记忆审查标记机制移除**：.memory_update_needed/.memory_review_needed 全链路删除，记忆整理由归档整理轮统一完成（失忆可由 query_history 重新回忆）
- **消息 ID 稳定化**：stableMessageIdOf 对无 ID 旧数据补稳定 ID（dialogId+ts+role+content hash），供去重/归档二次去重/前端 persistedMsgId/删除使用

### Changed
- **system prompt 持久化存储段落精简**：记忆相关合并为一条 `[记忆文件]`（内联命名规则与归档触发说明），移除会话存储说明
- **前端调整**：删除 PluginSettings.vue（并入 AgentSettings），WorkspaceTree / AgentSettings 等组件同步配置迁移
- **docs/tool-dev-guide.md 重构**：按 v0.5.0 五层架构重写（defineTool 工厂 / requires 门控 / per-Agent 烘焙 / reload(scope=global)）
- **prompt 框架层精简**：术语约定 3→1、标签约定 3→1、删除被工具描述覆盖的 3 条冗余指引、引号段 dev/admin 门控、background 指引与恢复后的参数对齐（Start-Process 表述改回 background:true）
- **WORKFLOW.md 重写**：对齐当前 API（Hashline v2 编辑流程/reload(scope=)/新 5 层路径），移除 reload_extensions 等旧工具名与废弃路径
- **skills.ts 模块拆出**：技能发现/渲染从 prompt.ts 独立成文件（对齐 mcp.ts 独立文件模式），makeInjectSkillsHook 重新导出
- **token 估算口径对齐**：estimateMessagesTokens/truncateMessagesByTokenBudget 不再计入 reasoning（DeepSeek 历史 reasoning 不发送给模型）；前端 ChatView 删除流式估算，改后端权威数据 + chat.end 落盘后刷新（lastRunEndAt）

---
## [0.5.0] - 2026-08-06

### Added
- **5 层目标架构落地**（按 `architecture-target-20260805.md`）：目录重组为 `core`(L1 单 Agent 引擎) → `agents`(L2 多 Agent 调度) → `plugins`(L3 能力扩展) → `services`(L4 对外门面) → `app`(L5 装配启动)，依赖严格单向；顶层仅 6 目录 + `shared`
- **新路径别名**：新增 `@agents/*`、`@app/*`；`@llm/*` 指向 `core/llm`；删除 `@routing/@infra/@discovery/@rpc/@global`

### Changed
- **core 引擎重组**：`core/agent/index.ts` → `core/loop.ts`（ReAct 引擎）；`core/session/*` 三文件合并 → `core/context.ts`（RunSession/SessionManager/convKeyFor）；`agent-queue.ts` → `core/queue.ts`；`llm/` 从顶层移入 `core/llm/`
- **agents 调度层新建**：收纳 `registry` / `router` / `group`(原 group-manager) / `config` / `config-diff` / `virtual-agent` / `app-state` / `credential-store`(原 infra)
- **app 装配层新建**：收纳主入口(原 `src/index.ts`) / `supervisor` / `loader`(原 discovery/agent-loader) / `plugin-loader`(原 plugins/loader) / `shutdown`
- **services 门面扩充**：`rpc`(原 rpc/)、`backup`、`interactions`(原 infra) 移入；`index` 增补导出
- **插件目录改名**：`agent-core` → `builtin`、`agent-math` → `builtin-math`；`timer`/`sub-agent` 移入 `builtin/src/`（定时与子 Agent 归插件域）
- **shutdown 去重**：`core/shutdown.ts` 与 `infra/shutdown.ts` 两份重复文件合并为 `app/shutdown.ts`（router 域 → 插件域 → WebUI → exit 顺序）
- **构建脚本同步**：`package.json` / `build-supervisor` / `build-release` 入口与别名全部指向新路径；顺带修复 `build-release.ts` 失效的 `src/global` 引用（→ `plugins/{builtin,builtin-math}`）

### Removed
- **废弃脚本**：删除 `scripts/build-supervisor.ts`（supervisor bundle 无任何启动路径使用）+ `scripts/clean-releases.ts`（手动清理 GitHub Release body 的维护脚本，CI 已自动生成）；同步移除 package.json 的 `build:supervisor` 脚本
- **3 个复制实现逻辑的过期测试**：`networkDown.test.ts`（复制 isNetworkError，已由集成测试覆盖真实行为）、`socialArchive.test.ts`（复制 isoWeekKey + 字符串模板自证断言）、`tags-system.test.ts`（复制 roleToTags/canUseTool，真实实现已由 tagInject.test.ts 覆盖）
- **临时/构建产物清理**：`release/`、`.cache/`、`scripts/runtime/` 遗留旧发布副本、`dist/` 等（约 373 MB，均可再生；`backups/`、`workspace/` 用户数据保留）

---

## [0.4.12] - 2026-08-05

### Added
- **数据备份/恢复**：新增 `src/core/backup.ts` 核心模块 + `POST /api/backup`（手工触发）+ `GET /api/backup`（列表）；备份 workspace 全量数据到项目根 `backups/`（gitignore 排除，绝不入库防泄露）；保留最近 4 份循环覆盖；每日 04:00 定时任务（7 天间隔才执行 = 每周自动备份）；活动栏"更多"菜单加"数据备份"按钮
- **会话级并行（架构升级）**：Agent 状态从实例级改为会话级（RunSession per-conversation），每会话独立执行队列——一个 Agent 可同时处理多个会话（不同对方/群聊），互不阻塞；steer 转向消息按会话路由

### Changed
- **bash 下沉 agent 基础 tag**：bash 工具 requires dev→agent，全部 14 实 Agent 自动获得（查进程/清理文件不再锁 dev）；dev 剩 browser/code_search/inspect_session/read_logs/reload
- **continue_turn 方向修复**：自我续推 hint 不再落盘为"对方发来的 trigger"（幽灵消息曾导致 editor 多跑一轮 + 前端显示方向错乱）；selfContinue 标记
- **agent-prompt 新增 DONE.md 说明**：TODO 只保留未完成项，新完成事项直接记 DONE.md 不回填（防膨胀）
- **TODO/DONE 拆分**：50KB→9.8KB，179 项已完成迁 DONE.md

### Fixed
- **steer 会话路由**：转向消息按 ActiveSession.sender 路由，不误入其他会话

---

## [0.4.11] - 2026-08-04

### Changed
- **工具注入统一为 tag 驱动**：移除 autoInject 机制，全部工具按 requires 匹配 Agent tags 注入（agent 基础 / dev 开发 / conductor 调度 / admin 管理）；Agent 只需配 tags 即自动获得对应工具
- **新增 conductor 调度 tag**：子 Agent 工具（spawn/await/list/kill_subagent）从 dev 独立，仅艾吉/莉莉/test 有
- **list_tools → list_tags**：返回 tag→工具映射 + 缺失提示（想要某工具就知道打什么 tag）
- **manage_plugins 并入 update_agent_profile**：update 支持 tags/tools/pre_hooks/post_hooks 统一管理；manage_plugins 移除
- **get_agent_profile → read_agent_info**：查自己（persona+hooks+脱敏 llm）/ 查他人（公开信息 + 你对该 Agent 的记忆）；移除 system_prompt 暴露
- **tags 管控**：非 admin 禁止给自己打 admin 标签（拦截器+工具双重校验）
- **news 补 dev 标签**：爬虫写脚本/浏览器能力
- **math_pro 补 dev 标签**：数学研究写代码

### Fixed
- **历史消息加载打转/重复**：ChatView 滚动加载 offset 按实际链数校准 + 按 message_id 去重 + 滚动位置保持（此前往上翻一直加载相同消息）

---

## [0.4.10] - 2026-08-04

### Changed
- **角色体系重构为能力标签 tags**（架构级）：Agent 身份从单一 role（user/developer/admin）升级为组合式能力标签 `tags: string[]`；工具按 `requires`（AND 语义）匹配 tags 自动注入，替代 config.tools 写死白名单；`role` 字段已从全部 Agent 配置移除（老用户由 update-config 脚本自动迁移 role→tags）
- **工具集按标签自动注入**：基础工具 requires `["agent"]`、dev 工具 `["dev"]`、admin 工具 `["admin"]`、领域工具 `["sap"]` 等；Agent 只需配 tags 即自动获得对应工具，无需逐个配置
- **记忆注入预算 600 → 10000 tokens**：缓存 token 便宜，一次注入完整记忆，减少 Agent 频繁调工具查 memory.md（会话割裂缓解）
- **摘要配置合并**：`archiveSummaryInjectLen` 并入 `summaryPreviewLen`（统一 4000 字，控制上下文压缩 + 归档 SUMMARY.md 的生成与注入）
- **归档触发比例 50% → 70%**：延迟归档触发，减少整理轮成本

### Added
- **归档 SUMMARY.md 跨会话注入**：归档时生成会话总结写入 `archive/SUMMARY.md`，preHook 注入后续会话，防止归档后会话割裂（Agent 在归档整理轮亲自写，系统自动生成降级兜底）
- **归档整理轮 hint 注入截断上限**：告知 Agent SUMMARY.md（4000 字）与 memory.md（10000 tokens）的注入上限，引导控制篇幅避免"写了被截断"
- **update-config 迁移脚本**：`npm run update:config` 将旧工作区配置迁移到新默认值（memoryBudget 600→10000 / summary 1000→4000 / archiveRatio 0.5→0.7 / 废弃字段移除 / role→tags）；start.bat 启动时自动执行，老用户升级无感
- **start.bat 启动检测新版本**：静默查 GitHub 最新版，有新版询问是否更新（Y 打开 update.bat）；移除 install.bat

### Fixed
- **归档残留 pending 导致误归档**：`.archive_pending` 残留让超时监视器误判并强制归档最近对话（20:47 把 20:44 的对话归档）；`completeArchiveReview` 改 try/finally 保证标记清理 + `scanPendingArchives` 启动即扫 + idleArchive 日志区分触发源
- **system_restart 非 Supervisor 模式**：不再"工具不存在"，注入后执行时返回明确原因
- **admin 可管理其他 Agent 档案**：update_agent_profile / manage_plugins 支持 agent_id（admin 标签）

---

## [0.4.9] - 2026-08-04

### Added
- **MCP 切换官方 SDK**：自建 JSON-RPC 客户端（~930 行）→ `@modelcontextprotocol/sdk`（~310 行），支持 Streamable HTTP + headers
- **23:30 全局批量归档**：timer-manager 内置 `__archive_all__` 特殊 hint，深夜自动归档所有活跃 1:1 会话（缓存低价 + 不打断白天对话）

### Changed
- **LLM 热更新**：切换全局默认模型时所有 Agent 的 LLM 跟随（rawLlmConfigs + resolveLLMPool 重解析）
- **config 清理**：移除旧 times 遗留 + 23:30 归档任务入库

---

## [0.4.8] - 2026-08-03

### Fixed
- **群聊回复空转（严重）**：Agent 收到群聊 trigger 后直接输出文本不调工具，回复未投递到群聊（空转），形成负反馈死循环。三层修复：① router hint 强化（明确"若值得回应必须调 send_group，直接输出文本不会发送到群聊；无话可说则沉默"）② agent-prompt 恢复群聊规则（回复必须用工具）+ 术语约定/COLLAB_TOOLS 补全 ③ `loadGroupHistory` 合并相邻"对方视角纯发言"消息（242 条→71 条，压缩 71%，既省 token 又抬高 assistant 示范密度）
- **自主推理轮次一律不设上限**：归档整理轮被硬编码 `maxTurns: 12/15`、定时任务默认 `99999` 限制，复杂整理被截断（neko 归档到 12 轮被强制终止）；移除三处硬编码，仅显式配置 maxTurns 才生效
- **孤立 tool 日志误报**：跨视角历史加载时对方视角的 assistant（tool_calls）被转 user 丢弃（A3 协议），其 tool 结果成为孤立被过滤——预期行为，日志 WARN 降为 debug
- **群聊消息格式统一 `<msg>` 标签 + 死循环修复**：群聊实时消息/历史统一 `<msg from name group>` 格式，Agent 能识别"这是群聊发言"
- **agent-prompt 指引检测 bug**：`buildGuidelinesBlock` 用实际可用工具集（含 autoInject）检测，此前 autoInject 工具检测不到导致群聊/协作指引缺失
- **bootstrap LLM 未配置不再崩溃**：LLM 未配置时启动不崩 + 配置全局 LLM 后自动补默认

### Added
- **browser 工具结果结构化展示**：webui 对 browser 工具结果做结构化渲染
- **社交活动归档**：A→自对话按天 + A→群聊参与按周归档（agent-session）

### Changed
- **群聊回复语义收敛为 send_group**：实验验证 reply_group 语义引导有效（测试14），但 send_group 在明确 hint 下同样正常（测试17/18 全员投递成功），reply_group 冗余删除——API 精简
- **删除群聊行为引导（省 token）**：群聊行为引导由 router 的 hint 每轮携带（更贴近当前消息），agent-prompt 静态重复引导删除，保留术语约定与 `<msg>` 格式说明
- **移除 adjust_llm 工具**：LLM 强度调节工具回退（此前 0.4.6 Added）

---

## [0.4.7] - 2026-08-03

### Fixed
- **中断不再误判网络失效（严重）**：`isNetworkError` 把用户主动中断（AbortError）也算网络错误，连续中断 2 次会导致整个系统进入网络失效模式、所有消息入队不投递；已排除，并给错误计数加 5 分钟时间窗口（跨天两次偶然错误不再触发全局 down）

---

## [0.4.6] - 2026-08-03

### Added
- **adjust_llm 工具**：Agent 自主调节 LLM 强度（温度/深度思考/最大输出），任务难开 thinking 温度 0，闲聊关 thinking 省 token；persist 可选写配置重启生效
- **Token 云图面板**：Token 用量新增气泡图 tab，气泡面积∝用量一眼看出最活跃 Agent（零新依赖）
- **首次启动引导**：全新环境自动创建 user + admin（艾吉），触发自我介绍并引导配置 LLM/创建 Agent

### Changed
- **全局定时重构**：chime 独立机制移除，并入统一 scheduleEntry（`__global__` 虚拟 Agent）；配置键 `chime`→`timer`（兼容旧键）；提示支持 `{{now}}`/`{{time}}`/`{{date}}` 占位符；任务项新增复制按钮
- **附件上传重构**：原始文件名存 `files/<agentId>/_tmp/`（或全局 `_tmp`），重名 SHA-256 幂等/加序号；中文文件名修复；用户气泡渲染附件可点击预览

### Fixed
- **前端全局定时无法点击**：新建任务弹窗条件 bug（两条件都 false 永不显示）
- **附件看不到内容**：WS handler 用 a.hash 拼路径（实际存原始名）→ 改用 a.text
- **Release 构建失败（v0.4.6）**：GlobalSettings.vue 占位符文本 `{{now}}`/`{{time}}`/`{{date}}` 被 Vue 解析为插值导致 vue-tsc 报错（改用 HTML 实体转义）；ChatInput.vue 误用 `store.activeAgentId`（chat store 无此属性，应为 agent store）

### Added（稳定性/体验）
- **router 网络失效模式**：网络异常时消息入队不丢，30s 探测自动恢复重投（连续 2 次网络错误才 down，防抖动）
- **对方正忙提示**：给忙的 Agent 发消息时前端提示"已作为追加指令排队"，不再误以为无响应

---

## [0.4.5] - 2026-08-02

### Fixed
- **A→A 自对话提示词指引**：告知 Agent 自对话不落盘，重要信息需自行更新 memory/TODO/note（配套 B1）
- **思维链正文被吞**：末尾有纯文本消息时，最后一条 meaningful step 的正文不展示；改为「不等于 final 气泡正文」判定
- **同 sender 长间隔消息误合并**：超过 10 分钟视为不同轮次（定时广播不再合并进同一 turn 链）

---

## [0.4.4] - 2026-08-02

### Added
- **Agent 角色选择器 UI**：配置面板加 user/developer/admin 下拉，无需改配置文件即可分配角色层级

### Changed
- **消息角色体系重构**：trigger 一等角色（角色判定彻底脱离正文内容嗅探）+ provider 双向转换（toProviderMessages/fromProviderMessages）+ viewer 视角统一 + loadHistory 返回持久化格式 + safeSplitIdx 结构截断（tool 对保护）
- **脚本统一**：8 个会话维护脚本合并为 `session-maint.js`（scan/aa/compact/migrate/all），运行时脚本移入 `scripts/runtime/`
- **token 估算共享**：`src/utils/tokens.ts` 统一实现，webui/server 复用

### Fixed
- **archive 归档重建污染**：tool 结果含 `<trigger>` 子串被误标 trigger（query_history 内嵌历史文本）；toPersistedRole 强制 tool/error 保持原角色
- **前端 trigger 判定**：`isTrigger` 改为纯 `role==='trigger'`（移除正文内容回退）
- **A→A 自对话污染**：postHook 对自对话永不落盘消息历史（仅记录用量）

---

## [0.4.3] - 2026-08-01

### Added
- **语义化中断**：InterruptReason + ToolInterrupt 体系，abort 从核弹变可控信号；reload/restart 抛中断
- **manage_plugins 装配反馈**：返回 dropped tools + 原因（不存在/无权）
- **web_search 配额检查**：本地积分账本 + 查询前配额门控

### Changed
- **工具清理**：移除废弃 reload_self_tools/reload_extensions
- **重启自动恢复**：restart enqueues continue-trigger，会话自动恢复

### Fixed
- **重启继续触发器来源**：continue-trigger from=session counterpart
- **去重窗口**：60s → 30s（复读机场景反馈）

---

## [0.4.2] - 2026-08-01

### Added
- **一键重启**：Supervisor 模式后端完整重启，WebSocket 自动重连，重启后会话自动恢复
- **bash 后台执行**：长驻服务 detached 运行 + 日志写文件，立即返回 PID 不阻塞
- **工具中断**：SSE abort + 进程树杀，长思考/长命令可随时打断
- **自我续推**：continue_turn 主动触发自己下一轮推理，无需等待用户输入
- **隐藏工具机制**：危险管理工具（system_restart）不在发现流程中展示，仅显式配置启用
- **工具分级模型**：基础/工具/开发/管理四层，按用户角色自动注入/剔除

### Improved
- **系统提示词指引重编排**：11 组分类（基础→管理），同类型合并
- **重复消息去重窗口**：8s → 60s，防止用户无意重发被吞

### Fixed
- **打断链路不再崩溃**：abort 异常捕获 + 进程级兜底，长思考中打断进程存活
- **打断后消息重复持久化**：重连/reload 不产生重复消息
- **重启瞬间去重失效**：去重缓存跨重启保留

---

## [0.4.1] - 2026-08-01

### Added
- **read_logs 日志工具**：Agent 可直接读取后端运行日志（内存环形缓冲，支持级别/关键词/条数过滤），调试不再依赖人工复制
- **群聊归档**：群聊达到阈值自动归档，每个参与者独立整理自己的群聊记忆（sessions/<agent>/group__<id>/memory.md），配合摘要锚点解决长群聊的上下文膨胀
- **群聊双阈值**：归档触发阈值（默认 50K）+ 单次加载上限（默认 30K），多 Agent 共享历史时防止 token 消耗爆炸
- **归档前记忆整理**：1:1 会话和群聊归档前，系统自动触发参与者基于完整上下文整理记忆（memory/TODO/note），整理完成才归档
- **工具分类重构**：开发工具（reload/code_search/inspect_session）从自动注入改为按需配置；browser 整合为全局工具
- **全局定时任务管理**：全局面板可增删改定时任务（时间/提示/目标 Agent）

### Fixed
- **工具调用事件串台**：chat.toolcall 事件缺 sender 校验，其他 Agent 的工具调用会串流到当前会话界面
- **归档标记路径错位**：归档标记改为 canonical 排序路径，双边会话（Agent↔Agent）不再因路径不对称而无法归档
- **群聊归档参与者读不到**：AppState 未注入 GroupManager，导致群聊参与者列表为空、归档不触发
- **群聊整理轮被跳过**：postHook 的 group_id 分支在 archiveReview 判断之前，群聊整理轮被提前 return

---

## [0.3.3] - 2026-07-31

### Added
- **冷启动安装**：`install.bat` 从 GitHub latest release 一键下载 → 校验 → 解压 → 安装
- **缓存复用**：zip 有效则跳过下载，损坏则自动清理重试
- **aria2c 加速**：检测到 aria2c 时 16 连接多线程下载；否则 fallback curl（断点续传 + 重试）
- **zip 完整性校验**：下载后自动验证格式，损坏重试（最多 3 次）
- **下载统计**：curl `--write-out` 输出字节数、耗时、速度

### Fixed
- **CI zip 格式错误**：Git Bash GNU `tar -a` 生成 tar 而非 zip，改为 PowerShell `Compress-Archive`
- **`update.bat` 版本解析**：简化为 `findstr` 直接提取，移除 PowerShell 依赖
- **bat 语法错误**：`for /f` 单引号与 PowerShell 冲突、`echo` 在 if 块内提前闭合、延迟展开 + 缺少 `pause`
- **bat 编码**：移除 `chcp 65001` 和所有 Unicode，全 ASCII
- **原子下载**：先 `.tmp` 再校验后 move，防止中断产生半截文件

### Changed
- Node.js 便携版 → **v24.18.0**（Krypton LTS）

---

## [0.3.2] - 2026-07-31

### Fixed
- **`update.bat` 下载失败**：多行 PowerShell `^` 续行符传给 PowerShell 导致语法错误
- **`update.bat` 编码乱码**：Node.js 检测与 `start.bat` 统一（自动解压 `node-portable.zip`）
- **前端文件链接**：`FILE_PATH_PATTERN` 不匹配裸路径；`TurnDisplayItem` 未转发 `previewFile` 事件

---

## [0.3.1] - 2026-07-31

### Added
- **ratio 滑块**：比例型配置项拖动滑块 + 百分比显示

### Changed
- **会话归档**：`archiveMinMessages` → `archiveTokenRatio`，token 比例比消息数更精准
- **`keepRecentRatio`**：20% → 2.5%，更激进截断降成本

### Fixed
- **归档死循环**：水位过于接近导致归档后立即再次触发
- **bash**：循环依赖、maxBuffer OOM、危险命令检测补全、stdin 支持、5 类友好错误提示

---

## [0.3.0] - 2026-07-31

### Added
- **Hashline v2 编辑协议**：read 输出 `[PATH#TAG]` 头部 + `行号:内容`；edit 支持 DSL patch
- **DSL 操作**：`SWAP`（替换）、`INS.PRE/POST/HEAD/TAIL`（插入）
- **文件级哈希**：4 字符 TAG，edit 时验证防并发冲突
- **write 输出 TAG**：无需重新 read 即可 edit
- **compress 对话框**：trigger → trim 全流程
- **AgentList Token 水位**：侧栏实时显示每个 Agent 的 token 占用
- **Token 占用预测 API**：`/api/sessions/:agentId/tokens`

### Changed
- **read/edit 重组**：`shared.ts`（61 行）+ `hashline-parser.ts` + `hashline-executor.ts` + `edit/tool.ts` 纯路由
- **Hashline v1 → v2**：行级哈希 → 文件级哈希，JSON edits → DSL，8 字符 → 4 字符
- **压缩机制**：marker 文件替代直接 `agent.receive()`
- **滚动**：仅初始加载自动滚底，`requestAnimationFrame` 等布局

### Fixed
- **edit 模糊匹配越界**：`matchedLen` 精确追踪
- **LLM 孤 tool_calls**：调用前过滤
- **clean-sessions.py**：重写为顺序构建器，修复而非删除；扩展到归档文件
- **虚拟 Agent**、**重复 marker**、**archiveAndRebuild 绕过** 等多项修复

---

## [0.2.0] - 2026-07-30

### Added
- **Steer**：立即中止 LLM 推理，提前进入下一轮 ReAct
- **SVG Logo**：聊天气泡 + Agent 节点 + 品牌紫渐变
- **一键更新**：`update.bat` 从 GitHub latest release 下载
- **write 预览**：文件名点击弹窗，语法高亮 + 行号 + 复制
- **＋ 下拉菜单**：新增 Agent / 创建群组合并入口
- **群聊简介编辑**：抽屉 textarea
- **日期分隔符**：今天/昨天/前天/三天前
- **思维链时间标签**："已思考 X 秒"
- **思维链工具摘要**：折叠栏 `read · edit · bash`
- **edit 返回 updated_hashes**：下次 edit 直接定位
- **局域网访问**：绑定 `::`，Vite `host: true`

### Changed
- **MCP 独立扩展**：`agent-mcp` 与 `agent-prompt` 完全解耦
- **agent-prompt 瘦身**：移除工具/MCP 描述块，由模型 `tools` 参数注入
- **统一管线**：私聊 + 群聊共用 `TurnDisplayItem`，`agent_id` 驱动
- **Turns 重构**：computed → 事件驱动增量 ref
- **思维链**：流式展开 → 结束 500ms 折叠；chain-body 思考 → 工具 → 正文
- **Token 面板**：移除总览 tab → 汇总条 + Agent/日期双 tab
- **气泡宽度**：`turn-item` 70% 统一管控
- **Sidebar**：Agent + 群组按时间混排
- **历史查询**：按消息计数，默认 10 轮
- **发布脚本**：`启动AgentChat.bat` → `start.bat`

### Fixed
- **WS 串台**：`cid` 会话粒度路由
- **记忆审查**：`idleArchive` + VirtualAgent `postHook`
- **群聊合并**：UUID 格式 ID 自动识别、不再合并
- **edit diff 行号**：`mergeLineRanges` gap 2 → 0
- **markdown 连字**：`font-variant-ligatures` 禁用
- **归档重叠**、**文件指数膨胀**、**steer 内容保留** 等

### CI
- push `release` → latest pre-release；push `v*` → 正式版本

---

## [0.1.3] - 2026-07-29

### Changed
- **Node.js 延迟解压**：发布包 190MB → 89MB（首次 `start.bat` 时解压）

### Fixed
- **`plugin.json` 缺失**：tsc 不复制 `.json`，`build-release` 现在自动补齐
- **`timer-state.json` 孤儿**：启动 + 保存时自动清理
- **`set_timer` 重复**：新增 `replace` 参数

---

## [0.1.0] - 2026-07-29

### Added
- **Hash 行编辑**：read 显示行哈希，edit 用 `lineHash + newText` 精准修改
- **版本检测**：`/api/version` 对比 GitHub，弹窗显示变更日志
- **热加载**：`reload_extensions` 无需重启
- **write 上限**：1MB 防止误操作
- **自动打开浏览器**

### Changed
- **User Agent → virtual** 类型
- **更多按钮**：三处统一 `⋯`
- **版本弹窗**：700px 宽
- **名称变更即时生效**

### Fixed
- **401**：`resolveLLMConfig` 从凭据库回注
- **DeepSeek**：`baseURL` / `deepseek-v4-pro` 默认
- **编码乱码**：bat 全 ASCII
- **隐私泄露**：release 不复制开发 workspace
- **首个模型默认**、**菜单关闭** 等

