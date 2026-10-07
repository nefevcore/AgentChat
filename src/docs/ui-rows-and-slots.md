# UI 行册与 Slot 树实装（webui 治理事实源）

> **状态**：实装行册（**源码快照 2026-10-06 复核**——cr-269 webui 文档组治理）。
> **事实源**（本文一切数字取自下列四源；与源码冲突时以源码为准）：
> 1. **行表** = `src/cordis.yml` 的 30 条 `ui-*` 行 + `src/ac-app/src/index.ts` 行集（两表行集一致，有测试锁定）；
> 2. **装载面** = 各行包 `src/index.ts` 的 `declareClient({name,entry,platform,phase})` + `src/ac-client-ui-*/client/index.ts` 的 `slots.declare / register / inject` 调用面；
> 3. **边界账本** = `scripts/dep-cycles.yml`（R6/R7 白名单，只减不增）+ `scripts/check-deps.mjs`（守卫；相位表 = 各行包 `package.json` 的 `agentchat.client.phase`）；
> 4. **装载链路** = `src/webui/vite.config.ts` 的 `rowClientsPlugin`（扫 `src/ac-*/client/index.ts`，行名 = 去 `ac-client-` / `ac-` 前缀）+ `src/webui/src/runtime/bootGraph.ts`（`/api/ui/boot-graph` 图装载；行卸载即回收）。
>
> **复核命令见 §4 注 12**。本文不改装载语义（yml 行序无装载语义，`phase` 才有）。
>
> **过程档案（已归档，勿当现状读）**：`archive/webui-slot-tree.md`（v1 调研树 + ~230 建议名词表）、`archive/webui-component-tree.md`（前端组件树）、`archive/webui-plugin-ownership.md`（薄层归属地图 v2 / DSH 对照）——其有效结论已压缩为本文附录 A/B/C 并按源码校正。
> **另档**：`webui-mobile-render-perf-plan.md`（cr-258 立项的待实施计划，独立保留）；`m30-slot-semantics-refinement-plan.md`（M30 席位语义收口实录 = 席位语义裁决原文）。

---

## 0. 阅读指南

- **§1 行册**：30 前端行（base 6 + domain 24）+ 行形态统一契约 + 基建三包 / webui 薄壳边界。
- **§2 Slot 树**：节点 = 席位（19 席：layout 12 / settings 3 / conversation 3 / tool 1），叶 = `NULL`（扩展位）或具体贡献（组件 + 条目 id + order）。
- **§3 归属（换轴视图）**：3.1 声明表 / 3.2 贡献表（行 → 席位#条目）/ 3.3 依赖矩阵 / 3.4 白名单边界（R6/R7）。
- **§4 注记与裁决链**：14 条注记，含被取代方案的历史裁决（不删结论，只标「谁取代谁、为什么」）；注 12 = 复核命令。
- **标记约定**（树与表通用）：`k:single` / `k:list` = 席位 kind；`elect` = 选举席（解析面按谓词或显式键选举，不经 SlotOutlet 叠加）；`scope=session` = store 座位实例轴（`entry.store` 工厂 × scopeKey=conversationId）；`pub` = 第三方可声明；`data` = 数据席（宿主渲染条目，贡献只供 `meta.def`）；`(n)` = 条目 order（缺省 100）；`[包]` = 贡献方行包；`〔注 n〕` = §4 注记。

---

## 1. 行册（30 前端行）

**统一形态**：`package.json`（`agentchat.plugin` + `agentchat.client{platform,entry,phase}`）+ `src/index.ts`（宿主半边 = `ctx.webui.declareClient` 声明 boot graph 条目）+ `client/`（插件半边 = `clientPlugin({inject,apply})`）+ `tests/`（宿主半边 node / client 半边 jsdom 分文件 + 双向摘除用例；薄行无独立 tests，覆盖走消费方测试族）。

- **三处同名纪律**：boot graph 条目名 = 行 id = `ExtensionMeta.name` = `ui-<域>`；包名即身份（`ac-client-ui-<域>`，D19）。
- **「可摘除」的限定语**：**boot graph 层成立**（行停用 → 贡献面消失，席位于宿主不残废）；**物理摘包会断 webui 构建**——base 行现存 5 条 R7 白名单运行时边（§3.4），需先消边。
- 依赖方向纪律由 `check-deps` 的 R6/R7 强制（base↛domain 新边一律红灯；R6 覆盖 `.ts`/`.vue` 同权重；白名单只减不增）。
- 行规模（2026-10-06 实测，含 tests）：30 行 client 半边合计 **233 文件 / 106 个 `.vue` / ~2.34MB**；最重 = ui-conversation（包 ~983KB，client 830KB / 56 文件 / 21 `.vue`）。

### 1.1 基础六件（phase: `base`）

boot graph 内按 **phase → 行 id 字典序**装载：**ui-conversation → ui-layout → ui-renderer → ui-settings → ui-theme → ui-tool**。该次序直接解释 register 姿势分布（注 8）：conversation 先于 layout 装载，故其对 layout 所辖席位（overlay / main:perspective / aux-sidebar）的贡献必须走 `slots.inject`；settings 在 layout 之后，可直接 `register` overlay。

