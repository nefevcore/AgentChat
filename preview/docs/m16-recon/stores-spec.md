# AgentChat preview 旧壳（webui/src）浓缩规格报告

> 供新原生前端（Vue3+Pinia+Vite）设计 stores 与引导面。**未修改任何文件。**
> 注：stores/ 目录实际为 **10 个文件**（任务书写 9 个但列出 10 个名字，以实际 10 个为准）。

## 0. 架构总览（先读这段）

- **分层**：`stores/*`（Pinia setup store）→ `services/websocket.ts`（传输适配客户端）→ `core/events/contract.ts`（WS_SEND/WS_EVENT 事件名单一来源）+ `core/registry/eventHandlers`（统一事件注册表：`registerEventHandler(type, fn)` / `dispatchEvent(type, data)`）。
- **事件流**：`feed.init()` 挂载唯一的 `ws.onMessage((type,data)=>ingest(type,data))` → `ingest` 只是 `dispatchEvent` → 各 store 在初始化时把处理器注册进注册表。**WS 消息只有一个分发点，事件处理器是"注册制"而非 store 内 switch**。
- `constants.ts`：`export const VIEWER_ID = ref('user')` — 当前用户身份的全局响应式单例；用户消息 `agent_id='user'`，所有归属判定都比对 `VIEWER_ID.value`。
- `main.ts`（20 行）：引样式（main.css / markdown.css / katex / texmath / ui/tokens.css）→ `createApp(App)` + `createPinia()` → mount。**无路由、无 store 预热——全部初始化在 App.vue 与各 store 首次实例化时**。
- `isolated-runtime.ts`：iframe isolated 档 UI 插件运行时（P5.5）。由 ui-plugin-iframe.html 在 `sandbox="allow-scripts"` iframe 内加载；插件入口模块 export `install(ctx)`，ctx 仅 `{ name, request(经 postMessage 由父窗口白名单代理，10s 超时), onEvent(白名单事件转发), onUnload }`；不暴露 Vue/DOM 宿主；自身处理 ready/error/unload 的 postMessage 协议、入口路径校验（前缀 + 防 `..`）。

---

## 1. Stores（10 个）

### 1.1 websocket.ts（连接壳）
- **state**：`connected: boolean`（唯一响应式状态）；非响应式私有 `wsClient: WebSocketClient`。
- **actions**：
  - `init()` — 幂等；`new WebSocketClient(\`${ws|wss}://${location.host}/ws\`)`，onConnect/onDisconnect 翻转 `connected`，然后 `connect()`。
  - `onMessage(handler): () => void` — 内部先 `init()` 防护（消除"必须先 init"的隐性顺序契约），返回退订函数。
  - `onConnect(handler)` / `send(type, data)` / `getClient()`。
- **入站事件**：不处理具体事件（透传给 handler）。
- **耦合**：被所有 store 当发送口；与 services/websocket.ts 的关系见 §2.5。

### 1.2 agents.ts（Agent 列表/选中/预设）
- **state**：`agents: AgentInfo[]`；`activeAgentId: string`（''=未选）；`presets: AgentPresetInfo[]`（REST /api/agent-presets，预设目录不在 Agent 列表）。
- **getters**：`defaultPreset`（`p.default` 优先 → 首个 → null）；`defaultPresetId`（回退 `'__standard__'`）。
- **actions**：
  - `requestAgents()` — **send `agent.list`** + fetchPresets()（REST）。
  - `selectAgent(id)` — **toggle 语义**：再点已选中项 = 反选为 ''；写/清 lastContext({kind:'agent'})。
  - `setAgents(list)` — 按 `lastActivity` 倒序排序。
  - `bumpAgent(role, content)` / `bumpAgentById(agentId, role, content)` — 更新该项 `lastMessage`（content 截 80 字）+ `lastActivity=Date.now()` + 重排。
  - `tryRestoreLastAgent()` — lastContext.kind==='agent' 且未选中时恢复选中，返回 agentId 或 null。
  - `getAgentAvatar(id)` / `getAgentName(id)`（列表→预设→id 兜底）/ `isPreset(id)`。
- **入站事件**：无直接注册（`agent.list.response` 由 chat store 处理后回调本 store）。
- **耦合**：被 feed（bumpAgentById/getUnread 门控）、chat（bumpAgent/defaultPresetId）、groups（清选中）引用。

