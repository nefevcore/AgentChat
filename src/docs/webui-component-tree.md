# WebUI 组件树（UI Component Tree）

> **定位**：本文整理**前端 Vue 组件的组合关系**（谁渲染谁、谁复用谁），
> 与 [`ui-rows-and-slots.md`](ui-rows-and-slots.md) §2 Slot 树分工互补——
> slot 树讲「席位/插口的形状与语义」，本文讲「组件本体的父子与引用」。
> 读代码前先看本文即可建立整张前端的地形图。
>
> **范围**：`src/webui`（装配壳，无业务组件，45 文件 ~107KB）+
> 26 个 `ac-client-ui-*` 行包的 `client/`（79 个 `.vue`）+
> `@agentchat/webui-kit`（13 个 `.vue` 原语），合计 92 个组件。
> 数据面行（无组件）见 §9。
> **口径**：以当前代码为准（M27 行包化 → M28 域资产归行 → M30 席位
> 语义收口 → 骨架语义定整 → 会话区重构〔ConversationView 四形态内核 /
> header-widget 席位 / aux 选区化群面板 / 辅助活动栏〕→ 设置左树数据化
> → 搜索池拆行之后的形态）。
> 树中标注 `[包名]`；挂载边标注挂载机制。

---

## 1. 组件树怎么长出来的（装配链）

`main.ts`（src/webui）本身零可视面知识，组件树分步长出：

```
main.ts (src/webui)
  ① createClient()                    浏览器端 cordis 实例 + SlotRegistry
  │                                   + bind* 三注册表（perspectives/
  │                                   messageViews/toolResultViews 解析面绑定）
  ② ctx.plugin(rpcHostPlugin)         RPC 宿主面（行 client 的契约实现）
  ③ applyBootGraph('base')            基础六件（封印前；boot graph 按
  │                                   行 id 字典序装载：ui-conversation →
  │                                   ui-layout → ui-renderer → ui-settings
  │                                   → ui-theme → ui-tool）
  ④ sealFactory()                     root 席位出厂封印
  ⑤ applyBootGraph('domain')          20 个域行（封印后动态批次；热通道
  │                                   可 diff——base 行集变更整页重载，
  │                                   domain 行动态装卸）
  ⑥ createApp(AcClientRoot)
       render: () => renderSlot('root')   ← 唯一 ctx 级渲染入口
  ⑦ initUiExtensionHost()             第三方 UI 插件（/ui-plugin/ 通道，
       + app.mount('#app')              bridge 双轨转发 SlotRegistry）
```

boot graph 模块解析双轨：dev 期 vite 直服行包 `client/` 源码；prod 期
vite 插件把全部行 client 构建为模块块并生成静态 loader 映射
（`virtual:row-clients`）。行卸载 → 不在图 → 前端消费面一并消失。

组件父子边有三种（后文树中统一用线形区分）：

| 边类型 | 标记 | 机制 | 例子 |
|---|---|---|---|
| 静态引用 | `├─` | SFC `import X from './X.vue'` 模板直用 | `ConversationView → ChatInput` |
| 异步引用 | `├─`（标注 async） | `defineAsyncComponent(() => import(...))` | 行入口 → 各 Host/卡片 |
| 席位挂载 | `⤷` | `SlotOutlet`（list/single）/ keyed 选举席 / registry 解析 | `AppFrame ⤷ ActivityBarHost` |

席位挂载边是**可拆卸边**：行卸载 → 贡献消失 → 该子树整枝退场（可摘除性
D19），这是组件树与静态 import 图的最大差异。

---

## 2. 顶层壳：AppFrame 骨架布局

`AppFrame` [layout] 占 `root` 席位（出厂唯一占用者）。骨架词汇 =
VSCode 布局同款：`menu-bar`/`bottom-panel`/`status-bar` 三骨架预留席已
declare 占名（无 outlet——实现时壳重构顶部/底部布局后开口），已开口
四区域横向 flex + 覆盖层：