| 包 | 行 id | 职责 | 声明席位数 |
|---|---|---|---|
| `ac-client-ui-conversation` | ui-conversation | 会话域：ctx.sessions（FeedCore/ChatCore）+ talk 视角 + 会话头 / dock / 消息视图三席声明 + queue·approval·interaction dock 与 token-gauge 头部、System Prompt·文件编辑 aux 选区出厂贡献 + ConversationView 四形态内核族（TranscriptList/ComposerDock） | 3 |
| `ac-client-ui-layout` | ui-layout | 应用壳：root 席 + AppFrame + 全骨架席位声明（12 席）+ 视角 / 主面板 / 选区选举解析面 + 左栏两壳（活动栏 / 主侧边栏）+ 辅助活动栏 + uiStore | 12 |
| `ac-client-ui-renderer` | ui-renderer | 渲染地基：vueRenderer / slotRender + SlotOutlet / SlotOutletItem 族 + markdown 管线（useMarkdown / abap-hljs）+ logger + ScrollableViewport（零席位贡献） | 0 |
| `ac-client-ui-settings` | ui-settings | 设置面板纯壳：左树（叶自 `settings:section` 贡献派生）+ 全局配置保存编排 + schema 引擎 + 设置 UI kit（SettingField / ConfirmDialog）+ 3 席声明 + overlay 出厂贡献；外域数据面 import 清零 | 3 |
| `ac-client-ui-theme` | ui-theme | 主题行：tokens 双主题 + themeStore（零席位贡献） | 0 |
| `ac-client-ui-tool` | ui-tool | 工具卡席位宿主：`tool-card:result-view` 声明 + toolLabel / toolIcon / toolResultViews 解析面 + 选举语义（零内联卡） | 1 |

### 1.2 域行（phase: `domain`，24 行）

| 包 | 行 id | 职责 | 主要贡献（席位#条目） |
|---|---|---|---|
| `ac-client-ui-agents` | ui-agents | 名册身份面 + agent 数据面单宿主（rosterApi）+ 编辑编排 useAgentSettings | primary-sidebar:domain#agents；settings:section#agents(10)；conversation:header-widget#agent-actions(30) |
| `ac-client-ui-browser` | ui-browser | 浏览器工具卡 | tool-card:result-view#browser |
| `ac-client-ui-desktop-storage` | ui-desktop-storage | 桌面壳「存储管理」节（壳层桥消费；无桥自摘） | settings:section#storage(90) |
| `ac-client-ui-fs` | ui-fs | fs 工具卡 ×3 | tool-card:result-view#read / #write / #edit |
| `ac-client-ui-goal` | ui-goal | goal 域（goalApi / useGoalTracking） | tool-card:result-view#goal；conversation:dock-widget#goal(50) |
| `ac-client-ui-group` | ui-group | 群域投影 + 群写侧（groupApi）+ 群信息面板 | overlay#create-dialog(95)；main:perspective#group(30)；aux-sidebar#group(45) |
| `ac-client-ui-jobs` | ui-jobs | 后台任务清单（jobBoard 域投影） | conversation:header-widget#jobs-chip(10) |
| `ac-client-ui-llm-pool` | ui-llm-pool | 模型池管理 + 池写 / 探测 / 发现面（poolApi） | settings:section#llmPools(20) |
| `ac-client-ui-plugin-registry` | ui-plugin-registry | 插件库 + 插件数据面（pluginApi） | settings:section#pluginLibrary(40) |
| `ac-client-ui-remote` | ui-remote | 远程设备设置节（设备列表 / 吊销 / 配对；remote-link P1） | settings:section#remote(95) |
| `ac-client-ui-run-code` | ui-run-code | run_code 程序卡 | tool-card:result-view#run_code |
| `ac-client-ui-run-nodes` | ui-run-nodes | 会话 run 骨架面板（cr-230；无后端行） | aux-sidebar#run-nodes(27) |
| `ac-client-ui-runview` | ui-runview | 运行矩阵域（fetchRuns 族；client-only 行首例） | main#tracking(50)；primary-sidebar:domain#tracking；aux-sidebar#tracking(20)；main:perspective#pair(10) |
| `ac-client-ui-search-pool` | ui-search-pool | 搜索引擎池管理（searchPoolApi；无后端池服务，后端无池行） | settings:section#searchPools(30) |
| `ac-client-ui-shell` | ui-shell | shell 工具卡 ×2 | tool-card:result-view#bash / #pwsh |
| `ac-client-ui-singles` | ui-singles | 独立会话（ctx.singleBoard） | primary-sidebar:domain#sessions；main:perspective#single(40)；conversation:header-widget#single-actions(30) |
| `ac-client-ui-skill` | ui-skill | 技能目录数据面（skillsApi；纯数据行，零席位贡献） | — |
| `ac-client-ui-subagent` | ui-subagent | 子 Agent 卡 + 子会话视角 + 域投影（ctx.subagentBoard） | tool-card:result-view#subagent；main:perspective#subagent(9) |
| `ac-client-ui-system` | ui-system | 版本 / 备份（systemApi） | overlay#version-dialog(97) |
| `ac-client-ui-onboarding` | ui-onboarding | 首启向导（五步覆盖层：用户/模型/搜索/Agent/导览；首启 localStorage 标记一次 + 未配模型跳过确认） | overlay#wizard(98)；activity-bar:more-menu#onboarding(10) |
| `ac-client-ui-timer` | ui-timer | 定时器视图 + 定时数据面（timerApi） | aux-sidebar#timers(30) |
| `ac-client-ui-todo` | ui-todo | todo 域 | tool-card:result-view#todo；conversation:dock-widget#todo(40) |
| `ac-client-ui-usage` | ui-usage | Token 用量（usageApi） | overlay#panel(96)；aux-sidebar#usage(15) |
| `ac-client-ui-web` | ui-web | web 工具卡 + 网络搜索面板 | tool-card:result-view#web_search / #BROWSER_FAMILY（正则）；aux-sidebar#search(12) |
| `ac-client-ui-workspace` | ui-workspace | 工作区 / 文件面（fileApi 上传登记） | overlay#file-preview(90)；aux-sidebar#preview(10) / #workspace(40) |

### 1.3 边界与薄壳

