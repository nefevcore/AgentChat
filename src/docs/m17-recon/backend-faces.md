# M17 侦察：src/ui/webui 依赖的后端端点面全表（HTTP REST + WS）

> 数据来源：逐文件核对 `src/ui/webui/src/`（234+ 文件）。HTTP 唯一入口 = `core/api/client.ts`（`request`/`jsonPost`/`jsonPut`/`jsonPatch`/`jsonDelete`，非 2xx 抛 `body.error || HTTP <status>`）；WS 唯一连接 = `services/websocket.ts` → `ws(s)://<host>/ws`（帧格式 `{type, data}`）。事件名以 `core/events/contract.ts`（WS_SEND / WS_EVENT 常量，单一来源）为准，另有一处契约外字面量 `ui.extensions.changed`（core/extensions/host.ts）。所有路径均相对同源后端根。

---

## §1 HTTP 端点全表

### 1.1 agents（Agent CRUD / 模型 / 头像）

| # | 方法+路径 | 参数/请求体 | 响应形状 | 用途 | 调用方 |
|---|---|---|---|---|---|
| 1 | `GET /api/agents` | — | `{ agents: AgentInfo[] }` | Agent 清单（注：主刷新路径走 WS `agent.list`，此处为 REST 补充拉取） | `core/api/endpoints/agents.ts` fetchAgents ← `CreateGroupDialog.vue`、`settings/useSettings.ts`（bootstrap） |
| 2 | `POST /api/agents` | `{ id?, name?, provider?, llm? }` | `{ success?, agentId?, error? }` | 创建 Agent（id 留空自动生成 UUID） | endpoints/agents.ts + settings/api.ts createAgent ← `AgentList.vue`、`useSettings.ts` |
| 3 | `DELETE /api/agents/:agentId` | — | `{ success?, error? }` | 删除 Agent | ← `dialog/DialogView.vue`、`useSettings.ts` |
| 4 | `GET /api/agents/models?base=<url>&provider=<id>&ref=<ref?>` | query：base（API 地址）、provider、可选 ref | `{ models?: string[] }` | 拉取模型列表（OpenAI 兼容 /models、Ollama /api/tags；由后端代理） | `settings/components/AgentPane.vue` |
| 5 | `GET /api/agents/:agentId/config` | — | `AgentConfigViews`（配置多视图） | Agent 配置读取 | settings/api.ts getAgentConfig ← `useSettings.ts` |
| 6 | `POST /api/agents/:agentId/config` | `{ config, sysContent?, agentContent? }` | `{ success?, error? }` | 保存 Agent 配置 | ← `useSettings.ts` saveAgent |
| 7 | `GET /api/agents/:agentId/timer` | — | `{ entries: TimerEntry[] }` | Agent 定时任务读取 | ← `useSettings.ts` |
| 8 | `POST /api/agents/:agentId/timer` | `{ entries: TimerEntry[] }` | `{ entries: TimerEntry[] }` | 保存定时任务 | ← `useSettings.ts` |
| 9 | `POST /api/agents/:agentId/avatar` | multipart：`file` | `{ success?, error? }` | 上传头像 | ← `AgentPane.vue` |
| 10 | `DELETE /api/agents/:agentId/avatar` | — | `{ success?, deleted?, error? }` | 删除头像 | ← `AgentPane.vue` |
| 11 | `GET /api/agents/:agentId/avatar` | query `?t=<cache-bust>`（可选） | 二进制图片（非 JSON） | 头像静态读取（`<img src>` / CSS 直链，不经 client.ts） | `AgentListPane.vue`、`chat/Message/TurnDisplayItem.vue`、`AgentPane.vue`（上传后预览） |
| 12 | `GET /api/sessions/:agentId/tokens` | — | `SessionTokens { tokenCount?, messageCount?, maxContextTokens?, usagePercent?, avgTokensPerMsg?, estimatedMsgsRemaining?, status?: 'low'|'moderate'|'high'|'critical' }` | 会话 Token 用量仪表（1v1 会话头） | endpoints/agents.ts fetchSessionTokens ← `dialog/DialogView.vue` |
| 13 | `GET /api/config/pools` | — | `{ llmProviders?: Record<string, any>, searchProviders?: Record<string, any> }` | LLM/搜索 Provider 池目录 | endpoints/agents.ts fetchPools + settings/api.ts getPools ← `AgentList.vue`、`ChatInput.vue`、`useSettings.ts` |

### 1.2 presets（预设 Agent 目录）