### 1.3 feed.ts（统一信息流，核心）★
- **state**：`dialogs: Record<DialogId, DialogFeed>`；`_version: Record<DialogId, number>`（bump 驱动派生）；非响应式 `_turnsCache/_turnsMemo`（增量 turns 缓存）、`_historyOffset/_historyReq`（分页 offset + 最新 requestId 防串页）、`resumeSnapshot/resumeMerged`（会话恢复）；`_activity: ActivityEntry[]`（全局活动索引，ts 倒序，cap 500）→ getter `activity`；全局 UI 信号 `turnInProgress/lastRunEndAt/archivePending`；`activeGroupId/activeSingleId` + 私有 `_singleAgent`（session→agentId 身份映射）。
- **DialogFeed 字段**：`id, kind, partner, rawMessages（唯一真相源）, status('idle'|'loading'|'ready'), hasMore, offset, lastActivity, lastMessage, unread, streaming`。
- **getters**：`activeDialogId`（**优先级 single > group > direct(由 agents store 派生)**）；`activeDialog`；`activeAgentId`(=agents store)；`unreadAgents: Set<string>`（有未读的 direct agentId 集）；`loadingHistory/hasMoreHistory`（当前活跃 dialog 的单值投影）；`gatingAgentId`（single 视角=登记的目标 Agent，否则列表选中项）。
- **actions（原语）**：`ensureById / bump / invalidateTurns / touch / append / removeMessage / replaceMessage / truncateAfter / resetDialog / setRaw / clearUnread / getUnreadCount / getRaw / getDialog / getTurns(id): ComputedRef<Turn[]>`（memo，仅该 dialog 版本变化时重算）。
- **actions（历史）**：`loadHistory` — **send `history.request`**（limit=5, offset=0, requestId）；`loadMoreHistory`（+5）；`mergeHistory`（首屏整体替换/续拉前插；**首屏替换前摘出仍在流式的尾部占位回填**；hasMore=user 条数≥5；stale 响应按 requestId 丢弃）；`loadGroupHistory/loadOlderGroupHistory`（REST，页 50）；`loadPairHistory/loadOlderPairHistory`（REST /api/history，页 50）。
- **actions（激活）**：`setActiveGroup/clearActiveGroup/setActiveSingle(sessionId, agentId?)/clearActiveSingle`（三者互斥）。
- **actions（init）**：`ws.init()` + 注册 FEED_HANDLERS + `ws.onMessage(ingest)` + `ws.onConnect(清理：loading→ready、streaming 分区关闭并 closeAllStreaming)`。
- **入站事件（FEED_HANDLERS）**：`chat.start, chat.step.start, chat.step.end, chat.interrupted, chat.end, chat.message.start(空), chat.message.update, chat.message.end, chat.message.error, chat.thinking.start/update/end, chat.toolcall.start/update/end(update|end 仅 markActive), chat.tool_execution.start/update/end, chat.session.resume, history.response, group.message, chat.virtual.receive`。
- **门控函数（新前端必须沿用的判定）**：`isForCurrentUser`（sender 缺省或=VIEWER_ID）；`isForActiveAgent`（**只门控全局 UI 信号** turnInProgress/archivePending/lastRunEndAt）；`isUserDialog`（dialogId 前缀：`group~` 过滤、`single~` 放行、`chat~` 必须含 VIEWER_ID——Agent 自言自语/Agent 间对话不进 UI）；`resolveDialogId`（`single~sid`→single dialog，否则 agentId→direct）；`agentKeyOf`（single 的消息身份=登记的 agentId 而非 sessionId）。
- **耦合**：依赖 websocket（send/onMessage/onConnect）、agents（activeAgentId/bumpAgentById）；被 chat/groups/singles 复用。reducer 细节见 §2.2。

### 1.4 chat.ts（业务动作 + 非消息状态）★
- **state（自有）**：`copyFeedback: boolean`；`compressPending: boolean` / `compressFeedback: string`（定时清空）；`busyFeedback: string`（busy ack 4s / deduped 3s / watchdog 6s 自动消失）；`interactionState: {interaction_id, agent_id, question, options[], allow_custom, timeout_ms} | null` → getter `interaction`；System Prompt 预览三态 `systemPromptLoading/Content/Error`；工具定义预览 `toolDefsLoading/Defs/Error`；私有 `singleMeta: Map<sessionId,{agentId}>`。
- **委托 feed（storeToRefs）**：`activeDialogId, unreadAgents, turnInProgress, loadingHistory, hasMoreHistory, lastRunEndAt, archivePending`。
- **computed**：`messages`（活跃 dialog raw）；`turns`（活跃 dialog 派生）；`currentMessages`（role∈agent|tool）；`contextBusy`（**分区 streaming 优先于全局 turnInProgress**——别的会话流式不能把当前输入框变成"打断并发送"）；`resolveContext(): {kind:'pair'|'single', agentId, sessionId?} | null`（single 激活优先，否则 activeAgent）。
- **actions（出站消息）**：
  - `sendMessage(content, to?, {deepThink?, reasoningEffort?, files?})` — 乐观 append 用户气泡（role='agent', agent_id='user'）→ 分区 `streaming=true` + 30s 看门狗 → pair 时 agents.bumpAgent → **send `chat.send`**（deepThink 默认 true，requestId 幂等，single 带 session）。
  - `interruptGeneration()` — **send `chat.interrupt`**（single 带 session）。
  - `regenerateMessage(msgId)` — 找前方最近 user 消息；pair+persisted 时对旧 assistant/user 各 **send `chat.delete_message`**；`feed.setRaw`（删区间+补新 user 气泡）→ 重新发送（_sendRaw）。
  - `deleteMessage(msgId)` — pair+persisted 时 **send `chat.delete_message`**；`feed.removeMessage`。
  - `editMessage(msgId, newContent)` — pair 时对其后所有 persisted 消息逐条 **send `chat.delete_message`**；`feed.replaceMessage`+`truncateAfter` → 重新发送。
  - `compressSession()`（仅 pair）— **send `session.compress`**。
  - `continueGeneration()` — **send `chat.continue`**。
  - `respondInteraction(choice)` — **send `chat.interact.respond`** 并清空弹窗状态。
  - `requestSystemPrompt(agentId?)` — **send `agent.system_prompt`**（single 带 session）；`requestToolDefs(agentId?)` — **send `agent.tool_defs`**。
  - `setSingleContext(sessionId, agentId)` — 登记元信息 + `feed.setActiveSingle` + **send `chat.subscribe`**（带 session 精确匹配，恢复活跃快照）；`clearSingleContext()`。
  - `loadHistory(from,to,session?)` / `loadMoreHistory()` — 委托 feed。
