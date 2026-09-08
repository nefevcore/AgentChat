# M27 WebUI 纯 Slot 重构 — 最终交接（2026-11，M27.1/M27.2 拆包修正）

> **进度快照（2026-11 M27.2 收口 session）：M27.1 + M27.2 全部
> 收口**——conversation 视图半边（`92fd912`）→ sidebar 面板壳迁入
> （`ca4cbb8`）→ settings 件（`e314b5a`）→ layout 件（`86aec77`，
> 基础七件收官 + webui 终态自检：clients/ 目录除役）；全量验收
> （双 typecheck / 1559 测试 / check-deps / 视觉门〔新行基线重建
> 05/07/08〕/ webui:build / desktop 构建冒烟）+ 计划文档 D19/S4
> 修订段「已实施」标注完成。**M27 关闭；余项见 §4 后置清单。**

> **M27 主体已收口**（S0-S4 全阶段，验收基线全绿——见 §1）。
> 用户复核后**改裁 D19 + S4 定案**：**前端插件一律独立成
> `ac-client-ui-*` 包**（即使无后端行）——包名即身份。拆两条线：
> **M27.1 域 UI 拆包**（六域 + runview 改名对齐，机械动作）与
> **M27.2 基础七件出包**（大型迁移，推翻 S4「clients/base/ 常驻」）。
> 本文件 = 下一 session 开工文档。事实源：
> `m27-webui-slot-refactor-plan.md`（D19 修订记录 + S4 修订记录）。

## 0. 修正目标一句话

**前端相关的插件（行包）一律 `ac-client-ui-<名>` 独立包，cordis.yml
各占一行，各自可独立摘除；后端行回归纯后端。** 纯库/运行时不在此列
（ac-client-slots / ac-client-runtime / @agentchat/webui-kit——不进行）。
域 = 后端行 + `ac-client-ui-<域>` 两个包；基础件 = 单独
`ac-client-ui-<件>`（本就无后端行）。

## 1. 收口现状（修正起点）

| 阶段 | 提交 |
|---|---|
| S0-S2 + S3 P0 | `21d089f` 及之前 |
| S3-1a：ac-todo 双半边 + rpc.onEvent + boot graph 热通道 + 两径验收 | `9619a5f` |
| S3-2/3：bridge D8 收窄 + D13 公开子集校验 | `4c428d3` |
| S3-1b：五域行 client 收口 + SessionsClientFace 协调面 | `84bff4d` |
| S4(a)：isolated-runtime 迁移 + 基础七件落点定案（常驻——**已被 M27.2 推翻**） | `2ea677e` |
| S4(b)：@agentchat/webui-kit 抽取 | `f17045f` |
| S4(c)：desktop 构建与启动冒烟 ✓ | `52bd798` |
| D19 改裁记录 + M27.1 交接 v1 | `a2b5c08` |

**验收基线（续作前先跑一遍确认起点绿）**：

```bash
pnpm typecheck && pnpm webui:typecheck   # 双 typecheck
pnpm test                                 # 1523 测试（shell-tools job/settled 负载敏感 flake，红则隔离复跑）
node scripts/check-deps.mjs               # R1-R6（仓库根跑）
AGENTCHAT_VISUAL=1 pnpm vitest run src/webui/tests/visual-snapshot.test.ts
pnpm webui:build                          # 壳 dist + 行 client 模块块
```

**可行性**：六域 client 半边依赖面已全契约化（只依赖 ac-client-runtime，
零 webui import）——M27.1 是机械动作；`ac-client-runview` 就是独立 UI
行的现成模板。M27.2 是真迁移（见 §3 体量评估），按件分批独立提交。

## 2. M27.1：域 UI 拆独立 client-ui 行包（六域 + runview 对齐）

### 2.1 目标形态（模板 = ac-client-runview）

```
src/ac-client-ui-todo/
  package.json        # agentchat: { plugin: true, client: { platform: web,
                      #   entry, phase: 'domain' } }；deps vue + ac-client-runtime
  src/index.ts        # top-level inject ['webui'] → declareClient 自声明
                      #（runview/src/index.ts 现范本）+ ExtensionMeta
  client/             # 原 ac-todo/client/* 原样迁入
  tests/              # boot graph 声明 + 卸载级联（runview-row 同款）
```

