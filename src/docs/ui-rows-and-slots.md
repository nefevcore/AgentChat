# UI 行册与 Slot 树实装（M27 + M28 产出物）

> **状态：实装行册（2026-11-08，M28 收口时点快照）。**
> 事实源 = 各行包 `client/index.ts` 的 declare/register 面；本文是**读侧
> 汇总**，行/席位/贡献变更时随步同步（本文不改装载语义——yml 行序无
> 装载语义，phase 才有）。
> 背景文档：`m27-webui-slot-refactor-plan.md`（Slot 机制设计）、
> `m28-ui-plugin-tree-plan.md`（插件树拆分施工图 + §10 进度）、
> `webui-slot-tree.md`（席位语义四分类 + ~230 建议名插口词表）。

## 0. 阅读指南

- **产出物清单**（§1）：26 前端行 + 基建三包边界 + webui 终态。
- **Slot 树**（§2）：节点 = Slot 名（席位），叶 = `NULL`（空位/第三方
  扩展位）或具体 UI 控件（贡献组件）。树形按 AppFrame 渲染层级排布。
- **按插件包归属**（§3）：同一份数据换轴——每包「声明席位（owner）+
  注册贡献（contributor）」两栏，用于分析分解合理性。
- 判定基准（§4）：owning = 声明方；域行贡献经 `slots.inject` 声明
  存活期效应（席位在场即注册/缺席即等待/塌缩或卸载即回收）。

---

## 1. 产出物清单（26 前端行）

统一形态：`package.json`（`agentchat.plugin` + client 清单）+
`src/index.ts`（宿主半边 declareClient，派生名三处同名）+ `client/`
（插件半边）+ `tests/`（宿主半边 node / client 半边 jsdom 分文件 +
双向摘除用例；薄行〔ui-skill/ui-jobs 等〕无独立 tests——覆盖走
消费方测试族）。cordis.yml 各占一行，双向可独立摘除（卸后端行 →
RPC 失败三态静默空态；卸 UI 行 → 前端消费面消失）。**限定语
（M29）**：「摘除」在 boot graph 层成立（行停用）；**物理摘包会断
webui 构建**——base 行的 R7 白名单边（`scripts/dep-cycles.yml`
六条契约词汇边）需先消边。依赖方向纪律由 check-deps R6/R7 守卫
（M29 P0-1 起生效）。

### 基础七件（phase: `base`——封印前批次）

| 包 | 行 id | 职责 |
|---|---|---|
| `ac-client-ui-renderer` | ui-renderer | 渲染地基：vueRenderer/slotRender + SlotOutlet 族 + markdown 管线 + logger |
| `ac-client-ui-theme` | ui-theme | 主题行：tokens 双主题 + themeStore |
| `ac-client-ui-tool` | ui-tool | 工具卡席位宿主：tool-card:result-view 声明 + 解析面 + 选举语义（零内联卡） |
| `ac-client-ui-sidebar` | ui-sidebar | 活动栏 + 三面板壳（list-panel:domain 选举席声明）+ uiStore |
| `ac-client-ui-conversation` | ui-conversation | 会话域：ctx.sessions（FeedCore/ChatCore）+ talk 视角 + message:final-view / tracking:dock-widget 声明 + queue/interaction dock 出厂贡献 + DialogView 族 |
| `ac-client-ui-settings` | ui-settings | 设置面板纯壳：左树 + 保存编排 + settings:section 等 3 席声明 |
| `ac-client-ui-layout` | ui-layout | 应用壳：root 席 + AppFrame + 9 席声明 + 视角注册表解析面 |

### 域行（phase: `domain`——封印后动态批次，19 行）

