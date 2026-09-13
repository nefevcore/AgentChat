# UI 行册与 Slot 树实装

> **状态：实装行册（当前代码快照）。**
> 事实源 = 各行包 `client/index.ts` 的 declare/register 面 + 依赖图
> （`scripts/dep-cycles.yml`）；本文是**读侧汇总**，行/席位/贡献变更时
> 随步同步（本文不改装载语义——yml 行序无装载语义，phase 才有）。
> 席位/贡献/依赖矩阵均与现态一一对应；复核命令见 §4 注 9。
> 背景文档（过程档案）：`webui-slot-tree.md`（席位语义四分类 + ~230
> 建议名插口词表）、`m30-slot-semantics-refinement-plan.md`（席位语义
> 收口——elect/data 轴 + 改名 + 退役实录）、`archive/`（M27-M29
> 施工图与复审）。

## 0. 阅读指南

- **产出物清单**（§1）：26 前端行（基础六件 + 域行 20）+ 基建三包边界 +
  webui 终态。
- **Slot 树**（§2）：节点 = Slot 名（席位），叶 = `NULL`（空位/第三方
  扩展位）或具体 UI 控件（贡献组件）。树形按 AppFrame 渲染层级排布。
- **按插件包归属**（§3）：同一份数据换轴——每包「声明席位（owner）+
  注册贡献（contributor）」两栏，用于分析分解合理性；§3.5 附包依赖
  矩阵（R6/R7 守卫锁定）。
- 判定基准（§4）：owning = 声明方；域行贡献多经 `slots.inject` 声明
  存活期效应（席位在场即注册/缺席即等待/塌缩或卸载即回收）——例外
  见注 8（todo/workspace 裸 register，依赖装载时序）。

---

## 1. 产出物清单（26 前端行）

统一形态：`package.json`（`agentchat.plugin` + client 清单）+
`src/index.ts`（宿主半边 declareClient，派生名三处同名）+ `client/`
（插件半边）+ `tests/`（宿主半边 node / client 半边 jsdom 分文件 +
双向摘除用例；薄行〔ui-skill 等〕无独立 tests——覆盖走消费方测试族）。
cordis.yml 各占一行，双向可独立摘除（卸后端行 → RPC 失败三态静默空态；
卸 UI 行 → 前端消费面消失）。

「摘除」的限定语：**boot graph 层成立**（行停用 = 贡献面消失）；
**物理摘包会断 webui 构建**——base 行现存 5 条 R7 白名单边
（`scripts/dep-cycles.yml`，均为契约词汇消费，见 §3.5）需先消边。
依赖方向纪律由 check-deps R6/R7 守卫强制（base↛domain 新边一律
红灯；R6 扩权 .ts/.vue 同权重——跨域边全量显式裁决；白名单只减不增）。

### 基础六件（phase: `base`——封印前批次）

boot graph 内按行 id 字典序装载：**ui-conversation → ui-layout →
ui-renderer → ui-settings → ui-theme → ui-tool**（`ac-webui` 快照按
phase + 行 id 排序）。
这个次序解释了 register 姿势的分布（注 8）：conversation 先于 layout
装载，其对 layout 所属席位的贡献必须走 `slots.inject`；settings 在
layout 之后，可直接 register overlay。