后端行反向摘除：删 `client/`、`webui-client` 子插件、client 清单、
vue/ac-client-runtime/ac-webui 依赖——回归纯后端行。

### 2.2 每域迁移清单（六域同款）

1. `git mv src/ac-<域>/client → src/ac-client-ui-<域>/client` + 新
   package.json + src/index.ts（抄 runview）+ ExtensionMeta（label
   「<域名>（前端）」）；
2. **cordis.yml + ac-app TREE 两表加行**（行 id `ui-todo` 等与 boot
   graph name 一致；M27 期间首次动组合根——两表同步纪律）；
3. webui re-export 改指向：`api/{tasks,jobs,groups,singles,roster,files}.ts`
   的 `ac-<域>/client` → `ac-client-ui-<域>`；`bootGraph.ts` 六处
   `import type {}`、`stores/agents.ts` RosterCore 同改；
4. 测试随行走：行测试迁新包；webui `clients-*.test.ts` 导入面同改；
   `portb-e2e` 行集断言 +6；`boot-graph-http` 真树断言改新名；
5. install + 双 typecheck + 全量测试 + 视觉门（插件目录六新行——
   07/08 白名单登记）+ build。每域独立提交。

### 2.3 命名对齐（坑 + 裁定）

vite `discoverRowClients` 从目录名派生静态映射键：`ac-client-ui-todo`
→ **`ui-todo`**；declareClient name 必须等于派生键（否则映射缺失→
装载器跳过）。**裁定：统一用目录派生名（`ui-todo`/`ui-jobs`/…）**
——零机制改动，且全族一致（boot graph 键、yml 行 id、ExtensionMeta
name 三处同名）。备选（manifest 显式名）不采。

### 2.4 runview 改名对齐

`ac-client-runview` → **`ac-client-ui-runview`**（前端行全族统一前缀；
派生名 `ui-runview`）。机械：目录改名 + yml/TREE 行 + webui
`api/runs.ts`/`bootGraph.ts`/测试导入面 + 行内 declareClient name。

### 2.5 跨 UI 行依赖（机制已成立）

`ui-group`/`ui-singles` client 插件 inject `['rpc','sessions','roster']`
——`roster` 由 `ui-agents` 行提供：行间依赖走 inject（fiber 等待，
装载序无关）✓ 保持 inject 不动。

### 2.6 双向摘除验收（修正核心收益）

- 卸 **UI 行**（yml patch/热通道）→ 后端在（RPC 可调）+ 前端消费面
  消失（工具卡回落文本渲染、dock 无贡献）；
- 卸**后端行** → UI 行照常装载，RPC 失败 → null → 三态静默空态；
- 每域两向用例进 `ac-client-ui-<域>/tests/`；真树断言进
  boot-graph-http；视觉白名单登记。

### 2.7 迁移顺序

todo（最小带组件）→ jobs → workspace → singles → groups → agents
（roster 最后——ui-group/ui-singles 依赖它）→ runview 改名收尾。

## 3. M27.2：基础七件出包（推翻 S4 常驻定案，用户裁定）

**七件全族 `ac-client-ui-{layout,theme,tool,conversation,renderer,
sidebar,settings}` 独立行包**（本就无后端行；ownership §3.2 的
ac-client-ui-* 包族形态复活——D19/S4 两处修订记录已入计划文档）。

### 3.1 分两步走

**第一步：renderer/sidebar/settings 三件先拆件**（webui 内插件化，
成为第五~七件基础件——无论出包与否都需要）：
- renderer = runtime/vueRenderer·slotRender + markdown 管线/气泡通用
  渲染资产；sidebar = Sidebar 动作区/更多菜单 + 三面板壳；settings =
  SettingsPanel 壳+左树+保存编排。席位从 hostLedger 代持转正
 （hostLedger 退役方向）；
