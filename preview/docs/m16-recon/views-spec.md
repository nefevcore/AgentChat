# AgentChat 旧壳视图层浓缩规格（供原生重写对照）

基准目录 `preview/webui/src/`。核心公共契约先行，再按组件分组。

## 0. 公共契约（重写前必读）

**ToolResultData**（`composables/useToolResult.ts`，工具消息 content 为 JSON 时 parse 所得）：
```ts
{ status: 'success'|'error'|'warning'|'info'|'blocked'|'launched';
  title?: string; message?: string; data?: Record<string,unknown>; type?: string }
```
- parse 短路优化：内容 trimEnd 后尾字符非 `}`/`]` 直接返回 null（流式 JSON 未完整不 parse，避免 O(n²)）。
- `useToolResult(rawContent, toolName)` → `{ parsed, isJson, component }`；component 由注册表 `resolveToolResultView(toolName)` 解析。
- 工具名→组件映射（`core/registry/toolResultViews.ts`）：`bash`→Terminal；`read`→Code；`write`→Write；`edit`→Edit；`web_search`→Web；`browser`→Browser；`fetch_webpage|open_browser_page|navigate_page|read_page|click_element|type_in_page|screenshot_page|hover_element|drag_element|handle_dialog|run_playwright_code`（正则族）→Web；`subagent`→Subagent。未注册→null 按 `<pre>` 文本渲染。注册表带 version ref，支持插件动态注册/覆盖（精确名优先于正则族，同命中取高 priority）。

**useChatShell**（`composables/useChatShell.ts`，三视图共用的滚动外壳）：
- 入参 `{ container, onTopThreshold, signal: () => [消息总数, 流式尾部长度] }`。
- 行为：向上滚（scrollTop 减小 >1px）即置 `isUserScrolledUp=true` 暂停自动跟随；回到距底 80px 内恢复；`scrollTop<=50` 触发 onTopThreshold（历史加载）；signal 变化时 rAF 合并自动滚底（同帧多次流式更新只滚一次）；`scrollToBottom` 双重 rAF；`reset()` 会话切换必调（清闭包残留，防"不足一屏不触发 scroll 事件"死状态）；`scrollToBottomAndReset` 供回到底部按钮。

---

## 1. Sidebar.vue — 左侧活动栏（48px 图标条）
- **props**: `listVisible: boolean`；`listPanel: 'agents'|'sessions'|'tracking'`（高亮用）。
- **emits**: `openListPanel(panel)`、`openGlobalSettings`、`openAgentSettings`、`openTokenUsage`、`showVersion`。
- **store**: `agents`（getAgentAvatar/getAgentName + VIEWER_ID 显示当前用户头像）；`theme`（theme、toggleTheme）。
- **骨架**: `.sidebar`（宽 48px 纵向 flex）→ `.sidebar-avatar-btn`（头像，点击=openAgentSettings，hover scale1.1+主色描边）→ 三个 `.sidebar-btn`（agents/sessions/tracking，active 时左侧 2px 主色竖条 ::before）→ `.sidebar-spacer` → Token 用量 btn、主题切换 btn（亮/暗双 svg）、插件动作 v-for（`sortedSidebarActions` 扩展槽，底部）→ 全局设置 btn → `.more-wrapper`（更多 btn + `.more-dot` 红点=有更新）。更多菜单 Teleport to body（fixed 定位于按钮右上，mouseenter/leave 300ms 延迟关闭）：数据备份（busy 态+结果消息 5s 自动清，定时器防叠加）、检查更新（红点）。
- **交互细节**: 挂载时 fetchVersion（localStorage simulateUpdate=1 模拟）刷新 hasUpdate；外层样式 `.agentchat-more-menu/.agentchat-more-item` 是全局（非 scoped）。

