# M27 WebUI 纯 Slot 重构 — 最终交接（2026-11，M27.1/M27.2 拆包修正）

> **进度快照（2026-11 M27.1/M27.2 执行 session，见文末「执行进度」节）**：
> M27.1 已全部收口（六域 + runview 改名，7 提交）；M27.2 第一步
> （三件拆件 + hostLedger 退役）与第二步 theme/renderer/tool/sidebar/
> conversation 核心（含装载器 phase 感知改造 + clientRuntime 单例
> 下沉）五件出包已收口。剩余：conversation 视图半边（DialogView 族）
> → sidebar 面板壳迁入收尾 → settings → layout + 全量验收。

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

### 剩余工作（下轮从这里继续）

1. **M27.2-2 三件出包**，依赖序：**conversation →（sidebar 面板壳迁入
   收尾）→ settings → layout**。每件 = 新包 `ac-client-ui-<件>`（照
   theme/renderer/tool/sidebar 模板：src/index.ts 宿主半边 declareClient
   phase:'base' + client/ 半边 + 行测试〔node 宿主半边/jsdom client 半边
   分文件〕）+ 视图资产随件迁出 + webui in-bundle 除役 + 组合根两表/
   两 package.json/portb-e2e 行集（**目录序 = localeCompare**）/
   boot-graph-http base 断言/视觉基线重建。
2. **conversation 件资产清单**（commit B——视图半边待迁；核心半边已出包
  `19ed5f6`：ctx.sessions 服务 + types/feed/chatOps/agentsStore/
   historyApi 随件走，webui 六处门面 re-export）：
   - 核心：clients/base/{conversation,feed-core,chat-core}.ts +
     stores/{feed,chat}.ts 门面（双模回落独立实例）+ api/chat-ops.ts；
   - 视图：components/dialog/{DialogView,GroupDrawer}.vue +
     components/chat/{Message/ 4 件, shared/, ConversationJobsChip,
     FilePreviewModal, InputMention, QueueDock} + ChatInput.vue +
     InteractionBar.vue + components/tracking/TaskDock.vue +
     composables/{useChatShell,useQueuedMessages}；
   - 共享 utils（多件消费——迁 conversation 后由消费方跨件 import 或
     下沉）：utils/{feed,format,tokens,switchTrace}.ts；
   - 注意：DialogView 直连 api/{roster,groups,singles,wire}——RPC 面
     在包内经 ctx.rpc 契约面改写或随件迁；agents 门面
    （stores/agents.ts）被 sidebar 面板壳共用——conversation 出包时
     一并定归属（倾向随 conversation 迁，sidebar shim 改跨件 import）；
   - **sessions.init() 时序**：conversation 出包后 main.ts 的
     ctx.sessions.init() 移到 base 批次装载后（applyBootGraph('base')
     之内/之后、domain 之前——init 幂等已具备）；
   - 完成后：sidebar 三面板壳（ListPanelsHost + AgentList/SessionList/
     RunTrackingPanel）自 webui shim 迁入 ac-client-ui-sidebar，
     clients/base/sidebar.ts shim 退役。
3. **settings 件**（依赖面已盘）：SettingsOverlayHost +
   settings/{api,schema,types,useSettings,components/ 12 件}。
   关键改写：settings/api.ts 的 wireRpc 直连改 clientRuntime()?.rpc
   契约面；core/extensions/slots 的 sorted{Settings,AgentSettings}Tabs
   解析面随 settings 走（注册面 bridge 留 webui）；api/roster·files
   的 settings 用函数随件迁或薄包装；EntryPickerModal 被 SessionList
   共用——conversation 视图半边先行后此耦合消解。
4. **layout 件**（最后——组合一切）：AppFrame + ResizeHandle +
     PerspectiveHost + 剩余 overlay 件（TokenUsage/VersionDialog/
     CreateGroupDialog/RunTracking?——按 ownership §3.2 再裁）。
5. 全量验收（§1 基线 + desktop 构建冒烟）+ 计划文档
   m27-webui-slot-refactor-plan.md D19/S4 修订段补「已实施」标注。

### 本轮机制沉淀（增量）

- vite `discoverRowClients` 派生名天然覆盖 `ac-client-ui-*`（strip
  `ac-client-` 前缀）——ui-theme 等基础件与六域同机制，零配置；
- 根 tsconfig `src/*/client/**/*.ts` 与 webui tsconfig `../ac-*/client/**`
  glob 均天然覆盖新包（无需改 tsconfig）；
- 出包件的 webui 侧门面/测试导入面换源后，`pnpm install` 重建
  workspace 链接即可（webui package.json deps 同步换源）；
- 双 typecheck 之外，视觉门「零 diff」是拆件 DOM 不变性的直接证据
 （abb7b09 提交即以基线未动通过验证）。