- **入站事件（HANDLERS）**：`agent.list.response`（setAgents→tryRestoreLastAgent→resetDialog+loadHistory+若 hasActiveSession 则 chat.subscribe）、`agent.profile.updated`（重拉 requestAgents）、`chat.send.ack`（busy=排队提示 / deduped=结束进行中态+重拉历史）、`chat.interaction`（置弹窗+turnInProgress）、`chat.interact.respond`（no-op）、`session.compressed`（反馈文案）、`session.archived`（成功→重置分区+重载历史；失败→❌）、`system.restarting`、`agent.system_prompt.response`、`agent.tool_defs.response`。
- **init 副作用（store setup 时执行）**：`feed.init()`（消息类 ingest + WS 单一分发）→ `ws.init()` → HANDLERS 注册进 eventHandlers 注册表。
- **耦合**：→ websocket/agents/feed；被 singles（setSingleContext）与几乎所有视图消费。

### 1.5 groups.ts（群组）
- **state**：`groups: GroupInfo[]`；`activeGroupId: string`；`showCreateGroup: boolean`（创建弹窗）。
- **actions**：`fetchGroups()`（REST /api/groups）；`selectGroup(id)` — **清 agents.activeAgentId（互斥）+ feed.setActiveGroup + saveLastContext(group)**；`deselectGroup()`；`open/closeCreateGroup`；`onGroupCreated(id)`（拉列表→选中）；`onGroupDeleted(id)`（活跃群被删→退出+清 lastContext）；`init()` — **幂等守卫**（二次调用只刷新列表，防处理器累积与劫持上下文）：注册 4 个群事件→fetchGroups、`group.message`→handleGroupMessage（更新 lastActivity+重排）、fetchGroups 后恢复守卫（群已删则放弃）、lastContext.kind==='group' 则恢复选中。
- **入站事件**：`group.created, group.deleted, group.join, group.leave`（→fetchGroups）、`group.message`（→列表重排；消息本体由 feed 的同名事件写分区）。
- **耦合**：agents（清选中）、feed（活跃对话）、lastContext。

### 1.6 singles.ts（独立会话列表）
- **state**：`singles: SingleSession[]`；`loaded: boolean`。
- **getters**：`activeSingleId`（=feed）；`activeSingle`；`activeSingles`（status==='active' 过滤）。
- **actions**：`refresh()`（REST /api/singles）；`createQuick()`（**复用已有空会话，避免空白条目堆积**）；`create(payload)`（创建→refresh→立即进入）；`selectSingle(sessionId)` — **历史由 DialogView 的 single watch 统一加载（列表只切上下文）**：`chat.setSingleContext(sessionId, session.agentId || agents.defaultPresetId)` + saveLastContext；`deselectSingle()`；`restoreLastSingle()`（已删/归档则清过期记录）；`updateSession(sessionId, {agentId?, model?, workspaceId?})`（PATCH；**活跃会话换 Agent → 重建 setSingleContext**）；`archive()`（软删，正打开先退出）；`remove()`（硬删）；`titleOf(s, agentName)`（标题回退：agentName·时间）。
- **入站事件**：`singles.updated` → refresh（**模块加载时即注册**，自动标题/设置变更即时上屏）。
- **耦合**：chat、feed、agents(defaultPresetId)、lastContext。

### 1.7 runs.ts（运行跟踪轮询）
- **state**：`snapshot: RunsSnapshot | null`；`loadError: string`；`loading: boolean`；`now: number`（1s 本地时钟，运行时长递增显示）。
- **actions**：`refresh()` — REST /api/runs；**in-flight 防护**（慢响应乱序完成防回跳）+ **内容签名比对**（剔除 generatedAt 后 JSON 相同 → 保留原对象引用只更新 generatedAt，避免 400+ 矩阵雨子级联重算）；`ensurePolling()` — 幂等；3s 轮询（`document.visibilityState==='visible'` 才发）+ 1s now tick；`stopPolling()`。
- **入站事件**：无（纯 REST）。**耦合**：无 store 耦合（RunTracking.vue / RunTrackingPanel.vue 挂载时 `ensurePolling()` + `requestAgents()`）。

### 1.8 theme.ts
见 §2.4（机制简单，全文即重点）。