## 2. ChatInput.vue — 输入区（重写重点）
- **props**: `disabled?`；`placeholder?`；`onSend?: (text)=>void`（提供则替代 store.sendMessage，群聊用）；`single?: SingleSession|null`（非空=独立会话，显示工作区/Agent/模型三个内联下拉）。
- **store**: `chat`（contextBusy、archivePending、sendMessage、interruptGeneration）；`agents`（agents、presets、defaultPreset、getAgentAvatar/getAgentName、activeAgentId）；`singles`（updateSession=PATCH 即时生效）；`workspaces`（workspaces、refresh、loaded）；`feed`（activeDialogId、getRaw）。
- **骨架**: `.chat-input`（圆角卡片，margin 0 10px 10px）→ ① `.file-preview-bar`（附件 chips：文件名+× 移除）→ ② `<InteractionBar/>`（决策弹窗触发器）→ ③ `<textarea rows=3>`（min-height 56px，resize:none，**固定 3 行不自适应增高**）→ ④ `.input-toolbar`：`.toolbar-left` 四个 `.dd` 下拉（single 时含工作区/Agent/模型 + 恒有思考强度），`.toolbar-right` 附件上传 icon-btn（uploading 时覆盖 spinner）+ `.send-btn`。
- **发送**: Enter 发送 / Shift+Enter 换行（keydown 拦截）。空文本且无附件时 send 禁用。默认路径：`store.contextBusy` 时先 `interruptGeneration()`（会话级精确打断，非全局）再发送——发送按钮变**橙色脉冲 `.interrupting`**（pulse-interrupt 动画），title="打断并发送"。发送参数：`{ deepThink: effort!==''，reasoningEffort: effort||undefined, files: attachedFiles }`。发送后清空文本+附件。
- **思考强度下拉**: `''|'low'|'high'|'max'`，默认 **high**；''=关闭思考（off 弱化色）。
- **独立会话三下拉**（单开互斥，document click 关闭，向上弹出 `.dd-menu`）：
  - 工作区：''=未分组；选择即 PATCH `updateSession(id,{workspaceId})`，失败回滚（仅当本地值未被新选择覆盖）。
  - Agent：默认预设（sparkles 图标）+ 其余预设（divider 分隔）+ 常规 Agent（排除 virtual）；**规则 1：会话已有消息（single.lastActivity 或 feed 分区非空）即锁定**（lock 图标，下拉禁开）。
  - 模型：''=默认模型 + fetchPools 条目（detail 显示池内 model）。
- **草稿清理**: watch single.id / feed.activeDialogId 变化 → 清空 inputText + attachedFiles（防 A 会话草稿串到 B，附件 hash 按 A 目录上传）。
- **附件**: 动态创建 `<input type=file multiple>`；循环上传前固定 `curAgent = activeAgentId`（防上传中途切 Agent 漂移目录）；uploadFile(FormData, agentId) → push `{hash, filename, filesize, text: data.path}`。
- **placeholder**: archivePending 时显示"当前 Agent 正在归档整理记忆，稍后处理您的回复…"。

## 3. InteractionBar.vue — ask_questions 决策弹窗
- **props**: 无（内嵌于 ChatInput）。**store**: `chat`（interaction、resolveContext、respondInteraction、dismissInteraction）。
- **骨架**: `v-if="interaction && visible"` → `.ib-trigger` 药丸（● + question 溢出省略 + ▾）→ 弹出 `.ib-menu`（绝对定位左上，min240/max340px）：`.ib-menu-header`（agent_id 徽章 + question）→ 选项 `.ib-item` 列表（点击即 `respondInteraction(opt)`）→ 末尾 `.ib-item-custom`（自定义输入 + "回复"按钮，Enter 提交）。
- **交互**: ① **会话归属门控**：interaction 是全局单槽，仅当 `it.agent_id === resolveContext()?.agentId`（或无 agent_id 旧载荷）才显示，防跨会话串台。② 新交互到达自动展开一次；③ timeout_ms 定时 dismiss（超时残留点了没反应）；④ document click 关闭菜单。

## 4. AgentList.vue — Agent+群混排列表（侧栏第一面板）
- **props**: `groups: GroupInfo[]`、`activeGroupId: string`。**emits**: `selectGroup(groupId)`、`createGroup`、`deselectGroup`。
- **store**: `chat`（getUnreadCount、clearUnread、loadHistory 间接）；`agents`（agents、activeAgentId、selectAgent、requestAgents、getAgentAvatar/getAgentName、hasActiveSession）；`singles`（deselectSingle）；`feed`（getDialog(directDialog(id))?.streaming = 忙闲指示）；`ui`（trackingViewVisible、pairView、closeTrackingView）；`websocket`（send chatSubscribe）；`theme`（星色 palette）。inject: `closeSidebar`。
- **骨架**: `.agent-list` → `.header`（`.search-box` 搜索 + `.add-btn` 新建菜单[新增 Agent/创建群组] + mobile-close）→ `.list-scroll` → `.list-item` v-for（`.item-avatar-wrap` StarAvatar 36px+running 光环+`.unread-badge`；群=九宫格头像 grid；`.item-info`=`.item-name`+`.item-last-msg`：agent 显示 lastMessage（user 前缀"你: "），群显示"N 个参与者"）→ 新增 Agent Modal（id/name/llm pool select，双击守卫 adding）。
- **核心结构**: **自由序混排**——agents+groups 合并为 UnifiedItem 按 lastActivity 降序浮顶（无分组标题）。**指针冻结**：列表容器 pointerdown 冻结行序快照、pointerup/leave/cancel 600ms 后解冻（防流式重排导致连点落错行/点击落空）。
- **selectAgent 细节**: deselectGroup+deselectSingle 互斥；覆盖层（tracking/pairView）打开时若已选中同 id 则强制再选中（selectAgent 是 toggle 会反选成空）；clearUnread；hasActiveSession 则 ws chatSubscribe；显式 `ui.closeTrackingView()`；closeSidebar；历史加载统一由 DialogView 的 activeAgentId watch 负责。
- **忙闲**: isAgentRunning=其 direct 对话 streaming→头像流转光环；**群头像无光环（设计决定**，Agent 是否发言由 send_group 决定，无法从事件流判断）。未读角标 >99 显"99+"。滚动条 hover 才浮现（.scroll-visible）。