- **基建三包**（纯库 / 运行时，不占行、不可摘除）：`ac-client-slots`（SlotCore 纯核 + SlotStoreAxis）、`ac-client-runtime`（ClientContext / SlotRegistry / clientRuntime）、`@agentchat/webui-kit`（设计原语：50 文件 / 41 个 `.vue`）。
- **webui 薄壳** = `src/webui/src`（45 文件 / ~124KB：api、core、runtime、settings、shims、types、utils、composables + `main.ts` / `isolated-runtime.ts` / `preview-main.ts` / `env.d.ts`）。装配序列第④步 = `runtime/bootGraph.ts`（图装载 + 热通道）；`stores/` 与域 api 门面已退役（`utils` / `composables` 余 re-export 维持旧路径）。
- **相关不占行包**：`ac-webui`（宿主行：下发 `/api/ui/boot-graph` + `/ui-plugin/` 静态路由 + `webui/extensions-changed` 帧）、`ac-webui-extensions`（第三方 UI 声明词汇表纯数据包；行已退役，见裁决链）。

---

## 2. Slot 树

树按 AppFrame 渲染层级排布；席位 schema 与贡献面由 §3 两表核对。

```text
root 〔k:single·factory——layout 出厂占用 webui-base-layout.app-frame(0)，封印后拒绝动态注册〕
└─ AppFrame [ui-layout]
   │  〔页面骨架词汇 = VSCode 布局同款：[menu-bar 顶部菜单栏·预留] /
   │   [activity-bar][primary-sidebar] / [main][aux-sidebar] / [bottom-panel·预留] /
   │   [status-bar·预留] + overlay 覆盖层〕
   ├─ activity-bar 〔k:list〕→ ActivityBarHost [ui-layout]
   │  ├─ activity-bar:plugin-actions 〔k:list·data·pub〕
   │  │     └─ NULL（第三方插件动作位——/ui-plugin/ 通道落点）〔注 1〕
   │  └─ activity-bar:more-menu 〔k:list·data·pub〕（cr-301：更多菜单项位——两项硬编码之外的数据化追加面）
   │        └─ 「新手引导」重播项 [ui-onboarding]
   ├─ primary-sidebar 〔k:list〕→ PrimarySidebarHost [ui-layout]
   │  └─ primary-sidebar:domain 〔k:list·elect——按 ui.primaryPanel × meta.panel 选举，
   │     与外层 primary-sidebar outlet 分离防叠加〕
   │     ├─ agents   → AgentListHost（meta.panel=agents）[ui-agents]
   │     ├─ sessions → SessionListHost（meta.panel=sessions）[ui-singles]
   │     └─ tracking → RunTrackingPanel（meta.panel=tracking）[ui-runview]
   ├─ main 〔k:list·elect——主区视图选举：active() 谓词 × order 小者先〕
   │  ├─ perspective-host(100) → PerspectiveHost（恒真兜底；keepAlive 保活）[ui-layout]
   │  │  └─ main:perspective 〔k:list·elect·pub〕
   │  │     ├─ subagent(9)  → SubagentConversationView [ui-subagent]
   │  │     ├─ pair(10)     → ConversationView（readonly 只读形态）[ui-runview]
   │  │     ├─ talk(20)     → ConversationView（1v1）[ui-conversation]
   │  │     ├─ group(30)    → ConversationView(group) [ui-group]
   │  │     ├─ single(40)   → ConversationView(single) [ui-singles]
   │  │     └─ NULL（第三方主区视图扩展位）
   │  ├─ tracking(50) → RunTracking（volatile——离开即卸载，轮询随卸载停）[ui-runview]
   │  └─ NULL（第三方主区视图扩展位——未来全屏设置页 / 看板等）
   ├─ aux-sidebar 〔k:list·elect——辅助侧边栏区域（第四区域本身）
   │  │  选举 = 显式选区 ui.auxPanel 优先、active() 回落 × def.order 小者先；
   │  │  rail 按钮序 = def.order；选区缺省 volatile（keepAlive 旗标留作扩展位）；
   │  │  无当选选区且无 rail 按钮（行卸载）→ 区域整体消失〕
   │  ├─ preview(10)    → FilePreviewPanelHost [ui-workspace]
   │  ├─ search(12)     → WebSearchPanelHost [ui-web]
   │  ├─ usage(15)      → TokenUsagePanelHost（keepAlive）[ui-usage]
   │  ├─ tracking(20)   → RunTrackingSidebarHost（keepAlive；rail badge=运行中会话数）[ui-runview]
   │  ├─ file-edits(24) → FileEditsPanelHost（keepAlive）[ui-conversation]
   │  ├─ run-nodes(27)  → RunNodesHost [ui-run-nodes]
   │  ├─ timers(30)     → TimersPanelHost（keepAlive）[ui-timer]
   │  ├─ prompt(35)     → SystemPromptPanelHost（keepAlive）[ui-conversation]
   │  ├─ workspace(40)  → WorkspaceTreeHost（恒真兜底选区；def 自带 rail 资产）[ui-workspace]
   │  ├─ group(45)      → GroupDrawer（available=群视角有活跃群才露按钮）[ui-group]
   │  └─ NULL（选区扩展位——与 workspace 同级：大纲 / 检查器等未来竞争）
   ├─ overlay 〔k:list——全局覆盖层；order 显式定序，缺省 100〕
   │  ├─ file-preview(90)   → FilePreviewHost [ui-workspace]
   │  ├─ create-dialog(95)  → CreateGroupHost [ui-group]
   │  ├─ panel(96)          → TokenUsageHost [ui-usage]
   │  ├─ version-dialog(97) → VersionHost [ui-system]
   │  ├─ wizard(98)        → WizardOverlay（首启向导——首启一次 + 更多菜单重播）[ui-onboarding]
   │  ├─ webui-base-settings.panel(100 缺省) → SettingsOverlayHost [ui-settings]
   │  └─ NULL（第三方弹窗贡献位——z-index 配额 / 四态回落见 ownerProps）〔注 2〕
   └─ menu-bar / bottom-panel / status-bar 〔k:list——骨架预留：declare 占名、无 outlet〕
```