```
#app
└─ AppFrame [ac-client-ui-layout]                      ⤷ root 席位（single·封印）
   ├─ ResizeHandle [layout]                             主侧边栏分屏把手
   │
   ├─ ① 活动栏（48px）
   │  ⤷ ActivityBarHost [ac-client-ui-layout]             ⤷ activity-bar 席位
   │     └─ ActivityBar [ac-client-ui-layout]
   │        ├─ Avatar / Icon / FeedbackNotice          (webui-kit)
   │        ├─ 三个主侧边栏面板按钮 + 更多菜单（备份/版本检查）
   │        └─ 插件动作按钮                ⤷ activity-bar:plugin-actions
   │                                       （数据席：宿主渲染按钮，
   │                                         贡献只供 meta.def）
   │
   ├─ ② 主侧边栏（260px±，三选一）
   │  ⤷ PrimarySidebarHost [ac-client-ui-layout]          ⤷ primary-sidebar 席位
   │     └─ <component :is>（primary-sidebar:domain 选举席，按 ui.primaryPanel
   │        × meta.panel 三选一；无匹配贡献 = 空面板区）
   │        ├─ AgentListHost → AgentList      [agents]   meta.panel='agents'
   │        │     └─ StarAvatar + Modal                  (webui-kit)
   │        ├─ SessionListHost → SessionList  [singles]  meta.panel='sessions'
   │        │     └─ EntryPickerModal [workspace] + StarAvatar + Modal
   │        └─ RunTrackingPanel              [runview]   meta.panel='tracking'
   │              └─ Icon + StarAvatar                    (webui-kit)
   │
   ├─ ③ 主区 main-area —— keyed 选举「主区视图」多选一（MainViewHost
   │     [layout] 按 active × order 选举；壳零域知识——让位协议随各条目
   │     active() 住 owning 行；keepAlive 条目曾当选即 v-show 常驻、
   │     volatile 条目随选举挂卸）
   │  ├─ chat(100)：PerspectiveHost [layout]（恒真兜底；keepAlive 文档流
   │  │     保活——草稿/滚动/流式态不因主区视图切换丢失）
   │  │  └─ <component :is>（main:perspective 选举席，active 谓词
   │  │     选举，order 小者优先激活）
   │  │     ├─ ConversationView [runview]       pair   order 10（a/b+readonly）
   │  │     ├─ ConversationView [conversation]  talk   order 20（group=null, single=null）
   │  │     ├─ ConversationView [group]         group  order 30（group props）
   │  │     └─ ConversationView [singles]       single order 40（single props）
   │  │        —— 四视角、**一个内核组件**（§3：同组件 props 切换 =
   │  │           原地 patch 不重挂载，切换语义全形态统一；pair 为
   │  │           readonly 只读形态——仅阅读消息，编辑类操作全关）。
   │  │           此处 [包名] = 视角贡献行，内核属主 conversation（见 §8）
   │  ├─ tracking(50)：RunTracking [ac-client-ui-runview]（volatile——离开
   │  │     即卸载，runs 轮询随卸载停；active 自带让位协议：开关开 &&
   │  │     非 pair 只读视角；「选中让位」兜底 watch 亦随 runview 行——
   │  │     选中 Agent/群/独立会话即收起矩阵与 pair）
   │  │        └─ Avatar + Icon                         (webui-kit)
   │  └─ NULL（第三方主区视图扩展位——未来全屏设置页/看板等）
   │
   ├─ ④ aux-sidebar 辅助侧边栏（第四区域——语义 = 右侧边栏，与活动栏/
   │     主侧边栏/主面板同级；席位 = 区域本身，「工作区」= 众多选区之一，
   │     NULL 扩展位与各选区同级。AuxSidebarHost [layout] 解析；选区缺席
   │     → 区域整体消失；显隐区域级——矩阵/视角切换不收起）
   │  ⤷ AuxSidebarHost [ac-client-ui-layout]                ⤷ aux-sidebar 席位（elect）
   │     ├─ ResizeHandle [layout]                      宽度把手（展开态）
   │     ├─ group（选区 order 10）：GroupDrawer [ac-client-ui-group]
   │     │    群信息面板（成员/改名/简介/群主/删除；active = drawerOpen
   │     │    域态，available = 群视角有活跃群才露出辅助活动栏按钮）
   │     ├─ workspace（选区）：WorkspaceTreeHost → WorkspaceTree
   │     │    [ac-client-ui-workspace]（恒真兜底选区；树锚 = **数据根**——
   │     │    files/·agents/·usage/ 等全域可见，dotfile 与敏感件〔控制面
   │     │    词表：config.json/credentials.json 等 + .env/*.pem 内置模式〕
   │     │    树不可见、预览/raw 读口拒读——词表单源住 ac-sandbox-core）
   │     │    └─ WorkspaceTreeNode（递归自引用）        + Icon (webui-kit)
   │     └─ 辅助活动栏 AuxActivityBar [ac-client-ui-layout]（右侧的活动栏
   │        同构布局列：40px 窄列 / 无底色透页面背景 / 内侧描边 / 按钮
   │        竖向居中 / 活动指示条镜像右缘——常规 flex 列**占位不覆盖**，
   │        展开/收起均常驻。按钮 = 各选区 rail 资产（点非当选区 = 展开
   │        〔显式选区 ui.auxPanel 置位 + activate 域侧激活〕，点当选且
   │        展开 = 二次点击收起区域；available 谓词控可见性；群组配置
   │        按钮住此，与「工作区」同级）
   │
   └─ ⑤ 全局覆盖层 overlay 席位（list，按 order 排；order 缺省 100）
      ├─ SystemPromptModal               [conversation]  order 88（自持开关态
      │                                  ui.systemPromptOpen）
      ├─ FilePreviewHost → FilePreviewModal     [workspace]     order 90（markdown/hljs 渲染）
      ├─ CreateGroupHost → CreateGroupDialog    [group]         order 95
      ├─ TokenUsageHost  → TokenUsage           [usage]         order 96
      ├─ VersionHost     → VersionDialog        [system]        order 97
      └─ SettingsOverlayHost → SettingsPanel    [settings]      order 100 缺省（§5）
```