**第二步：七件逐一出包**——携带各自视图资产出 webui（layout 携
AppFrame；conversation 携 feed-core 74KB + chat-core 38KB + DialogView
族……视图资产按 ownership §3.2 配置归属随件迁出）。

### 3.2 关键机制点

- **boot graph phase**：七件 UI 行 declareClient `phase: 'base'`
 （RowClientDescriptor 已有 base/domain 字段；listBootGraph 已按
  phase 排序 base 在前）。**装载器需 phase 感知改造**：main.ts 装配序
  变为 ③ applyBootGraph(base 阶段) → sealFactory 封印 → ④ domain
  阶段——`syncGraph()` 按 phase 分两批装载/回收（热通道 diff 同步
  语义注意：base 行变更需整页重载而非动态回收——裁决点）；
- **pinia**：基础件内部允许 pinia（D10）；包 deps 加 pinia；门面
  （stores/ 四件）随七件出包评估退役/随行；
- **依赖方向**：七件包不再 import webui——视图资产随件走后，共享
  小件（utils/format 等）下沉 @agentchat/webui-kit 或 ac-client-runtime
  （按性质）；webui/ 终态 = main.ts + runtime 胶水（bootGraph/
  rpcClient/clientRuntime）+ api/wire + shims + 构建入口 + dist；
- **视觉零回归**：DOM/CSS 不变性纪律 + 逐件 D23-A 选择器审计 + 视觉
  门逐件 diff（这正是 S1 建基线的用途）。

### 3.3 体量与节奏（诚实评估）

这是 ownership「阶段三」的完全体——view 资产大迁徙（webui/src/
components + settings + composables 大部分随件走）。**逐件独立
提交、件件视觉门全绿再进**；建议顺序：theme（最小）→ tool →
sidebar → renderer → layout → conversation（最重，feed/chat 巨石）→
settings（面板大而独立）。预估占下一 session 的大头；M27.1 先行
（半天量级）后开工。

## 4. M27 剩余后置项（随修正更新）

> **2026-11 收口后补记**：本节后置项已展开为完整施工图——见
> `m28-ui-plugin-tree-plan.md`（P1 域资产归位〔行完整〕→ P2 宿主退化
> 〔贡献席位化——插件树 = slot 树〕→ P3 收尾；含裁决记录 T1-T9、
> 工具卡↔后端域镜像表、逐资产迁移表与提交模板）。本节保留为原始
> 记录，实施以 M28 文档为准。

1. goal/usage/timer/skill 域 UI → **直接建 `ac-client-ui-*` 行**
  （不走后端 client/ 过渡）；
2. stores 四门面退役（消费面切 ctx.roster/sessions）+ feed 分区升级
  store 座位实例轴（与 M27.2 conversation 件联动）；
3. QueueDock/InteractionBar 迁入 tracking:dock-widget 席位贡献；
   ~230 建议名插口按需开口；
4. api/ 薄包装层随消费面收敛退役；主文档 CSP 实施；HMR 热卸载评估
  （D14 后置）。

## 5. 机制与坑（开工前必读）

1. **宿主半边声明**：UI 行整行即宿主——top-level `inject=['webui']`
  （runview 形）；后端行残留的 webui-client 子插件在 M27.1 中删除；
2. **同键双声明 TS2717**：ClientContext 服务名只在一处 declare；富
   类型经门面 cast（stores/feed·chat 两处 `as` 现范本）——M27.2 中
   SessionsClientFace 的 owning 议题重开（conversation 件出包后契约
   面随件走或留 runtime，开工裁定点）；
3. **注册顺序竞态**：事件驱动布尔必须问初值来源（DialogView 连接条
   `ref(wireRpc.connected)` 教训）；
4. **e2e 三件套**：client 栈全装 → `setClientRuntime` →
   `sessions.init()` → 新 pinia 在 setRuntime 之后建 store；
5. **ac-client-runtime DOM 纪律**：结构化类型 + `export {}`；根 tsc
   exclude 浏览器纯库（webui/webui-kit）——**M27.2 后七件包同列
   exclude，类型检查归 webui vue-tsc include**；