```text
ConversationView 四形态内核（main:perspective 各视角共用骨架——同组件 props 切换 = 原地 patch）：
├─ conversation:dock-widget 〔k:list·scope=session——composer 上方 dock 卡列；
│  │  ownerProps：refreshPattern=tool/after-execute · loop/after-run；triState=true〕
│  ├─ interaction(10) → InteractionBar（ask_questions 决策 dock）[ui-conversation]
│  ├─ approval(20)    → ApprovalBar（提权审批 dock）[ui-conversation]
│  ├─ queue(30)       → QueueDockHost（store 座位实例轴）[ui-conversation]
│  ├─ todo(40)        → TodoDockCard [ui-todo]
│  ├─ goal(50)        → GoalDockCard [ui-goal]
│  └─ NULL（群 / pair 视角整列隐藏；第三方 dock 卡扩展位）
├─ conversation:header-widget 〔k:list——会话头动作区；ownerProps = form / agentId /
│  │  conversationId / single，贡献按形态自取自 gate〕
│  ├─ jobs-chip(10)      → ConversationJobsChip [ui-jobs]
│  ├─ token-gauge(20)    → TokenGauge（占用仪表 + 详情弹层 + 归档入口）[ui-conversation]
│  ├─ agent-actions(30)  → AgentHeaderActions（Agent 配置 + 删除确认随件内迁）[ui-agents]
│  └─ single-actions(30) → 独立会话动作族 [ui-singles]
└─ message:final-view 〔k:list·elect·pub——keyed final 视图，按 match / priority 选举〕
   ├─ user / assistant → 内建 id（走 TurnDisplayItem 内建分支；注册 component 为 stub）
   └─ NULL（第三方经 registerMessageView 注册；未命中回落内建 assistant 视图）

settings 树（SettingsPanel 壳内，非 root 子树）：
├─ settings:main-view 〔k:list·pub——settings-tab:global 别名；sortedSettingsTabs 解析面〕
│  └─ NULL（第三方全局设置页签位；出厂节叶自 settings:section 贡献派生）〔注 4〕
├─ agent-pane:tab 〔k:list·pub——settings-tab:agent 别名；sortedAgentSettingsTabs 供 AgentPane〕
│  └─ NULL（Agent 编辑页第三方页签位）
└─ settings:section 〔k:list·elect——按 selectedNode × meta.section 选举；
   │  叶序 = 贡献顶层 order；左树叶自席位条目派生（壳零出厂叶硬编码）〕
   ├─ agents(10)        → AgentSettingsHost（label：Agent 设置）[ui-agents]
   ├─ llmPools(20)      → LlmPoolsHost → PoolManager（label：模型管理）[ui-llm-pool]
   ├─ searchPools(30)   → SearchPoolsHost → SearchPoolManager（label：搜索引擎）[ui-search-pool]
   ├─ pluginLibrary(40) → PluginLibraryHost（label：插件库）[ui-plugin-registry]
   ├─ storage(90)       → StorageHost（label：存储管理；桌面壳桥自探活，无桥自摘）[ui-desktop-storage]
   └─ remote(95)        → RemoteDevices（label：远程设备）[ui-remote]

tool-card:result-view 〔k:list·elect·pub——非 DOM 席位：精确名 → 正则族 → priority 选举〕
├─ bash / pwsh → ToolResultTerminal [ui-shell]
├─ read → ToolResultCode / write → ToolResultWrite / edit → ToolResultEdit [ui-fs]
├─ web_search → ToolResultWeb / BROWSER_FAMILY（正则）→ ToolResultWeb [ui-web]
├─ browser → ToolResultBrowser [ui-browser]
├─ subagent → ToolResultSubagent [ui-subagent]
├─ run_code → ToolResultRunCode [ui-run-code]
├─ todo → ToolResultTodo [ui-todo]
├─ goal → ToolResultGoal [ui-goal]
└─ 未命中 → 文本渲染回落（宿主默认）〔注 3〕
```

**席位总数 20**（layout 13 + settings 3 + conversation 3 + tool 1）。按渲染形态分：**DOM outlet 6**（root / activity-bar / primary-sidebar / overlay / conversation:dock-widget / conversation:header-widget）、**解析面选举 7**（primary-sidebar:domain / main / aux-sidebar / main:perspective / settings:section / tool-card:result-view / message:final-view）、**页签别名解析 2**（settings:main-view / agent-pane:tab）、**数据席 2**（activity-bar:plugin-actions / activity-bar:more-menu）、**骨架预留 3**（menu-bar / bottom-panel / status-bar）。

---

## 3. 归属（换轴视图：声明方 owning / 贡献方 contributing）

判定基准：**owning = 声明方**（`slots.declare` 的那一行）；域行贡献多经 `slots.inject(seat, () => register(...))` 声明存活期效应（**席位在场即注册 / 缺席即等待 / 塌缩或卸载即回收**），例外见注 8。

### 3.1 声明表（19 席 → owner 行）