| # | 方法+路径 | 参数 | 响应形状 | 用途 | 调用方 |
|---|---|---|---|---|---|
| 14 | `GET /api/agent-presets` | — | `{ presets: AgentPresetInfo[] }`，条目 `{ id, name, label, description, default }`（如 `__standard__`/`__minimal__`） | 预设 Agent 目录（空 Agent 会话的路由目标 / Session 下拉） | `core/api/endpoints/agentPresets.ts` ← `stores/agents.ts` fetchPresets |

### 1.3 groups（群组）

| # | 方法+路径 | 参数/请求体 | 响应形状 | 用途 | 调用方 |
|---|---|---|---|---|---|
| 15 | `GET /api/groups` | — | `{ groups: GroupInfo[] }` | 群组列表 | `stores/groups.ts` |
| 16 | `POST /api/groups` | `{ name?, participants?: string[], description?, group_id? }` | `{ group?: { group_id? }, success?, error? }` | 创建群组 | `CreateGroupDialog.vue` |
| 17 | `PATCH /api/groups/:groupId` | `Record<string, unknown>`（改名/成员等） | `{ success?, error? }` | 更新群组 | `dialog/GroupDrawer.vue` |
| 18 | `DELETE /api/groups/:groupId` | — | `{ success?, error? }` | 删除群组 | `dialog/DialogView.vue` |
| 19 | `GET /api/groups/:groupId/history?limit=50&offset=<n>` | query：limit（默认 50）、offset（>0 才带） | `{ messages?: any[] }`（宽松消息结构，前端归一化） | 群组历史分页（最新优先 + 上翻更早） | `stores/feed.ts` loadGroupHistory / loadOlderGroupHistory |

### 1.4 runs（运行跟踪 + pair 只读历史）

| # | 方法+路径 | 参数/请求体 | 响应形状 | 用途 | 调用方 |
|---|---|---|---|---|---|
| 20 | `GET /api/runs` | — | `RunsSnapshot { generatedAt: string, members: RunsMember[], pairs: RunsPairSession[], groups: RunsGroupSession[], groupArchives: RunsGroupArchive[], singles: RunsSingleSession[], running: RunsRunningEntry[], subagents: { active: RunsSubagent[], completed: RunsSubagent[] }, coverage: RunsCoverage }`（详见 endpoints/runs.ts 的 DTO） | 运行跟踪快照（3s 轮询；纯读 + mtime/size 行数缓存） | `stores/runs.ts` ← `RunTracking.vue`（矩阵主视图）、`RunTrackingPanel.vue`（侧栏面板） |
| 21 | `POST /api/runs/interrupt` | `{ convKey: string }` | `{ success: boolean, error? }` | 软中断指定会话键的运行中 run（runEnd 落盘后退出） | `RunTrackingPanel.vue` |
| 22 | `GET /api/history?from=<lo>&to=<hi>&limit=100&offset=<n>` | query：from/to（会话两端点，任意顺序）、limit（默认 100/前端用 50）、offset | `{ messages: PairHistoryMessage[] }`，条目 `{ role, content, agent_id?, message_id?, timestamp?, label?, reasoning_content? }` | Agent 会话对（`chat~<lo>~<hi>`）只读历史——运行矩阵格子进入的主区视角 | `stores/feed.ts` loadPairHistory / loadOlderPairHistory ← `PairDialogView.vue` |

### 1.5 singles（独立会话）

| # | 方法+路径 | 参数/请求体 | 响应形状 | 用途 | 调用方 |
|---|---|---|---|---|---|
| 23 | `GET /api/singles` | — | `{ singles: SingleSession[] }`，条目 `{ id, agentId, model?, title?, workspaceId?, status: 'active'|'archived', createdAt, updatedAt, lastActivity? }` | 独立会话列表 | `stores/singles.ts` |
| 24 | `POST /api/singles`（`?reuse=1` 可选） | `{ agentId?, model?, title?, workspaceId?, reuse? }`（空体 = 快速创建空会话） | `{ session: SingleSession, reused? }` | 创建独立会话；reuse=1 时复用已存在空会话 | `stores/singles.ts` create/createQuick ← `SessionList.vue` |
| 25 | `PATCH /api/singles/:id` | `{ agentId?, model?, title?, workspaceId? }`（agentId `''`=清空待选（已有消息 409）；model `null`=清除覆盖；workspaceId `''`=未分组） | `{ session: SingleSession }` | 更新会话设置（输入栏内联换 Agent/模型/挂工作区） | `stores/singles.ts` updateSession ← `DialogView.vue`、`ChatInput.vue` |
| 26 | `DELETE /api/singles/:id` | — | `{ session: SingleSession }` | 归档（软删，消息保留） | `stores/singles.ts` archive ← `SessionList.vue` |
| 27 | `DELETE /api/singles/:id?purge=1` | query purge=1 | `{ deleted: boolean }` | 硬删（元数据 + 消息记录） | `stores/singles.ts` remove ← `SessionList.vue` |