## 5. SessionList.vue — 会话列表（工作区树）
- **emits**: `deselectGroup`。**store**: `agents`、`singles`（activeSingles、activeSingleId、selectSingle、create/createQuick、remove、titleOf、refresh、loaded）、`workspaces`（workspaces、create、rename、remove、refresh）、`feed`（getDialog(singleDialog(id))?.streaming）、`ui`、`theme`。
- **骨架**: `.session-list` → ① `.create-row` 整行虚线"新增"按钮（createQuick，双击守卫）→ ② `.ws-toolbar`（"工作区"文本 + folder-plus 新增工作区 + mobile-close）→ ③ `.tree-scroll`：`.ws-node` 工作区根（folder/folder-open 图标随折叠态；title=名称+路径；hover 显示 `.ws-act` 更多菜单[重命名/删除]+加号新建该工作区会话）→ `.ws-children .list-item` 会话叶（StarAvatar 15px+running 光环、标题、hover 浮现删除按钮，padding-left 28px 缩进）。
- **树模型**: 工作区根按名称排（空工作区也显示）；未挂靠会话归"未分组"固定根（排末尾，仅有会话才出现）；默认全展开，collapsed Set 记忆折叠。会话项按 lastActivity 降序。
- **弹窗**: 删除会话确认（硬删不可恢复）；新增工作区（browseFolder 原生选夹 + 路径手输兜底 + 名称缺省文件夹名 + picking 提示）；重命名；删除工作区（会话移入未分组）。selectSingle：清 agent/group 选中 + closeTrackingView + closeSidebar。

## 6. PairDialogView.vue — Agent↔Agent 只读视角
- **props**: `{ a: string; b: string }`（两端点 id）。inject `settingsAgentId`（=viewer→全部左气泡）。
- **store**: `agents`、`ui`（closePairView、openPreview）、`feed`（getRaw/getDialog/getTurns/loadPairHistory/loadOlderPairHistory，分区 id=`pair:a|b`）。
- **骨架**: `.chat-view` → `.chat-header`（返回 btn→ui.closePairView + 双头像×标题+"只读·双方视角"）→ `.messages-wrapper>.messages-container(@scroll=shell.onScroll)>.messages-content`：空态 / `.history-loading` spinner / turnDisplayItems（time/event/error 分隔 + `TurnDisplayItem :show-actions="false"`）→ 回到底部悬浮 btn。**与 DialogView 完全同一套类名与管线**。
- **交互**: watch [a,b] immediate → shell.reset + loadPairHistory + 滚底（onCleanup 取消守卫防快速切格）；上翻 loadOlder（前插后 scrollTop=scrollHeight-prevHeight 保持位置）。

## 7. RunTracking.vue — 运行矩阵（主区大画布）
- **props**: 无。**store**: `runs`（snapshot、loading、now、ensurePolling、loadError）、`agents`、`groups`（selectGroup、deselectGroup、init）、`singles`（deselectSingle）、`ui`（openPairView/closeTrackingView）、`chat`（clearUnread、loadHistory）、`websocket`（chatSubscribe）。
- **骨架**: `.run-page` → `.page-header`（标题 + `.range-toggle` 日期范围 1h/1天/3天/1周/1月/全部 + 快照时间）→ `.matrix-scroll>.matrix-wrap` → `.matrix-grid`（CSS grid `190px repeat(N,40px)`，gap5；`.corner`+`.col-head`（sticky 顶，头像）+每行 `.row-head`（sticky 左，头像+名）+`.cell`）→ `.legend` + 覆盖面分析折叠区 → Teleport tooltip `.mx-tip`。
- **数据**: 轴=snapshot.members（排除 preset，按 kind 排序 agent/virtual/group/system/unknown）；cellKey=两端点排序 join('|')；运行中 run（chat/group 的 convKey 拆~）映射到格子。**浓度**=范围内消息量 v 封顶 RANGE_CAP（h1:30…all:3000）后 log(1+v)/log(1+CAP) 分 5 档 c1–c5；运行格 heat-live 最深+SVG 旋转光环（transform 合成器动画）；群参与证据格浅绿 heat-evidence；对角线虚线框；上三角=镜像（无数据斜纹不可点、有数据弱化可点进同一会话）。
- **hover 十字**: hover 只存 {ri,ci}（防全量重算）；十字底色带=两层绝对定位 div 铺 gap（不触碰格子颜色）；mousemove rAF 合并 tooltip 坐标；十字外格子 opacity 置灰（不用 filter）。tooltip：两端点、关系（自会话/群参与/1v1）、范围内/总消息数+bytes、相对时间、周归档证据、运行条目（source 中文映射+时长+summary）。
- **点击格子 openCell**: 群格→selectGroup；viewer 参与 pair→selectAgent+clearUnread+loadHistory+chatSubscribe（矩阵入口必须显式加载历史，否则空白）；其余→ui.openPairView（不关矩阵，返回回矩阵）。