| 席位 | kind / 修饰 | owner 行 | 渲染 / 解析面 |
|---|---|---|---|
| `root` | single·factory | ui-layout | `renderSlot(root)`（main.ts AcClientRoot；出厂条 `webui-base-layout.app-frame`） |
| `activity-bar` | list | ui-layout | ActivityBarHost（SlotOutlet） |
| `activity-bar:plugin-actions` | list·data·pub | ui-layout | ActivityBar 壳渲染按钮，贡献只供 `meta.def` |
| `activity-bar:more-menu` | list·data·pub | ui-layout | ActivityBar「更多」菜单追加项（cr-301——两项硬编码之后按 order 升序；出厂贡献 = ui-onboarding「新手引导」） |
| `primary-sidebar` | list | ui-layout | PrimarySidebarHost（SlotOutlet） |
| `primary-sidebar:domain` | list·elect | ui-layout | PrimarySidebarHost 选举（`ui.primaryPanel` × `meta.panel`） |
| `main` | list·elect | ui-layout | MainViewHost（`active()` × order 小者先；keepAlive 条目 v-show 保活） |
| `aux-sidebar` | list·elect | ui-layout | AuxSidebarHost（显式选区优先 → `active()` 回落 × def.order）+ AuxActivityBar（rail） |
| `overlay` | list | ui-layout | AppFrame SlotOutlet（order 显式定序） |
| `main:perspective` | list·elect·pub | ui-layout | PerspectiveHost（`active()` × order；四视角同组件 props 切换） |
| `menu-bar` / `bottom-panel` / `status-bar` | list（骨架预留） | ui-layout | 无 outlet——declare 占名（实现时壳重构顶部/底部布局后开口） |
| `settings:main-view` | list·pub | ui-settings | SettingsPanel（`sortedSettingsTabs`；`settings-tab:global` 别名） |
| `agent-pane:tab` | list·pub | ui-settings | AgentPane（`sortedAgentSettingsTabs`；`settings-tab:agent` 别名） |
| `settings:section` | list·elect | ui-settings | SettingsPanel（`selectedNode` × `meta.section`；左树叶序 = 贡献顶层 order） |
| `conversation:dock-widget` | list·scope=session | ui-conversation | ComposerDock SlotOutlet（order；`entry.store` 工厂 × scopeKey=conversationId） |
| `conversation:header-widget` | list | ui-conversation | ConversationView SlotOutlet（order） |
| `message:final-view` | list·elect·pub | ui-conversation | TurnDisplayItem（match / priority） |
| `tool-card:result-view` | list·elect·pub | ui-tool | ToolMessage（精确名 → 正则族 → priority） |

### 3.2 贡献表（30 行 → 席位#条目）

| 行 | 贡献（席位#条目(order)） | 说明 |
|---|---|---|
| ui-layout | root#webui-base-layout.app-frame(0)；main#webui-base-layout.perspective-host(100)；activity-bar#webui-base-layout.activity-bar；primary-sidebar#webui-base-layout.primary-sidebar | 出厂骨架 + 自家 12 席声明（同包 declare→register，直 register） |
| ui-conversation | conversation:dock-widget#interaction(10) / #approval(20) / #queue(30)；conversation:header-widget#token-gauge(20)；aux-sidebar#prompt(35) / #file-edits(24)；main:perspective#talk(20)；message:final-view#内置 user / assistant（BUILTIN_MESSAGE_VIEWS） | 跨包席位一律 `inject` 落位（本行先于 layout 装载） |
| ui-settings | overlay#webui-base-settings.panel（缺省 100） | 自家 3 席声明 + 出厂 overlay |
| ui-tool | —（零贡献：宿主行只有席位声明与解析面） | toolLabel / toolIcon / toolResultViews 解析面 |
| ui-renderer | — | 无席位贡献（渲染地基资产） |
| ui-theme | — | 无席位贡献（tokens / themeStore） |
| ui-skill | — | 无席位贡献（skillsApi 数据面） |
| ui-agents | primary-sidebar:domain#agents；settings:section#agents(10)；conversation:header-widget#agent-actions(30) | 三处均 `inject` |
| ui-browser | tool-card:result-view#browser | |
| ui-desktop-storage | settings:section#storage(90) | 无桥（非桌面形态）→ 宿主自摘本节 |
| ui-fs | tool-card:result-view#read / #write / #edit | 三卡一行（同后端域） |
| ui-goal | tool-card:result-view#goal；conversation:dock-widget#goal(50) | |
| ui-group | overlay#create-dialog(95)；main:perspective#group(30)；aux-sidebar#group(45) | aux 选区 available=群视角有活跃群 |
| ui-jobs | conversation:header-widget#jobs-chip(10) | 另含 jobBoard 域投影 |
| ui-llm-pool | settings:section#llmPools(20) | |
| ui-plugin-registry | settings:section#pluginLibrary(40) | |
| ui-remote | settings:section#remote(95) | |
| ui-run-code | tool-card:result-view#run_code | |
| ui-run-nodes | aux-sidebar#run-nodes(27) | cr-230；无后端行 |
| ui-runview | main#tracking(50)；primary-sidebar:domain#tracking；aux-sidebar#tracking(20)；main:perspective#pair(10) | 四轴齐发；让位 watch 随本行 |
| ui-search-pool | settings:section#searchPools(30) | 搜索池无后端池行 |
| ui-shell | tool-card:result-view#bash / #pwsh | 2026-09-16 工具拆分双名，同组件 ToolResultTerminal |
| ui-singles | primary-sidebar:domain#sessions；main:perspective#single(40)；conversation:header-widget#single-actions(30) | |
| ui-subagent | tool-card:result-view#subagent；main:perspective#subagent(9) | order 9 显式居 pair(10) 前（互斥置位，防御序） |
| ui-system | overlay#version-dialog(97) | |
| ui-timer | aux-sidebar#timers(30) | 定时任务聚合 aux 选区（settings sys.timer 节已撤，见裁决链） |
| ui-todo | tool-card:result-view#todo；conversation:dock-widget#todo(40) | 裸 register（注 8） |
| ui-usage | overlay#panel(96)；aux-sidebar#usage(15) | |
| ui-web | tool-card:result-view#web_search / #BROWSER_FAMILY(正则)；aux-sidebar#search(12) | 双 def 同行（精确 + 族） |
| ui-workspace | overlay#file-preview(90)；aux-sidebar#preview(10) / #workspace(40) | 裸 register（注 8）；两选区并存同轴竞争 |

