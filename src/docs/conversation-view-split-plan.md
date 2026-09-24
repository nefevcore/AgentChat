# ConversationView 拆分精简方案（conversation-view-split-plan）

> 2026-12 立项 · 状态：**已实施**（同日四动作一次落地，验证与收口清单见 §七）。拆分对象 `ac-client-ui-conversation/client/ConversationView.vue`（762 行 → 258 行组合壳）。

## 一、背景与现状

ConversationView.vue 是四形态合一的会话视图内核（direct / group / single / pair·readonly，
原 DialogView.vue 更名扩容，PairDialogView 并入）。历经会话区重构 B 路线——`TranscriptList` /
`useTurnDisplayItems` / `useChatShell` / `header/` 席位贡献已抽出——仍余 **762 行 / 38KB**，
包内第 6 大文件。剩余体积是四形态攒下的编排胶水，分层清晰、无环依赖，适合沿同一路线继续拆。

体积构成（script 480 行 + template 166 行 + style 110 行）：

| 块 | 行数 | 内容 |
|---|---|---|
| 身份/头部派生 | ~90 | dialogId、四形态标志、headerAgentId、title、presetChipLabel、epA/epB、jobsConversationId、headerWidgetData、dock 键 |
| 历史装载 | **~190** | 三条 load-more 路径 + **5 个 watch**，含取消守卫 / 8s 超时 / 身份守卫 |
| 群发路径 | ~35 | sendGroupMessage + 发送锁 + 10s 兜底定时器 + 卸载清理 |
| 渲染模型 | ~35 | isSingleFresh、streamingTailLen、topLoading、emptyText 等 |
| 队列/预览/分支 | ~50 | useQueueSeat 接线、steerAllQueued、handlePreviewFile、forkFromMessage |
| template 头部区 | ~90 | pair 双端点头、标题/预设徽标、思维链开关、席位、三枚反馈 chip |
| style 头部区 | ~85 | thinking-switch 族、pair-* 族、preset-chip、compress-wrap、hamburger |

## 二、拆分设计（4 个核心动作，全部同包新增文件）

### ① `client/useConversationIdentity.ts`（~110 行）——纯派生层，首刀

迁入全部 computed：dialogId、isGroup/isSingle/isPair、rawMessages/feedDialog、singleAgentId、
groupOwnerAgentId、headerAgentId、activeAgentName、title、presetChipLabel、jobsConversationId、
headerWidgetData、dockAgentId/dockConversationId。内部自取 `useRosterCore()` / `useFeedStore()`，
入参仅 `props`。全部纯派生、零行为，风险最低的热身刀。

注意两条踩坑注释必须随迁（它们约束派生式本身）：
- single 元数据 agentId 空 = 默认预设承载（空串会令后端把 sid 当 viewer 估算）；
- dock 键的 agentId 兜底（single 空 agentId → defaultPresetId）——「排队消息显示得出、删不掉」
  的根因注释，与 QueueDockHost 同轴同实例（`conversation:dock-widget` × `queue` × convId）。

### ② `client/header/ConversationHeader.vue`（~240 行）——template + style 平移

`header/` 子目录已有先例（TokenGauge、SystemPromptPreviewButton）。template 头部区（485-574 行）
与配套样式整体迁入：pair 双端点头（`endpointOf`/`epA`/`epB` 随迁，组件内自调 `useRosterCore`，
不逐头像经 props 传）、标题 + 预设徽标、思维链开关、`SlotOutlet conversation:header-widget` 席位、
compress-wrap 三枚反馈 chip（compressFeedback / busyFeedback / archivePending）、hamburger 按钮。

props 面收敛：`{ isPair, isGroup, a?, b?, title, presetChipLabel, ownerData }`（ownerData =
headerWidgetData 产物，直接喂 SlotOutlet data）。内部：`inject(toggleDrawer)`、`useUiStore()`
（思维链开关）、`useChatStore()`（三枚反馈 chip）——store 全局单例、inject 跨层级成立，
祖先 shell → 后代 header 方向不变。

### ③ `client/useConversationHistory.ts`（~230 行）——最大一块，最险一刀

整体迁入：三条加载路径（`triggerLoadMore` / `loadOlderGroupHistory` / `loadOlderPairHistory`）、
5 个 watch（pair 端点 / group 切换 / dialogId / activeAgentId / single id + `chatStore.loadingHistory`
双 watch）、`isInitialHistoryLoad`、`waitForHistoryLoaded`（8s 超时）。返回
`{ isLoadingMore, onTopThreshold, topLoading, firstLoadPending }`。

