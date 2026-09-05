# WebUI 薄层化 · 组件插件归属地图（v2，对齐 DSH webui 设计）

> 与 `docs/webui-slot-tree.md` 配套。v2 修正 v1 的「薄层」理解：参照
> **DSH（DeepSeek Harness）webui 的实际设计**（本机 dsh 0.1.1-rc.2 安装面
> 实证，见 §1）——薄层不是「webui 保留聊天骨架 + 各域挂贡献者」，而是
> **浏览器里跑一个客户端 cordis 运行时，可视面 100% 是按域拆分的
> client-ui 插件包**；webui/ 本体瘦到只剩运行时 + slot 基建 + 构建入口。
> v1 的归属判据（数据面归属/跨域聚归宿主/可摘除性测试）全部保留，
> 改变的是**组织形态**。本文不改动任何代码。

---

## 1. DSH webui 设计实证

以下均为本机安装的 dsh 包清单与类型声明中直接读到的事实（非推测）。

### 1.1 客户端 cordis 运行时

- `dsh-cordis-client-runner` —— "Browser half of dynamic dual-half plugin
  packages: event subscription, closure evaluation, guard facade, and loader
  entries"。**浏览器里有一个真的 cordis fiber 树**。
- `dsh-client-runtime` —— "Client core services: SlotRegistry,
  SessionRuntime (scope tree + object layer)"。注册经**调用方 ctx.effect**
  路由进调用方 fiber——插件卸载即级联回收其全部 slot 贡献（与服务端
  fiber 语义同构，`slots.d.ts` 原文注释明确要求 prototype 方法以保住
  caller-ctx 绑定）。
- `dsh-client-connection` —— "Wire consumer layer: HTTP-up/WebSocket-down
  client, ConnectionController dual streams with reconnect"。
- `dsh-client-modules` —— "dual-face: node half composes the
  `__DSH_BOOT__` entry graph (incremental dsh.client scan, bundle route,
  index tap, webPlugins service); browser half is the lazy-CJS module table
  the vendored cordis Loader consumes"。
- `dsh-client-hmr` / `dsh-client-locale` / `dsh-host-frontend-static`
  （SPA dist 服务）。

### 1.2 slot 系统（比我 v1 设想的强一档）

`dsh-client-ui-slots`（SlotCore 纯核：注册语义/声明账本/装载校验/卸载
级联）+ `SlotRegistry`（cordis Service 层）：

- **SlotMap 声明合并**：每个 UI 包 `declare module` 注入自己的 slot key
  与类型——slot 集是开放类型系统，不是封闭 union。
- **slot 形状**：`kind: 'single' | 'list' | 'chain'`；`scope: 'root' |
  'session'`；owner props 类型化；**cell + priority 选举**（同 cell 高
  优先级 shadow 低者，非简单 order 追加）；**store 座位**（per-entry
  store handle，按 scope key 实例化/回收，会话死即清）。
- **`root` 单席位**：壳渲染的唯一洞，被 `ui-layout` 的 AppFrame 占据，
  其内声明 sidebar / conversation / details / `shell.overlay` 四个 seat；
  动态注册进 root 反而低优先级会被出厂者压住（文档明示"DO NOT
  register here"）——全屏自有面走 `shell.overlay`（list 型、additive、
  点击穿透）。
- **`inject(key, cb)`**：依赖某 slot 声明的存活期效应（声明即回调、
  消失即回收）——UI 包间的依赖用声明表达，不用行序。
- **`renderSlot('root')`**：唯一 ctx 级渲染入口；其余 key 一律在组件内
  经 props renderSlot face 渲染。`install(renderer)` boot-once。
- **`onEntryError`**：entry 渲染崩溃自动 abdicate（退位）+ 监督订阅
  ——贡献健康是一等公民。

### 1.3 壳也是插件、每域一个 client-ui 包

- `dsh-client-ui-layout` —— "Shell plugin: three-column AppFrame with
  drag handles, ctx.layout viewing-state service"。**布局是插件**。
- `dsh-client-ui-conversation` —— "Conversation domain: skeleton, ordered
  chat flow, composer … and details host"。**会话骨架是插件**。
- `dsh-client-ui-tool` —— "Client Tool call-tree renderer and **keyed
  per-tool presentation slot**"。工具呈现 = 按工具名 keyed 的 slot 面。