6. **视觉门调试链**（无图像输入）：diff 红掩膜包围盒/行带 → 双图
   逐行色采样 → worktree HEAD 对照 dist → 页内几何 walk dump；gate
   失败自动落 `*.current.png`；
7. **desktop**：构建含构件下载（网络敏感，超时×3 后恢复实录在案）；
   冒烟 = dist + win-unpacked exe 进程 12s 存活。

## 6. 建议开工序

1. §1 基线确认绿；
2. **M27.1**（§2.7 顺序逐域拆 + runview 改名）——立范首域 todo；
3. **M27.2**（§3.1 先拆三件再逐件出包，§3.3 顺序与节奏）；
4. §4 后置项按需穿插（goal/usage/timer/skill 直达新形态）；
5. 全量验收（基线 + desktop）→ 计划文档 D19/S4 修订段补「已实施」
   标注，M27.1/M27.2 收口。

## 7. 执行进度（2026-11 M27.1/M27.2 session 实录——下轮续作起点）

### 已收口（提交序列，全部双 typecheck + 全量测试 + check-deps +
视觉门 + webui:build 绿）

| 步骤 | 提交 | 内容 |
|---|---|---|
| M27.1-todo 立范 | `8f40e6a` 前后 | ac-client-ui-todo 拆包 + ac-todo 回归纯后端 + 双向摘除测试 + boot-graph-http 双向断言改写 |
| M27.1-jobs | `d045a07` | 同款（ui-jobs） |
| M27.1-workspace | `66c9572` | 同款（ui-workspace；后端行装配需真 agentStore/agents/session 行 + 临时根） |
| M27.1-singles | `38b3e94` | 同款（ui-singles；注意 portb-e2e/singles-*/等测试里的**动态 import** 也要换源——`from '…'` grep 会漏） |
| M27.1-group | `f5b5278` | 同款（ui-group） |
| M27.1-agents | `3281b89` | 同款（ui-agents；roster 最后拆，ui-group/ui-singles inject 'roster' 不动——fiber 等待机制成立） |
| M27.1-runview 改名 | `362aa66` | ac-client-ui-runview（派生名 ui-runview 三处同名）+ README 布局同步 |
| M27.2-1 三件拆件 | `abb7b09` | renderer/sidebar/settings webui 内插件化 + **hostLedger 退役**（四席位转正：tool-card→tool、message:final-view→conversation、settings 两席→settings）；DOM 不变性验证 = 视觉门**零像素 diff**（基线未动） |
| M27.2-2 首件 theme | `8820ae3` | ac-client-ui-theme 出包（phase:'base'）+ **装载器 phase 感知改造**（applyBootGraph('base') 封印前 / ('domain') 封印后；热通道 base 行集变更 → 整页重载——§3.2 裁决落地） |
| M27.2-2 renderer | `3ae567c` | ac-client-ui-renderer 出包（**次序调整：先于 tool**——markdown 管线是 tool 的硬依赖）：vueRenderer/slotRender/SlotOutlet 族 + useMarkdown/abap-hljs/logger + ScrollableViewport 随件走；13 处测试 vi.mock 键换源 |
| M27.2-2 tool | `c30f72e` | ac-client-ui-tool 出包：tool-card 席位 + 内置 8 卡组件迁入 + workspaceFile/goalCard 数据管线随件走；解析面（resolve/register）留 webui re-export 维持旧路径 |
| M27.2-2 sidebar | `51c3656` | ac-client-ui-sidebar 出包（**分两步交付**）：活动栏（SidebarHost/Sidebar——跨件消费改客户端服务面直连：roster/theme）+ uiStore（pinia D10，webui 门面 re-export 同实例）+ systemApi 随件走；三面板壳暂留 webui shim（webui-base-sidebar-panels——消费 conversation 域门面） |
| M27.2-2 conversation 核心 | `19ed5f6` | ac-client-ui-conversation 出包（**分两步交付之一——核心半边**）：ctx.sessions 服务（feed/chat 核心 rpc 参数化——RpcClientFace 契约面注入，扩可选 onOpen/onAck + call 透传 requestId/timeoutMs）+ types/feed/chatOps/agentsStore/historyApi/switchTrace/media 随件走；clientRuntime 单例下沉 ac-client-runtime；六处 webui 门面 re-export + wireFace 防御适配器；webuiBoot 预 provide rpc 桩（makeRpcStub 工厂——根双 provide 消除）；根 tsconfig 补 @agentchat/protocol paths |
| M27.2-2 conversation 视图半边 | `92fd912` | DialogView/GroupDrawer/ChatInput/InteractionBar + Message 4 件 + ConversationJobsChip/FilePreviewModal/InputMention/QueueDock + TaskDock/GoalBar + 五 composables（rpc 契约面参数化）+ utils（format/tokens/streamingMarkdown/clipboardFile/mention）随件走；数据面随件迁（groupApi/rosterApi/goalApi/skillsApi/fileApi）；messageViews 解析面迁包 + toolResultViews 解析面迁 tool（toolLabel/toolIcon/jobs 视图词汇同步收编）；包内 pinia 门面 chatStore/feedStore（同 id 双定义）；RpcClientFace 扩可选 connected/onClose；视觉门零像素 diff |
| M27.2-2 sidebar 面板壳收尾 | `ca4cbb8` | ListPanelsHost + AgentList/SessionList/RunTrackingPanel + starColor 迁入 ac-client-ui-sidebar（list-panel 席位贡献随包走，shim 退役）；themeStore 进 theme 包；EntryPickerModal 归 conversation（数据面同源）；createAgent/fetchLlmProviders→agents、convKeyToId/interruptRun→runview |
| M27.2-2 settings | `e314b5a` | ac-client-ui-settings 出包：api/schema/types/useSettings + 12 组件 + SettingsOverlayHost；rpcDefault 缺省锚（`rpc = wireRpc` 别名零 body 改动）；页签解析面 extensionTabs + 旧 slot 目录随件走（注册面 bridge 留 webui）；fetchAgentModels→conversation、uploadAvatar/deleteAvatar→agents；视觉基线重建（新行 ui-settings：05/07/08） |
| M27.2-2 layout | `86aec77` | ac-client-ui-layout 出包（基础七件收官）：root + 四 seat + 别名席声明 + AppFrame/PerspectiveHost/ResizeHandle/RunTracking/WorkspaceTree/TokenUsage/VersionDialog/CreateGroupDialog + 视角注册表解析面随件走；PairDialogView 归 conversation；webui 终态自检（clients/ 目录 + constants.ts 除役）；视觉基线重建（新行 ui-layout） |