| 包 | 行 id | 职责 |
|---|---|---|
| `ac-client-ui-conversation` | ui-conversation | 会话域：ctx.sessions（FeedCore/ChatCore）+ talk 视角 + message:final-view / conversation:dock-widget / conversation:header-widget 三席声明 + queue·interaction dock / token-gauge·system-prompt-preview 头部 / SystemPrompt overlay 出厂贡献 + ConversationView 四形态内核族（TranscriptList/ComposerDock） |
| `ac-client-ui-layout` | ui-layout | 应用壳：root 席 + AppFrame + 全骨架席位声明（12 席）+ 视角/主面板/选区选举解析面 + 左栏两壳（活动栏/主侧边栏）+ 辅助活动栏 + uiStore |
| `ac-client-ui-renderer` | ui-renderer | 渲染地基：vueRenderer/slotRender + SlotOutlet/SlotOutletItem 族 + markdown 管线（useMarkdown/abap-hljs）+ logger + ScrollableViewport |
| `ac-client-ui-settings` | ui-settings | 设置面板纯壳：左树（叶自 settings:section 贡献派生）+ 全局配置保存编排 + schema 引擎 + 设置 UI kit（SettingField/ConfirmDialog）+ 3 席声明；外域数据面 import 清零 |
| `ac-client-ui-theme` | ui-theme | 主题行：tokens 双主题 + themeStore |
| `ac-client-ui-tool` | ui-tool | 工具卡席位宿主：tool-card:result-view 声明 + toolLabel/toolIcon/toolResultViews 解析面 + 选举语义（零内联卡） |

### 域行（phase: `domain`——封印后动态批次，20 行）

| 包 | 行 id | 职责 | 主要贡献（席位 → 条目） |
|---|---|---|---|
| `ac-client-ui-todo` | ui-todo | todo 域 | tool-card `todo`；dock `todo`(10) |
| `ac-client-ui-jobs` | ui-jobs | 后台任务清单 | jobBoard 域投影 + ConversationJobsChip（conversation:header-widget 贡献 order 10） |
| `ac-client-ui-workspace` | ui-workspace | 工作区/文件面 | overlay `file-preview`(90)；aux-sidebar `workspace`（选区条目，自带 rail 资产）；fileApi 上传登记（白名单边） |
| `ac-client-ui-singles` | ui-singles | 独立会话 | primary-sidebar `sessions`；perspective `single`(40)；ctx.singleBoard；header-widget `single-actions`(30) |
| `ac-client-ui-group` | ui-group | 群域投影 + 群写侧（groupApi）+ 群信息面板 | overlay `create-dialog`(95)；perspective `group`(30)；aux-sidebar `group`(10)（群信息面板选区） |
| `ac-client-ui-agents` | ui-agents | 名册身份面 + agent 数据面单宿主（rosterApi：CRUD/池/配置读写）+ 编辑编排 useAgentSettings | primary-sidebar `agents`；settings:section `agents`(10)；ctx.roster + useRosterCore；header-widget `agent-actions`(30) |
| `ac-client-ui-runview` | ui-runview | 运行矩阵 | main `tracking`(50，选举条目)；primary-sidebar `tracking`；perspective `pair`(10)；fetchRuns 族 |
| `ac-client-ui-goal` | ui-goal | goal 域 | tool-card `goal`；dock `goal`(20)；goalApi/useGoalTracking |
| `ac-client-ui-usage` | ui-usage | Token 用量 | overlay `panel`(96)；usageApi |
| `ac-client-ui-skill` | ui-skill | 技能目录数据面 | skillsApi（纯数据行；ChatInput @ 提及消费，白名单边） |
| `ac-client-ui-system` | ui-system | 版本/备份 | overlay `version-dialog`(97)；systemApi（活动栏版本/备份入口消费，白名单边） |
| `ac-client-ui-timer` | ui-timer | 定时器视图 + 定时数据面（timerApi） | settings:section `sys.timer`(50)；TimerPane（供 AgentPane 跨包） |
| `ac-client-ui-shell` | ui-shell | shell 工具卡 | tool-card `bash` |
| `ac-client-ui-fs` | ui-fs | fs 工具卡 ×3 | tool-card `read`/`write`/`edit` |
| `ac-client-ui-web` | ui-web | web 工具卡 | tool-card `web_search` + BROWSER_FAMILY（正则双 def） |
| `ac-client-ui-browser` | ui-browser | 浏览器工具卡 | tool-card `browser` |
| `ac-client-ui-subagent` | ui-subagent | 子 Agent 卡 | tool-card `subagent` |
| `ac-client-ui-llm-pool` | ui-llm-pool | 模型池管理 + 池写/探测/发现面（poolApi） | settings:section `llmPools`(20) |
| `ac-client-ui-search-pool` | ui-search-pool | 搜索引擎池管理（SearchPoolManager + searchPoolApi 写面；后端无池服务——消费方 ac-web-tools 读 config.searchProviders） | settings:section `searchPools`(30) |
| `ac-client-ui-plugin-registry` | ui-plugin-registry | 插件库 + 插件数据面（pluginApi） | settings:section `pluginLibrary`(40)（四件） |