### 1.6 workspace（数据目录树 / 文件内容）——工具见 §4

| # | 方法+路径 | 参数 | 响应形状 | 用途 | 调用方 |
|---|---|---|---|---|---|
| 28 | `GET /api/workspace/tree`（`?path=<dir>` 可选，空=根） | query path | `{ path?, children?: WorkspaceNode[] }`，节点 `{ name, type: 'dir'|'file', size?, children? }` | 工作区目录树（懒加载） | `WorkspaceTree.vue` |
| 29 | `GET /api/workspace/file?path=<p>` | query path | `{ path?, content?, base64?, contentType?, error? }`（消费方另读 `size`/`binary` 字段） | 文件内容预览（base64 供截图/二进制） | `chat/FilePreviewModal.vue`、`chat/ToolResult/ToolResultBrowser.vue` |
| 30 | `GET /api/workspace/raw?path=<p>` | query path | 原始文件字节（非 JSON） | HTML 文件"新窗口打开"直链 | `FilePreviewModal.vue` 模板 `<a :href>` |

### 1.7 browse（本机原生对话框）

| # | 方法+路径 | 请求体 | 响应形状 | 用途 | 调用方 |
|---|---|---|---|---|---|
| 31 | `POST /api/browse/folder` | `{ title? }` | `{ success: boolean, path?, cancelled?, error? }` | 打开原生文件夹选择框（用户工作区登记） | `SessionList.vue` |
| 32 | `POST /api/browse/file` | `{ accept?, title? }` | `{ success: boolean, path? }` | 打开原生文件选择框（MCP 配置等） | `settings/components/SettingField.vue` |
| 33 | `GET /api/browse/read-file?path=<p>` | query path | `{ content?, error? }` | 读取选择器选中文件内容 | `chat/ToolResult/ToolResultWrite.vue` |

### 1.8 workspaces（用户工作区登记）

| # | 方法+路径 | 参数/请求体 | 响应形状 | 用途 | 调用方 |
|---|---|---|---|---|---|
| 34 | `GET /api/workspaces` | — | `{ workspaces: Workspace[] }`，条目 `{ id, name, path, createdAt, updatedAt }` | 用户工作区列表（会话树根分组；沙箱白名单根） | `stores/workspaces.ts` ← `SessionList.vue` |
| 35 | `POST /api/workspaces` | `{ path: string, name? }` | `{ workspace: Workspace }` | 登记本机文件夹为工作区 | `SessionList.vue`（经 store.create） |
| 36 | `PATCH /api/workspaces/:id` | `{ name? , path? }`（至少一个） | `{ workspace: Workspace }` | 改名 / 换文件夹 | `SessionList.vue` rename |
| 37 | `DELETE /api/workspaces/:id` | — | `{ deleted: boolean }` | 删除登记（会话保留 → 未分组） | `SessionList.vue` remove |

### 1.9 system（版本 / 备份 / 用量 / 上传）

| # | 方法+路径 | 参数/请求体 | 响应形状 | 用途 | 调用方 |
|---|---|---|---|---|---|
| 38 | `GET /api/version`（`?simulate=true` 可选） | query simulate | `VersionInfo { current?, latest?, hasUpdate?, latestUrl? }` | 版本检查（simulate 供 UI 演示更新流程，localStorage `agentchat.simulateUpdate`） | `Sidebar.vue`、`VersionDialog.vue` |
| 39 | `GET /api/version/changelog` | — | `{ content? }`（Markdown 文本） | 更新日志 | `VersionDialog.vue` |
| 40 | `POST /api/version/update` | — | `{ status?, message?, steps? }`（status==='success' 即成功） | 触发自更新 | `VersionDialog.vue` |
| 41 | `POST /api/backup` | — | `{ status?, file?, size?, keep?, error? }` | 立即备份 | `Sidebar.vue` |
| 42 | `GET /api/usage/tokens`（`?days=N` 或 `?from=YYYY-MM-DD&to=YYYY-MM-DD`，都不传=全部） | query days/from/to | `UsageSummary { overall{...}, by_agent[], by_day[], by_pair[], by_day_llm?[], range?{from,to} }`（详形见 TokenUsage.vue 接口） | Token 用量统计（云图/日用量/按模型堆叠） | `TokenUsage.vue`（30s 自动刷新） |
| 43 | `POST /api/upload` | multipart：`file`（+ 可选字段 `agentId`，'user' 时不带） | `{ hash?, storedName?, originalName?, size?, path? }` | 聊天附件上传（带 agentId → `files/<agentId>/_tmp/`；否则全局 `_tmp/`） | `ChatInput.vue`（经 endpoints/system.ts uploadFile） |