移动端（≤768px）：主侧边栏转左抽屉（fixed 置顶 + 遮罩），收起态
pointer-events 穿透避免拦截活动栏。

---

## 3. 会话区：ConversationView 四形态内核

`ConversationView` [conversation] 是 **direct / group / single / pair·readonly
四视角的单一内核组件**（props 区分形态）。group/singles/runview 行经
`defineAsyncComponent` **跨包异步引用**同一内核注册各视角；pair 视角传
`a/b + readonly:true`（仅阅读消息，禁止编辑类操作——无输入框/无 dock/
无仪表/轮内动作关闭）。消息渲染链经 `TranscriptList` +
`useTurnDisplayItems` 单源共享；四视角同组件 props 切换 = 原地 patch，
切换语义统一。树按模板布局区域分组（头部 / 消息区 / dock 列 / 输入区），
与 §2 AppFrame 同款画法。

```
ConversationView [ac-client-ui-conversation]
│  ⤷ main:perspective 选举席挂载：talk（本行出厂 order 20）；group/singles/
│    runview 行跨包 async 引用同一内核各注册 group(30)/single(40)/
│    pair(10·readonly)——见 §2 ③
│
├─ ① 头部 chat-header
│  ├─（pair 形态：返回按钮 + 双端点头像标题「只读 · 双方视角」）
│  ├─（其余形态：汉堡菜单〔移动端抽屉〕+ 标题 + 群参与者计数）
│  ├─ ThinkingIcon                    思维链开关 (webui-kit；ui.showThinking)
│  ├─ SlotOutlet ⤷ conversation:header-widget 席位（list，order 序；
│  │  ownerProps = { form, agentId, conversationId, single }——贡献按
│  │  形态自取自gate，群/pair 形态全部自隐）
│  │  ├─ ConversationJobsChip         [jobs]         order 10（会话任务清单
│  │  │                               chip，零任务自隐）
│  │  ├─ TokenGauge                   [conversation] order 20（占用 gauge(26px)
│  │  │                               + 详情弹层(56px) + 归档入口）
│  │  ├─ SystemPromptPreviewButton    [conversation] order 25（System Prompt
│  │  │                               预览入口，弹窗走 overlay 席位）
│  │  ├─ AgentHeaderActions           [agents]       order 30（Agent 配置按钮 +
│  │  │                               ⋯ 菜单〔删除 Agent，确认弹窗随件内迁〕）
│  │  └─ SingleHeaderActions          [singles]      order 30（⋯ 菜单〔归档独立
│  │                                 会话，确认弹窗随件内迁〕）
│  ├─ FeedbackNotice ×3               压缩/忙碌/归档整理中反馈 chip（零宽锚点
│  │                                 悬挂；tone 语义派生图标/配色）
│  └─ Icon                            System Prompt 入口按钮 (webui-kit)
│
├─ ② 消息区 TranscriptList（四形态共享）
│  ├─ time / event / error 分隔符      纯 div 非组件（时间线/系统事件/错误）
│  ├─ TurnDisplayItem ×N              消息列表逐轮渲染（§4 渲染链；
│  │                                   continuation 延续轮不重复头像/名称）
│  └─ useChatShell 滚动外壳（组件内——宿主经 ref 取 scrollToBottom/
│     reset/container）；空态 gate / 回到底部 / 加载指示随件
│
├─ ③ 任务 dock 列 ComposerDock（位置语义——composer 上方，不预设内容；
│  │  群/pair 形态隐藏）
│  ⤷ conversation:dock-widget 席位（list，order 序）
│     ├─ TodoDockCard → TodoPanel      [todo]         order 10
│     ├─ GoalDockCard  → GoalBar       [goal]         order 20（hover 操作区：
│     │                                 暂停/恢复 · 编辑 · 删除——写走
│     │                                 goal/update·delete RPC，与 Agent
│     │                                 goal 工具同一写口；缺写面 props 退化
│     │                                 只读形态）
│     ├─ QueueDockHost → QueueDock     [conversation] order 30（排队 dock；
│     │                                 per-conversation 核心态经 store 座位
│     │                                 实例轴——entry.store 工厂 ×
│     │                                 scopeKey=conversationId，同轴同实例）
│     └─ InteractionBar                [conversation] order 40（ask_questions 决策）
│
├─ ④ 输入区 ChatInput（单实例条件接线：group = RPC 群发路径 / direct·single
│  │  = store.sendMessage 默认路径 + 排队手势；pair 只读形态不渲染）
│  └─ InputMention                    @ 提及弹层 + Icon (webui-kit；
│                                     技能清单经 skillsApi [skill]）
│
├─ Modal                              （无——System Prompt 预览 = overlay
│                                     席位贡献〔§2 ⑤ order 88，开关态住
│                                     ui store〕；删除/归档确认随
│                                     agents/singles 头部贡献内联）
└─ 群视角右侧抽屉                      （无——已迁 aux-sidebar 选区〔§2 ④，
                                       GroupDrawer 为 group 选区〕）
```