| 包 | 行 id | 职责 | 主要贡献（席位 → 条目） |
|---|---|---|---|
| `ac-client-ui-todo` | ui-todo | todo 域 | tool-card `todo`；dock `todo`(10) |
| `ac-client-ui-jobs` | ui-jobs | 后台任务清单 | ConversationJobsChip（DialogView 头消费）；jobBoard 域投影 |
| `ac-client-ui-workspace` | ui-workspace | 工作区/文件面 | overlay `file-preview`(90)；main:workspace `tree` |
| `ac-client-ui-singles` | ui-singles | 独立会话 | list-panel `sessions`；perspective `single`(40)；ctx.singleBoard |
| `ac-client-ui-group` | ui-group | 群域 | overlay `create-dialog`(95)；perspective `group`(30) |
| `ac-client-ui-agents` | ui-agents | 名册身份面 | list-panel `agents`；settings:section `agents`；ctx.roster + useRosterCore + rosterApi |
| `ac-client-ui-runview` | ui-runview | 运行矩阵 | main:tracking `matrix`；list-panel `tracking`；perspective `pair`(10)；fetchRuns 族 |
| `ac-client-ui-goal` | ui-goal | goal 域 | tool-card `goal`；dock `goal`(20)；goalApi/useGoalTracking |
| `ac-client-ui-usage` | ui-usage | Token 用量 | overlay `panel`(96)；usageApi |
| `ac-client-ui-skill` | ui-skill | 技能目录数据面 | skillsApi（纯数据行） |
| `ac-client-ui-system` | ui-system | 版本/备份 | overlay `version-dialog`(97)；systemApi |
| `ac-client-ui-timer` | ui-timer | 定时器视图 | settings:section `sys.timer`；TimerPane |
| `ac-client-ui-shell` | ui-shell | shell 工具卡 | tool-card `bash` |
| `ac-client-ui-fs` | ui-fs | fs 工具卡 ×3 | tool-card `read`/`write`/`edit` |
| `ac-client-ui-web` | ui-web | web 工具卡 | tool-card `web_search` + BROWSER_FAMILY（正则双 def） |
| `ac-client-ui-browser` | ui-browser | 浏览器工具卡 | tool-card `browser` |
| `ac-client-ui-subagent` | ui-subagent | 子 Agent 卡 | tool-card `subagent` |
| `ac-client-ui-llm-pool` | ui-llm-pool | 模型池管理 | settings:section `llmPools` + `searchPools`（双节） |
| `ac-client-ui-plugin-registry` | ui-plugin-registry | 插件库 | settings:section `pluginLibrary`（四件） |

**边界**：基建三包 `ac-client-slots`（SlotCore 纯核 + SlotStoreAxis）、
`ac-client-runtime`（ClientContext/SlotRegistry/clientRuntime）、
`@agentchat/webui-kit`（设计原语）为纯库/运行时——不占行、不可摘除。
webui 终态 = main.ts 装配序列 + runtime 胶水（bootGraph/rpcClient/
wireFace）+ extensions bridge + api/wire·extensions + utils/shims +
构建入口（45 文件 ~106KB；stores/ 与 11 域 api 门面已退役）。

---

## 2. Slot 树（节点 = 席位；叶 = NULL / UI 控件）

> 标记：`〔k〕` kind（single=选举/list=序/chain=消费序）；`〔s〕` scope
> （session = store 座位实例轴按 conversationId 实例化）；`〔pub〕`
> 第三方可声明；`〔解〕` 解析面席位（注册表选举渲染，非 SlotOutlet DOM
> 渲染）；`〔注 n〕` 见 §4 分析注记。叶节点 `[包]` = 贡献方插件包。