### 3.3 依赖矩阵（各行包 `package.json` 运行时依赖；只列 `ac-*` / `@agentchat/*` 非 kit 项）

`✓R6` / `✓R7` = 该边在 `scripts/dep-cycles.yml` 白名单内；未标 ✓ 的域名依赖 = 非运行时边（type-only）或同相位依赖。

| 行包 | base 依赖 | domain 依赖 |
|---|---|---|
| ui-layout | renderer、theme（+ slots） | system（`✓R7`） |
| ui-conversation | layout、renderer、tool（+ slots） | agents（`✓R7`）、workspace（`✓R7`）、skill（`✓R7`）、llm-pool（`✓R7`）、singles（仅 `import type`，不计边——注 11） |
| ui-settings | layout（+ slots）、ac-webui-extensions（纯数据包） | — |
| ui-tool / ui-theme / ui-renderer | —（renderer 仅 slots/runtime） | — |
| ui-agents | conversation、layout、settings、theme | llm-pool（`✓R6`）、plugin-registry（`✓R6`）、timer（`✓R6`） |
| ui-browser | — | workspace（`✓R6`） |
| ui-fs | renderer | workspace（`✓R6`） |
| ui-group | conversation、layout | agents（`✓R6`） |
| ui-plugin-registry | settings | workspace（`✓R6`） |
| ui-runview | conversation、layout、theme | agents（`✓R6`）、jobs（`✓R6`） |
| ui-singles | conversation、layout、theme | agents（`✓R6`）、workspace（`✓R6`） |
| ui-subagent | conversation、layout、theme | agents（`✓R6`）、jobs（`✓R6`） |
| ui-usage | layout、theme | agents（`✓R6`） |
| ui-timer | layout、settings | agents（`✓R6`） |
| ui-run-code | renderer、tool | — |
| ui-run-nodes | conversation、layout | — |
| ui-system | layout、renderer | — |
| ui-web | layout | — |
| ui-workspace | layout、renderer | — |
| ui-remote | settings | — |
| ui-search-pool / ui-llm-pool | settings | — |
| ui-desktop-storage / ui-goal / ui-jobs / ui-skill / ui-shell / ui-todo | —（仅 runtime） | — |

### 3.4 白名单边界（`scripts/dep-cycles.yml`，20 边：5 R7 + 15 R6）

**R7（base → domain，5 条）**

| from → to | 判据（M29 P2-1 定谳：RPC 包装 / 纯工具词 / 惰性取用口 = 契约词汇） |
|---|---|
| ui-layout → ui-system | 版本入口动作跨行消费（backupNow / fetchVersion = system 域 RPC 词汇） |
| ui-conversation → ui-agents | rosterAccess 惰性取用口 + rosterApi 直连（TokenGauge / AgentHeaderActions / ChatInput 池清单） |
| ui-conversation → ui-workspace | fileApi 上传登记门面（thin typed wrapper，零域内状态消费） |
| ui-conversation → ui-skill | ChatInput skillsApi（@ 提及的技能清单拉取） |
| ui-conversation → ui-llm-pool | ChatInput 池清单（模型选择数据面） |

**R6（domain → domain，15 条）**：ui-agents → llm-pool / plugin-registry / timer；ui-timer → agents；ui-browser → workspace；ui-fs → workspace；ui-group → agents；ui-plugin-registry → workspace；ui-runview → agents / jobs；ui-subagent → agents / jobs；ui-singles → agents / workspace；ui-usage → agents。

**纪律**：白名单**只减不增**（新增边不在册 = 红；边已消化而条目未删 = 红）；每消化一环即删条目，清零即除役白名单机制本身。R6 自 2026-09-11 扩权为 `.ts` / `.vue` 同权重（消 .vue 媒介盲区）。

---

## 4. 注记与裁决链

### 4.1 结构注记