> 渲染内核内部件（非组件树的补充）：`useTurnDisplayItems.ts`（turns →
> DisplayItem 派生管线：稳定 key / event·error 分隔 / run 插播紧凑化 /
> 时间分隔）与 `TranscriptList.vue` 同为共享抽取产物，四形态单源。

---

## 4. 消息渲染链：TurnDisplayItem 三形态 → 三消息 → 工具卡选举

`TurnDisplayItem` [conversation] 是 TranscriptList 逐轮渲染的统一载体：
同一组件内按「有无思维链 × 全局思维链开关（ui.showThinking）」切三分支
（模板分支，非子组件）；final 视图（message:final-view）与工具卡
（tool-card:result-view）两处选举席在分支内消费。

```
TurnDisplayItem [conversation]                一「轮」= 发送者 + 思维链 + final（右 = 本端）
│  ├─ 三分支：① 纯文本轮 ② 链轮 ③ 思维链隐藏模式
│  └─ continuation 延续轮：run 被插播 event 切开的同 agent 后续段——
│     不再重复头像/名称，内容列对齐原块（读作同一 run 的连续片段）
│
├─ ① 纯文本轮（无链；final 强生命周期：loop 中 final 悬置 → 渲染流式
│  │  尾步消息，与收束后 final 同位）
│  ├─ <component :is> ⤷ message:final-view 选举席——插件 final 视图
│  │  （仅收束后：resolveMessageView 按 match + priority 选举，renderer
│  │   替换整卡；内置 user/assistant 无 renderer 走下方内建分支）
│  ├─ UserMessage                            finalViewId='user' 内建分支（右）
│  └─ AssistantMessage                       其余内建分支（左；流式 =
│                                            useChunkedMarkdown 分块渲染）
│
├─ ② 链轮（折叠栏；流式中创建的轮默认展开、历史轮默认折叠，此后仅
│  │  用户手动切换——整链显隐另由全局思维链开关承担）
│  ├─ Avatar                                 对端头像 (webui-kit；延续轮不渲染)
│  ├─ chain-header（纯 div：ThinkingIcon + 摘要「思考过程 | N 步 | 用时」
│  │  + 流式 dots + 折叠 chevron；展开态 sticky 吸顶）
│  ├─ chain-body（每 meaningful step ×N；稳定 key = assistant 消息 id——
│  │  │  工具结果前插/步骤重建不整组重挂载）
│  │  ├─ AssistantMessage（compact）         步思考文本（thinking /
│  │  │                                     reasoning_content；思考相位流式）
│  │  ├─ ToolMessage ×N                     步工具卡（下方选举链）
│  │  └─ AssistantMessage（compact）         步中间正文（与 final 同文去重；
│  │                                        entry 末尾纯文本步由此保全）
│  └─ final 气泡（插件 renderer 优先 / AssistantMessage；空正文不渲染）
│
├─ ③ 思维链隐藏模式（链体一律不渲染，header 是唯一活动指示）
│  ├─ Avatar + 静态 chain-header（摘要 + 流式 dots；无折叠交互）
│  └─ final 气泡（同上；loop 中 final 悬置 → 只有 header + dots）
│
├─ UserMessage [conversation]                 用户消息（右）：编辑 textarea
│  │  （Enter 确认 / Esc 取消）+ 图片附件缩略图（/api/file 直链）
│  └─ Avatar                                 (webui-kit)
├─ AssistantMessage [conversation]            Agent 消息（左，markdown：
│  │  useMarkdown [renderer]）
│  └─ Avatar + ThoughtIcon                   (webui-kit)
└─ ToolMessage [conversation]                 工具卡（链内，默认折叠；仅用户点击展开）
   ├─ 标签栏（纯 div：Icon + toolDisplayLabel / toolIconName 词条——解析面
   │  先查 tool-card:result-view 注册表 meta，未装载行回落静态表〔词条
   │  解析面住 ac-client-ui-tool〕+ 状态 OK/ERR/BLK + 流式 dots + chevron；
   │  write 卡带预览入口）
   └─ 内容体 tool-body（展开时）
      ├─ error / warning / blocked 通道      纯 div（结构化错误/拦截提示）
      ├─ 结果未返回：专用卡先亮             参数预览 + loading 态（bash
      │                                       终端卡实时显示流式输出）
      ├─ <component :is>（useToolResult → resolveToolResultView：精确名 →
      │  正则族 → priority，未命中回落 pre 文本。载荷三形归一：{ok,output}
      │  信封 / 裸 output / {status,…} 旧 preview 形；流式尾部非 }/] 短路）
      │  ⤷ tool-card:result-view 选举席贡献（行 client 半边异步卡 +
      │     label / icon 展示 meta）：
      │     ├─ ToolResultTerminal [shell]        bash 终端卡
      │     │  └─ ScrollableViewport [renderer] + Icon
      │     ├─ ToolResultCode    [fs]            read 文件卡
      │     │  └─ ScrollableViewport [renderer]（useMarkdown 代码高亮）
      │     ├─ ToolResultWrite   [fs]            write 卡（Modal 内容预览 +
      │     │                                    useMarkdown；读经 browseReadFile [workspace]）
      │     ├─ ToolResultEdit    [fs]            edit diff 卡
      │     │  └─ ScrollableViewport [renderer]
      │     ├─ ToolResultWeb     [web]           web_search + 浏览器族正则 11 工具 + Icon
      │     ├─ ToolResultBrowser [browser]       browser 多动作 tab 卡 + Icon
      │     │                                    （screenshot 经 fetchWorkspaceFile [workspace]）
      │     ├─ ToolResultSubagent [subagent]     子 Agent 调度清单卡 + Icon
      │     ├─ ToolResultGoal    [goal]          目标管理卡（goalCard 归一化纯库）
      │     └─ ToolResultTodo    [todo]          任务清单卡（tasks 归一化纯库）
      └─ pre 回落（未知工具原始文本 / 无输出空态）
```