```
root 〔k:single·factory——layout 出厂占用，封印后拒绝动态注册〕
└─ AppFrame [ui-layout]
   │
   ├─ sidebar 〔k:list〕
   │  └─ SidebarHost [ui-sidebar]（活动栏壳）
   │     └─ sidebar:plugin-actions 〔k:list·pub〕
   │        └─ NULL（第三方插件动作位——当前无出厂贡献）〔注 1〕
   │
   ├─ list-panel 〔k:list〕
   │  └─ ListPanelsHost [ui-sidebar]（三面板壳）
   │     └─ list-panel:domain 〔k:list——选举席：壳按 ui.listPanel 开关
   │        × meta.panel 选举渲染，与外层 list-panel outlet 分离防叠加〕
   │        ├─ agents  → AgentListHost（名册面板）[ui-agents]
   │        ├─ sessions → SessionListHost（独立会话面板）[ui-singles]
   │        └─ tracking → RunTrackingPanel（运行面板）[ui-runview]
   │
   ├─ main 〔k:list——视角专座容器〕
   │  └─ PerspectiveHost [ui-layout]（默认插槽内容；active 谓词选举）
   │     └─ main:perspective 〔k:list·pub〕
   │        ├─ pair(10)  → PairDialogView 内核（会话对只读视角）[ui-runview]
   │        ├─ talk(20)  → DialogView（1v1 会话视角）[ui-conversation]
   │        ├─ group(30) → DialogView(group)（群视角）[ui-group]
   │        └─ single(40) → DialogView(single)（独立会话视角）[ui-singles]
   │           │
   │           └─ DialogView 内部（talk/single/group 共用骨架）：
   │              ├─ tracking:dock-widget 〔k:list·s:session〕
   │              │  │  （composer 上方 dock 卡列；store 座位实例轴首例
   │              │  │   ——entry.store 工厂 × scopeKey=conversationId）
   │              │  ├─ todo(10)       → TodoDockCard [ui-todo]
   │              │  ├─ goal(20)       → GoalDockCard [ui-goal]
   │              │  ├─ queue(30)      → QueueDockHost（排队 dock；轴上
   │              │  │                   核心态 createQueuedDockStore）[ui-conversation]
   │              │  ├─ interaction(40) → InteractionBar（ask_questions
   │              │  │                   决策 dock）[ui-conversation]
   │              │  └─ NULL（群视角整列隐藏；第三方 dock 卡扩展位）
   │              │
   │              └─ message:final-view 〔k:list·解——keyed final 视图，
   │                 resolveMessageViewRenderer 按 match 选举〕
   │                 ├─ user     → NULL（内置 id 走 TurnDisplayItem 内建分支）
   │                 ├─ assistant → NULL（兜底内置，同上）
   │                 └─ NULL（第三方经 registerMessageView 注册；未命中
   │                    回落内建 assistant 视图）
   │
   │              └─ group:drawer 〔k:single——群视图右侧信息抽屉区
   │                 （M29 P1-2；非群视角不渲染）〕
   │                 └─ webui-domain-group.drawer → GroupDrawer（群成员/
   │                    改名/简介/群主/删除——零 props 自服务：当前群/
   │                    开合态取 ctx.groups）[ui-group]
   │
   ├─ main:workspace 〔k:single——工作区树专座；壳（分屏容器/rail 把手/
   │  宽度持久化）留 layout，按席位占用门控：无贡献 → 壳整体隐藏〕
   │  └─ webui-domain-workspace.tree → WorkspaceTree [ui-workspace]
   │
   ├─ main:tracking 〔k:single——运行矩阵专座；让位协议壳（开关/选中
   │  让位 watch/chat 区保活）留 layout，按席位占用门控〕
   │  └─ webui-domain-runview.matrix → RunTracking [ui-runview]
   │
   ├─ overlay 〔k:list——全局覆盖层；order 显式定序 = 原 AppFrame 内联序锚〕
   │  ├─ file-preview(90)   → FilePreviewModal [ui-workspace]
   │  ├─ create-dialog(95)  → CreateGroupDialog [ui-group]
   │  ├─ panel(96)          → TokenUsageHost（用量弹窗）[ui-usage]
   │  ├─ version-dialog(97) → VersionDialog [ui-system]
   │  ├─ webui-base-settings.panel(100 缺省) → SettingsOverlayHost [ui-settings]
   │  └─ NULL（第三方弹窗贡献位——z-index 配额/四态回落见 ownerProps）〔注 2〕
   │
   └─ tool-card:result-view 〔k:list·解——keyed 工具结果视图，
      resolveToolResultView 按 match/priority 选举；非 DOM 席位〕
      ├─ bash       → ToolResultTerminal [ui-shell]
      ├─ read       → ToolResultCode（+write→Write / edit→Edit）[ui-fs]
      ├─ web_search → ToolResultWeb [ui-web]
      ├─ BROWSER_FAMILY（正则）→ ToolResultWeb [ui-web]
      ├─ browser    → ToolResultBrowser [ui-browser]
      ├─ subagent   → ToolResultSubagent [ui-subagent]
      ├─ todo       → ToolResultTodo [ui-todo]
      ├─ goal       → ToolResultGoalAsync [ui-goal]
      └─ 未命中 → 文本渲染回落（宿主默认）〔注 3〕

settings 树（SettingsPanel 内，非 root 子树）：
├─ settings:main-view 〔k:list·pub·解——settings-tab:global 别名；
│  extensionTabs 解析面（sortedSettingsTabs）〕
│  └─ NULL（第三方全局设置页签位；出厂页签走 SettingsPanel 自有左树）〔注 4〕
├─ agent-pane:tab 〔k:list·pub·解——settings-tab:agent 别名〕
│  └─ NULL（Agent 编辑页第三方页签位）
└─ settings:section 〔k:list——选举席：SettingsPanel 按 selectedNode
   × meta.section 选举渲染（不经 outlet，防叠加）〕
   ├─ agents        → AgentSettingsHost [ui-agents]
   ├─ llmPools      → PoolManager 模型节 [ui-llm-pool]
   ├─ searchPools   → 搜索引擎节 [ui-llm-pool]
   ├─ pluginLibrary → 插件库节（四件）[ui-plugin-registry]
   └─ sys.timer     → GlobalTimerHost [ui-timer]
```