**边界**：基建三包 `ac-client-slots`（SlotCore 纯核 + SlotStoreAxis）、
`ac-client-runtime`（ClientContext/SlotRegistry/clientRuntime + viewer
端点单源）、`@agentchat/webui-kit`（设计原语）为纯库/运行时——不占行、
不可摘除。webui 终态 = main.ts 装配序列 + runtime 胶水（bootGraph/
rpcClient/wireFace）+ extensions bridge + api/wire·extensions +
utils/shims + 构建入口（45 文件 ~107KB；stores/ 与域 api 门面已退役，
utils/composables 余 re-export 维持旧路径）。

---

## 2. Slot 树（节点 = 席位；叶 = NULL / UI 控件）

> 标记：`〔k〕` kind（single=选举/list=序/chain=消费序）；`〔s〕` scope
> （session = store 座位实例轴按 conversationId 实例化）；`〔pub〕`
> 第三方可声明；`〔解〕` 解析面席位（注册表选举渲染，非 SlotOutlet DOM
> 渲染）；`〔注 n〕` 见 §4 分析注记。叶节点 `[包]` = 贡献方插件包。

```
root 〔k:single·factory——layout 出厂占用，封印后拒绝动态注册〕
└─ AppFrame [ui-layout]
   │  〔页面骨架词汇 = VSCode 布局同款：
   │   [menu-bar 顶部菜单栏·预留] / [activity-bar][primary-sidebar]
   │   [main][aux-sidebar] / [bottom-panel 底部面板·预留] /
   │   [status-bar 底部状态栏·预留] + overlay 覆盖层。三预留席 =
   │   declare 占名、无 outlet——实现时壳重构顶部/底部布局后开口〕
   │
   ├─ activity-bar 〔k:list——活动栏〕
   │  └─ ActivityBarHost [ui-layout]（活动栏壳）
   │     └─ activity-bar:plugin-actions 〔k:list·data·pub——第一段 =
   │        宿主件 ActivityBar 组件；数据席位：宿主渲染按钮，贡献供
   │        meta.def〕
   │        └─ NULL（第三方插件动作位——/ui-plugin/ 通道落点）〔注 1〕
   │
   ├─ primary-sidebar 〔k:list——主侧边栏〕
   │  └─ PrimarySidebarHost [ui-layout]（三面板壳）
   │     └─ primary-sidebar:domain 〔k:list·elect——选举席：壳按
   │        ui.primaryPanel 开关 × meta.panel 选举渲染，与外层
   │        primary-sidebar outlet 分离防叠加〕
   │        ├─ agents  → AgentListHost（名册面板）[ui-agents]
   │        ├─ sessions → SessionListHost（独立会话面板）[ui-singles]
   │        └─ tracking → RunTrackingPanel（运行面板）[ui-runview]
   │
   ├─ main 〔k:list·elect——主区视图席位（keyed 选举多选一：
   │  MainViewHost 按 active × order 选举；让位协议随各条目 active()
   │  住 owning 行（壳零域知识）；keepAlive 条目文档流保活 / volatile
   │  条目随选举挂卸；条目缺席 → 兜底 chat 直显〕
   │  ├─ chat(100) → PerspectiveHost [ui-layout]（恒真兜底；keepAlive =
   │  │  true——会话视图局部态〔草稿/滚动/卡片展开〕文档流保活）
   │  │  └─ main:perspective 〔k:list·elect·pub〕
   │  │     ├─ pair(10)  → ConversationView 内核·readonly 形态（会话对
   │  │     │             只读视角：a/b + readonly）[ui-runview]
   │  │     ├─ talk(20)  → ConversationView（1v1 会话视角）[ui-conversation]
   │  │     ├─ group(30) → ConversationView(group)（群视角）[ui-group]
   │  │     └─ single(40) → ConversationView(single)（独立会话视角）[ui-singles]
   │  │        │
   │  │        └─ ConversationView 内部（四形态共用骨架——同组件 props
   │  │           切换 = 原地 patch，切换语义统一）：
   │  │           ├─ conversation:dock-widget 〔k:list·s:session（第一段
   │  │           │  = 宿主件 ComposerDock；store 座位实例轴——entry.store
   │  │           │  工厂 × scopeKey=conversationId〕
   │  │           │  ├─ todo(10)       → TodoDockCard [ui-todo]
   │  │           │  ├─ goal(20)       → GoalDockCard [ui-goal]
   │  │           │  ├─ queue(30)      → QueueDockHost（排队 dock）[ui-conversation]
   │  │           │  ├─ interaction(40) → InteractionBar（ask_questions
   │  │           │  │                   决策 dock）[ui-conversation]
   │  │           │  └─ NULL（群/pair 视角整列隐藏；第三方 dock 卡扩展位）
   │  │           │
   │  │           ├─ conversation:header-widget 〔k:list——会话头动作区
   │  │           │  （ownerProps = form/agentId/conversationId/single，
   │  │           │  贡献按形态自取自gate）〕
   │  │           │  ├─ jobs-chip(10)       → ConversationJobsChip [ui-jobs]
   │  │           │  ├─ token-gauge(20)    → TokenGauge [ui-conversation]
   │  │           │  ├─ system-prompt-preview(25) → SystemPromptPreviewButton
   │  │           │  │                      （System Prompt 预览入口，弹窗走
   │  │           │  │                       overlay 席位）[ui-conversation]
   │  │           │  ├─ agent-actions(30)  → AgentHeaderActions（Agent 配置
   │  │           │  │                      + 删除确认随件内迁）[ui-agents]
   │  │           │  └─ single-actions(30) → SingleHeaderActions（归档独立
   │  │           │                         会话 + 确认随件内迁）[ui-singles]
   │  │           │
   │  │           └─ message:final-view 〔k:list·解——keyed final 视图，
   │  │              resolveMessageViewRenderer 按 match 选举〕
   │  │              ├─ user      → 内置 id（走 TurnDisplayItem 内建分支）
   │  │              ├─ assistant → 兜底内置（同上）
   │  │              └─ NULL（第三方经 registerMessageView 注册；未命中
   │  │                 回落内建 assistant 视图）
   │  │
   │  ├─ tracking(50) → RunTracking [ui-runview]（volatile——离开即卸载，
   │  │  runs 轮询随卸载停；active 自带让位协议：开关开 && 非 pair 只读
   │  │  视角；「选中让位」兜底 watch 亦随本行——选中 Agent/群/独立会话
   │  │  即收起矩阵与 pair）
   │  └─ NULL（第三方主区视图扩展位——未来全屏设置页/看板等）
   │
   ├─ aux-sidebar 〔k:list·elect——辅助侧边栏席位（第四区域本身，
   │  语义 = 右侧边栏；「工作区」= 众多选区之一，NULL 扩展位与各选区
   │  同级。AuxSidebarHost 按〔显式选区 ui.auxPanel 优先、active() 谓词
   │  回落 × order〕选举；**辅助活动栏**（AuxActivityBar 常规布局列，
   │  占位不覆盖、展开/收起均常驻）= 各选区 rail 资产同级按钮（点非
   │  当选区 = 展开〔activate 域侧激活 + 显式置位〕，当选且展开时二次
   │  点击 = 收起——活动栏同款；available 谓词控按钮可见性）；选区缺席
   │  → 区域整体消失（内在于选举）；显隐区域级——矩阵/视角切换不收起；
   │  选区缺省 volatile（keepAlive 旗标留作扩展位）〕
   │  ├─ group(10) → GroupDrawer（群信息面板选区；active = drawerOpen
   │  │  域态、available = 群视角有活跃群、rail activate = openDrawer；
   │  │  删除编排随件内迁）[ui-group]
   │  ├─ workspace → WorkspaceTreeHost → WorkspaceTree（恒真兜底选区；
   │  │  def 自带 rail {icon: folder-tree, title: 工作区}；volatile
   │  │  ——区域收起即卸载）[ui-workspace]
   │  └─ NULL（选区扩展位——与 workspace 同级：大纲/检查器等未来竞争）
   │
   ├─ overlay 〔k:list——全局覆盖层；order 显式定序，缺省 100〕
   │  ├─ system-prompt(88) → SystemPromptModal（自持开关态
   │  │                      ui.systemPromptOpen）[ui-conversation]
   │  ├─ file-preview(90)   → FilePreviewHost → FilePreviewModal [ui-workspace]
   │  ├─ create-dialog(95)  → CreateGroupHost → CreateGroupDialog [ui-group]
   │  ├─ panel(96)          → TokenUsageHost → TokenUsage（用量弹窗）[ui-usage]
   │  ├─ version-dialog(97) → VersionHost → VersionDialog [ui-system]
   │  ├─ webui-base-settings.panel(100 缺省) → SettingsOverlayHost [ui-settings]
   │  └─ NULL（第三方弹窗贡献位——z-index 配额/四态回落见 ownerProps）〔注 2〕
   │
   └─ tool-card:result-view 〔k:list·解——keyed 工具结果视图，
      resolveToolResultView 按 match/priority 选举；非 DOM 席位〕
      ├─ bash       → ToolResultTerminal [ui-shell]
      ├─ read/write/edit → ToolResultCode / Write / Edit [ui-fs]
      ├─ web_search → ToolResultWeb [ui-web]
      ├─ BROWSER_FAMILY（正则）→ ToolResultWeb [ui-web]
      ├─ browser    → ToolResultBrowser [ui-browser]
      ├─ subagent   → ToolResultSubagent [ui-subagent]
      ├─ todo       → ToolResultTodo [ui-todo]
      ├─ goal       → ToolResultGoal [ui-goal]
      └─ 未命中 → 文本渲染回落（宿主默认）〔注 3〕

settings 树（SettingsPanel 内，非 root 子树）：
├─ settings:main-view 〔k:list·pub·解——settings-tab:global 别名；
│  extensionTabs 解析面（sortedSettingsTabs）〕
│  └─ NULL（第三方全局设置页签位；出厂节叶自 settings:section 贡献派生）〔注 4〕
├─ agent-pane:tab 〔k:list·pub·解——settings-tab:agent 别名；
│  sortedAgentSettingsTabs 供 AgentPane 动态页签〕
│  └─ NULL（Agent 编辑页第三方页签位）
└─ settings:section 〔k:list·elect——选举席：SettingsPanel 按 selectedNode
   × meta.section 选举渲染（不经 outlet，防叠加）；节宿主自足取数
   （编辑编排/数据面随域，壳只管选举与全局保存）。左树数据化：贡献
   meta.section（选举键）/ meta.label（叶词条）+ 顶层 order（叶序轴）
   ——左树平铺叶自席位条目派生（sectionTree.ts），行装卸叶/节同步
   退场；默认选中守卫回落偏好叶 llmPools 否则首叶〕
   ├─ agents(10)        → AgentSettingsHost（label「Agent 设置」）[ui-agents]
   ├─ llmPools(20)      → LlmPoolsHost → PoolManager（label「模型管理」）[ui-llm-pool]
   ├─ searchPools(30)   → SearchPoolsHost → SearchPoolManager（label「搜索引擎」）[ui-search-pool]
   ├─ pluginLibrary(40) → PluginLibraryHost → 插件库节四件（label「插件库」）[ui-plugin-registry]
   └─ sys.timer(50)     → GlobalTimerHost（label「定时任务」）[ui-timer]
```