### 剩余工作（下轮从这里继续）

> **2026-11 收口 session 后：本节 1-5 全部完成——M27.2 收口**
> （conversation 视图半边 `92fd912` → sidebar 面板壳 `ca4cbb8` →
> settings `e314b5a` → layout `86aec77`〔基础七件收官 + webui 终态
> 自检：clients/ 目录与 constants.ts 除役〕；全量验收 + 计划文档
> D19/S4 修订段「已实施」标注完成）。原施工图存档如下；后置项见 §4，
> 新增机制沉淀见下方「收口 session 实录」。

**〔已完成〕开工第一步**：确认起点绿——工作区干净、跑 §1 验收基线（双
typecheck / pnpm test〔当前 1553 通过〕/ check-deps / 视觉门
〔AGENTCHAT_VISUAL=1〕/ webui:build）。

1. **〔已完成 `92fd912`〕conversation 视图半边**（commit B；核心半边已出包 `19ed5f6`——
   ctx.sessions 服务 + types/feed/chatOps/agentsStore/historyApi/
   switchTrace/media 均已在包内，webui 六处门面 re-export）：
   - 迁入包：components/dialog/{DialogView,GroupDrawer}.vue +
     components/chat/{Message/ 4 件, shared/, ConversationJobsChip,
     FilePreviewModal, InputMention, QueueDock} + ChatInput.vue +
     InteractionBar.vue + components/tracking/TaskDock.vue +
     composables/{useChatShell,useQueuedMessages} +
     utils/{format,tokens}.ts（webui 门面 re-export）；
   - 关键改写：DialogView 直连 api/{roster,groups,singles,wire}——
     改 `clientRuntime()?.rpc` 契约面（或数据函数随件迁+webui 薄包装）；
   - AppFrame（layout 件暂留 webui）的 perspective builtins 引用
     DialogView/PairDialogView——webui → 包 import 合法方向 ✓；
   - agents 门面归属已定（随 conversation，sidebar shim 经 webui
     门面消费 ✓）；sessions.init() 时序已成立（base 批次装载，
     init 在 domain 后调用——幂等）。