### 1.10 config（全局配置）

| # | 方法+路径 | 请求体 | 响应形状 | 用途 | 调用方 |
|---|---|---|---|---|---|
| 44 | `GET /api/config` | — | `{ config: Record<string, any> }` | 全局配置读取（settings bootstrap；也在 isolated 插件 GET 白名单内） | `settings/api.ts` ← `useSettings.ts` |
| 45 | `POST /api/config` | `{ config: Record<string, any> }` | `{ success?, error? }` | 保存全局配置 | `useSettings.ts` saveGlobal |

### 1.11 plugins（插件域新契约，全部在 settings/api.ts）

| # | 方法+路径 | 参数/请求体 | 响应形状 | 用途 | 调用方 |
|---|---|---|---|---|---|
| 46 | `GET /api/plugins/llm-schemas` | — | `Record<string, any[]>` | LLM Provider 配置 schema | `useSettings.ts` bootstrap |
| 47 | `GET /api/plugins/search-schemas` | — | `Record<string, any[]>` | 搜索 Provider 配置 schema | 同上 |
| 48 | `GET /api/plugins/schemas` | — | `{ namespaces: Record<string, any[]>, extensions?, tools? }` | 命名空间 schema（全量） | 同上 |
| 49 | `GET /api/plugins/assembly/:agentId` | — | `{ assembly: AssemblyView }`（presets/hooks 顺序表/tools 显式清单 + 全量目录） | Agent 装配视图读取 | `useSettings.ts` refreshAssembly |
| 50 | `PUT /api/plugins/assembly/:agentId` | `AssemblyUpdate`（patch） | `{ success: true, assembly: AssemblyView, migrated? }` | 保存装配（服务端校验 + 原子写盘 + 热重载 + WS 广播） | `useSettings.ts` saveAgent |
| 51 | `GET /api/plugins/catalog` | — | `PluginCatalog` | 插件/钩子/工具全量目录（单真相源；也在 isolated GET 白名单） | `useSettings.ts` |
| 52 | `GET /api/plugins/library` | — | `PluginLibrary`（已安装 + 待审暂存） | 插件库 | `useSettings.ts`、`PluginLibraryPane.vue` |
| 53 | `POST /api/plugins/library/stage` | `{ dir, owner }` | `{ staging: StagingRecord }` | 本地目录暂存待审 | `PluginLibraryPane.vue` |
| 54 | `POST /api/plugins/library/approve` | `{ id, grants: string[] }` | `{ installed: PluginInfo }` | 人审通过并安装 | `StagingReviewModal.vue` |
| 55 | `POST /api/plugins/library/reject` | `{ id }` | `{ success: true }` | 拒绝暂存 | `StagingReviewModal.vue`、`PluginLibraryPane.vue` |
| 56 | `POST /api/plugins/library/:name/uninstall` | — | `{ success: true, backupDir? }` | 卸载（目录移 .backup） | `PluginLibraryPane.vue` |
| 57 | `GET /api/plugins/market/search`（`?q=<query>` 可选） | query q | `MarketSearchResult`（源失败返回缓存并带 stale 标记） | 市场搜索（显式触发） | `PluginLibraryPane.vue` |
| 58 | `GET /api/plugins/market/cached` | — | `{ entries: MarketEntry[] }` | 本地缓存市场索引（零网络） | `PluginLibraryPane.vue` |
| 59 | `POST /api/plugins/market/stage` | `{ spec, owner? }` | `{ staging: StagingRecord }` | 市场条目进待审队列 | `PluginLibraryPane.vue` |
| 60 | `POST /api/plugins/market/install` | `{ spec, grants? }` | `{ installed: { name, version, hash } }`（缺高危 grants 时 400 → 前端回落 stage+人审） | 市场一步安装 | `PluginLibraryPane.vue` |
| 61 | `GET /api/plugins/session` | — | `{ plugins: PluginInfo[] }` | 会话级插件列表（开发态） | `useSettings.ts` |
| 62 | `POST /api/plugins/session/register` | `{ dir, owner?, grants?, watch: true }` | `{ status: 'loaded'|'replaced', plugin: PluginInfo }` | 开发目录 → 会话级加载（重启即失） | `PluginLibraryPane.vue` |
| 63 | `POST /api/plugins/session/:name/reload` | — | `{ status: 'loaded'|'replaced' }` | 会话级重载 | `PluginLibraryPane.vue` |
| 64 | `POST /api/plugins/session/:name/unload` | — | `{ success: true }` | 会话级卸载 | `PluginLibraryPane.vue` |
| 65 | `GET /api/plugins/permissions` | — | `PluginPermissionsView` | 权限词汇表（徽章 / grants 勾选源） | `useSettings.ts` |
| 66 | `GET /api/plugins/staging/:id/tree` | — | `{ files: StagingFileInfo[] }` | 暂存目录文件树（人审） | `StagingReviewModal.vue` |
| 67 | `GET /api/plugins/staging/:id/file?path=<p>` | query path | `StagingFileContent` | 暂存文件内容（人审只读） | `StagingReviewModal.vue` |