---

## 5. 设置面板：SettingsPanel 壳 + settings:section 节选举

`SettingsPanel` [settings] 是纯壳：左树（叶自 settings:section 席位派生）+
节选举 + 全局保存编排；Agent 编辑编排自足在 ui-agents（保存钮随编辑器
内迁）。右侧主区三分支互斥：域行大件节 → 插件全局页签 → 命名空间字段列。

```
SettingsOverlayHost [settings]               ⤷ overlay 席位（§2 ⑤；绑线经
│                                            ui store——globalSettingsVisible /
│                                            settingsAgentTarget / settingsSectionTarget）
└─ SettingsPanel [settings]                  纯壳：左树（席位派生）+ 节选举
   │                                         + 保存编排
   ├─ 头部（纯 div：StatusDot 未保存徽记 + Icon 关闭）(webui-kit)
   ├─ 左树 sp-tree（纯 div；平铺叶无分组——叶自 settings:section 席位
   │  条目派生〔sectionTree.ts deriveSectionLeaves：meta.section 选举键 /
   │  meta.label 词条 + 顶层 order 叶序轴〕。slots/changed 版本计数响应
   │  ——行装卸 → 叶与节同步即时出现/消失〔整枝退场〕；默认选中守卫
   │  回落偏好叶 llmPools 否则首叶）
   │  ├─ agents(10) / llmPools(20) / searchPools(30) /
   │  │  pluginLibrary(40) / sys.timer(50)
   │  │                                      出厂五叶 = 五枚域行贡献
   │  │                                      （ui-agents「Agent 设置」/
   │  │                                      ui-llm-pool「模型管理」/
   │  │                                      ui-search-pool「搜索引擎」/
   │  │                                      ui-plugin-registry「插件库」/
   │  │                                      ui-timer「定时任务」；
   │  │                                      initialAgentId / initialSection 定位）
   │  └─ ui-tab:* ×N ⤷ settings:main-view    动态叶（= settings-tab:global
   │                                         别名；order 升序追加，树形不变）
   ├─ 右侧主区 sp-main（三分支互斥）
   │  ├─ <component :is>（settings:section 选举席：selectedNode ×
   │  │  meta.section 匹配；sectionEntries 共用版本轴——域行装卸时节
   │  │  与左树叶同步即时出现/消失；无贡献 = 空态，壳不残废）
   │  │  ├─ AgentSettingsHost [agents]（async） section='agents'——列表/编辑
   │  │  │                                     双态（节切走即卸载，编辑态不跨
   │  │  │                                     节驻留；入口定位 watch
   │  │  │                                     ui.settingsAgentTarget）
   │  │  │  ├─ AgentListPane                  列表态：Agent 清单
   │  │  │  │  ├─ Modal「新建 Agent」+ Button (webui-kit)
   │  │  │  │  └─ ConfirmDialog [settings]    删除确认
   │  │  │  └─ AgentPane                      编辑态（页签：基本信息 / 模型 /
   │  │  │     │  定时任务 / 插件配置 + 动态页签；上一个/下一个导航 +
   │  │  │     │  保存配置钮随编辑器）
   │  │  │     ├─ Icon + 头像上传              (webui-kit)
   │  │  │     ├─ SettingField [settings]
   │  │  │     ├─ TimerPane [timer]           定时任务页签
   │  │  │     │  └─ Modal + Button           编辑弹窗 (webui-kit)
   │  │  │     ├─ ExtToolsPane [plugin-registry]   插件配置页签
   │  │  │     │  └─ ExtensionSettingsModal [plugin-registry]
   │  │  │     │     └─ EntryPickerModal [workspace]
   │  │  │     └─ 动态页签内容 <component :is>（sortedAgentSettingsTabs ←
   │  │  │        agent-pane:tab 席位条目 meta.def；= settings-tab:agent
   │  │  │        别名；resolveTabProps 注入 base props）
   │  │  ├─ LlmPoolsHost → PoolManager [llm-pool]（async）
   │  │  │                                     section='llmPools'（模型池，
   │  │  │                                     严格镜像 ac-llm-pool 后端行）
   │  │  │  └─ PoolManager 子树：Modal/Button/Icon (webui-kit)
   │  │  │     + SettingField [settings] + ConfirmDialog [settings]
   │  │  ├─ SearchPoolsHost → SearchPoolManager [search-pool]（async）
   │  │  │                                     section='searchPools'（搜索引擎
   │  │  │                                     池；后端无池服务——消费方
   │  │  │                                     ac-web-tools 读 config.searchProviders）
   │  │  │  └─ SearchPoolManager 子树：Modal/Button/Icon (webui-kit)
   │  │  │     + SettingField [settings]（无 ConfirmDialog——搜索池删除
   │  │  │       无凭据联动，不确认）
   │  │  ├─ PluginLibraryHost → PluginLibraryPane [plugin-registry]（async）
   │  │  │  │                                        section='pluginLibrary'
   │  │  │  │  （目录 / 配置 / 市场三页签）
   │  │  │  └─ PluginLibraryPane 子树：Modal/Button/Icon (webui-kit——工具
   │  │  │     详情 / 市场安装 / 事件治理弹窗) + ConfirmDialog [settings]
   │  │  │     + StagingReviewModal [plugin-registry]
   │  │  │     + ExtensionSettingsModal → EntryPickerModal [workspace]
   │  │  └─ GlobalTimerHost [timer]（async）  section='sys.timer'
   │  │     └─ Modal + Button（编辑/新建定时任务弹窗）(webui-kit)
   │  ├─ <component :is>（ui-tab:* 命中：settings:main-view 插件全局页签；
   │  │  props = resolveTabProps——base：globalConfig / nsSchemas / pools）
   │  └─ NsFieldList → SettingField（ns.* 命名空间节——保留分支：出厂树
   │     已无 ns 叶〔M22 D1 并入插件库〕，仅 initialSection 直达可命中）
   ├─ 底部（纯 div：重启后端按钮 + Button 关闭 / 保存配置）(webui-kit)
   │  （saveAll 只管全局配置——Agent 编辑编排已归 ui-agents，保存钮
   │   在 AgentPane 编辑器内）
   └─ ConfirmDialog                          未保存关闭 / 重启后端确认
```