**席位总数：19**（layout 12 + settings 3 + tool 1 + conversation 3）。
按渲染形态分：DOM outlet 渲染 6（root/activity-bar/primary-sidebar/
overlay/conversation:dock-widget/conversation:header-widget）、解析面
选举 7（primary-sidebar:domain/main/aux-sidebar/main:perspective/
settings:section/tool-card:result-view/message:final-view）、页签别名
解析 2（settings:main-view/agent-pane:tab）、数据席 1
（activity-bar:plugin-actions）、骨架预留 3（declare 占名、无 outlet）。

---

## 3. 按插件包归属（换轴视图）

> 同一份数据按 owner/contributor 两栏重排。「声明」= 该席位的存在与
> ownerProps 契约归此包；「贡献」= 该包注册的条目（席位 → 条目）。
> 分析判定：看每包「声明数/贡献数」是否与其域职责相当（§4）。

### ui-layout（base）
- 声明（12）：`root`(single·factory)、`activity-bar`、`primary-sidebar`、
  `primary-sidebar:domain`(elect)、`main`(elect)、`aux-sidebar`(elect)、
  `overlay`、`menu-bar`/`bottom-panel`/`status-bar`（三骨架预留席——
  declare 占名、无 outlet）、`main:perspective`(pub·elect)、
  `activity-bar:plugin-actions`(pub·data)