### 1.12 ui（UI 扩展 + 静态资产）

| # | 方法+路径 | 参数 | 响应形状 | 用途 | 调用方 |
|---|---|---|---|---|---|
| 68 | `GET /api/ui/extensions` | — | `{ extensions: UIExtensionDescriptor[] }`（name/version/entry/styles/slots/isolated） | UI 插件目录（宿主轮询/事件同步） | `core/extensions/host.ts`（经 endpoints/ui.ts） |
| 69 | `GET /api/ui/slots` | — | —（无调用方，端点已从前端删除） | 遗留：仅存在于 isolated 插件 GET 白名单（p5.5-policy.ts）中 | — |
| 70 | `GET /ui-plugin/<name>/<entry>?v=<version>`（模块资产）、descriptor.styles 的 href（CSS）、`/ui-plugin-iframe.html?name=&entry=&version=`（隔离档壳页） | — | JS 模块 / CSS / HTML | UI 插件入口动态 `import()` 与样式注入、sandbox iframe 宿主页（非 JSON API，静态托管面） | `core/extensions/host.ts`、`isolated.ts` |

> 另：UI 插件桥（`core/extensions/bridge.ts` 的 `ctx.request`）向**非隔离插件**开放任意 `request(path, init)`（同 client.ts）；**隔离插件**经父窗口代理，仅允许 GET 白名单：`/api/ui/extensions`、`/api/ui/slots`、`/api/config`、`/api/version`、`/api/plugins/catalog`、`/api/plugins/permissions`、`/api/plugins/library`、`/api/plugins/assembly/:id`（p5.5-policy.ts）。

---

## §2 WS 出站词汇全表（客户端 → 服务器，帧 `{type, data}`）

连接：`ws(s)://<host>/ws`（单连接；断线重连 2s 起指数退避封顶 30s；未连发送入待发队列上限 100；90s 无入站帧判半开主动重连）。

| # | type | data 字段 | 用途 | 调用方 |
|---|---|---|---|---|
| 1 | `chat.send` | `{ to, content, deepThink: boolean, reasoningEffort?: 'low'\|'high'\|'max', files: unknown[], requestId?, session? }`（requestId = 客户端幂等 id；single 上下文带 session） | 发消息（sendMessage 带本地气泡；_sendRaw 供重推理/编辑重发） | `stores/chat.ts` |
| 2 | `chat.interrupt` | `{ to, session? }` | 中断当前生成（single 带session 精确中断） | `stores/chat.ts` interruptGeneration |
| 3 | `chat.continue` | `{ to, session? }` | 继续生成（无需新用户消息） | `stores/chat.ts` continueGeneration |
| 4 | `chat.subscribe` | `{ to, session? }` | 订阅活跃会话快照（刷新/切回恢复运行中 run；single 必带 session 防串台） | `stores/chat.ts` setSingleContext / onAgentListResponse；`AgentList.vue`；`RunTracking.vue`；`RunTrackingPanel.vue` |
| 5 | `chat.delete_message` | `{ agent, counterpart, messageId }` | 持久化删除单条消息（重推理/删消息/编辑重发；仅 pair 场景） | `stores/chat.ts` regenerateMessage / deleteMessage / editMessage |
| 6 | `chat.interact.respond` | `{ interaction_id, choice }` | ask_questions 决策回填 | `stores/chat.ts` respondInteraction |
| 7 | `history.request` | `{ from, to, limit, offset, requestId?, session? }`（首屏 offset=0，上翻 +limit；single 带 session） | 会话历史分页拉取 | `stores/feed.ts` loadHistory / loadMoreHistory |
| 8 | `agent.list` | `{}` | 拉取 Agent 清单（响应走 `agent.list.response`） | `stores/agents.ts` requestAgents |
| 9 | `agent.system_prompt` | `{ agentId, session? }` | 预览装配后的 System Prompt | `stores/chat.ts` requestSystemPrompt |
| 10 | `agent.tool_defs` | `{ agentId }` | 预览工具定义 | `stores/chat.ts` requestToolDefs |
| 11 | `session.compress` | `{ agent, counterpart }` | 触发会话压缩/记忆归档（仅 pair） | `stores/chat.ts` compressSession |
| 12 | `system.restart` | `{}` | 请求后端重启（保存配置后） | `settings/useSettings.ts` |
| 13 | `group.message` | `{ group_id, content, from }`（from = VIEWER_ID 'user'） | 群聊发消息 | `dialog/DialogView.vue` |