## 8. RunTrackingPanel.vue — 侧栏第三面板（运行树）
- **props**: 无。inject closeSidebar。**store**: `runs`（snapshot/now/ensurePolling/loadError）、`ui`（trackingViewVisible、openTrackingView/closeTrackingView）、`agents`、`groups`、`singles`、`chat`、`websocket`、`theme`。
- **骨架**（对齐 SessionList 树形态）: `.runs-panel` → `.panel-toolbar`（"运行跟踪"文本）→ `.tree-scroll`：① `.tree-node.action` 运行总览（点击 toggleMatrix 开关主区矩阵，active 态主色；badge=运行数）② 运行中节点（badge）→ `.tree-leaf.run` v-for（StarAvatar 15px running 光环、sessionTitle（自会话/X↔Y/@群/single 标题）、`fmtDuration(now-startedAt)` 时长、hover 浮现 `.leaf-stop` 中断按钮→`interruptRun(convKey)` API）③ 活跃子Agent 节点→叶（父头像+名·父名+时长，title=task）。
- **jumpTo**: 可跳转目标=single/group/viewer 参与的 agent（Agent↔Agent 运行仅展示）；agent 分支补齐导航仪式（clearUnread+loadHistory+chatSubscribe）；显式 closeTrackingView+closeSidebar。

## 9. TokenUsage.vue — Token 用量统计弹窗（Modal 1120px）
- **props**: `visible: boolean`；**emits**: `close`。**store**: `agents`（getAgentName）、`theme`。数据自取 `fetchUsageTokens`（chart.js+d3-chord）。
- **骨架**: Modal → 左 `.usage-side`（统计范围 select 近7/30/90/全部/自定义（date×2+应用按钮，dirty 提示"未应用"）、缓存命中/总输入进度条摘要+总输出/总步数/请求数、竖向 tab 总览/用量统计）→ 右 `.usage-main`：cloud tab（弦图 SVG 660×660：外环弧段∝协作流量、弦=1v1 用量渐变、占比<2% 并"其他"、径向文字标签、悬停联动高亮+自定义 tooltip、includeUserSelf 复选框、群聊流量始终排除）或 daily tab（Chart.js 按日堆叠柱状图，统计方式切换 缓存/模型（top7 模型其余并"其他"）、柱顶圆角、external HTML tooltip）。
- **交互**: 打开即加载+30s 自动刷新（关闭清定时器）；loadSeq 序号守卫防旧响应回退；切 tab/主题/数据变化重绘；空数据先销毁旧图防新旧同屏；弦图 hover 事件委托（innerHTML 重建后监听仍有效）。

## 10. CreateGroupDialog.vue — 创建群组弹窗
- **emits**: `close`、`created(groupId)`。数据自取 fetchAgents（排除 viewer；loadError 显式展示）+ apiCreateGroup。
- **骨架**: Modal 420px → 表单（群组 ID 可选/名称必填/描述可选）→ 参与者多选列表（`.participant-item` label+隐藏 checkbox：自绘圆形勾选图标、头像、名称+id 两行；selected 主色淡底）→ 已选计数徽章 → footer 取消/创建（loading 态）。校验：名称空/未选参与者→error 文案。

## 11. UserMessage.vue — 用户气泡（右）
- **props**: `message: ChatMessage`；`index`；`senderAvatar?`；`senderName?`；`showContinueBtn?`。**emits**: `edit(msgId, newContent)`、`continueGeneration`、`previewFile(filePath)`。
- **骨架**: `.message-item.message-user`→`.user-message`（flex-end）→ `.user-msg-body`（order:-1）：`.user-bubble`（附件 chips 行（点击 previewFile）+ `.user-text` 纯文本 pre-wrap）→ `.user-btn-row`（`showContinueBtn` 时左侧"继续生成"双箭头按钮 hover 显形；复制按钮（copied 态 2s 绿勾）；编辑按钮）→ 右侧 `.msg-avatar`（32px）。
- **交互**: 行内编辑模式（textarea rows=2，Enter 确认/Esc 取消/Shift+Enter 换行；内容不变不 emit）；复制 navigator.clipboard+2s 状态复位。