---

## 6. webui-kit 底座（`@agentchat/webui-kit`）

13 个组件原语 + 纯函数（`formatDurationMs` / `formatRelativeTime` /
`formatFileSize` / `starColor`）+ 三份 CSS（`tokens.css` 设计令牌 /
`row.css` 清单行 / `badge.css` 徽章语言）。kit 内部依赖（全部静态）：

```
Icon ──────────────┐（最底层原语：unplugin-icons 虚拟模块）
Button → Icon      │
Avatar → Icon      │
Modal  → Icon      │
FeedbackNotice → Icon
StarAvatar → Avatar → Icon
RingProgress（独立）
StatusDot（独立）  ThinkingIcon  ThoughtIcon
Tooltip（独立，当前无行组件消费）
StarCard / PulseTrace（L2 组合件，当前无行组件消费——预留原语）
```

行组件对 kit 的消费面（谁在用哪些原语；= 当前 import 实况）：

| kit 原语 | 消费方（行包） |
|---|---|
| Icon | 32 组件（最广：会话/侧边栏/工具卡/设置全线——ActivityBar、AuxActivityBar、ConversationView、TurnDisplayItem、ToolMessage、ChatInput、InputMention、QueueDock、InteractionBar、GoalBar、头部动作件〔AgentHeaderActions / SingleHeaderActions 等〕、各 ToolResult 卡、PoolManager 族、PluginLibraryPane 族、EntryPickerModal、WorkspaceTreeNode、RunTracking 族、SettingsPanel 等） |
| Modal | SystemPromptModal、AgentHeaderActions、SingleHeaderActions、GroupDrawer、CreateGroupDialog、TokenUsage、SettingsPanel、ConfirmDialog、EntryPickerModal、ExtToolsPane、ExtensionSettingsModal、PluginLibraryPane、StagingReviewModal、PoolManager、SearchPoolManager、TimerPane、GlobalTimerHost、ToolResultWrite、AgentList、AgentListPane、SessionList |
| Button | ConfirmDialog、AgentListPane、PoolManager、SearchPoolManager、StagingReviewModal、ExtToolsPane、ExtensionSettingsModal、PluginLibraryPane、TokenUsage、TimerPane、GlobalTimerHost、EntryPickerModal |
| Avatar | ActivityBar、ConversationView（pair 头部双端点）、ChatInput、UserMessage、AssistantMessage、TurnDisplayItem、GroupDrawer、RunTracking |
| StarAvatar | AgentList、SessionList、RunTrackingPanel |
| RingProgress | TokenGauge [conversation]（Token 仪表） |
| FeedbackNotice | ActivityBar（备份反馈）、ConversationView（归档/忙碌/整理中 ×3） |
| ThinkingIcon / ThoughtIcon | ConversationView（开关）+ TurnDisplayItem（链头）/ AssistantMessage（思考标记） |
| StatusDot | SettingsPanel |