- 贡献：root → AppFrame（出厂占用）；main → chat(100)（恒真兜底
  PerspectiveHost 宿主条目，keepAlive 文档流保活）；activity-bar →
  ActivityBarHost；primary-sidebar → PrimarySidebarHost

### ui-settings（base）
- 声明（3）：`settings:main-view`(pub)、`agent-pane:tab`(pub)、
  `settings:section`(elect——选举席)
- 贡献：overlay → SettingsOverlayHost（order 缺省 100）

### ui-tool（base）
- 声明（1）：`tool-card:result-view`（keyed 解析面·elect）
- 贡献：（零卡——解析面 resolveToolResultView + 静态表降级回落）

### ui-conversation（base）
- 声明（3）：`message:final-view`(elect)、`conversation:dock-widget`
  (session)、`conversation:header-widget`
- 贡献：message:final-view → user/assistant（内置 id，stub 组件走内建
  分支）；conversation:dock-widget → queue(30, store 工厂) +
  interaction(40)；conversation:header-widget → token-gauge(20) +
  system-prompt-preview(25)；
  overlay → system-prompt(88)；main:perspective → talk(20)

### ui-agents（domain）
- 贡献：primary-sidebar:domain → agents 面板；settings:section →
  agents 节（AgentSettingsHost + useAgentSettings 编辑编排自足；叶词条
  /叶序随贡献〔meta.label + order 10〕）；conversation:header-widget →
  agent-actions(30)