### 1.9 ui.ts
见 §2.1（逐字段）。

### 1.10 workspaces.ts（用户工作区）
- **state**：`workspaces: Workspace[]`；`loaded: boolean`。
- **actions**：`refresh()`（REST /api/workspaces）；`create({path, name?})`；`rename(id, name)`；`remove(id)`（均操作后 refresh）。
- **入站事件**：无。**耦合**：无（纯 REST；工作区=会话树根节点/沙箱白名单文件夹，语义在后端）。

---

## 2. 特别重点（新前端必须沿用的交互语义）

### 2.1 ui.ts 全部交互语义（逐字段）

| 字段/动作 | 类型/签名 | 语义 |
|---|---|---|
| `listVisible` | boolean（默认 true） | 桌面端列表面板可见性 |
| `listWidth` | number（默认 260） | 列表面板宽度（px），拖拽范围 [160, innerWidth-48-320]（MIN_LIST=160 / MIN_CHAT=320） |
| `listPanel` | 'agents' \| 'sessions' \| 'tracking' | 列表槽位当前页（Agent/群列表、会话列表、运行跟踪清单）；**localStorage `agentchat.listPanel` 持久化**，非法值回退 'agents'；**活动栏只换侧边栏，不直接决定主区** |
| `trackingViewVisible` | boolean（默认 false） | 主区「运行矩阵」大画布视图；由清单面板入口 `openTrackingView()` 打开 |
| `pairView` | {a,b} \| null | 主区「Agent 会话对」只读视角（矩阵格子进入，两端点非 viewer）；active 期间覆盖聊天视角（perspective 注册在最前） |
| `sidebarVisible` | boolean（默认 false） | 移动端（≤768px）侧边栏抽屉 |
| `workspaceVisible` / `workspaceWidth` | boolean（false）/ number（280） | 右侧工作区分屏；宽度范围 [180, 480]，handle 在左缘（**右移=变窄，与列表方向相反**） |
| `globalSettingsVisible` / `settingsAgentTarget` | boolean / string | 全局设置面板；target=打开时定位到的 Agent（''=不定位；聊天页/侧边栏可 `openAgentSettings(id)`） |
| `tokenUsageVisible` / `versionVisible` | boolean | Token 用量 / 版本弹窗 |
| `previewVisible` / `previewFilePath` / `previewFallbackAgentId` | boolean / string / string | 文件预览**全局单例**弹窗；fallbackAgentId 供 `files/<agentId>/` 相对路径回退 |
| `resizing` | boolean | 拖拽进行中（document 级 mousemove/mouseup + body cursor=col-resize + userSelect:none） |
| `isNarrow()` | () => boolean | `window.innerWidth <= 768` |
| `toggleList()` | () => void | 窄屏=翻转抽屉后**立即返回**（否则会把刚关的抽屉又打开）；宽屏=翻转 listVisible |
| `openListPanel(p)` | (p) => void | 点当前页=toggleList；点另一页=切换+写 localStorage+展开（窄屏同时开抽屉） |
| `openTrackingView()` / `closeTrackingView()` | | 后者**连带 pairView=null**（防悬挂 pair 独占主区） |
| `openPairView(a,b)` / `closePairView()` | | 进入 pair 时**不关矩阵**——返回即回矩阵而非空白聊天区 |
| `toggleSidebar()` / `closeSidebar()` | | 移动端抽屉 |
| `toggleWorkspace()` | | 与会话共存，不影响 Agent 列表 |
| `openAgentSettings(id)` / `openGlobalSettings()` / `closeSettings()` | | 设置面板三件套 |
| `openTokenUsage/closeTokenUsage`、`openVersion/closeVersion`、`openPreview(path, fallbackAgentId)/closePreview` | | 弹窗开关（closePreview 同时清 path/fallback） |
| `startResize(kind, e)` | ('list'\|'workspace', MouseEvent) => void | 拖拽启动；onResizeMove 有 **buttons 归零兜底**（鼠标移出窗口松开时防悬挂） |

### 2.2 chat.ts + feed.ts 的流式状态机（turn/step/message/tool）

**数据结构**（单一真相源 → 派生）：
- 每个 dialog 的 `rawMessages: ChatMessage[]`（append-only；流式消息**原地更新**对象）。
- `Turn{agent_id, steps: TurnStep[], final}`；`TurnStep{assistant: ChatMessage, tools: ChatMessage[], isStreaming}`。派生由纯函数 `buildTurns(raw)` 完成，feed 的 `getTurns(id)` 是 memo 化 computed（`_version[id]` bump 触发；`buildTurnsIncremental` 复用完成轮次对象身份——**仅最后一条消息签名变化时前缀 turn 引用不变，Vue 跳过重渲染**；结构性变更由 `invalidateTurns` 显式失效）。
- **流式占位链核心：`lastStreaming(msgs, role?)`** = 从尾往前找第一条 `isStreaming` 消息。所有 delta 类 reducer 都"找最后一条流式占位原地追加"，**绝不新建第二个占位**（双占位=旧占位冻结成"测/测试"双气泡的根因）。