**席位总数：17**（layout 9 + settings 3 + sidebar 1 + tool 1 +
conversation 3——M29 P1-2 增 `group:drawer`）。其中 DOM outlet 渲染 11、
解析面选举 5、纯扩展位 1（sidebar:plugin-actions）。

---

## 3. 按插件包归属（换轴视图）

> 同一份数据按 owner/contributor 两栏重排。「声明」= 该席位的存在与
> ownerProps 契约归此包；「贡献」= 该包注册的条目（席位 → 条目）。
> 分析判定：看每包「声明数/贡献数」是否与其域职责相当（§4）。

### ui-layout（base）
- 声明：`root`(single·factory)、`sidebar`、`list-panel`、`main`、
  `main:workspace`(single)、`main:tracking`(single)、`overlay`、
  `main:perspective`(pub)、`sidebar:plugin-actions`(pub)
- 贡献：root → AppFrame（出厂占用）

### ui-sidebar（base）
- 声明：`list-panel:domain`（选举席）
- 贡献：sidebar → SidebarHost；list-panel → ListPanelsHost

### ui-settings（base）
- 声明：`settings:main-view`(pub)、`agent-pane:tab`(pub)、`settings:section`（选举席）
- 贡献：overlay → SettingsOverlayHost(100)

### ui-tool（base）
- 声明：`tool-card:result-view`（keyed 解析面）
- 贡献：（零卡——解析面 resolveToolResultView + 静态表降级回落）

### ui-conversation（base）
- 声明：`message:final-view`（keyed 解析面）、`tracking:dock-widget`(session)、
  `group:drawer`(single——M29 P1-2 群抽屉区，ui-group 贡献抽屉体)
- 贡献：main:perspective → talk(20)；tracking:dock-widget →
  queue(30, store 工厂) + interaction(40)；message:final-view →
  user/assistant（内置 id）

### ui-agents（domain）
- 贡献：list-panel:domain → agents 面板；settings:section → agents 节

### ui-singles（domain）
- 贡献：list-panel:domain → sessions 面板；main:perspective → single(40)

### ui-runview（domain）
- 贡献：main:tracking → matrix；list-panel:domain → tracking 面板；
  main:perspective → pair(10)

### ui-group（domain）
- 贡献：overlay → create-dialog(95)；main:perspective → group(30)；
  group:drawer → 抽屉体（M29 P1-2 自 conversation 迁域——零 props
  自服务：当前群/开合态取 ctx.groups）

### ui-workspace（domain）
- 贡献：overlay → file-preview(90)；main:workspace → tree

### ui-usage（domain）
- 贡献：overlay → panel(96)

### ui-system（domain）
- 贡献：overlay → version-dialog(97)

### ui-timer（domain）
- 贡献：settings:section → sys.timer 节

### ui-llm-pool（domain）
- 贡献：settings:section → llmPools 节 + searchPools 节（双节）

### ui-plugin-registry（domain）
- 贡献：settings:section → pluginLibrary 节

### ui-todo（domain）
- 贡献：tool-card → todo；tracking:dock-widget → todo(10)

### ui-goal（domain）
- 贡献：tool-card → goal；tracking:dock-widget → goal(20)

### ui-shell / ui-fs / ui-web / ui-browser / ui-subagent（domain，工具卡行）
- ui-shell：tool-card → bash
- ui-fs：tool-card → read + write + edit
- ui-web：tool-card → web_search + BROWSER_FAMILY（正则）
- ui-browser：tool-card → browser
- ui-subagent：tool-card → subagent

### ui-jobs / ui-skill / ui-theme / ui-renderer（无席位贡献）
- ui-jobs：ConversationJobsChip（DialogView 头跨包消费）+ jobBoard 服务
- ui-skill：skillsApi 纯数据行
- ui-theme：themeStore + tokens（CSS 注入，无 slot 面）
- ui-renderer：渲染地基（SlotOutlet/vueRenderer 本体）

---

### 3.5 包依赖矩阵（M29 消化后形态）