### ui-singles（domain）
- 贡献：primary-sidebar:domain → sessions 面板；main:perspective →
  single(40)；conversation:header-widget → single-actions(30)

### ui-runview（domain）
- 贡献：main → tracking(50)（运行矩阵主区视图——volatile，active 自带
  让位协议 + 选中让位兜底 watch 随本行）；primary-sidebar:domain →
  tracking 面板；main:perspective → pair(10)

### ui-group（domain）
- 贡献：overlay → create-dialog(95)；main:perspective → group(30)；
  aux-sidebar → group(10)（群信息面板选区 GroupDrawer——零 props 自
  服务：当前群取 ctx.groups、开合意愿 drawerOpen 域态）

### ui-workspace（domain）
- 贡献：overlay → file-preview(90)；aux-sidebar → workspace 选区
  （def 自带 rail 资产 {folder-tree 工作区}，恒真兜底）

### ui-usage（domain）
- 贡献：overlay → panel(96)

### ui-system（domain）
- 贡献：overlay → version-dialog(97)

### ui-timer（domain）
- 贡献：settings:section → sys.timer 节（meta.label + order 50）

### ui-llm-pool（domain）
- 贡献：settings:section → llmPools 节（节宿主自足取数；meta.label +
  order 20；严格镜像 ac-llm-pool 后端行的 llmProviders 面）