（契约 `WS_SEND` 共 13 条，与上表一一对应，无未使用词。）

---

## §3 WS 入站事件全表（服务器 → 客户端）

### 3.1 消息流（`stores/feed.ts` FEED_HANDLERS 统一 ingest）

公共字段：`agentId?` / `agent?` / `sender?` / `dialogId?`（`dialogId` 形如 `chat~lo~hi` / `group~gid~aid` / `single~sid`，前端据此路由分区）。

| # | 事件名 | 载荷形状（前端消费的字段） | 用途 |
|---|---|---|---|
| 1 | `chat.start` | `{ hint?, source? { kind, form?, summary? }, sender?, dialogId? }` | run 起点：后台/自主 run（archive 等）写时间线分隔符 hint；archivePending 置位 |
| 2 | `chat.step.start` | `StreamEventBase` | ReAct 步开始：开流式占位、分区 streaming=true |
| 3 | `chat.step.end` | `{ interrupted?, ...base }` | 步结束：关闭占位；interrupted 走中断路径 |
| 4 | `chat.interrupted` | base | 中断：占位回落 + "⏸️ (已被中断)" |
| 5 | `chat.end` | `{ content? (string，兜底补最终回复), ...base }` | run 结束：兜底补气泡、清 archivePending/lastRunEndAt |
| 6 | `chat.message.start` | — | 预留（handler 空实现） |
| 7 | `chat.message.update` | `{ delta? }` + base | 正文流式增量 |
| 8 | `chat.message.end` | `{ content?, reasoning?, tool_calls?, agentId?/agent? }`（MessageEndPayload） | 消息收口：覆盖 content/thinking/toolCalls |
| 9 | `chat.message.error` | `{ content? \| payload? }` | LLM 调用失败：追加 role='error' 红条 |
| 10 | `chat.thinking.start` | `{ label? }` + base | 思维链开始 |
| 11 | `chat.thinking.update` | `{ delta? }` | 思维链增量 |
| 12 | `chat.thinking.end` | `{ label? }` | 思维链结束 |
| 13 | `chat.toolcall.start` | `{ name, index? }` + base | LLM 生成工具参数："正在调用工具"占位 |
| 14 | `chat.toolcall.update` | base | 参数流式（仅点亮进行中态） |
| 15 | `chat.toolcall.end` | base | 参数生成完（仅点亮进行中态） |
| 16 | `chat.tool_execution.start` | `{ tool_call_id, tool_name, arguments, label? }` + base | 工具开始执行：建/升级 tool 占位 |
| 17 | `chat.tool_execution.update` | `{ delta?, tool_call_id? }` | 工具结果流式增量（按 tool_call_id 匹配） |
| 18 | `chat.tool_execution.end` | `{ tool_call_id?, result? }` | 工具结束：写入 result |
| 19 | `chat.session.resume` | `{ active, agentId, session?, userMessages?: [{content, ts}] \| userMessage?+userMessageTs?, steps?: [{ thinking, label, tool_calls: [{id,name,arguments,result,label}], content, ts }], content?, thinking?, phase? ('tool'), toolCallId?, toolName?, label? }` | 活跃会话快照（chat.subscribe 响应）：刷新后恢复未落盘当前轮 |
| 20 | `chat.virtual.receive` | `{ from \| agent, payload, label? }` | 虚拟 Agent（含 user 侧）收到消息：Agent 主动发 user 的实时推送 |
| 21 | `history.response` | `{ messages: PersistedMessage[]（role/content/agent_id/message_id/timestamp/label/reasoning_content/tool_calls/tool_call_id/name/source）, requestId?, session? \| agentId }` | 历史分页响应（requestId 回显防旧响应串页） |
| 22 | `group.message` | `{ group_id, from, payload? \| content? }`（GroupMessageEvent） | 群聊消息（入站同名复用出站词）：写 group 分区 + 列表重排 |

### 3.2 非消息类（`stores/chat.ts` HANDLERS 等）