---

## 7. 渲染地基：renderer 基础件（ac-client-ui-renderer）

无业务视图，供全树消费的地基原语（phase base，名序第 3 位装载）：

| 资产 | 消费方 |
|---|---|
| `SlotOutlet.vue` + `SlotOutletItem.ts`（宿主模板同轴标记）+ `slotRender.ts` | AppFrame（activity-bar/primary-sidebar/overlay）、ConversationView（header-widget）、ComposerDock（dock-widget）——一切席位挂载点的渲染侧 |
| `ScrollableViewport.vue` | ToolResultTerminal [shell]、ToolResultCode / ToolResultEdit [fs] |
| `useMarkdown.ts`（+ `abap-hljs.ts` ABAP 高亮注册） | AssistantMessage [conversation]、FilePreviewModal [workspace]、ToolResultCode / ToolResultWrite [fs]、VersionDialog [system]（changelog） |
| `vueRenderer.ts` | main.ts 的 `renderSlot('root')` 唯一入口 |
| `logger.ts` | conversation 行 feed-core / chat-core |

---

## 8. 跨包引用关系总表（组件复用网）

组件树之外最有信息量的是**跨包引用**——同一组件被多个域行复用：

| 被复用组件 | 属主 | 引用方（引用形态） |
|---|---|---|
| `ConversationView` | conversation | group / singles / runview（async，视角贡献；pair 携 readonly 形态——四视角一内核） |
| `ScrollableViewport` | renderer | ToolResultTerminal [shell]、ToolResultCode / ToolResultEdit [fs]（静态） |
| `SettingField` | settings | PoolManager [llm-pool]、SearchPoolManager [search-pool]、AgentPane [agents]（静态） |
| `ConfirmDialog` | settings | AgentListPane [agents]、PoolManager [llm-pool]、PluginLibraryPane [plugin-registry]（静态） |
| `EntryPickerModal` | workspace | SessionList [singles]、ExtensionSettingsModal [plugin-registry]（静态） |
| `TimerPane` | timer | AgentPane [agents]（静态） |
| `ExtToolsPane` + `ExtensionSettingsModal` | plugin-registry | AgentPane [agents]（静态） |
| `toolDisplayLabel` / `toolIconName` 词条解析 | tool | ToolMessage [conversation]（静态） |
| `PoolManager` | llm-pool | LlmPoolsHost（本行宿主；搜索池半边已拆为 SearchPoolManager 随 ui-search-pool 行） |

> 规则注释：domain→base 静态引用合法（域行消费基础件资产）；domain→domain
> 引用目前 workspace / settings / renderer / timer / plugin-registry /
> agents 六家被跨域消费，且都是「可复用小件 / RPC 包装 / 惰性取用口」。
> 视角内核 ConversationView 的跨包 async 引用是特例（视角 = 跨包引用
> 内核 + 域 props）。
> 数据面边：跨行运行时边一律经 `scripts/dep-cycles.yml` 白名单显式裁决
> （.ts/.vue 同权重，共 17 条——5 条 base→domain + 12 条 domain→domain；
> 见 ui-rows-and-slots.md §3.5）；type-only 弱依赖不计。

---

## 9. 数据面行与动态挂载点

**无 `.vue` 组件的行**（纯数据/解析面，组件树不出现但服务树消费）：

| 行 | 内容 |
|---|---|
| `ac-client-ui-theme` | themeStore（主题态）+ CSS 令牌应用 |
| `ac-client-ui-tool` | toolLabel / toolIcon / toolResultViews 解析面（图标与卡片选举的中枢；零内联卡） |
| `ac-client-ui-skill` | skillsApi（skillsRpc 三态；技能区由消费方渲染） |

> jobs 行现为视图行（ConversationJobsChip 经 conversation:header-widget
> 席位贡献），不在本表。

**动态挂载点清单**（`<component :is>` / 席位渲染——组件树的"虚线边"，
改这里的注册面即可增删子树而无需改宿主模板）：