**reducer 一览**（事件 → 对 rawMessages 的操作）：
- `step.start`：分区 `streaming=true`；尾部已有"空的流式 assistant 占位"则复用，否则 push `newAssistant`（content='', isStreaming=true）。
- `thinking.start`：找到流式 assistant 设 `label`；**重复 start（重连重放）→ 先关闭旧占位再开新占位**（旧占位残留会让派生 step 恒流式、折叠栏强制展开）。
- `thinking.update`：`asst.thinking += delta`（同步写 `reasoning_content` 别名）。
- `thinking.end`：更新 label（含耗时）。
- `message.update`：`asst.content += delta`。
- `message.end`：终值回填 content/reasoning/tool_calls；**bumpAgentById 打给事件所属 Agent**（不是当前激活 Agent——防串台写列表预览）+ recordActivity。
- `message.error`：分区 streaming 回落；**同步关闭所有流式占位**（空内容改"⚠️ (生成失败)"）；append 一条 `role:'error'` 消息（buildTurns 渲染为红色错误分隔符）。
- `toolcall.start`（LLM 开始生成参数）：assistant.toolCalls push `{preparing:true, running:true, label:'正在调用工具: X'}` + 同时 push 一条 `role:'tool'` 流式占位（**结果返回前即可渲染"正在调用"卡**）。
- `tool_execution.start`：**升级** toolcall 阶段的 preparing 占位为真实 `tool_call_id`+arguments（找到则原地改 id/label/arguments；找不到占位才新建）。
- `tool_execution.update`：优先**按 tool_call_id 精确匹配**占位追加 delta（并行工具时"最后一条流式 tool"可能是另一个调用）；同步写 assistant.toolCalls 对应项的 result。
- `tool_execution.end`：按 tool_call_id 关闭（`content=result, isStreaming=false`）；旧事件无 id 时回退位置匹配；toolCalls 对应项 `running=false, result=回填`。
- `step.end`：关闭最后的流式 assistant + 所有流式 tool；分区 `streaming=false`；interrupted 则走 onInterrupted；active 时 `scheduleDone`（**300ms 延迟**确认无残留流式才把全局 turnInProgress 置 false）。
- `interrupted`：所有流式 assistant 关闭（空内容改"⏸️ (已被中断)"）+ closeAllStreaming + streaming=false。
- `chat.end`：**兜底**——增量事件丢失时用携带的最终 content 补出回复（占位空则填入；无占位且无同内容消息则 push final）；关闭一切流式。
- `chat.virtual.receive`：Agent 主动发消息给 user → push 到发送方 Agent 的 direct 分区；**非当前活跃 Agent → `unread += 1`** + bumpAgentById。
- `chat.session.resume`：恢复活跃快照（详下）。

**关键不变量（注释里反复强调的坑，新前端照抄语义）**：
1. **全局 UI 信号门控 vs 分区状态无关**：turnInProgress/lastRunEndAt/archivePending 只由"当前查看会话的 Agent"（gatingAgentId）的事件更新；但分区的 streaming 标志/流式占位/收尾**必须与查看上下文无关地处理**——否则运行中途切换会话会让开/关事件失去配对，分区永久 streaming（头像光环不熄灭）。
2. **发送即置位**：sendMessage 乐观置 `分区.streaming=true`（不等 step.start）+ 30s 看门狗（到期无任何 isStreaming 占位仍标记 streaming → 判定事件链断裂，回落并提示"连接可能已中断"）。
3. **resume 快照合并**（chat.session.resume）：快照带 session id 时精确路由到该 single 分区；历史未到先挂起、由 history 首屏补合。合并三步去重：①userMessages 同内容已落盘则跳过；②已完成 steps 跳过前 min(已落盘 assistant 数, steps.length) 个（旧载荷"进行中步骤并入 steps 尾部"按镜像特征剔除）；③进行中部分**复用已有流式载体原地续流（长度取胜，不回卷直播已渗出的内容）**，绝不新建第二个占位；phase='tool' 时 toolCalls 只标记 running 防重复条目。
4. **历史合并竞态**：首屏整体替换前摘出仍在流式的尾部占位回填（否则占位被 wipe、后续 delta 静默丢弃）；stale 响应（requestId 与该目标最新发出的不一致）直接丢弃；`hasMore` 按**user 条数≥页大小**判定，offset 按 userCount 校准。
5. **重连清理**（ws.onConnect）：loading→ready（断线期间的 history.request 已作废）、streaming 分区关闭+closeAllStreaming。

**turns 派生分组规则**（utils/feed.ts `buildTurns`）：
- `role:'event'`（或 user+source.legacyRole='trigger'）与 `role:'error'` → **独立 system turn**（渲染为时间线分隔符，final.role 同名）。
- agent/user 消息按 sender 分组为一条 turn 链（同 sender 多条 message 合成一个 Turn 的多个 step）；**拆分条件**：换 sender、间隔 > `MERGE_GAP_MS`（10 分钟）、或"纯正文消息紧跟已完成正文轮"（plainAfterComplete——否则正文会被吞进上一轮思维链折叠栏）。
- 完全空白的流式占位（content/thinking/toolCalls 皆空）跳过，不产生空气泡。
- tool 消息按 `tool_call_id` 匹配回填所属 step 的 tool_calls result/label。
- final 沿用最后一条消息的原始 id（edit/regenerate/delete 按 id 定位 rawMessages）并继承 isStreaming（驱动 markdown 分块提交路径）与 files。