1. **〔注 1〕activity-bar:plugin-actions 现为 NULL**：第三方插件动作位。出厂无贡献是预期形态——它是 `/ui-plugin/` 通道（extensions bridge 双轨）的落点，非死席位。
2. **〔注 2〕overlay 的 order 序 = 视觉序锚**（90 → 95 → 96 → 97 → 100 缺省）：新增弹窗行显式定序即可插队，无序竞争；z-index 配额（modal 1200 / installConfirm 1250 / governance 1280 / entryPicker 1300）与弹窗骨架四态回落见席位 ownerProps。
3. **〔注 3〕tool-card:result-view 未命中回落文本渲染**：宿主不残废红线的直接体现——卸任一卡行只损失该工具的富卡，消息流完整。
4. **〔注 4〕settings:main-view / agent-pane:tab 出厂零注册**：出厂节走 settings:section 选举，左树平铺叶亦自其贡献派生（壳零出厂叶硬编码）；两席是第三方扩展页签的别名位。若长期无第三方消费，可评估并席（属「按需开口」纪律，不预裁）。
5. **声明 / 贡献比观察**：19 席全部由 base 行声明，域行零声明、全贡献——「宿主退化为 slot 提供者」的终态判据已达成：域行摘除不损失任何席位存在性，只损失贡献叶；依赖图层面同样成立（base→domain 仅存 5 条定谳契约边）。
6. **工具卡行粒度**：按「后端域 ↔ 卡行」镜像表判定（fs 三卡同行、web 双 def 同行、shell 双名同行），非按卡数机械拆分；若某卡需独立演进，同 id 重注册替换机制天然支持。
7. **conversation 仍是最重行**（2026-10-06 实测：包 ~983KB，client 830KB / 56 文件 / 21 个 `.vue`）：sessions 核心 + ConversationView 四形态内核族——composer 不拆的保守裁决仍生效，进一步拆分需新裁决点。
8. **register 姿势两式（装载时序事实）**：跨包席位贡献多经 `ctx.slots.inject(key, () => register(...))` 声明存活期效应（席位在场即注册 / 缺席即等待 / 声明塌缩或本行卸载即回收）；例外 = **ui-todo / ui-workspace** 用裸 `register`（只消费 base 先行装载已声明的席位，运行时序内安全，但裸 client 测试须先手动 declare 席位）；同包 declare→register（layout / settings / conversation 自家席位）天然时序安全，直 register。
9. **席位语义轴（M30 收口已实施）**：席位词表 = kind（single / list）+ elect（选举扶正，取代旧 priority 特例语义）+ data（数据席）；旧「keyed presentation / 白名单 UISlotId」词汇退役。**useSeatOccupancy 门控原语已除役**（D3 及其后记：随主区 / aux 语义纯化同批）——占用门控内在于选举，源码仅存注释与测试注记（`ac-client-ui-renderer/tests/renderer-client.test.ts`）。
10. **服务端注册表退役（M30 D7 已实施）**：`ctx.uiExtensions` + BUILTIN_SLOTS 白名单删除（`ac-webui-extensions` 行退役；词汇表 slotCatalog 留包转纯库）。第三方 UI 链路 = manifest.ui → `ctx.webui.addEntry` → 浏览器 SlotRegistry；`webui` 行只负责 boot graph 下发 + `/ui-plugin/` 静态路由。
11. **两行的 `agentchat.client` 元数据缺失（遗留项）**：`ac-client-ui-desktop-storage` 与 `ac-client-ui-remote` 的 `package.json` 只有 `agentchat.plugin=true`，无 `agentchat.client{phase}`——其宿主半边 `declareClient` 已正确声明 `phase=domain`，vite 行发现也不依赖该字段，故**运行/装载不受影响**；但 `check-deps` 的相位表（`pkg.agentchat.client.phase`）不含这两行 → 其跨行静态边不受 R6/R7 扫描（当前无违例）。另：`ui-conversation → ui-singles` 仅 `import type`，按纪律不计运行时边（旧组件树文档曾按声明依赖误计 17 条边）。
12. **〔注 12〕复核命令（2026-10-06 口径）**：
    - 席位声明面：`grep -rn 'slots.declare(' src/ac-client-ui-*/client`
    - 贡献面：`grep -rn 'slots.register(' src/ac-client-ui-*/client`（配 `slots.inject(` 判存活期效应）
    - 行集：比对 `src/cordis.yml` 的 `- id:` 条目与 `src/ac-app/src/index.ts` 行表（测试锁定两表一致）
    - 行发现：`src/webui/vite.config.ts` 的 `discoverRowClients()`（扫 `src/ac-*/client/index.ts`）
    - 边界：`node scripts/check-deps.mjs`（R6/R7 + 白名单只减不增）
13. **dock 序重排（2026-09-13）已生效**：旧账（todo 10 / goal 20 / queue 30 / interaction 40）作废——现序 = 决策 interaction(10) → 审批 approval(20) → 排队 queue(30) → 任务 todo(40) → 目标 goal(50)（待办行动卡置顶，环境锚点下沉）。
14. **本次复核对旧版账目的修正**（旧版为治理前快照，数字与叶子已过时）：
    - 行数：26 → **30 行**（旧版漏 ui-run-code / ui-desktop-storage / ui-remote / ui-run-nodes 等）；域行口径（20 与 21 两处自相矛盾）统一为 24。
    - 席位叶子：dock 序见注 13；会话头补 single-actions(30)；overlay 撤 system-prompt(88)、增 storage(90) / remote(95)；conversation 增 aux 两选区（prompt 35 / file-edits 24）；aux 新增 search(12) / usage(15) / run-nodes(27) / timers(30) / group(45)；main:perspective 增 subagent(9)；tool-card 增 pwsh / run_code；settings:section 撤 sys.timer(50)、增 storage(90) / remote(95)。
    - **primary-sidebar:domain 三条目不带 order**（旧版 10 / 20 / 40 系误读 `meta.def` 字段）：选举键 = `ui.primaryPanel` × `meta.panel`。
    - 规模数字按 2026-10-06 实测刷新（webui 薄壳 45 文件 ~124KB；client 半边 233 文件 / 106 个 `.vue` / ~2.34MB；webui-kit 41 个 `.vue`）。

### 4.2 裁决链（被取代方案的结论保留——历史裁决不是待办）