### ui-search-pool（domain）
- 贡献：settings:section → searchPools 节（SearchPoolManager +
  searchPoolApi 写面；meta.label + order 30。后端无池服务——消费方
  ac-web-tools 读 config.searchProviders，仅经 config RPC 契约面耦合）

### ui-plugin-registry（domain）
- 贡献：settings:section → pluginLibrary 节（PluginLibraryHost 自足
  取数；meta.label + order 40）

### ui-todo（domain）
- 贡献：tool-card → todo（label 任务清单/icon clipboard-list）；
  conversation:dock-widget → todo(10)

### ui-goal（domain）
- 贡献：tool-card → goal（label 目标管理/icon target）；
  conversation:dock-widget → goal(20)

### ui-shell / ui-fs / ui-web / ui-browser / ui-subagent（domain，工具卡行）
- ui-shell：tool-card → bash
- ui-fs：tool-card → read + write + edit
- ui-web：tool-card → web_search + BROWSER_FAMILY（正则）
- ui-browser：tool-card → browser
- ui-subagent：tool-card → subagent

### ui-jobs / ui-skill / ui-theme / ui-renderer（无席位贡献）
- ui-jobs：ctx.jobBoard 服务面 + ConversationJobsChip（header-widget
  贡献 order 10）
- ui-skill：skillsApi 纯数据行（ChatInput @ 提及清单拉取）
- ui-theme：themeStore + tokens（CSS 注入，无 slot 面）
- ui-renderer：渲染地基（SlotOutlet/vueRenderer 本体）

### 3.5 包依赖矩阵（package.json 运行时依赖实况）

> 行包静态运行时值边实况（R6/R7 守卫锁定；复核：
> `node scripts/check-deps.mjs`）。读法：行 → 列 = 该行包静态 import
> 列包模块（type-only 弱依赖不计，如 conversation → singles 的
> SingleSession）。跨相位/跨域边一律经 `scripts/dep-cycles.yml` 白名单
> 显式裁决（.ts/.vue 同权重，共 17 条：**5 条 base→domain + 12 条
> domain→domain**；判据 = 「RPC 包装/纯工具词/惰性取用口/可复用小件 =
> 契约词汇，不构成相位耦合」；只减不增）。

| 包（phase） | → 运行时依赖（* = 白名单边） | 形态注记 |
|---|---|---|
| renderer / theme / tool（base） | （零依赖） | 干净 base 行 |
| conversation（base） | layout · renderer · tool（toolLabel/toolIcon 词条解析）· agents*〔rosterAccess+rosterApi〕· workspace*〔fileApi〕· skill*〔skillsApi〕· llm-pool*〔池模型归一化〕 | 最重 base 行；四条白名单边均为 RPC/工具词消费 |
| layout（base） | conversation · renderer · theme · system*〔M28 §5.1 版本/备份动作〕 | 壳件：骨架席位 + 左栏两壳 + uiStore |
| settings（base） | layout | 纯壳 + 全局面：外域数据面 import 清零 |
| agents（domain） | conversation · settings · layout · theme · llm-pool*〔模型发现/池模型归一化〕· plugin-registry*〔ExtToolsPane 小件〕· timer*〔TimerPane+timerApi〕 | 域行反向依赖最多者；agent CRUD 单宿主（rosterApi） |
| group（domain） | conversation · layout · agents*〔roster 取用口+fetchAgents〕 | 视角 + aux group 选区贡献 |
| plugin-registry（domain） | settings · workspace*〔EntryPickerModal 小件〕 | 数据面 pluginApi 自足 |
| llm-pool（domain） | settings | poolApi 写/探测/发现面自足（对 agents 依赖为零） |
| search-pool（domain） | settings | 搜索引擎池单节（仅消费 settings 共享面） |
| timer（domain） | settings | timerApi 归域；全局定时 = 全局配置域 |
| runview（domain） | conversation · layout · theme · agents*〔useRosterCore〕· jobs*〔任务清单词汇〕 | 视图行 |
| singles（domain） | conversation · layout · theme · agents*〔useRosterCore〕· workspace*〔EntryPickerModal〕 | 视图行 |
| usage（domain） | layout · theme · agents*〔useRosterCore〕 | 视图行 |
| workspace / system（domain） | layout · renderer | 面板行 |
| fs（domain） | renderer · workspace*〔browseReadFile〕 | 卡行 |
| browser（domain） | workspace*〔fetchWorkspaceFile〕 | 卡行（无 renderer 依赖） |
| shell（domain） | renderer | 卡行 |
| todo / goal / web / subagent / skill / jobs（domain） | （零依赖） | 卡行/数据行干净 |