### 2.3 未读计数：计算与消费
- **唯一累增点**：feed 的 `chat.virtual.receive` 处理器——`vAgentId !== activeAgentId` 时 `dialog.unread += 1`（Agent 主动发来消息且用户不在该会话）。普通流式回复**不计未读**。
- **读取**：`feed.getUnreadCount(agentId)`（direct dialog 的 unread）；`feed.unreadAgents`（computed Set，有未读的 direct agentId 集）；chat store 两者均转发。
- **消费组件**：`AgentList.vue`——`unreadCountOf(id)`/`unreadLabel(id)`（>99 显示 "99+"）渲染徽标，**进入会话（点击/键盘选中）时 `chatStore.clearUnread(id)`**；`RunTracking.vue` 与 `RunTrackingPanel.vue` 在导航进对话时也调用 `clearUnread(other)`。`clearUnread` 只做 `dialog.unread = 0`。

### 2.4 theme.ts 主题切换机制
- state：`theme: 'light' | 'dark'`。初始：localStorage **`agentchat.theme`**（合法值直用）→ 否则 `matchMedia('(prefers-color-scheme: dark)')` 跟随系统。
- `toggleTheme()` 翻转；`watch(theme, immediate)` 做三件事：①写回 localStorage；②`document.documentElement.classList` **互斥 add/remove 'dark'/'light'**；③`window.dispatchEvent(new CustomEvent('theme-changed', {detail:{theme}}))`——**highlight.js 代码块主题据此事件切换**。App.vue setup 顶层 `useThemeStore()` 即完成首次应用。

### 2.5 websocket store 与 services/websocket.ts 的关系
- **store 是薄壳**：仅持有响应式 `connected` + 幂等创建一个 `WebSocketClient` 实例，转发 onMessage/onConnect/send。协议细节全部在 service。
- **service 是"preview 线协议适配器"**：类面保留 src 时代的 `connect/send/onMessage/onConnect/onDisconnect/disconnect/isConnected`，并新增 `rpc(method, params, requestId?)`。内部：
  - **出站翻译**（src send 词汇 → preview rpc/call）：`chat.send→conversation/deliver`（requestId 直通，30s 幂等去重）、`chat.interrupt→conversation/interrupt`、`chat.delete_message→session/delete-message`、`chat.interact.respond→interaction/reply`、`history.request→session/history`（全量回读+本地分页+合成 history.response）、`agent.list→agents/list`（合成 agent.list.response）、`agent.system_prompt/agent.tool_defs→同名 RPC`、`session.compress→session/archive`（成功合成 session.compressed）、`group.message→group/send`；**`chat.subscribe`/`system.restart` 静默降级**（preview 无对应面）；`chat.continue` 降级为投递"（请继续）"。
  - **入站合成**（preview 帧 → src 契约事件）：`loop/run-started→chat.start`、`loop/step-started→chat.step.start`、`loop/after-step→tool_execution.start + chat.message.end + chat.step.end`、`tool/after-execute→tool_execution.end`、`loop/after-run→chat.end|chat.interrupted`、`llm/delta(-start/-end)` 按 chunk 字段分流 `reasoning→thinking.* / delta→message.update / toolCalls→toolcall.start|update`、`llm/chat-error→chat.message.error`、`tool/progress→tool_execution.update（首片补 start）`、`router/reply-completed|group/message-posted→group.message`、`durable-interaction/opened→chat.interaction`、`archive/completed→session.archived`、`agents/updated→agent.profile.updated`、`plugin/*→plugin.catalog.changed`、`ws/ack→chat.send.ack(busy/deduped/parked)`、`rpc/result→rpcPending 应答`。
  - **dialogId 映射** `mkDialog`：conversationId≠agent → `group~cid~agent`（群过程流式不进 1v1）；sender='agent' → `chat~agent~a`；否则 `chat~user~a`——feed 的 isUserDialog 归属过滤依赖此键。
  - **连接质量**：重连退避（2s×1.5 上限 30s）、半开看门狗（90s 无入站主动断开重连，15s 检查）、待发积压队列（上限 100，丢最旧）、rpc 60s 超时。
  - **注意：模块级另有 `getPreviewClient()` 单例**（`core/preview/rpc.ts` 的 REST-ish RPC 端点层复用），与 store init 创建的实例**是两个实例、两条 /ws 连接**——新前端设计时应合并为单一连接。

---

## 3. types/index.ts 全部导出

基础契约（`MessageSource/PersistedMessage/ToolCall/PluginMeta`）re-export 自 `../compat/protocol`（@agentchat/protocol 单源）。