1. **薄层形态三轮裁决**：v1「宿主保留聊天骨架 + 各域挂贡献者」被否 → v2（`archive/webui-plugin-ownership.md`，对齐 DSH webui 实证）改为「浏览器跑客户端运行时，可视面 100% 按域拆 client-ui 插件包，webui 瘦到运行时 + slot 基建 + 构建入口」 → **D19 改裁**：域 UI 的物理落点 = **各前端行包 `client/` 半边**（当时基础件定「常驻 webui clients/base、不建独立包」） → **M27.2 再进一步**：基础件同样出包（layout / conversation / renderer / settings / theme / tool）——当前态即此。前两轮的判据（数据面归属 / 跨域聚归宿主 / 可摘除性验收）**继续有效**，仅组织形态被后者取代。
2. **服务端 slot 注册表退役**（M30 D7）：`ctx.uiExtensions` + BUILTIN_SLOTS 六槽白名单删除（生产链路零消费）；第三方 UI 走 manifest.ui → `ctx.webui.addEntry` → 浏览器 SlotRegistry。结论保留：服务端不再有权威 slot 白名单，fail-closed 改由 SlotMap 声明账本 + 装载校验承担。
3. **占用门控原语除役**（M30 D3 及后记）：`useSeatOccupancy(key)` 退役——占用门控内在于选举（原手码门控有壳残废风险），不再提供独立原语。
4. **settings `sys.timer` 节撤**（A3）：定时任务聚合 aux 选区是唯一入口（与 aux 面板同组件纯冗余）；`/timer` 快捷命令经 `ui.openTimers` 直达选区。settings:section#sys.timer(50) 条目作废。
5. **会话头 System Prompt 预览撤**（cr-30 窄屏 Modal 退役 + cr-244 头部入口撤）：overlay#system-prompt(88) 与 header-widget#system-prompt 条目一并作废，改 aux-sidebar#prompt(35) 选区（对照阅读；rail 恒可见）。
6. **group:drawer 席位 retired**：群面板迁 aux-sidebar 选区（会话区重构）——席位数不变（换开新席）。
7. **骨架语义定整（2026-09-11）**：main:tracking 专座收编为 main 选举条目；main:workspace → workspace → aux-sidebar 两轮改名；辅助活动栏第二轮成型；`ui-sidebar` 行归并 ui-layout（基础七件 → 六件）。

---

## 附录 A. 调研档案要点（`archive/webui-slot-tree.md`，v1 调研 · 建议名口径）

- **方法**：布局骨架与扩展基建由主线通读（App.vue / stores/ui.ts / core/extensions / core/registry / tokens.css / vite.config 等）；约 50 个组件的可视元素由 6 组并行盘点全覆盖。
- **四态模式统一**：loading / error / empty / content——替换型插口必须遵守「未填充时回落宿主默认渲染」。
- **11 条横切约定**（今仍为设计约束）：四态回落 / 弹窗骨架先行统一 / z-index 配额秩序（宿主统一发配额，禁插件自选高位）/ 行点击导航语义宿主所有 / 门控正交性 / 状态词汇宿主固定 / 移动端行为继承（≤768px 左抽屉模式；替换型 slot 须继承对应移动端行为）/ 命令式通道保留 / 启停两层分家不可绕开 / 安全边界不变式（isolated 档不进 slot 注册表等）/ 命名与替换语义（`<域>:<元素>[-<位置>]` param-case；同 id 后注册替换；order 缺省 100 稳定排序）。
- **旧 8 UISlotId 收编映射**（perspective → main:perspective、tool-result → tool-card:result-view、message-view → message:final-view、ws-event → global:event 等）已成永久机制（`core/extensions/slotCatalog` + 安装期词汇校验）；树中其余 **~230 插口为建议名**，按「按需开口」纪律逐个开口，不预裁。

## 附录 B. 组件树要点（`archive/webui-component-tree.md`）

- **装配链**：main.ts AcClientRoot → `renderSlot(root)` → AppFrame → 各区域宿主 → 席位渲染面。
- **动态挂载点清单**（组件树的「虚线边」；选举 / 排序键以本文 §3.1 与源码为准）：PerspectiveHost / MainViewHost / PrimarySidebarHost / AuxSidebarHost / SettingsPanel / AgentPane / ToolMessage / TurnDisplayItem / ComposerDock / ConversationView / AppFrame / ActivityBar。
- **跨包复用网**（每边的白名单裁决依据 = 该文 §8 组件复用表 + `dep-cycles.yml` 各条 ruling）：ConversationView（conversation，被 group / singles / runview / subagent async 引用——视角 = 跨包引用内核 + 域 props）；ScrollableViewport（renderer → shell / fs 卡）；SettingField / ConfirmDialog（settings → llm-pool / search-pool / agents / plugin-registry）；EntryPickerModal（workspace → singles / plugin-registry）；TimerPane（timer → agents）；ExtToolsPane / ExtensionSettingsModal（plugin-registry → agents）；toolDisplayLabel / toolIconName（tool → conversation）。
- **规模校正（2026-10-06 实测）**：行包 client 半边 106 个 `.vue`、webui-kit 41 个 `.vue`（旧版记 79 / 13，已过时）；无 `.vue` 的数据 / 资产行 = ui-theme / ui-tool / ui-skill（ui-renderer 仅 2 个 `.vue` 资产）。

## 附录 C. 归属地图与裁决点（`archive/webui-plugin-ownership.md`，v2 / DSH 对照）

- **DSH 实证四条**：客户端 cordis 运行时（浏览器 fiber 树 + SlotRegistry）；slot 系统（SlotMap 声明合并 + kind/scope/cell 选举 + store 座位 + inject）；壳也是插件（每域一个 client-ui 包）；装配 = 启动图 + lazy 模块表。
- **判据（继续有效）**：判据 A 数据面归属定行；跨域聚归宿主；可摘除性验收。
- **裁决点**：D1 roster 混域（agent / group 分属两行）；D4 运行矩阵独立成行（已落 ui-runview）；D9 设计原语独立包（已落 webui-kit）；修订 D2 / D5 / D6（会话骨架、设置壳、输入区壳由「宿主」降为基础件）；新增 D13（Vue 不换栈——SlotRegistry 框架无关）/ D14（root 单席位纪律）/ D15（内置包与第三方插件同装载通道后的信任分级：内置默认信任，第三方维持现状）；D19（行包 `client/` 半边）见 §4.2 第 1 条。
- **该文 §3.3「域能配对表」的建议包名未采用**（如 ac-client-ui-web-tools / ac-client-ui-edit / ac-client-ui-session-query / ac-client-ui-interaction）——实际落点见本文 §1（web 卡归 ui-web、edit 归 ui-fs、queue / interaction 归 ui-conversation 等）。历史方案，勿按名索包。


