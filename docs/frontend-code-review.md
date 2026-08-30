# WebUI 前端代码整理报告（2026-02）

> 背景：前端经多轮迭代后出现「难以稳定复现」的不稳定现象（偶发卡死、状态残留、
> 列表错乱、数据不刷新、重复渲染等）。本次对 `src/ui/webui/src` 全量重读分析
> （约 60 文件 / 300KB），定位并修复了一批有实锤证据的缺陷，删除死代码，补回归测试。
> 六轮批次：A–L 十二个症状族，~81 项缺陷。第七轮 M 批次（工具卡片域）后合计 ~88 项。
>
> 验证：`pnpm --filter @agentchat/webui typecheck` ✅ · `vitest run src/ui/webui/tests/` 40/40 ✅ · `vite build` ✅

## 一、架构现状速写

```
main.ts → App.vue（视角注册：pair/talk/group/single 共享 DialogView 内核）
  ├─ stores/feed.ts     统一信息流（per-dialog rawMessages + buildTurns 派生 turns）★核心
  ├─ stores/chat.ts     业务动作（发送/重生成/编辑）+ 非消息状态（委托 feed）
  ├─ stores/{agents,groups,singles,runs,ui,theme,workspaces,websocket}
  ├─ services/websocket.ts  WS 客户端（自研重连 + 待发队列）
  ├─ core/events/contract.ts  WS 事件契约（单一来源）
  ├─ core/registry/*     事件/视角/消息视图注册表（单一分发点）
  ├─ core/extensions/*   插件宿主（bridge/isolated iframe/p5.5 沙箱策略）
  └─ settings/*          设置面板域（schema 驱动）
```

核心设计（健康，保留）：feed 单一真相源 + 纯函数派生 turns（增量 memo）+
WS 单一分发 + 视角注册表。本次问题集中在**并发时序**与**生命周期对称性**，不在架构。

## 二、已修复缺陷（按症状族分组）

### A. 偶发卡死 / 越用越卡

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| A1 | `stores/groups.ts:init()` | 无幂等守卫；RunTracking/Panel 每次点不在列表的群就叠加 5 个 WS 处理器 → 每个群事件触发 N 次 fetchGroups（处理器只增不减，刷新才清） | `initialized` 守卫；二次调用仅刷新列表 |
| A2 | `DialogView.vue:waitForHistoryLoaded` | 无超时：WS 断线时在途 history.request 永无响应 → `isLoadingMore` 永久 true 堵死一切后续分页（顶部 spinner 不消失） | 8s 超时兜底 + 会话身份守卫（切换后不按新会话内容做滚动补偿） |
| A3 | `stores/feed.ts` 分区 status | 断线重连后 `status:'loading'` 永久残留（同 A2 根因的 store 侧） | `init()` 注册 `onConnect`：重连时清理卡死分区 |
| A4 | `RunTracking.vue` hover | 每次 mousemove 替换 `hover` 对象引用 → N² 格子的 class 绑定每帧全量重算（400+ 格矩阵滑动掉帧） | tooltip 坐标拆独立 `tipPos` ref；hover 只存格子身份 |
| A5 | `stores/runs.ts` | 3s 轮询无 in-flight 防护：慢响应乱序完成把新快照回滚成旧快照（数据"回跳"） | in-flight 标志 |