## 12. AssistantMessage.vue — AI 消息（左，重写重点）
- **props**: `message: ChatMessage`；`index`；`isStreaming?`；`showCopy?=true`；`showActions?=true`（群聊 false 隐藏重试/删除）；`compact?`（思维链内不加 padding）；`senderAvatar?`；`senderName?`。**emits**: `downloadFile`、`previewFile(filePath)`、`regenerate`、`deleteMessage`。
- **composable**: `useMarkdown`（render=markdown-it+hljs；renderPlain=纯文本）+ `useChunkedMarkdown`×2（**分块渲染核心性能设计**：内容切"已提交前缀（HTML 缓存，仅在安全边界=代码围栏外空行时增长）+待提交尾部（转义纯文本 `.streaming-pending` 追加）"，每帧成本≈增量；流式结束 flush 全量渲染保证最终一致）。
- **turn 渲染结构**: `.message-item.message-assistant` → `.assistant-row`：左 `.msg-avatar`（32px）+ 右 `.assistant-col`：① `.sender-name`（12px 次要色）→ ② 思考区 `.think-content-section`（`v-if=hasThinking`）：`.think-content-label`（ThoughtIcon+thinkingLabel+流式红点组+chevron 旋转 90°）点击 toggle；`.think-content-body`（12px、左侧 1px 竖线缩进、renderPlain 渲染 reasoning/thinking）→ ③ 正文 `.assistant-bubble`（markdown v-html + pending 尾部；isError 时红色描边底 error-message 样式）→ ④ `.copy-btn-row`：复制全文（2s 状态）、`showActions` 时重新推理/删除（流式中 disabled）。
- **思考折叠**: `showThinking` 默认 **true（展开）**；流式中强制展开，结束保留用户选择。thinkingLabel：优先后端 message.label（含耗时），否则本地计时器"已思考（用时 N 秒）"（500ms interval，流式起止管理）。
- **typing indicator**: `isStreaming && 无正文` 时第二行 `.assistant-row` 渲染 `<TypingIndicator/>`（三跳动圆点）。
- **事件委托**: messageRoot click → 代码块"复制"按钮（.md-code-block-btn，2s 已复制态）+ `.file-path-link/.file-tag`（data-filePath→emit previewFile）。

## 13. ToolMessage.vue — 工具卡（折叠容器）
- **props**: `message: ChatMessage`（toolName/name/content/arguments/status/isStreaming/isError）、`index`。**emits**: 无。**composable**: `useToolResult`（注意 content 必须用 computed 引用而非 toRef——流式派生 turn 每次重建 message 对象）。
- **骨架**: `.message-tool` → `.tool-label`（齿轮 icon+displayName+状态：running=黄点组动画/`OK` 绿/`ERR` 红/`BLK` 橙+chevron）点击展开 → `.tool-body`（左竖线缩进 14px）：JSON 时按 status 分支——error→`.tool-json-error` 文案（bash/browser 例外仍渲染组件）；warning/blocked→对应文案；其余→可选 `.tool-json-title` + 专用组件 `<component :data :loading="false" :tool-name>`；无组件→`<pre>` 原文。**结果未返回（调用中/流式）但已知工具**：立即用参数预览渲染专用卡片（loading=isRunning，参数铺开成 data，流式原文喂 output→bash 终端实时显示）。
- **交互**: ① running 时**自动展开**（watch isRunning→isExpanded=true）；② isWriteTool（name==='write'&&parsed.data.path）时点击标签=展开+调用子组件 `open()`（defineExpose）直接弹文件内容 Modal；③ 状态徽标从 parsed.status/error 双源推导。

## 14. TurnDisplayItem.vue — 统一轮次容器（重写重点）
- **props**: `turn: Turn`；`index`；`settingsAgentId: string`（对齐基准：等于它的 agent 右侧气泡，其余左侧）；`showActions?`。**emits**: `regenerate(msgId)`、`deleteMessage(msgId)`、`edit(msgId, content)`、`continueGeneration`、`previewFile({filePath, agentId})`。
- **store**: `chat`（turnInProgress）、`agents`（getAgentAvatar/getAgentName；头像 fallback=`/api/agents/:id/avatar`）。注册表 `messageViews`：resolveMessageView(turn, final)→'user'/'assistant'/插件视图 id；插件 renderer 优先（`<component :is :turn :final>`）。
- **结构**: `.turn-item`（max-width **70%**；turn-left/turn-right 对齐）：
  - **纯文本轮**（无思维链）：final 为 user→`.turn-bubble-right>UserMessage`；否则→`.turn-bubble-left>AssistantMessage`（finalIsStreaming=无链时 final 承载流式）。
  - **含折叠栏轮**（hasChain=任一 step 有 thinking 或 tools）：`.turn-chain-row`：左头像+右 `.turn-chain-col`（`.turn-sender-name` → `.chain-header`（ThinkingIcon+chainLabel=`思考过程（共 N 步，共用时 M 秒）`+运行黄点组+chevron）→ `v-show=isExpanded .chain-body`：每 step（key=assistant.id 稳定键防重挂载丢展开态）渲染 [思维链 AssistantMessage（content 清空只显 thinking，compact）+ v-for ToolMessage + step 正文（若≠final 内容）] → 底部 final 气泡 AssistantMessage）。