2. **〔已完成 `ca4cbb8`〕sidebar 面板壳迁入收尾**（conversation 视图半边完成后）：
   ListPanelsHost + AgentList/SessionList/RunTrackingPanel 自 webui
   shim 迁入 ac-client-ui-sidebar（agentsStore 经包 import
   'ac-client-ui-conversation/client/agentsStore.ts'、uiStore 本包、
   api/{roster,runs,tasks} 消费按 conversation 同款改写）；
   clients/base/sidebar.ts shim 退役（main.ts/webuiBoot 同步）。
3. **〔已完成 `e314b5a`〕settings 件**（依赖面已盘）：SettingsOverlayHost +
   settings/{api,schema,types,useSettings,components/ 12 件}。
   关键改写：settings/api.ts 的 wireRpc 直连改 clientRuntime()?.rpc
   契约面；core/extensions/slots 的 sorted{Settings,AgentSettings}Tabs
   解析面随 settings 走（注册面 bridge 留 webui）；api/roster·files
   的 settings 用函数随件迁或薄包装；EntryPickerModal 被 SessionList
   共用——conversation 视图半边先行后此耦合消解。
4. **〔已完成 `86aec77`〕layout 件**（最后——组合一切）：AppFrame + ResizeHandle +
   PerspectiveHost + 剩余 overlay 件（TokenUsage/VersionDialog/
   CreateGroupDialog/RunTracking?——按 ownership §3.2 再裁；终态裁定：
   PairDialogView 归 conversation、视角注册表解析面随 layout、
   fetchWorkspaceTree→workspace / createGroup→conversation /
   fetchChangelog+runVersionUpdate→sidebar systemApi）。
   完成后 webui 终态自检 ✓：main.ts + runtime 胶水（bootGraph/rpcClient/
   clientRuntime re-export）+ core/extensions bridge + api 薄包装层
  （退役评估）+ shims + 构建入口 + dist。
5. 〔已完成〕全量验收（§1 基线 + desktop 构建冒烟）+ 计划文档
   m27-webui-slot-refactor-plan.md D19/S4 修订段补「已实施」标注。

### 机制沉淀（跨轮累积——出包动作照此清单过）

**出包模板**（照 ac-client-ui-conversation 最新形态）：
- 新包 `src/ac-client-ui-<件>/`：package.json（agentchat.plugin +
  client 清单 phase:'base'；deps 含 ac-client-runtime/ac-client-slots/
  需要的兄弟 UI 包；pinia 按 D10）+ src/index.ts（宿主半边
  declareClient，name = 派生名三处同名）+ client/（插件名
  `ac-client-ui-<件>.client`）+ tests（node 宿主半边/jsdom client
  半边分文件）；
- webui 侧四件套：in-bundle 除役（main.ts/webuiBoot）+ 门面
  re-export（消费面零改动）+ 组合根两表（cordis.yml + ac-app TREE）
  + 两 package.json deps；portb-e2e 行集断言 +ui-<件>
 **（目录序 = localeCompare，不是 ASCII！）**；boot-graph-http
  base 断言；视觉基线重建（插件目录新行 07/08——
  AGENTCHAT_VISUAL_UPDATE=1 后复跑确认零 diff）。

**坑与解法（实录）**：
- vite `discoverRowClients` 派生名天然覆盖 ac-client-ui-*（strip
  `ac-client-`）；根/webui 两 tsconfig glob 天然覆盖新包；