---

## 4. 分解合理性分析注记

1. **〔注 1〕activity-bar:plugin-actions 现为 NULL**：第三方插件动作位。
   出厂无贡献是预期形态——它是 `/ui-plugin/` 通道（extensions bridge
   双轨）的落点，非死席位。
2. **〔注 2〕overlay 的 order 序 = 视觉序锚**（88 → 90 → 95 → 96 → 97 →
   100 缺省）：新增弹窗行显式定序即可插队，无序竞争；z-index 配额
   （modal 1200 / installConfirm 1250 / governance 1280 / entryPicker 1300）
   与弹窗骨架四态回落见席位 ownerProps。
3. **〔注 3〕tool-card:result-view 未命中回落文本渲染**：宿主不残废
   红线的直接体现——卸任一卡行只损失该工具的富卡，消息流完整。
4. **〔注 4〕settings:main-view / agent-pane:tab 为空**：出厂节走
   settings:section 选举，左树平铺叶亦自其贡献派生（壳零出厂叶硬编码）；
   这两个 pub 席位是第三方扩展页签的别名位，当前零注册。若长期无第三方
   消费，可评估并席（属 ~230 插口「按需开口」纪律，不预裁）。
5. **声明/贡献比观察**：席位声明全部落在 base 行（layout 12 /
   settings 3 / tool 1 / conversation 3）——域行零声明、全贡献。这是
   「宿主退化为 slot 提供者」的终态判据达成证据：域行摘除不损失任何
   席位存在性，只损失贡献叶子；且该终态在依赖图层面同样成立
   （§3.5——base→domain 仅存 5 条定谳契约边）。
6. **工具卡行粒度**：fs 三卡同行、web 双 def（精确 + 浏览器族正则）
   同行——按「后端域 ↔ 卡行」镜像表判定，非按卡数机械拆分。若某卡
   需要独立演进，同 id 重注册替换机制天然支持。
7. **conversation 仍是最重行**（实测 ~521KB / 68 文件，其中 client
   半边 ~468KB / 38 文件〔14 个 .vue〕：sessions 核心 + ConversationView
   四形态内核族——composer 不拆的保守裁决仍生效）。它的分解收益已
   让位于轴/贡献机制（queue 状态已上轴），进一步拆分需新裁决点。
8. **register 姿势两式**（装载时序事实）：跨包席位的贡献多经
   `ctx.slots.inject(key, () => register(...))` 声明存活期效应——席位
   在场即注册、缺席即等待（裸 client 测试不炸）、声明塌缩/本行卸载即
   回收。例外是 **todo / workspace** 两行用裸 `ctx.slots.register`：它们
   只消费 base 先行装载已声明的席位（tool-card/dock-widget/overlay/
   aux-sidebar），运行时序内安全，但裸 client 测试须先手动 declare
   席位（见 todo-row.test）。同包 declare→register（layout/settings/
   conversation 的自家席位）天然时序安全，均直 register；conversation
   先于 layout 装载（base 行 id 序），故其对 overlay/main:perspective 的
   贡献走 inject，而 settings 在 layout 之后可直接 register overlay。
9. **数据一致性口径**：本文席位/条目快照与代码 declare/register 面
   一一对应；复核命令：
   `grep -rn "slots.declare(" src/ac-client-ui-*/client` +
   `grep -rn "slots.register(" src/ac-client-ui-*/client`；
   依赖矩阵与白名单实况复核：`node scripts/check-deps.mjs`。