### B. 状态残留 / 串台

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| B1 | `useChatShell.ts` | `isUserScrolledUp/lastScrollTop` 跨会话残留（三视角复用同一实例）；新会话不足一屏时 scroll 事件不触发，残留标志停掉自动滚底 + 悬浮"回到底部"。旧 ChatView 有重置逻辑，迁移时丢失 | 暴露 `reset()`；DialogView/PairDialogView 切换时调用 |
| B2 | `settings/useSettings.ts:loadAgent` | 无竞态守卫：快速切 Agent 时 A 的晚到响应覆盖 B 的数据 | 请求序号（agentLoadSeq）丢弃过期响应；loadAssembly/refreshAssembly 同守卫 |
| B3 | `settings/useSettings.ts:saveAgent` | 跨 await 重读 `agentId.value`：保存中切换会把 A 的配置 POST 给 B（数据损坏级） | 进入即快照身份与数据（targetId/rawSnapshot/…），回写前校验未切走 |
| B4 | `settings/useSettings.ts:refreshAssembly` | WS 热重载事件无条件前移 `agentAssemblySaved` 基线 → 未保存编辑被标记"已保存"（静默丢失） | 有装配编辑时只更新视图不前移基线 |
| B5 | SettingsPanel 面板关闭 | 不重置编辑态："已放弃"的编辑在重开同一 Agent 时复活（同 id 不重载）且可被误保存 | 关闭时 `resetAgent()`（同时作废在途请求） |
| B6 | `ChatInput.vue` | 草稿/附件跨会话残留；上传循环中 `activeAgentId` 漂移（await 期间切 Agent → 后续文件传错目录） | 会话切换清空草稿/附件；上传目标循环前固定 |
| B7 | `InteractionBar.vue` | ask_questions 全局单槽：A 会话的决策弹窗在 B 会话照常弹出（作答发到 A 流程但用户以为在回答 B） | 按当前上下文 Agent 门控显示 |
| B8 | `DialogView.vue` Token 仪表盘 | A 的迟到响应覆盖 B 的数据 | 请求序号守卫 |
| B9 | `stores/feed.ts:bumpAgent 误用` | `bumpAgent(role,content)` 固定打给"当前激活 Agent"——后台 Agent 流式完成时把别人的回复写进激活项的列表预览/排序 | 两处改 `bumpAgentById(事件所属 agent)` |
| B10 | `FilePreviewModal.vue` | 快速连点两个文件：A 的慢响应后到覆盖 B 的内容（标题 B 正文 A） | 请求序号 + 关闭时作废在途 |
| B11 | `TokenUsage.vue:loadData` | 无请求序列守卫：快速切范围时旧响应最后落地（数据与所选范围不符） | 请求序号 |
| B12 | `settings/loadPluginCatalog` | WS 事件风暴时并发请求乱序覆盖（插件库"偶发回退"） | 请求序号 |

### C. 数据正确性 / 丢消息

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| C1 | `stores/feed.ts:onToolEnd/onToolUpdate` | 按"最后一条流式 tool 占位"（位置）匹配：并行工具时 X 的结果写进 Y 的占位（Y 永远 running、结果错乱——单工具不复现） | 一律按 `tool_call_id` 精确匹配；无 id 的旧事件退回位置匹配 |
| C2 | `utils/feed.ts:msgSig` | 签名只数 toolCalls 个数不看内容：`tc.result/running/label` 原地变更不可见 → 增量 turns 复用过期缓存（工具卡永久转圈） | 签名覆盖每个调用的 result 长度/running/label |
| C3 | `stores/feed.ts:mergeHistory` | 首屏整体替换 wipe 正在流式的占位（切走再切回丢生成中的回复，后续 delta 静默丢弃） | 替换前摘出流式尾部占位追加到新页后 |
| C4 | `stores/feed.ts:loadGroupHistory` | REST 整体替换 vs 实时消息竞态：fetch 期间 WS push 的群消息被旧快照吞掉 | 记录 fetch 起点，活尾部追加 |
| C5 | `stores/feed.ts:onMessageError` | 不关闭流式占位：run 硬失败无 stepEnd 时占位 isStreaming 永真（动画常转） | 关闭全部流式标记 + 空占位补"⚠️ 生成失败" |
| C6 | DialogView 群切换 watch | A 的迟到加载回调对 B 的视图滚底（对比 PairDialogView 有 onCleanup 守卫——同一逻辑两处实现行为不一致） | 补 onCleanup 取消守卫 |