> M29 行包依赖纪律修复后的运行时值边实况（R6/R7 守卫锁定；
> 复核：`node scripts/check-deps.mjs`）。读法：行 → 列 = 该行包静态
> import 列包模块。base→domain 边仅存白名单六条契约词汇边
> （`scripts/dep-cycles.yml`，只减不增）。

| 包（phase） | → 运行时依赖 | 形态注记 |
|---|---|---|
| renderer / theme / tool（base） | （零 domain 依赖） | 干净 base 行 |
| conversation（base） | agents〔白名单·rosterAccess+rosterApi〕· workspace〔白名单·fileApi〕· skill〔白名单·skillsApi〕· jobs〔白名单·JobsChip〕· renderer · sidebar | 最重 base 行；四条白名单边均为 RPC/工具词消费 |
| layout（base） | agents〔白名单·rosterAccess〕· conversation · renderer · theme · sidebar | viewer 单源迁 runtime（M29 P1-1） |
| settings（base） | sidebar | M29 P1-3 后纯壳 + 全局面：外域数据面 import 清零 |
| sidebar（base） | system〔白名单·M28 §5.1〕 | 版本入口动作 |
| agents（domain） | conversation · plugin-registry · settings · sidebar · theme · timer | 域行反向依赖最多者；agent CRUD 单宿主（rosterApi） |
| group（domain） | conversation · agents | T6 视角 + group:drawer 抽屉贡献（M29 P1-2） |
| plugin-registry（domain） | settings · workspace | 数据面 pluginApi 自足（M29 P1-3a） |
| llm-pool（domain） | settings · agents | poolApi 写/探测面自足（M29 P1-3d） |
| timer（domain） | settings | timerApi 归域（M29 P1-3c）；全局定时 = 全局配置域 |
| singles / runview / usage（domain） | conversation/agents/sidebar/theme（+ workspace/jobs） | 视图行 |
| fs / browser（domain） | renderer · workspace | 卡行 |
| workspace / system（domain） | sidebar · renderer | 卡行/面板行 |
| todo / goal / shell / web / subagent / skill（domain） | renderer 或零 | 卡行干净 |

---

## 4. 分解合理性分析注记

1. **〔注 1〕sidebar:plugin-actions 现为 NULL**：第三方插件动作位
   （M27 D13 别名收编）。出厂无贡献是预期形态——它是 `/ui-plugin/`
   通道（extensions bridge 双轨）的落点，非死席位。
2. **〔注 2〕overlay 的 order 序 = 原 AppFrame 内联序锚**（90 → 95 →
   96 → 97 → 100 缺省）：这是视觉门零 diff 的机制保证——新增弹窗行
   显式定序即可插队，无序竞争。
3. **〔注 3〕tool-card:result-view 未命中回落文本渲染**：宿主不残废
   红线的直接体现——卸任一卡行只损失该工具的富卡，消息流完整。
4. **〔注 4〕settings:main-view / agent-pane:tab 为空**：出厂页签走
   SettingsPanel 自有左树 + settings:section 选举；这两个 pub 席位是
   第三方扩展页签的历史别名位（D13），当前零注册。若长期无第三方
   消费，可评估并席（属 ~230 插口「按需开口」纪律，不预裁）。
5. **声明/贡献比观察**：席位声明全部落在 base 行（layout 9 /
   settings 3 / sidebar 1 / tool 1 / conversation 2）——域行零声明、
   全贡献。这是「宿主退化为 slot 提供者」的终态判据达成证据：
   域行摘除不损失任何席位存在性，只损失贡献叶子。
6. **工具卡行粒度**：fs 三卡同行、web 双 def（精确 + 浏览器族正则）
   同行——按「后端域 ↔ 卡行」镜像表判定（M28 §2.2），非按卡数机械
   拆分。若某卡需要独立演进，同 id 重注册替换机制天然支持。
7. **conversation 仍是最重行**（实测 ~495KB / 38 文件〔M29 P1-2 迁出
   GroupDrawer 后；复审时点 ~506KB——见 ui-rows-and-slots-review.md
   F4〕：sessions 核心 + DialogView 族——T7 保守案裁决：composer 不拆）。
   它的分解收益已让位于轴/贡献机制（queue 状态已上轴），进一步拆分需
   新裁决点。
8. **数据一致性口径**：本文席位/条目快照与代码 declare/register 面
   一一对应；复核命令：
   `grep -rn "slots.declare(" src/ac-client-ui-*/client` +
   `grep -rn "slots.register(" src/ac-client-ui-*/client`。