- **包内导入显式扩展名**（.ts/.vue）——exports 通配下 extensionless
  在 vue-tsc 失败；
- **vi.mock 键随迁移换源**：mock 的是导入方 specifier——grep
  `vi.mock('../src/…')` 对照迁移清单（logger 13 处/wire 族已处理；
  wire 相关用 wireFace 防御适配器后无需 mock wireRpcFace）；
- **jsdom URL 垫片 × node:url 不兼容**：宿主半边行测试必须 node；
  client 半边读 document 的（useMarkdown/uiStore 等）jsdom——分文件；
- **无类型依赖**：@types/* 进包 devDeps；texmath 垫片随 owning 件；
- **vite DEV 旗标**在包内改结构性取值
 （`(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV`）；
- **@agentchat/protocol 无实包**：根 tsconfig 已加 paths 映射到
  webui shim（勿删）；
- **rpc 契约面**：包内数据函数 rpc 必传（webui 包装传
  wireFace——runtime/wireFace.ts 防御适配器）；
  `ctx.provide('rpc', …)` 一经调用不得再 provide（cordis 根双注册
  抛错）——测试用 makeRpcStub().impl 传 bootWebuiRuntime(rpc)；
- **clientRuntime 单例已下沉 ac-client-runtime**（包内非组件上下文
  用 `clientRuntime()?.rpc` / `?.roster` 等——webui re-export 兼容）；
- 视觉零 diff 是 DOM 不变性直接证据（abb7b09 先例）；CRLF 文件上
  Node 脚本批量替换记得匹配 `\r\n`（或用 edit 工具）。

**收口 session 新增实录（视图半边 → layout 全链）**：
- **pinia 门面双定义形态**：包内组件消费包内 store（chatStore/
  feedStore/themeStore——runtime 绑服务核心 / 无 runtime 离线桩），
  webui 门面保留 wireFace 独立分支供 feed/chat 状态机测试族
  （vi.mock '../src/api/wire' 拦截面不变）。同 pinia id 双定义 =
  先注册者生效；app 内两定义均走 runtime 分支 → 同一 store 实例。
  **勿把 webui stores 改成纯 re-export**（独立实例分支是测试族的
  数据驱动面——21 处红灯实录）；
- **`rpc = wireRpc` 缺省零改动迁移**：包内 rpcDefault.ts（clientRuntime
  单例委托 + 拒绝桩）以 `import { defaultRpc as wireRpc }` 别名复用——
  settings/api.ts 40+ 函数签名零 body 改动随件迁；组件 rpc seam =
  `useClientContext()?.rpc ?? null` + 早退守卫（离线桩不误显）；
- **解析面归属 = owning 件**：messageViews→conversation、
  toolResultViews/toolLabel/toolIcon→tool、sorted*Tabs/slotCatalog→
  settings、perspectives→layout；webui registry/ 目录全为 re-export
  门面（bridge bind/register 面 + 测试导入面零改动——同模块实例）。
  **解析面单测链不得触 .vue**（node 环境）：SLOT_KEY/def 类型与
  解析面同文件、出厂批次住 index.ts re-export（toolResultViews 先例）；
- **跨包静态视图 import 不构成 R5 环**：环检测只看 .ts 运行时值边
  ——.vue 互引（conversation↔sidebar uiStore/agentsStore）合法；
  包间数据函数走「rpc 必传 + 缺省适配层」（settings dataFaces/
  layout rpcDefault 先例）；
- **slots 注册表 order 轴**：同 id 重注册继承插入序，选举按【顶层
  entry.order】（meta.def.order 仅视图携带）——解析面 computed 依赖
  锚用 slots/changed 版本计数（runtime 缺席期首读也要建锚，ctx.slots.
  version 直读在 pre-boot 首读后不失效——settings extensionTabs 实录）；
- **视觉基线重建时机**：仅新增行（ui-settings/ui-layout）触发
  05/07/08 重建；纯文件搬迁零 diff（DOM 不变性）。