### D. 重复渲染 / key 不稳定

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| D1 | DialogView/PairDialogView `v-for :key` | turn key 用数组下标：上翻前插历史时全部下标平移 → 整列表 unmount/remount（展开态/卡片状态全丢、长会话闪烁） | `DisplayItem.key` 稳定标识（agent_id+时间戳+内容长度）；分隔符用时间戳 |
| D2 | `TurnDisplayItem.vue` 折叠栏内步骤/工具 key | 同样依赖外层 index 组合 | step 用 assistant 消息 id；工具用 tool_call_id |

### E. 安全（不可信内容注入面）

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| E1 | `useMarkdown.ts` fence 语言标签 | `token.info`（LLM 输出/skill_read 的文件内容）未转义进 `v-html` → 可注入 `onerror` 载荷 | 取首词 + `escapeHtml` |
| E2 | `ToolResultWeb.vue` / `ToolResultBrowser.vue` | 搜索结果/浏览器工具 URL 未过滤协议：`javascript:` 写入 `:href` 点击即执行 | `safeUrl()` 仅放行 http(s) |
| E3 | `ToolResultWeb.vue:score` | `r.score.toFixed(4)` 无空值保护：单条结果缺 score 抛错中断整树 patch | `v-if` 类型守卫 |

### F. 连接层（WebSocket 客户端）

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| F1 | `services/websocket.ts` connect/onclose | 重连竞态下旧 socket 迟到的 onclose 把 `connected` 错误置 false（新连接实际存活，UI 卡"已断开"） | socket 身份守卫（事件回调校验 `this.ws === ws`） |
| F2 | disconnect() | 残留 onclose 触发"复活重连"；清的是 handlers（方向反了）→ 复活连接全聋 | 先摘事件再 close；不清 handlers |
| F3 | pendingMessages | 无上限：断线数小时的页面重连 flush 一大批过时指令（"幽灵消息"） | 上限 100 丢最旧 |
| F4 | onConnect/onDisconnect | 无法注销（与 onMessage 不对称，用即累积） | 返回 disposer |

### G. 其他稳定性

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| G1 | `stores/ui.ts` ResizeHandle | 鼠标移出窗口松开：document 收不到 mouseup → 拖拽态永久悬挂（col-resize 光标 + 未按键移动仍改宽度） | `onResizeMove` 检测 `e.buttons` 归零即收尾 |
| G2 | `stores/ui.ts:toggleList` | 窄屏强制重开抽屉（活动栏图标永远关不掉） | 窄屏翻转后立即 return |
| G3 | `isolated-runtime.ts` | ready/error 消息 source 常量写反（`iframe-host` ≠ 宿主过滤的 `plugin-iframe`）→ isolated 插件加载失败完全静默 | 两处改正确常量 |
| G4 | `core/registry/toolResultViews.ts` | 注册无去重（对照 perspectives/messageViews 均按 id 替换）→ 插件更新组件静默不生效 | 按 match 替换 |
| G5 | SettingsPanel `restarting` | 无解锁路径（WS 事件丢失时按钮永久"正在重启"） | 30s 兜底解锁 |
| G6 | `TokenUsage.vue` 空数据早退 | 不清旧图：切到无记录范围时旧图表与"暂无数据"同屏 | 早退前 destroy/清空 |
| G7 | DialogView groupSendTimer | 卸载不清理（切视角后仍操作已卸载实例） | onUnmounted 一并清理 |
| G8 | `svc/archive/src/plugin.ts` | `ctx.bootstrap` 直接访问在 webui 的 plugin tsconfig 程序下 TS2339（拖垮 typecheck/build） | 经 any 取契约（inject 已保证运行时存在） |