| 导出 | 说明 |
|---|---|
| `AgentInfo` | Agent 列表项：`id, name, description, avatar?, lastActivity?(ms,排序用), lastMessage?{role,content,timestamp,agent_id?}, hasActiveSession?(后台活跃), virtual?` |
| `TurnStep` | 思维链子步骤：一次 assistant thinking+其工具执行。**全字段**：`assistant: ChatMessage`（含 thinking+toolCalls）、`tools: ChatMessage[]`（按 tool_call_id 匹配）、`isStreaming: boolean` |
| `Turn` | 一个对话轮次（任意 sender 的思考+回复）。**全字段**：`agent_id: string`、`steps: TurnStep[]`、`final: ChatMessage \| null`（最终纯文本回复，无 toolCalls） |
| `DisplayItem` | ChatView 渲染单元。**全字段**：`type: 'turn'\|'time-separator'\|'event'\|'error'`、`message?`、`turn?`、`index: number`、`isStreaming?`、`timeText?`（分隔符时间文本）、`timestamp?`（event/error 自带毫秒时间戳）、`key?`（**稳定渲染 key（内容标识而非下标）**——历史前插时下标平移会导致全列表重建/展开态丢失） |
| `PluginMeta` | `SharedPluginMeta & { enabled: boolean; description: string }` |
| `LLMConfig` | `provider: 'openai'\|'deepseek'\|'glm'\|'ollama'`、`api_key`、`base_url?`、`model?`、`temperature?`、`max_tokens?`、`reasoning_effort?: 'low'\|'high'\|'max'`、`thinking?` |
| `AgentFullConfig` | Agent 完整配置：`agent_id, name, virtual?, tags?(base/dev/admin/conductor), allowedPaths?(路径穿透白名单), llm?: LLMConfig, plugins?: [{name?, tools?, runStart?, runEnd?, stepStart?, stepEnd?, toolExecutionStart?, toolExecutionEnd?, fallback?}], [key:string]: any` |
| `PersistedMessage` | `SharedPersistedMessage` + `_meta?: {timestamp, from, to, correlation_id?, message_id?}`（WS 实时包装的展示私有字段） |
| `ToolCall` | `= SharedToolCall`（工具调用，单源） |
| `ChatMessage` | **前端核心消息**。**全字段**：`id`、`role: 'agent'\|'user'\|'tool'\|'event'\|'error'`（注意：**用户消息也用 role='agent'+agent_id='user' 表达**）、`content`、`persistedMsgId?`（后端删除操作用）、`agent_id?`（sender）、`source?: MessageSource`（event 分隔符渲染）、`toolCalls?: ToolCall[]`、`toolName?`、`tool_call_id?`、`name?`、`arguments?: unknown`（结果前渲染专用卡片）、`thinking?`、`reasoning_content?`（thinking 别名）、`label?`（思考标签含耗时）、`isStreaming?`、`status?: 'running'\|'success'\|'error'`、`isError?`、`timestamp: number(ms)`、`files?: FileAttachment[]`、`_archived_context?` |
| `FileAttachment` | `hash, filename, filesize, text?` |
| `WSIncoming` | `{ type: string; data: any }` |
| `GroupInfo` | `group_id, name, participants[], created_at(number), description?, lastActivity?(前端 WS 驱动，与 Agent 统一排序)` |
| `GroupPersistedMessage` | REST 群历史消息：`role, content(string\|null), agent_id, name?, tool_calls?, tool_call_id?, reasoning_content?, label?, timestamp(string)` |

---

## 4. App.vue（布局 / 初始化 / 接线）

**布局**（`.app-layout` flex，100vh/100vw，三层 + 弹窗层）：
1. **移动端遮罩**：`sidebar-overlay`（v-if sidebarVisible，点击 closeSidebar，z-110；≤768px 时列表抽屉 z-120 置顶、收起时 pointer-events:none 防透明占位拦截图标栏）。
2. **Sidebar（活动栏）**：props `list-visible/list-panel`；事件 `open-list-panel/open-global-settings/open-agent-settings(VIEWER_ID)/open-token-usage/show-version`——全部转投 ui store。
3. **列表槽位**（v-if listVisible，宽 listWidth，右缘 ResizeHandle kind=list）：`ui.listPanel` 三选一 —— `AgentList`（props groups/activeGroupId；事件 select/deselect/create-group → groups store）、`SessionList`（事件 deselect-group）、`RunTrackingPanel`。
4. **主区 main-area**：`RunTracking`（v-if `trackingViewVisible && !pairView`，运行矩阵大画布）与 `chat-area`（**v-show 保活**——`!trackingViewVisible || pairView`，流式状态/草稿不因查看矩阵丢失）。chat-area 内：`PerspectiveHost`（视角容器，@group-deleted→groups.onGroupDeleted）→ 条件渲染工作区分屏（ResizeHandle kind=workspace + `WorkspaceTree`，宽 workspaceWidth，@preview-file→ui.openPreview）+ 悬浮 `workspace-rail` 把手（v-show !workspaceVisible，≤768px 隐藏）。
5. **弹窗层**：`FilePreviewModal`（preview 三字段）、`CreateGroupDialog`（v-if groups.showCreateGroup）、`SettingsPanel`（globalSettingsVisible + initialAgentId=settingsAgentTarget）、`TokenUsage`、`VersionDialog`。