入参：`{ props, dialogId, feedDialog, isGroup, isPair, transcript, chatStore?, feed? }`——store 可
内部自取。TranscriptList 的 expose 面在 .ts 里用**结构化接口**声明：
`interface TranscriptListHandle { scrollToBottom(force?: boolean): void; reset(): void; container(): HTMLElement | undefined }`
——避免 .ts 导 .vue 组件类型（SFC 类型导入在纯 TS 上下文不可靠）。

**全部注释逐字随迁**——这些注释是踩坑记录（注册顺序竞态 / immediate 缺失 / 取消守卫 / 8s 超时
根因 / 群聊无限递归），属于行为规约的一部分，不是废话。

### ④ `client/useGroupSend.ts`（~55 行）

迁入：`sendGroupMessage`、`groupTurnInProgress`、`groupSendTimer`（10s 兜底解锁）、`resetGroupTurn`、
`onUnmounted` 定时器清理。入参 `{ props, rpc, chatStore, transcript }`，返回
`{ groupTurnInProgress, sendGroupMessage }`。rpc 经 `useClientContext()?.rpc` 获取后传入
（或组件内取好传入，保持 composable 纯度均可，实施时择一）。

### 拆后主文件（~280 行）

保留：props 定义、composable 接线（identity → history → groupSend）、渲染模型小件
（isSingleFresh / streamingTailLen / emptyText / showTurnActions）、连接条（wireStoreConnected 及
onOpen/onClose 接线）、`useQueueSeat` + `steerAllQueued`、`handlePreviewFile`、`forkFromMessage`、
template 主体（header 收敛为一个标签 + 四 props）、残余样式 ~25 行。文件头注改写，指向新模块。

## 三、消费方契约与兼容保障（为什么不影响项目使用）

以 2026-12 grep 事实为准：

1. **外部引用面闭环**：引 `ConversationView.vue` 的消费方共 4 处，全部
   `defineAsyncComponent` 按文件路径引用——`ac-client-ui-conversation/client/index.ts`、
   `ac-client-ui-group`、`ac-client-ui-runview`、`ac-client-ui-singles` 各自的 index.ts。
   拆分不改文件路径、不改组件对外 props/expose 契约 → 消费方零改动。
2. **行边界不动**：新文件全部落在 `ac-client-ui-conversation/client/` 包内，无新包、无
   cordis.yml / TREE / boot graph / package.json exports 改动；同 chunk 异步加载，无装载行为变化。
3. **不动契约面**：RPC 面、slot 席位（`conversation:header-widget` 的 SlotOutlet 与 ownerData 形状
   不变——席位贡献方 TokenGauge / ConversationJobsChip / AgentHeaderActions / SystemPromptPreviewButton
   感知不到差异）、feed/chat/ui store 均不触碰。拆分是纯客户端组件内部重组。
4. **测试基线**：包内 19 个测试文件全部测纯逻辑层（feed/chatOps/paste/composePrefs 等），无一
   引用 ConversationView.vue——拆分不触碰任何被测面。实施每步 `pnpm typecheck`，收口
   `pnpm lint && pnpm test:unit` 与拆前基线对照。

   **拆前基线（2026-12-12 实测）**：`pnpm test:unit` 全绿（283 文件 / 2087 用例通过 · 2 skip）；
   `pnpm typecheck` 存 1 个**与本拆分无关的既有错误**（`src/ac-openai-completions/tests/
   request-headers.test.ts(37,12)` TS2571）——收口对照时以「不新增错误」为准，勿误判为回归；
   `pnpm lint` 存既有 suppression 死条目债务（eslint 提示有不再发生的 suppressions）——非本
   方案引入，收口时只对账 ConversationView 相关条目随迁，不顺手清理他处存量。
5. **lint suppression 对账**：`eslint-suppressions.json` 按文件锚定——ConversationView.vue 条目
   （5 × no-unnecessary-condition）拆分后随代码迁到新文件，须重新生成/对账，不能残留死条目。
6. **文档登记**：`src/docs/webui-component-tree.md` 组件树含 ConversationView 条目——拆分后补
   ConversationHeader 等新行（收口清单见 §七）。

## 四、不变量清单（迁移时逐条核对，全部来自现存踩坑注释）

1. **immediate 三连**：pair watch / activeAgentId watch / single watch 均 `{ immediate: true }`
   （group watch 同款）。缺 immediate = 视角 keyed 重挂载时挂载首调不触发 → direct 分区只显示
   实时推入的入站消息、「主动消息点进只见该条」（2026-09-12 前端反馈根因）。重复 loadHistory
   无害——feed 的 requestId 时序守卫去重。