| 宿主 | 挂载面 | 选举/排序键 |
|---|---|---|
| `main.ts` AcClientRoot | `renderSlot('root')` | root 席位（single·factory 封印，仅 AppFrame） |
| `PerspectiveHost` | `main:perspective` 选举 | `active()` 谓词，order 小者先（四视角同组件 props 切换） |
| `MainViewHost` | `main` 主区视图选举 | `active()` 谓词，order 小者先；keepAlive 条目 v-show 保活 / volatile 条目 v-if |
| `PrimarySidebarHost` | `primary-sidebar:domain` 选举 | `ui.primaryPanel` × `meta.panel` |
| `AuxSidebarHost` | `aux-sidebar` 选区选举 + 辅助活动栏 | 显式选区（`ui.auxPanel`，辅助活动栏按钮点击置位）优先、`active()` 谓词回落，order 小者先；辅助活动栏（AuxActivityBar 常规布局列）= 各选区 rail 资产同级按钮（点非当选区展开 / 当选且展开时二次点击收起；available 谓词控可见性） |
| `SettingsPanel` | `settings:section` 选举 + 左树叶派生 + `settings:main-view` | `selectedNode` × `meta.section`（节）；叶序 = 贡献顶层 `order`（升序稳定） |
| `AgentPane` | `agent-pane:tab` 页签（经 sortedAgentSettingsTabs 解析） | 插件页签 order（缺省 100） |
| `ToolMessage` | `tool-card:result-view` 选举 | 精确名 → 正则族 → priority |
| `TurnDisplayItem` | `message:final-view` 选举 | match / priority |
| `ComposerDock`（SlotOutlet） | `conversation:dock-widget` list | order（决策 10 / 审批 20 / 排队 30 / 任务 40 / 目标 50——2026-09 重排） |
| `ConversationView`（SlotOutlet） | `conversation:header-widget` list | order（jobs 10 / gauge 20 / system-prompt 25 / actions 30） |
| `AppFrame`（SlotOutlet×3） | activity-bar / primary-sidebar / overlay（+ menu-bar/bottom-panel/status-bar 预留席，暂无 outlet） | order / single 选举 |
| `ActivityBar` | `activity-bar:plugin-actions` 数据席 | order（宿主渲染按钮） |

---

## 10. 阅读指引（按区域找代码）

| 区域 | 入口组件 | 包 |
|---|---|---|
| 应用壳/骨架布局 | `AppFrame.vue` | ac-client-ui-layout |
| 主区视图选举宿主 | `MainViewHost.vue`（+ `mainViews.ts`） | ac-client-ui-layout |
| 视角容器 | `PerspectiveHost.vue`（+ `perspectives.ts`） | ac-client-ui-layout |
| 活动栏 | `ActivityBarHost.vue → ActivityBar.vue` | ac-client-ui-layout |
| 主侧边栏壳 | `PrimarySidebarHost.vue` | ac-client-ui-layout |
| aux 区域宿主 + 辅助活动栏 | `AuxSidebarHost.vue` + `AuxActivityBar.vue`（+ `auxSidebarViews.ts`） | ac-client-ui-layout |
| 布局/面板状态 | `uiStore.ts` | ac-client-ui-layout |
| 会话内核（四形态） | `ConversationView.vue` | ac-client-ui-conversation |
| 消息区共享组件 | `TranscriptList.vue`（+ `useTurnDisplayItems.ts`） | ac-client-ui-conversation |
| 头部席位贡献 | `header/TokenGauge.vue`、`ConversationJobsChip.vue`、`AgentHeaderActions.vue`、`SingleHeaderActions.vue` | conversation / jobs / agents / singles |
| 消息/工具卡 | `TurnDisplayItem.vue / ToolMessage.vue` | ac-client-ui-conversation |
| 会话对（只读） | `ConversationView.vue` readonly 形态（runview 注册 pair） | ac-client-ui-conversation |
| 运行矩阵/跟踪 | `RunTracking.vue / RunTrackingPanel.vue` | ac-client-ui-runview |
| 设置面板 | `SettingsOverlayHost.vue → SettingsPanel.vue`（+ `sectionTree.ts`） | ac-client-ui-settings |
| 模型池 | `LlmPoolsHost.vue → PoolManager.vue` | ac-client-ui-llm-pool |
| 搜索引擎池 | `SearchPoolsHost.vue → SearchPoolManager.vue` | ac-client-ui-search-pool |
| Agent 管理 | `AgentSettingsHost.vue → AgentPane.vue` | ac-client-ui-agents |
| 群信息面板（aux 选区） | `GroupDrawer.vue` | ac-client-ui-group |
| 工作区 | `WorkspaceTreeHost.vue → WorkspaceTree.vue` | ac-client-ui-workspace |
| 弹窗族 | overlay 席位六件（§2 ⑤） | conversation/workspace/group/usage/system/settings |
| UI 原语 | `src/webui-kit/src/*.vue` | @agentchat/webui-kit |