**初始化顺序**：
- setup 顶层：`useThemeStore()`（watch immediate 应用主题）→ 实例化 groups/singles/ui/agents store。
- `watch([activeAgentId, activeGroupId, activeSingleId])`：任一**从空变非空**→ `ui.closeTrackingView()+ui.closePairView()`（矩阵让位回聊天；toggle 反选/同值重选不触发，导航组件各自显式关闭）。
- **视角注册 ×4（顺序即优先级）**：`pair`（最先，active=`!!ui.pairView`，组件 PairDialogView）→ `talk`（active=无 group 且无 single，DialogView）→ `group`（active=activeGroupId，DialogView）→ `single`（active=activeSingleId，DialogView）。后三者共享 DialogView 内核，仅 props 不同（group/single 传对应对象）。
- `provide`：`settingsAgentId`（ref(VIEWER_ID)，消息左右对齐基准）、`openAgentSettings(id)`、`toggleSidebar`、`closeSidebar`。
- `onMounted`：`useWebSocketStore().init()` → `groupsStore.init()` → `singlesStore.refresh().then(restoreLastSingle)`（独立会话历史由 DialogView 的 single watch 加载）→ `initUiExtensionHost()`（插件视角动态安装）。
- 注意：**chat/feed 的初始化（feed.init + WS 单一分发挂载 + HANDLERS 注册）发生在首次 `useChatStore()` 时**（组件树中 AgentList/DialogView 等引用即触发）；`requestAgents` 由 AgentList/SessionList/RunTracking(Pannel)/DialogView 挂载或刷新时调用。

---

## 5. utils 六件（用途 + 导出）

- **logger.ts**：与后端同接口的分级前端日志（`HH:mm:ss │ LVL │ [TAG] msg` 格式），级别由 URL 参数或 localStorage `LOG_LEVEL` 控制；导出 `logger{debug/info/warn/error}`。
- **format.ts**：展示格式化；导出 `formatFileSize(bytes)`、`formatRelativeTime(ts)`（今天/昨天/前天/N天前/日期）、`TIME_SEPARATOR_GAP_MS`（5 分钟）、`insertTimeSeparators(items)`（DisplayItem 列表插时间分隔符；event/error 自带 timestamp 时不重复插）。
- **starColor.ts**：Agent 星色系统——agent_id 稳定哈希派生 8 色 nebula/aurora 双主题色板，user 固定白金；导出 `hashAgentId`、`starColor(agentId, theme)`、`USER_STAR`、`ThemeMode('nebula'|'aurora')`。
- **feed.ts**：**统一信息流纯函数层**（§2.2 的派生核心）；导出 DialogId 四形态构造/解析（`directDialog/groupDialog/singleDialog/pairDialog/parseDialogId/groupIdOf/sessionIdOf`，格式 `direct:|group:|single:|pair:a|b`）、`mergeHistoryPage`（历史按 persistedMsgId 去重合并+userCount）、`buildTurnFromAgentMsgs`、`buildTurns`（raw→Turn[]，含 MERGE_GAP_MS=10min 与 plainAfterComplete 拆轮规则）、`buildTurnsIncremental`+`TurnsMemo`（签名比对增量复用）、`lastStreaming/closeAllStreaming`（流式占位链核心）、`groupMessageToChatMessage/pairMessageToChatMessage`（REST 历史转换）。
- **lastContext.ts**：上次会话上下文持久化（刷新恢复）；localStorage `agentchat.lastContext` 存 `{kind:'agent'|'group'|'single', id}`（最后写入者胜；旧键 agentchat.lastAgent/lastGroup 读取时自动迁移）；导出 `loadLastContext/saveLastContext/clearLastContextIf(kind)`（仅 kind 匹配才清，防跨类型误清）。
- **switchTrace.ts**：会话切换/历史加载全链路毫秒级 console 追踪（蓝色 `[switch]` 前缀，不受 LOG_LEVEL 影响；click→active-id→view-watch→req→resp→merge→loading(false)→dom-updated→load-more 链路定位卡顿段）；导出 `traceSwitch(evt, detail?)` 与 `histReqSentAt: Map<requestId, performance.now()>`（算历史往返耗时）。

---

### 给新前端的关键提示（浓缩版）
1. feed 的 per-dialog 分区 + rawMessages 单一真相源 + 纯函数派生 turns + 增量 memo 这套骨架值得原样沿用（大量修复注释都锚定在这套不变量上，见 §2.2 五条不变量）。
2. 全局 UI 信号（turnInProgress 等）与分区 streaming 的**门控分离**是最容易踩的坑，务必保留。
3. 两处双实例/双连接（ws store vs getPreviewClient）建议在新前端合并为单连接。
4. localStorage 键共 3 个：`agentchat.theme`、`agentchat.listPanel`、`agentchat.lastContext`（+ 旧迁移键）；html class 为 light/dark 互斥 + window 'theme-changed' 事件。