- **交互**: 流式中强制展开（避免展开↔折叠闪烁）；**会话整体结束（turnInProgress→false）一次性折叠所有本次经历流式的 turn**（wasStreaming 标记，不影响历史轮与手动展开）；`.chain-header.expanded` 时 **sticky 吸附消息区顶部**（top=负容器 padding，滚动途中可快速折叠）；canRegenerate=非 system 轮且非流式（供 final 气泡重试/删除）；chainLabel 耗时=首尾 step 时间戳差，为 0 时从各 label"用时 N 秒"累加。

## 15. ScrollableViewport.vue / TypingIndicator.vue
- **ScrollableViewport**: props `{ maxHeight?: string }`（默认 '60vh'）；`.scrollable-viewport{overflow-y:auto}` 包 slot——工具卡内容限高滚动（Terminal 命令 260px/输出 40vh/stderr 30vh、Code/Edit 默认 60vh）。
- **TypingIndicator**: 无 props；`.typing-indicator` 三个 8px 圆点 `typing` 上下弹跳动画（delay 0/0.2/0.4s），fit-content 宽圆角气泡。

## 16. ToolResult 七组件 props 契约（统一 `{ data: Record<string,unknown>; loading?: boolean }`，Code/Edit 另有 `toolName?`）
- **Terminal（bash）**: 读 `command, cwd, exit_code, stdout|output, stderr, message, guidance, truncated, timed_out`。命令块（banner"终端命令"+cwd，`$ `+深底代码，max260px）→ loading 无输出时"正在执行..."点组 → message：无输出=红色错误/有输出=黄色引导 → stdout 块（banner"终端输出"+含 stderr 或 exit N 徽标，max40vh）→ stderr 独立块（红字，max30vh）→ 截断/超时橙字警告。isError=exit_code≠0。
- **Code（read/skill_read）**: `type==='directory'` 时目录清单（items:[{name,type}]，"N 项/N 目录/N 文件"徽标，文件夹金色+尾斜杠）；否则文件卡：头部（文件名+语言徽标+meta 徽标（size/total_lines/L起-止/version/author）+复制按钮）→ loading 点组（有参数无内容时"正在读取..."）→ ScrollableViewport 代码区（**动态围栏**：内容含``` 时加长 fence 防 .md 内嵌截断；skill_read 直接 markdown 渲染）→ 截断黄条"仅显示前 X（原始 Y）"。
- **Write（write）**: 渲染为**行内链接** `.write-link`（文件名，点击 open()→Modal 1000px：头部（完整路径+语言徽标+字符数+复制+关闭）→ browseReadFile(path) 拉内容渲染高亮代码；失败可重试；`defineExpose({open})` 供 ToolMessage 标签点击联动）。
- **Edit（edit）**: 头部（铅笔 icon+文件名+`N 处替换（含 M 处模糊匹配）`+first_changed_line 徽标+复制 diff）→ ScrollableViewport diff 区：行前缀分色（`- `红删/`+ `绿加/`...`斜体分隔/两空格灰上下文；无标记时纯文本 pre）；loading 时"正在应用编辑..."；路径兼容 path/file/file_path/filePath。
- **Web（web_search 及浏览器族）**: 双模式——isSearch（results 数组）：搜索头（"搜索 query"+耗时/条数/积分）→ 可选"📝 AI 摘要"卡 → 结果卡列表（标题 a[target=_blank]、url、content 默认 max80px 超 200 字可展开、相关性 score）；isFetch（url/text）：链接行（去协议截 60 字符）+ size/类型/已截断标签 → 文本 pre max200px"展开全文"；text_extracted===false→"无法提取文本"。**safeUrl：仅放行 http(s)，其余替换 '#'（XSS 防御）**。
- **Subagent（subagent）**: 按 data 结构推断 kind——`subagents/active_count`→list（"N 活跃"+行式列表：状态徽章/id/task/耗时）；`result|error`→await（状态徽章+⏱耗时+result 卡片或 ❌error 或"仍在运行中…"）；message 含"已终止/已回收"→kill；否则 spawn（"子 Agent 已创建"+ID code 徽章）。状态徽章映射 running 黄/done 绿/error 红/timeout 橙/killed 灰（前置圆点）。
- **Browser（browser）**: isBatch=`results[0].action` 存在——批量头（`N 步 ✓x ✗y 第 N 步失败`）+错误条+步骤行（action 徽章 emoji+中文（open/click/type/press/content/screenshot/html/eval/close 各配色）、`#step.repeat`、✓/✗、摘要（按 action 取参/果）、content/eval 可展开详情）；单动作按优先级：screenshot（relPath/file→"预览截图"按钮懒加载 fetchWorkspaceFile base64→img max320px hover 放大）/page（url 链接+title+text pre max200px 展开）/eval（result pre）/html（html_length 字符）/ok（✓ 完成）。同样 safeUrl 只放行 http(s)。