### H. 设置域补充批次（第二轮审查）

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| H1 | `useSettings.ts:saveTimersFor` | 回包无条件覆盖：保存 in-flight 期间的继续编辑被服务端回显冲掉（丢失更新） | 发送前快照，回包仅当本地未继续编辑时应用 |
| H2 | `useSettings.ts:loadMeta` | allSettled 全部 rejected 分支静默丢弃：schemas/池拉取失败出空 UI 无报错 | 聚合失败项写入 error |
| H3 | `StagingReviewModal.vue` | 文件树/内容预览无守卫：快速点不同文件时晚到响应与选中项错配 | 请求序号守卫（loadTree/openFile/reset） |
| H4 | `AgentPane.vue` | 切换 Agent 不重置 `selectedLlmPool/llmModelOptions`：B 的模型下拉显示 A 选过的池与 A 拉取的模型列表（UI 级串台） | agentId watch 中同步 raw.llm.$ref 并清空派生列表 |
| H5 | `AgentPane.vue` 头像 | `URL.createObjectURL` 从不 revoke（每次选图泄漏 blob）；文件输入不复位（同文件二次选不触发 change） | `setAvatarPreview` 统一 revoke；change 后复位 input.value |
| H6 | SettingsPanel | 面板已开时 `initialAgentId` 变化不导航（如从聊天页再点另一个 Agent 的设置入口） | watch 联合 `[visible, initialAgentId]` |
| H7 | `PluginLibraryPane.vue` | "拒绝"按钮与"审查"行为完全相同（都只开弹窗）；`busyName === s.id` 恒 false（存的是 name）——disabled 失效 | 拒绝直连确认 + `api.rejectPlugin`；disabled 改比对 manifest.name |
| H8 | `settings/api.ts` 死代码 | deprecated 端点×4（getAgentPlugins/getGlobalPlugins/getGlobalTools/getAgentTools）零调用；uploadAvatar/deleteAvatar 与 endpoints/agents.ts 逐字重复；stripEmpty 无用 re-export | 删除（消费方统一走 endpoints 版） |

### J. 列表与抽屉域补充批次（第四轮）

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| J1 | `WorkspaceTree.vue` | loading/error 全局单例：任意子目录懒加载都把整棵树体替换成"加载中/错误" → 全部节点展开态（组件本地 isOpen）丢失、子目录错误清空整树；双击同一目录重复请求 | 状态下沉：全局 loading/error 仅根加载使用；子目录失败以行内占位呈现；per-path in-flight 守卫 |
| J2 | `GroupDrawer.vue` | `onOpen` 初始化函数从未被调用 → 抽屉名称输入框永远为空、保存按钮恒禁用；保存无 busy 守卫、不回写 name、不刷新 groups store；空实现 `leaveGroup`（按钮点击无反应） | 改 `watch([visible, groupId])` 初始化；保存加守卫 + 回写 name/description + fetchGroups；移除无契约支撑的退出按钮 |
| J3 | `stores/chat.ts` sendMessage | 发送即置 `streaming=true` 无兜底：后端重启/事件丢失时无 stepStart/stepEnd → contextBusy 永久卡"打断并发送"态 | 30s 看门狗：到期分区已无任何流式占位仍 streaming → 回落并提示 |
| J4 | `AgentList.vue` / `SessionList.vue` | 新建 Agent/会话无 busy 守卫（双击重复创建两个） | busy 标志 + 按钮 disabled |
| J5 | `ChatInput.vue` 三个下拉 | "迟到失败回滚"无校验：快速连选时旧请求的失败回滚覆盖新选择 | 回滚前校验 `sel* === id` |
| J6 | `stores/chat.ts` busy 提示 | `a.agent_id === d.to` 恒 undefined（主键是 id）→ 提示一直显示原始 id | 改 `a.id` |
| J7 | `Sidebar.vue` 备份消息 | setTimeout 未跟踪：连续备份时旧定时器提前清掉新消息 | 定时器跟踪 + 清除旧 |
| J8 | `CreateGroupDialog.vue` | Agent 列表拉取失败静默 → "正在加载"永久转圈 | 错误态展示 |
| J9 | `stores/feed.ts:markUnread` | 零调用死代码 | 删除 |

> ask_questions 并发覆盖（后者顶掉前者使前者永久无法作答）属全局单槽的协议层限制：跨会话串台已由 InteractionBar 归属门控（B7）缓解，多槽队列需后端配合，列遗留。