| # | 事件名 | 载荷形状 | 用途 | 处理方 |
|---|---|---|---|---|
| 23 | `agent.list.response` | `{ agents: AgentInfo[] }` | Agent 清单（含 hasActiveSession → 恢复选中 + chat.subscribe） | `stores/chat.ts` |
| 24 | `agent.profile.updated` | — | Agent 画像变化 → 重拉 REST+WS 清单 | 同上 |
| 25 | `chat.send.ack` | `{ busy?, deduped?, to? }` | 发送回执：busy=排队提示；deduped=重连重发被去重 → 重拉历史 | 同上 |
| 26 | `chat.interaction` | `{ interaction_id, agent_id, question, options: string[], allow_custom, timeout_ms }` | ask_questions 决策弹窗 | 同上 |
| 27 | `chat.interact.respond` | — | 响应回显（no-op） | 同上 |
| 28 | `session.compressed` | — | 归档已触发回执（"Agent 正在整理记忆"） | 同上 |
| 29 | `session.archived` | `{ success, agent?, counterpart?, error? }` | 归档完成 → 重载会话历史 | 同上 |
| 30 | `singles.updated` | — | 独立会话元数据变更（自动标题/设置）→ 刷新列表 | `stores/singles.ts` |
| 31 | `system.restarting` | — | 后端重启中（Supervisor 自动拉起 + WS 重连） | `stores/chat.ts` |
| 32 | `agent.system_prompt.response` | `{ success, systemPrompt? \| error? }` | System Prompt 预览响应 | `stores/chat.ts` |
| 33 | `agent.tool_defs.response` | `{ success, toolDefs? \| error? }` | 工具定义预览响应 | 同上 |
| 34 | `group.created` | `{ group_id }`（载荷宽松） | 群组创建 → 刷新 + 选中新组 | `stores/groups.ts` |
| 35 | `group.deleted` | `{ group_id }` | 群组删除 → 清选中 + 刷新 | 同上 |
| 36 | `group.join` | — | 成员加入 → 刷新群列表 | 同上 |
| 37 | `group.leave` | — | 成员离开 → 刷新群列表 | 同上 |
| 38 | `group.delivered` | `{ group_id }` | 群消息投递完成 → 复位该群 turn 态 | `dialog/DialogView.vue` |
| 39 | `plugin.catalog.changed` | — | 插件目录变化 → 重拉 catalog/assembly | `settings/useSettings.ts` |
| 40 | `plugin.reload` | — | 插件重载 → 同上 | 同上 |
| 41 | `agent.assembly.changed` | — | Agent 装配变化 → 重拉 assembly | 同上 |
| 42 | `ui.extensions.changed` | `{ name?, reason?: 'register'\|'unregister'\|'reload' }` | UI 插件集变化 → 防抖 150ms 重同步 /api/ui/extensions（**契约外字面量，不在 contract.ts**） | `core/extensions/host.ts` |

（另：协议层 30s 后端 ping 只是保活，前端不消费具体内容——只用"有任何入站帧"喂半开看门狗。）

---

## §4 上传 / 文件面

### 4.1 上传（唯一上传端点）

- `POST /api/upload` —— multipart/form-data：字段 `file`（文件本体）+ 可选字段 `agentId`（当前对话 Agent，`'user'` 不带）。响应 `{ hash?, storedName?, originalName?, size?, path? }`。语义：有 agentId → 落 `files/<agentId>/_tmp/`；否则全局 `_tmp/`。调用链：`ChatInput.vue` triggerFileUpload → `endpoints/system.ts uploadFile`。附件随后以 `{ hash, filename(=storedName), filesize, text(=path) }` 进入 `chat.send` 的 `files` 数组。
- `POST /api/agents/:agentId/avatar` —— multipart：字段 `file`。响应 `{ success?, error? }`。（头像专用上传，独立于 /api/upload。）

### 4.2 文件读取（预览/工具结果消费）

| 端点 | 形状 | 消费方 |
|---|---|---|
| `GET /api/workspace/file?path=<p>` | `{ path?, content?, base64?: boolean, contentType?, size?, binary?, error? }`——文本直读；二进制时 content=base64 + base64:true（data URL 渲染）；SVG 以文本返回（前端自行编码 data URL） | `chat/FilePreviewModal.vue`（消息内文件路径点击预览；404 时 fallback `files/<fallbackAgentId>/<path>` 再试一次）、`chat/ToolResult/ToolResultBrowser.vue`（browser 工具截图预览：解析 result 里的相对路径 → base64 加载） |
| `GET /api/workspace/raw?path=<p>` | 原始字节流（非 JSON） | `FilePreviewModal.vue`：HTML 文件"新窗口打开"的 `<a href>` 直链 |
| `GET /api/browse/read-file?path=<p>` | `{ content?, error? }` | `chat/ToolResult/ToolResultWrite.vue`（write 工具结果显示写后文件内容） |
| `GET /api/agents/:agentId/avatar` | 二进制图片 | `<img>`/CSS 直链：`AgentListPane.vue`、`TurnDisplayItem.vue`、`AgentPane.vue`（均带 `?t=` 破缓存） |
| `GET /api/plugins/staging/:id/file?path=<p>` | `StagingFileContent` | `StagingReviewModal.vue`（插件人审只读文件） |