## 17. DialogView.vue — 统一会话视图（direct+group+single 单内核，886 行）
- **props**: `group: GroupInfo|null`；`single?: SingleSession|null`。**emits**: `groupDeleted(groupId)`。inject: `toggleSidebar`、`settingsAgentId`、`openAgentSettings`。
- **store**: `chat`（loadHistory/loadMoreHistory/hasMoreHistory/loadingHistory、sendMessage、regenerateMessage、deleteMessage、editMessage、continueGeneration、compressSession、compressPending/compressFeedback、busyFeedback、turnInProgress、lastRunEndAt、toolDefs 系列、systemPrompt 系列、copyFeedback）、`agents`、`singles`（archive）、`websocket`（connected、send groupMessage、onMessage groupDelivered）、`feed`、`ui`。
- **turn/step 组织（feed 切片）**: `dialogId` = single→`single~id` / group→`group~id` / direct→`chat~viewer~agent`。`feed.getTurns(dialogId)` 返回 Turn[]（每 turn={agent_id, steps:[{assistant, tools[]}], final}）；映射为 DisplayItem 流：final.role==='event'（非 viewer）→`event` 分隔条（label=content||source.summary）；role==='error'→`error` 红分隔条；否则→`turn` 项。**稳定 key**=`turn-${agent_id}-${ts}-${final.content.length}-${steps.length}`（下标前插平移会导致整列重建丢展开态）。再经 `insertTimeSeparators` 按时间插入日期分隔。
- **头部 actions**（按模式）: direct 专属——Token 仪表盘（`.session-token-gauge`：色阶进度条 low绿/moderate黄/high橙/critical红+百分比；fetchSessionTokens，切 agent 竞态守卫+run 结束刷新）、归档按钮（compressPending spinner；feedback 淡入）、System Prompt 预览（Modal 700px：loading/error/pre 内容+字符数+刷新/复制）、Agent 配置（isPreset 不显示）；direct/single——更多菜单（工具定义预览 XML Modal / 归档独立会话|删除 Agent）；group——参与者数+信息抽屉按钮。断连横幅 `[WARN] 连接已断开，正在重连...`。
- **消息区**: 空态 gate（loadingHistory 时显 spinner 占位而非"开始对话"防误导）；`.history-loading` 顶部 spinner；turnDisplayItems 循环（time/event/error 分隔+TurnDisplayItem `:show-actions="!isGroup"`，regen/delete/edit/continue 全接 chatStore）；回到底部悬浮按钮（isUserScrolledUp）。
- **输入**: group→`<ChatInput :disabled=groupTurnInProgress :on-send=sendGroupMessage>`（WS groupMessage 发送，groupDelivered/error 事件解锁+10s 兜底定时器）；否则→`<ChatInput :single>`。
- **历史加载**: direct triggerLoadMore（记 prevScrollHeight，await loadingHistory（8s 超时兜底）后补偿 scrollTop；**身份守卫**：await 期间切会话不补偿；内容不足一屏且有更多→自动续拉）；group→loadOlderGroupHistory（feed 前插+保持位置）；顶部阈值由 shell.onScroll 触发。首屏滚底/续拉保持位置由 isInitialHistoryLoad 区分。
- **会话切换仪式**: watch dialogId→shell.reset()+scrollToBottom（防滚动状态跨会话残留）；watch activeAgentId（direct）→统一 loadHistory（**历史加载唯一入口**，其他调用方都删了）；watch single.id 同理；watch group.group_id→loadGroupHistory（onCleanup 取消守卫）。
- **删除确认 Modal**: 三态文案（group=删群/single=归档/agent=永久删除含凭据）。

## 18. GroupDrawer.vue — 群信息抽屉（280px 右侧）
- **props**: `group: GroupInfo`；`visible: boolean`。**emits**: `close`、`deleteGroup(groupId)`。**store**: `agents`（成员头像名）、`groups`（fetchGroups）。
- **骨架**: `.drawer-panel` → 成员区（搜索框+4 列头像网格 `.drawer-member-item`（40px 圆头像+viewer 显"我"角标））→ 群聊名称行（input+保存按钮（未改禁用/saved 绿态 2s），Enter 提交；updateGroup 后本地回写+fetchGroups）→ 群聊简介 textarea → 底部红色"删除群组"。打开/切群时初始化编辑字段（watch visible+group_id immediate）。