### K. DialogView 域收尾批次（第五轮）

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| K1 | direct 历史加载职责分散 5 处 | AgentList/RunTracking/RunTrackingPanel/chat.ts 各自调用 `loadHistory`——任何新导航入口漏调即"空白会话直到刷新"（缺陷 7） | 收敛到 DialogView 的 `activeAgentId` watch（与 single 模式对齐）；移除 AgentList 的调用；矩阵入口同 id 重入与 chat.ts 恢复路径保留（requestId 时序守卫去重） |
| K2 | DialogView 切 Agent watch 的 nextTick 自动续拉 | 不可达死逻辑（首次加载期间 `hasMoreHistory` 恒 false；真正生效的是 loadingHistory watch 的同款逻辑）——同一逻辑两处实现一死一活 | 删除死块（留活） |
| K3 | `utils/feed.ts:mergeHistoryPage` | userCount 硬编码 `m.agent_id === 'user'`，与调用方 `VIEWER_ID.value` 不一致——VIEWER_ID 未来可配置时分页 offset 校准会错算 | 改为 `viewerId` 参数（缺省 'user' 保持兼容），调用方传 `VIEWER_ID.value` |

### L. Turn 派生层收尾批次（第六轮）

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| L1 | `utils/feed.ts` Turn 派生 | `FeedAgentMsg` 丢弃原始 `id/files/agent_id`，final 用合成 id → edit/regenerate/delete 按 id 查 rawMessages 永远 -1（操作按钮静默失效）；用户附件 chips 在 turns 视图不渲染 | `FeedAgentMsg` 增加 `id/files/agent_id` 透传；`buildTurnFromAgentMsgs` final 沿用 `last.id` |
| L2 | `TurnDisplayItem.vue` regenerate/delete 门控 | 绑定 `isSelf`（settingsAgentId 固定 VIEWER → assistant 轮恒 false）→ 按钮渲染了但点击永不触发 | 改 `canRegenerate`（非 system 轮且非流式中） |
| L3 | `TurnDisplayItem.vue` final 流式态 | 硬编码 `:is-streaming="false"` → final 永远走 useChunkedMarkdown 的全量分支，每个 rAF 帧对全文跑 markdown-it（长回复 O(n²) 卡顿；typing indicator 永不显示） | `finalIsStreaming = !hasChain && isStreaming`（纯文本轮 final 承载正文流式，复用 committed/pending 分块） |
| L4 | `stores/feed.ts:onThinkingStart` | 双 thinking.start（重连重放）时旧占位 `isStreaming` 永不复位 → 派生 step 恒流式（折叠栏强制展开、dots 不灭） | push 新占位前关闭旧占位 |
| L5 | `stores/feed.ts:onThinkingStart` | `markActive()` 无条件点亮全局 turnInProgress——后台会话的 thinking 事件影响当前视图的思维链折叠时机 | handler 传 `isForActiveAgent`，仅 active 会话点亮 |
| L6 | `stores/feed.ts:onStepStart` | 重复 step.start（WS 重连重放）无条件追加第二个空占位（"测/测试双气泡"的另一入口） | 尾部已是空流式占位时跳过 |
| L7 | `stores/feed.ts:init` onConnect | 断线中 stepEnd/chatEnd 全丢的分区占位永久 streaming（无 resume 快照兜底时） | 重连后对 `streaming` 分区 `closeAllStreaming` + 回落 |