- 其余同构：`ui-renderer / ui-sidebar / ui-theme / ui-settings（+
  settings-general / settings-models / settings-plugins /
  settings-plugin-inventory）/ ui-goal / ui-jobs / ui-skill /
  ui-subagent / ui-plan / ui-workflow-run / ui-workspace /
  ui-model-selection / ui-commands / ui-attachment / ui-reference /
  ui-trajectory / ui-user-questions / ui-message-feedback /
  ui-input-trigger / ui-permission-presets / ui-agent-preset /
  ui-brand-official / ui-cordis / ui-deliverables /
  ui-directory-picker-browse|native` —— **33+ 个 client-ui 包**。
- **配对关系**：宿主域包**不带 UI**（`dsh-goal`、`dsh-tool-todo` 均无
  `dsh.client` 字段）；UI 是独立 npm 包（`packages/client/ui-goal` 等），
  带 `dsh.client` 清单（`{ platform: 'web', inject: [...] }`）+ `./client`
  出口。UI 包之间显式 inject（如 ui-goal inject ui-conversation——
  GoalBar dock 到 composer 上方）。
- 组合：profile `bundles: [dsh-base, dsh-web-app]`（服务端 cordis 行）
  + node 半边增量扫 `dsh.client` → 启动图；第三方插件（如本机 web
  profile 装的 `@nefevcore/abap-adt-dsh-plugin`）同一机制进树。

## 2. 「薄层」的正确含义（对 v1 的修正）

| | v1（被否） | v2（DSH 模型） |
|---|---|---|
| webui/ 保留 | 聊天流骨架 + 设置壳 + 设计系统 + 布局 | **客户端运行时 + slot 基建 + 连接层 + 构建入口 + 设计原语**，仅此而已 |
| 布局/会话骨架 | 宿主地形，不可摘 | **基础 client-ui 插件集合**（layout/conversation/renderer/sidebar/theme），预装配但可替换可摘除 |
| 域 UI 形态 | 宿主 bundle 内置贡献者 → 后期随行 ui/ 目录 | **每域一个 `ac-client-ui-*` 独立包**，客户端 cordis 组合装配，与后端域包平行配对 |
| slot 机制 | 6 slot 白名单 + 封闭 UISlotId union | **SlotMap 声明合并**（开放类型）+ kind/scope/cell 选举/store 座位/inject/onEntryError |
| 装配 | /api/ui/extensions 清单 + 动态 import | 同源演进：客户端启动图（`__DSH_BOOT__` 同款）+ lazy 模块表 + vendored Loader |

技术栈注：DSH 前端是 React + zustand；AgentChat 是 Vue + pinia。
**SlotRegistry 是框架无关的 cordis Service 层**（renderer 经
`install()` 注入、组件内经 props face 渲染），整套机制可原样落在
Vue 上——不换栈，只换组织方式。

## 3. AgentChat 落地映射

### 3.1 webui/ 终态保留（瘦身为运行时级）

| 资产 | 对应 DSH 件 | 说明 |
|---|---|---|
| 客户端 cordis 运行时（新） | dsh-cordis-client-runner + dsh-client-runtime | 浏览器 fiber 树 + SlotRegistry + 会话运行时 |
| slot 纯核（新） | dsh-client-ui-slots（SlotCore） | 注册语义/声明账本/装载校验/卸载级联，零 cordis 依赖可单测 |
| 连接层 | api/wire.ts + core/api/client.ts → dsh-client-connection 形态 | HTTP 上行/WS 下行 + 重连 |
| 模块装配（新） | dsh-client-modules | node 半边扫 `ac.client` 清单组启动图；浏览器半边 lazy 模块表 |
| 构建入口 | apps/web（vite 入口） | webui/ 退化为 dsh-web-frontend 同款「入口 + dist」 |
| 设计原语 | ui-primitives + tokens | 独立包 `@agentchat/webui-kit`，供全部 client-ui 包引用（v1 D9 维持） |
| i18n / HMR（可选后置） | dsh-client-locale / dsh-client-hmr | 非首期必须 |

### 3.2 基础 client-ui 插件集合（预装配、可替换）

| 包（建议名） | 对应现状资产 | 对应 DSH 件 |
|---|---|---|
| ac-client-ui-layout | App.vue 三层布局、Sidebar 壳、list-panel 容器、ResizeHandle、stores/ui | ui-layout（占 root、声明四 seat） |
| ac-client-ui-conversation | DialogView 壳、feed/chat stores、TurnDisplayItem、Assistant/UserMessage、useChatShell、useMarkdown | ui-conversation |
| ac-client-ui-renderer | markdown 管线、气泡/分隔条通用渲染 | ui-renderer |
| ac-client-ui-tool | ToolMessage 外壳 + 按工具名 keyed 的 presentation slot 面 | ui-tool |
| ac-client-ui-sidebar | Sidebar 动作区/更多菜单、roster·session-list·runs 三面板**壳** | ui-sidebar |
| ac-client-ui-theme | theme store + 双主题 | ui-theme |
| ac-client-ui-settings | SettingsPanel 壳+左树+保存编排、SettingField/NsFieldList/ExtensionSettingsModal | ui-settings（再拆 general/models/plugins 子包可后置） |