## 19. layout/PerspectiveHost.vue、ResizeHandle.vue
- **PerspectiveHost**: 无 props；emits `groupDeleted`；读 `core/registry/perspectives` 的 activePerspective+perspectiveVersion（响应式依赖），动态 `<component :is v-bind=props()>`——主区唯一容器，视角=注册项。
- **ResizeHandle**: props `{ kind: 'list'|'workspace' }`；mousedown→`ui.startResize(kind, e)`（拖拽逻辑集中 stores/ui，resizing 态驱动 active 主色）；3px 宽 col-resize 透明条，hover/active 显主色。

## 20. 一句话组
- **VersionDialog.vue**: props `{visible}`+emit close 的版本信息弹窗——fetchVersion（+changelog markdown 渲染）、current/latest 对比、hasUpdate 时"立即更新"按钮（runVersionUpdate 成功后 2s 自动 reload 页面），Transition overlay+panel 自绘（非 ui/Modal）。
- **WorkspaceTree.vue**: 工作区目录树面板（fetchWorkspaceTree 懒加载子目录、per-path in-flight 守卫、根级错误才替换整树/子目录失败行内占位、文件点击 emit previewFile、emit close）。
- **WorkspaceTreeNode.vue**: 递归树节点（自 import 自引用；TreeNode{name,type:'dir'|'file'|'more',size,children}；本地 isOpen 折叠、展开时 emit toggle 懒加载、按扩展名映射 lucide 图标+配色，activePath 高亮）。
- **chat/FilePreviewModal.vue**: 工作区文件预览弹窗（props `{visible, filePath, fallbackAgentId}`；fetchWorkspaceFile 按 ext 分模式渲染 markdown/hljs 代码/图片(base64)/HTML/文本，404 时 fallback `files/<agentId>/` 前缀重试，emit close）。

## 21. settings 组
- **SettingsPanel.vue**（读前 300 行）: props `{visible, initialAgentId?}`+emit close；useSettings 全家桶；左侧树（Agent 设置/模型管理/搜索引擎/扩展与工具/插件库/定时任务+插件动态 settings-tab:global 叶子）右侧内容；selectedNode 导航；定时任务编辑（HH:mm 校验、`__archive_all__/__backup_all__` 系统任务特判 builtin 保护不可删）；saveAll 按 dirty 分支保存+分级成功提示（"下次运行生效"）；未保存关闭走 ConfirmDialog；重启后端（30s 兜底解锁 restarting）；visible watch 时 loadMeta/loadGlobal、initialAgentId 定位 AgentPane，关闭时 resetAgent 防放弃编辑复活。
- **AgentPane.vue**（读前 200 行）: Agent 配置巨型表单组件，props 约 20 个（agentId/agents/raw/effective/sys/agent prompt 内容与开关/timers/assembly/plugins/permissions/各 schema/pools/globalConfig/saving），emits 全 v-model:update:* + switch/back/saveTimers；tabs（基本信息/模型/定时任务/扩展与工具+插件 settings-tab:agent）；切 Agent 重置 tab 与模型本地派生态（防 A 的池/模型列表串到 B）；模型区=池选择+基础字段+分组（推理/采样/边界，隐藏 logprobs/top_logprobs/tool_choice）+从 API 拉模型列表（后端代理带凭据）；装配三字段（presets/tools{include,exclude}/hooks）patch 到 raw，旧 plugins 契约只读展示。
- **useSettings.ts**（读前 150 行）: 设置核心状态 composable（非 Pinia）——展示 effective/编辑 raw/dirty=保存快照比对；元数据（llmSchemas/searchSchemas/nsSchemas/pools/agents）；globalConfig+agentRaw/agentEffective+sys/agent prompt+timers；插件域三块（agentAssembly/pluginCatalog/pluginLibrary/pluginPermissions/sessionPlugins）；assemblyOf 兼容旧盘（disabledTools 并入 exclude、disabledHooks 剔除）；保存统一走 settings/api.ts，装配走 PUT /api/plugins/assembly/:agentId。

## 22. 重写时的关键提醒（跨组件）
1. **历史加载唯一入口**在 DialogView 的 activeAgentId/single.id/group_id watch——所有列表/矩阵/面板导航入口只切选中态+清未读+（必要时）chatSubscribe，不各自 loadHistory。
2. **选中互斥三元组**（agent / group / single）+ 同值重选需显式 closeTrackingView（App 的 watch 只认非空变化）。
3. 稳定 key 策略（turn/step/tool 三层）是展开态/卡片状态不丢的关键。
4. 流式性能三件套：useChunkedMarkdown 分块渲染、parseToolResult 尾字符短路、useChatShell rAF 合并滚底。