（`GET /api/workspace/tree` 为目录元数据面，归 §1.6；文件内容读取统一在 本节。）

---

## §5 结论：前端依赖的独立后端域

按"补齐 preview 后端需实现的域"分组（每面一句话）：

1. **chat/WS RPC 面（`/ws`）** —— 全部对话生命周期：13 个出站词（chat.send/interrupt/continue/subscribe/delete_message/interact.respond、history.request、agent.list/system_prompt/tool_defs、session.compress、system.restart、group.message）+ 42 个入站事件（消息流 22 + 非消息 20），是 preview 已有 WS RPC 需对齐词汇与载荷（含 dialogId 路由、requestId 幂等、resume 快照）的核心面。
2. **agents 域（REST）** —— Agent CRUD、per-agent config/timer、模型列表代理（/api/agents/models）、头像上传/删除/静态读取、会话 token 仪表（/api/sessions/:id/tokens）。
3. **presets 目录面** —— `/api/agent-presets` 只读目录：空 Agent 会话的路由目标与 Session 下拉。
4. **groups 域（REST + WS 事件）** —— 群组 CRUD、群历史分页（/api/groups/:id/history），配 group.created/deleted/join/leave/delivered 推送。
5. **singles 域（REST + WS 事件）** —— 独立会话 CRUD（创建含 reuse、PATCH 设置、归档/硬删 purge），配 singles.updated 推送；会话历史复用 WS history.request（带 session）。
6. **runs 快照面** —— `/api/runs` 全量运行快照（members/pairs/groups/groupArchives/singles/running/subagents/coverage）+ `/api/runs/interrupt` 软中断 + `/api/history` pair 只读历史（矩阵格子进入视角）。
7. **workspaces 用户工作区面** —— `/api/workspaces` CRUD：本机文件夹登记（沙箱白名单根、会话树分组）。
8. **workspace 数据目录文件面** —— `/api/workspace/tree|file|raw`：数据目录树浏览、文件内容（base64/文本）、原始字节直链（FilePreviewModal/ToolResultBrowser 消费）。
9. **browse 原生对话框面** —— `/api/browse/folder|file|read-file`：服务端唤起本机选择框并回读内容（桌面宿主能力）。
10. **upload 附件面** —— `POST /api/upload` multipart（agentId 定向落 `files/<agentId>/_tmp/`），附件句柄进 chat.send files。
11. **config/config.pools 配置面** —— `/api/config` 全局配置读写 + `/api/config/pools` Provider 池目录（settings 主数据源）。
12. **版本面** —— `/api/version`（?simulate）+ `/api/version/changelog` + `/api/version/update` 自更新（Sidebar/VersionDialog）。
13. **备份面** —— `POST /api/backup` 立即备份（Sidebar）。
14. **用量统计面** —— `/api/usage/tokens`（days/from/to 范围）多维聚合（overall/by_agent/by_day/by_pair/by_day_llm），TokenUsage 30s 轮询。
15. **插件域面** —— `/api/plugins/*` 全套：schemas 三种、assembly 读写、catalog、library（stage/approve/reject/uninstall）、market（search/cached/stage/install）、session 插件（register/reload/unload）、permissions、staging 审阅（tree/file），配 plugin.catalog.changed / plugin.reload / agent.assembly.changed WS 推送。
16. **UI 扩展面** —— `/api/ui/extensions` 目录 + `/ui-plugin/*` 静态资产托管（entry 模块 / styles / iframe 壳页）+ `ui.extensions.changed` 推送；隔离档另需 GET 白名单代理（含遗留 `/api/ui/slots`）。

**核对说明**：HTTP 侧全部 70 行端点均逐文件核对自 `core/api/endpoints/*`（9 文件）、`settings/api.ts`、组件模板直链（avatar / workspace.raw）；无任何业务代码绕过 `core/api/client.ts` 直接 `fetch`（唯二直接引用 client.request 的是 UI 扩展桥 bridge.ts/isolated.ts，属受控透传/白名单代理）。WS 侧出站 13 词与 `WS_SEND` 常量一一对应，入站 41 词与 `WS_EVENT` 常量一一对应，另加 1 个契约外字面量 `ui.extensions.changed`。