2. **取消守卫 ×2 + 身份守卫 ×1**：pair/group 快速 A→B 切换时迟到回调不得对新视图滚底
   （onCleanup cancelled）；triggerLoadMore 的 `dialogAtStart`——await 期间切会话（同一 DOM 容器
   复用），迟到恢复不得按新会话内容计算滚动补偿。
3. **8s / 10s 两个兜底**：`waitForHistoryLoaded` 8s 超时（WS 断线在途 history.request 永无响应 →
   isLoadingMore 卡死 + 顶部 spinner 不消失 + 后续全被守卫挡掉）；群发 10s 兜底解锁（投递确认/
   异常未及时到达）。onUnmounted 清理定时器（切视角卸载后仍会触发并操作已卸载实例）。
4. **群聊不走 direct 自动续拉**：空群 hasMore=true + 内容不足一屏 → triggerLoadMore 无限递归 →
   页面卡死。群上翻由 loadOlderGroupHistory 按滚动触发。
5. **compress-wrap 定位依赖**：`align-self: stretch` 拉满头部高（header-actions 同步拉满作参照），
   chip 挂头部底缘下方 10px——DOM 结构与样式必须同迁 ConversationHeader，层级关系不得变。
6. **连接条初值取现态**：`rpc?.connected?.() ?? true`（M27 S3-1b 回归：行 client 异步装载后 WS
   常在挂载前已开，纯事件初值 false → 注册顺序竞态 → 断连条永久误显；桩缺省按已连接处理）。此块
   留主文件，不迁。
7. **队列座位轴**：`useQueueSeat(dockConversationId, dockAgentId)` 与 QueueDockHost 贡献同轴同实例
   （`conversation:dock-widget` × `queue` × convId）；agentId 兜底逻辑见 §二①——identity 拆分后
   主文件与 QueueDockHost 仍取同一派生源，不得各写一份。
8. **transcript ref 可选性**：TranscriptList 在 fresh 开场（isSingleFresh）下不渲染，挂载时序晚于
   watch immediate 首调——`transcript.value?.` 可选链容错必须保持。

## 五、实施顺序与验证

每步后 `pnpm typecheck`；全部完成 `pnpm lint && pnpm test:unit` 对照基线；冒烟清单见下。
小步提交，每步可独立回退：

1. **① identity**（纯 computed，零行为）
2. **② ConversationHeader**（template + style 平移；注入/store 就地取；验收 compress chip 悬挂位置）
3. **③ history**（watch 块逐字迁移、注释不丢；验收四形态历史装载与滚动补偿）
4. **④ groupSend + 主文件头注改写收口**

冒烟清单：四形态切换、群发（含 10s 兜底）、上翻加载（direct 续拉 / group 前插 / pair 前插）、
single fresh 开场居中 → 首条消息后回底部布局、断连条出现/恢复、队列 steer/删除、头部席位
（Token 仪表 / jobs chip / Agent 动作）四形态 gate、思维链开关、窄屏 hamburger。

## 六、可选二级拆分（不首刀，防过度工程）

- `header/ThinkingSwitch.vue`（~50 行）：自包含 pill 开关，只绑 ui store；
- `handlePreviewFile` 的 fallback 推导抽纯函数——FileEditsPanel.vue:491 注释自认「同口径」手抄了
  一份，可单源化（顺带消一处注释债）；
- `streamingTailLen` 抽纯函数进 format.ts。

## 七、收口登记清单

- [x] `src/README.md` 设计档案索引登记本方案（WebUI 行）——立项时已完成
- [x] `src/docs/webui-component-tree.md` 补 ConversationHeader / 新 composables 条目
- [x] `eslint-suppressions.json` 条目随迁对账（ConversationView 5 条 → 主文件 3 + useConversationHistory 2；lint 全局存量死条目债务系拆前既有，未顺手清理他处）
- [x] CHANGELOG 条目（Unreleased · Changed）

**实施结果（2026-12）**：四动作一次落地——主文件 762 → 258 行（-66%）；
identity 130 行 / history 222 行 / groupSend 54 行 / ConversationHeader 223 行。
验证：vue-tsc（webui:typecheck）全绿；test:unit 283 文件 / 2087 用例与基线一致；
typecheck 无新增错误（存量 ac-openai-completions 1 错与 lint 死条目债务均系拆前既有）。
冒烟建议（人工）：四形态切换、群发、三路上翻加载、single fresh 开场、断连条、
队列 steer/删除、头部席位四形态 gate、思维链开关、窄屏 hamburger。

**预期收益**：主文件 762 → ~280 行（−63%）；包内不再有「一个文件装四形态全部细节」的汇集点；
每块 ≤240 行且各自内聚（派生 / 装载 / 群发 / 头部），后续四形态各自的演进有明确落点。