### 3.3 域能配对表（后端域包 ↔ client-ui 包 ↔ slot 注册点）

> 归属判据沿用 v1：判据 A（数据面归属）定行；本表把 v1「形态」列统一
> 改为**独立 client-ui 包**。slot 注册点即 `webui-slot-tree.md` §4 的
> 命名空间（树 = SlotMap 初始声明集）。

| 后端域包 | client-ui 包（建议） | 主要可视面（现状资产迁入） | slot 注册点 |
|---|---|---|---|
| ac-todo | ac-client-ui-todo | ToolResultTodo、TodoPanel、api/tasks todo 段 | tool 面 keyed、tracking:dock-widget |
| ac-goal | ac-client-ui-goal | ToolResultGoal、GoalBar、goal 段 | tool 面 keyed、tracking:dock-widget |
| ac-jobs | ac-client-ui-jobs | ConversationJobsChip、api/jobs、清单面板任务节点 | chat:header-actions、runs:tree-section |
| ac-timer | ac-client-ui-timer | TimerPane、sys.timer 全局段、/timer 命令 | agent-pane:tab、settings:sidebar-section、mention 组 |
| ac-usage | ac-client-ui-usage | TokenUsage 弹窗 | 覆盖层 + 入口钮 |
| ac-llm-pool | ac-client-ui-llm-pool | PoolManager(llm)、模型页签字段、模型/强度下拉数据 | settings:sidebar-section、chat:input-toolbar |
| ac-web-tools | ac-client-ui-web-tools | ToolResultWeb、ToolResultBrowser、PoolManager(search) | tool 面 keyed |
| ac-fs-tools | ac-client-ui-fs-tools | ToolResultCode(read)、ToolResultWrite、@ 引用教学 | tool 面 keyed、mention 组 |
| ac-str-replace-editor | ac-client-ui-edit | ToolResultEdit | tool 面 keyed |
| ac-shell-tools | ac-client-ui-shell | ToolResultTerminal | tool 面 keyed |
| ac-skill | ac-client-ui-skill | 技能三源组、skill_read 分支 | mention 组 |
| ac-session-query | ac-client-ui-session-query | # 会话引用组 | mention 组 |
| ac-subagent | ac-client-ui-subagent | ToolResultSubagent、subagentMeta、清单面板节点 | tool 面 keyed、runs:tree-section |
| ac-durable-interaction | ac-client-ui-interaction | InteractionBar | chat:composer-dock |
| ac-conversation | ac-client-ui-conversation-queue | QueueDock、排队/插话可视化 | chat:composer-dock |
| ac-session | ac-client-ui-session-tokens | token 仪表+归档按钮、历史分页数据面 | chat:header-actions |
| ac-archive | ac-client-ui-archive | 归档反馈 chips、/archive 命令 | chat:header-notice |
| ac-agents（+admin/presets） | ac-client-ui-agents | AgentListPane、AgentPane、roster agent 行、System Prompt 预览 | settings:sidebar-section、roster:* |
| ac-agent-presets | （并入上包） | 预设项与兜底文案 | — |
| ac-group | ac-client-ui-group | CreateGroupDialog、GroupDrawer、群视角差异、roster group 行 | chat:header-actions、roster:* |
| ac-singles | ac-client-ui-singles | SessionList 面板、工作区/Agent 下拉 | sidebar:list-panel、chat:input-toolbar |
| ac-workspace | ac-client-ui-workspace | WorkspaceTree(Node)、@ 浏览数据、FilePreview 数据通道 | workspace-tree:*、file-preview:viewer |
| ac-plugin-registry | ac-client-ui-plugins | PluginLibraryPane 目录+配置页签、StagingReviewModal | settings:sidebar-section |
| ac-plugin-market | （并入上包或独立） | 市场页签+安装确认 | plugin-library:tabs-append |
| ac-event-policy | ac-client-ui-event-policy | 事件治理动作/确认弹窗 | plugin-library 事件视图装饰位 |
| ac-backup / ac-restart | （并入 settings 基础集） | 备份菜单项、重启按钮 | sidebar:more-menu-items、settings:footer |
| ac-web-api（version 面） | ac-client-ui-version | VersionDialog | 覆盖层 + 入口 |
| （宿主裁决 D4）运行矩阵 | ac-client-ui-runview | RunTracking、RunTrackingPanel、api/runs | main:perspective、sidebar:list-panel |
| 纯库行（memory/persona/security/…） | 无独立包 | fields 声明自管（ExtensionSettingsModal 渲染） | 声明层 |