### M. 工具结果卡片域收尾批次（第七轮）

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| M1 | `useToolResult.ts:parseToolResult` | 流式每 delta 全量 JSON.parse + 抛异常（异常构造堆栈昂贵，大输出 O(n²) CPU） | 尾部短路：trimEnd 后末字符非 `}`/`]` 时必然不完整，直接返回 null |
| M2 | `useMarkdown.ts:linkifyFilePaths` | 保护正则第三分支 `\1` 回指未参与分组（恒空匹配的负向前瞻恒真 → 等效贪婪 `.*` 到结尾，长 HTML 回溯近 O(n²)） | 改 `\3`（第三分支自己的捕获组） |
| M3 | `ToolResultCode/Write.vue` | 用 ``` 包裹文件内容：读取 .md 等含内嵌 fence 的文件必现围栏截断、后续内容按 markdown 渲染（版面跑偏） | `fenceOf()` 动态升级更长围栏 |
| M4 | `ToolResultWrite.vue` | `filePath` 一次性常量（props.data 流式替换后取不到）；读取失败后 error 短路 → 永远无法重试；复制定时器不清理 | filePath/fileName 改 computed；失败允许重试；定时器跟踪 |
| M5 | `ToolResultEdit/Code.vue` | 复制按钮 setTimeout 未跟踪（连点互踩 + 卸载后残留） | 定时器跟踪 + onBeforeUnmount 清理 |
| M6 | `ToolMessage.vue` | `A\|\|(!A&&B)` 恒冗余条件 | 化简 |
| M7 | 死文件 | `ToolResultCard.vue` 整文件（未注册未引用）、`ui/ScrollView.vue`（仅导出无使用，与 ScrollableViewport 重复）、`useToolResult.getToolResultComponent` 兼容导出 | 删除 |

### I. 基础设施补充批次（第三轮）

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| I1 | `services/websocket.ts` | **半开连接无心跳**（原 P0-1）：网络静默断开（NAT 超时/睡眠唤醒）时浏览器不触发 onclose，readyState 恒 OPEN——发消息全部写进死 socket，表现为"聊着聊着没响应，刷新才好" | 空闲看门狗：90s 无任何入站消息即主动 close 走重连（后端有 30s 协议层 ping，正常连接不会误杀） |
| I2 | `services/websocket.ts:connect` | CLOSING 状态窗口直接重建 socket 的双连接竞态（原 P1-1） | 身份守卫已覆盖事件错乱；CLOSING 放行重建并在注释说明 |
| I3 | `stores/websocket.ts` | `onMessage/onConnect` 在 `init()` 前调用 TypeError（隐性顺序契约） | 两个入口自动先 `init()` |
| I4 | `core/extensions/isolated.ts` | subscribe/unsubscribe 协议不对称（原 P2-1）：父侧 unsubscribe 是 no-op，插件每次 订阅→退订→再订阅 都多挂一个 WS handler → 同一事件向 iframe 投递 N 次 | 按 type 引用计数（0→1 订阅、1→0 退订），与 iframe 运行时协议对齐 |
| I5 | `core/extensions/host.ts` | 同名插件并发加载覆盖丢失旧 disposers（原 P2-2）→ 孤儿 perspective/订阅/style 残留 | per-name in-flight 互斥；isolated 挂载前防御性卸载旧实例 |
| I6 | `core/extensions/host.ts` | `install()` 无超时（原 P3-1）：挂起的插件阻塞其后所有插件加载 | 15s `Promise.race` 超时，超时走回滚分支 |
| I7 | `core/extensions/p5.5-policy.ts` | 三处策略绕过（原 P2-3）：`:root` body 可写任意全局属性；CSS 转义（`\75 rl(`）绕过 url 黑名单；选择器未禁反斜杠 | `:root` 逐 declaration 仅放行 `--*`；声明值与选择器全面禁反斜杠（新增 2 个回归用例） |
| I8 | 死代码 | `format.ts` 5 个无调用函数、`starColor.ts` 3 个导出、`endpoints/ui.ts:getUiSlots` | 删除（保留项均经 grep 验证有调用方） |

> 未动的有意设计：`plugin.ts` EADDRINUSE → `process.exit(1)` 是防双实例的**有意行为**（避免重复定时调度/重复写状态），保留；其 disposer 的 `await` 化建议随后端任务处理。

## 三、死代码清理

- **删除** `components/ChatView.vue`（1240 行，DialogView 前身）与 `components/GroupChat.vue`（504 行）——全局无引用，且 ChatView 里保留着一份"正确"的 shell 重置逻辑，与现实现不一致误导排查（B1 的回归正是迁移时丢的）。
- **删除后确认**：`TurnDisplayItem` 内部对死代码的注释引用一并更新。

## 四、新增回归测试

- `tests/feed-parallel-tools.test.ts`（2 用例）：并行工具调用结果按 `tool_call_id` 归属——占位开关、running 标志、result 内容三重钉住（C1/C2）。
- 既有 6 个测试文件（36 用例）全部保持通过；两个 store mock 补齐 `onConnect`。

## 五、遗留建议（未动，需产品/后端配合）

1. **fetch 层超时/取消**：`core/api/client.ts` 无 timeout/AbortController；本次已在各消费点加序号守卫（B8/B10/B11/H3），系统性方案是 client 层透传 `AbortSignal.timeout()`。
2. **feed Map 无上限**：`_turnsCache/_turnsMemo/_historyOffset` 等按 dialog 永久累积；长期使用建议加 LRU 上限。
3. **`getTurns` computed 内写缓存**：Vue 反模式（多订阅者并发求值可能交错覆盖）；建议副作用移出。
4. **p5.5-policy 深层重构**：`:root`/反斜杠两个实用绕过面已封堵；彻底方案是 CSSOM 解析 + 选择器白名单（本轮未做）。
5. **直接历史加载职责分散**：已收敛到 DialogView（K1）；chat.ts 的恢复/归档重载路径属必要保留。
6. **chatSubscribe 无 unsubscribe 配对**：需后端确认订阅集幂等性。
7. **ConfirmDialog 重入**：并发 ask 会覆盖 resolveFn 使首个 Promise 永不 settle（当前 UI 序列概率低）。
8. **NsFieldList JSON 兜底编辑**：非法 JSON 被静默丢弃（"应用"无条件清空输入）。
9. **保存中未禁用 Agent 切换导航**：saveAgent 已做身份快照防护，导航按钮补 `:disabled="saving"` 更稳妥。
10. **webui plugin.ts EADDRINUSE 退出进程**：属防双实例的有意设计；建议 disposer 改 `await server.stop()` 以消除端口释放竞态（随后端任务）。
11. **logger 每条日志重复解析配置**：高频 WS 场景的轻微 GC/IO 压力，可缓存解析结果。
12. **ask_questions 全局单槽**：并发提问后者覆盖前者（前者永久无法作答，靠后端超时解困）；跨会话串台已由 UI 归属门控缓解，多槽/队列需后端协议配合。
13. **feed 分区/缓存永不回收**：删除会话/Agent 不清对应分区与 turns 缓存（与遗留 2 同源，LRU 可一并解决）。
14. **卡片折叠 v-show + 无虚拟化**：历史工具卡（含 hljs DOM）与截图 base64 常驻内存；建议 content-visibility/按需加载/卸载释放（涉及交互行为，需专项设计）。
15. **展开态按下标索引**：ToolResultWeb/Browser 的 expandedResults/expandedSteps 以数组下标为键，结果列表重排时错位（外层 key 已稳定化，此处为组件内部状态）。
16. **ToolResultSubagent 按 action 文案猜语义**：英文 kill 消息渲染成"已创建"；需后端结构化 action 字段。

## 六、改动清单

修复（17 文件）：`services/websocket.ts`、`stores/{feed,groups,runs,ui}.ts`、`settings/useSettings.ts`、`settings/components/SettingsPanel.vue`、`components/dialog/{DialogView,PairDialogView}.vue`、`components/{ChatInput,InteractionBar,RunTracking,TokenUsage}.vue`、`components/chat/FilePreviewModal.vue`、`components/chat/Message/TurnDisplayItem.vue`、`composables/{useChatShell}.ts`、`utils/{feed,format}.ts`、`types/index.ts`、`composables/useMarkdown.ts`、`components/chat/ToolResult/{ToolResultWeb,ToolResultBrowser}.vue`、`core/registry/toolResultViews.ts`、`isolated-runtime.ts`、`svc/archive/src/plugin.ts`（类型契约）
删除：`components/ChatView.vue`、`components/GroupChat.vue`
新增：`tests/feed-parallel-tools.test.ts`、本报告