### 3.4 组合与装载

- 每个client-ui 包：`package.json` 带 `agentchat.client` 清单
  （`{ platform: 'web', inject: [...] }`）+ `./client` 出口——DSH
  `dsh.client` 同款双半包形态（node 半边组图、浏览器半边是模块）。
- 装配面复用现有件演进：`ac-webui` 的 entries 清单 + `/ui-plugin/`
  静态托管 → 升级为「启动图下发」（`__DSH_BOOT__` 同款：bundle 路由 +
  增量 client 扫描）；前端 `core/extensions/host.ts` 的动态 import 机制
  保留为第三方动态插件的通道，**内置域走同一模块表**（内外一套机制，
  这是与 v1「内置贡献者 + 随行 ui/」双轨方案的关键差异）。
- 可摘除性测试（v1 判据 C）不变且更强：摘掉 `ac-client-ui-todo` 行 →
  fiber 卸载 → SlotRegistry 级联回收 todo 卡/dock 卡/工具卡，浏览器
  内零残留。

## 4. 对 slot 树文档的升级指引

`webui-slot-tree.md` 的树形与命名**整体保留**，实施时升级四点：

1. **SlotMap 化**：树中每个 id 从「白名单字符串」升为 SlotMap 声明合并
   键（declare module 注入类型）；封闭 `UISlotId` union 与后端
   BUILTIN_SLOTS 静态表退役，改由声明账本 + 装载校验承担 fail-closed。
2. **每 slot 声明形状**：`kind`（single/list/chain——替换型≈single+cell
   选举、填充型≈list、装饰型≈list 于条目作用域、覆盖型≈chain/overlay）+
   `scope`（root/session——dock 卡、会话任务 chip 属 session 域）+
   owner props 类型。
3. **cell 选举替代纯 order**：同 cell 内 priority 高者 shadow 低者
   （「插件覆盖内置」有了统一语义，不再需要 registerXxx 的 priority
   特例）。
4. **inject 表达 UI 包依赖**：v1 §4 树中的「配对注册」（side-nav +
   view、tab + 面板）改用 `inject(key, cb)` 声明依赖；`onEntryError`
   作为贡献健康的统一监督面。

## 5. 迁移阶段（重排）

1. **阶段一 · slot 基建升级**：SlotCore 纯核 + SlotRegistry（客户端
   cordis 运行时最小化落地：可先宿主 bundle 内嵌运行时，不拆包）；
   SlotMap 以 slot 树定稿为初始声明集；layout/conversation 两件壳
   插件化（root + 四 seat 骨架），原 8 个 UISlotId 缝平移收编。
2. **阶段二 · 域 UI 拆包**：按 §3.3 配对表逐域拆出 ac-client-ui-*
   包（先数据面单一者：todo/goal/jobs/usage/timer/skill）；每拆一域
   跑一次可摘除性验收。
3. **阶段三 · 薄壳收口**：webui/ 只剩 §3.1 运行时级资产；内置域 UI
   全部经启动图装载；`pnpm webui:build` 产物 = 壳 dist + 各包 client
   模块；第三方动态插件与内置域同一通道。

## 6. 裁决点（v1 D1-D12 大部保留，修订与新增）

- 保留：D1 roster 混域（agent/group 行分属两包）、D4 运行矩阵归属
  （推荐独立 ac-client-ui-runview，比 v1 的「宿主保留」更贴合薄层
  目标）、D9 设计原语独立包（webui-kit）、D7/D8/D10/D11/D12。
- **修订 D2/D5/D6**：v1 把会话骨架/设置壳/输入区壳划给宿主——v2 全部
  降为基础 client-ui 插件集合（§3.2），「宿主」一词只剩运行时。
- **新增 D13**：Vue 不换栈（SlotRegistry 框架无关）；渲染器安装契约
  （install(renderer) + 组件内 renderSlot face）需出 Vue 版。
- **新增 D14**：root 单席位纪律（出厂者高优先级；全屏面走
  shell.overlay 型 list seat）——防插件误占 root 打散框架。
- **新增 D15**：内置域与第三方插件同一装载通道后，信任分级如何延续
  （现有 isolated iframe 档、GET/事件白名单是否套用到内置 client-ui
  包——建议内置包默认信任、第三方维持现分级）。
