# M28 UI 插件树拆分计划 — 域资产归位 + 宿主退化（插件树 = slot 树）

> **状态：P0/P1 已实施（2026-11-08——见 §10 执行进度）；P2/P3 待续**。
> 前置 = M27 全量收口（2026-11——见
> `m27-handoff.md` 进度快照 + `m27-webui-slot-refactor-plan.md` D19/S4
> 修订段「已实施」标注）。本文收编 `m27-handoff.md` §4 后置项，并按
> 「宿主退化为 slot 提供者、一切视觉内容成为贡献行叶子」的思路展开为
> 完整施工图。
> 事实源：`m27-handoff.md` §7 机制沉淀（出包模板/坑与解法）；
> `webui-slot-tree.md`（席位语义四分类 + ~230 建议名插口）；
> `webui-plugin-ownership.md`（资产归属原案）。

## 0. 目标一句话

**基础七件退化为「席位声明 + 解析面 + 壳容器」（近乎零视觉资产）；
一切视觉内容（卡/视图/面板/dock/弹窗/页签）成为独立贡献行的叶子——
UI 插件树等价于 slot 树的运行时形态，贡献行的自然单位镜像后端能力
域。**拆分判据从 M27.2 的「消费面归属」修正为「域归属 + 席位贡献」。

## 1. 现状盘点（M27 收口时点）

### 1.1 体积分布（client/ 资产，KB / .vue 数）

| 包 | 体积 | vue | 包 | 体积 | vue |
|---|---:|---:|---|---:|---:|
| conversation | 543 | 16 | todo | 21 | 3 |
| settings | 413 | 13 | agents | 17 | 0 |
| layout | 161 | 9 | runview / singles | 12 | 0 |
| sidebar | 113 | 6 | jobs | 8 | 0 |
| tool | 108 | 8 | group | 7 | 0 |
| renderer | 37 | 2 | workspace | 5 | 0 |
| | | | theme | 4 | 0 |

conversation + settings 两包占全族 **65%**——粒度偏大的实体证据。

### 1.2 三类借宿（问题定义）

1. **数据面借宿**（纪律副作用：「数据函数随件迁 = 跟消费面走」）：
   conversation 持有 skill 目录（skillsApi）、群写侧（groupApi）、
   名册/池（rosterApi）、上传/目录浏览（fileApi）、goal 读面
   （goalApi）；sidebar 持有 system 域（systemApi）。
2. **视图借宿**（纪律副作用：「AppFrame 直挂组件随 layout 走」）：
   layout 收容 runview 域（RunTracking）、workspace 域（WorkspaceTree）、
   usage 域（TokenUsage）、system 域（VersionDialog）、group 域
   （CreateGroupDialog）；sidebar 收容 agents/singles/runs 三域面板。
3. **域行残缺**：group（写侧+建群弹窗在外）、runview（运行矩阵在外）、
   workspace（树视图+文件预览+浏览上传在外）、agents（池数据面在外）
   ——行不完整导致「卸域行 ≠ 该域 UI 消费面消失」的语义漏洞。

### 1.3 不需要拆的

theme（无 slot 语义的全局状态，4KB 终态）、renderer（渲染机制本体
——SlotOutlet/useMarkdown 是「树的渲染器」）、以及各包的**壳容器**
（AppFrame/SidebarHost/ListPanelsHost/PerspectiveHost/SettingsPanel
骨架/TaskDock dock 列容器）——壳即席位宿主，留在宿主包。

## 2. 终态蓝图：插件树 = slot 树

### 2.1 两层形态

```
宿主层（phase:'base'——壳 + 席位 + 解析面，全 SlotOutlet 渲染）
  layout        root/main/overlay/list-panel/sidebar 六席位 + AppFrame
                纯壳 + perspectives 解析面
  sidebar       活动栏壳 + 三面板壳（ListPanelsHost）+ plugin-actions 席位
  conversation  ctx.sessions 服务 + feed/chat 核心 + message:final-view /
                tracking:dock-widget / chat:composer（新开）三席位 +
                消息流骨架（TurnDisplayItem/Message 4 件）+ messageViews
  tool          tool-card:result-view 席位 + 解析面 + 选举语义（零卡）
  settings      settings 两席位 + 面板壳 + extensionTabs 解析面
  theme/renderer 地基（不变）

贡献层（domain 行——UI 树叶子，每行 = 视图 + 数据面 + 席位贡献）
  视角：talk（conversation 出厂）/ group / single / pair（随域行贡献）
  消息视图：user/assistant（conversation 内置出厂）+ 专用消息卡
  工具卡：bash / fs(read·write·edit) / web / browser / subagent /
          goal / todo（镜像后端工具域）
  dock：todo 面板 / goal 条 / queue / ask_questions
  面板：agents / sessions / tracking（list-panel 贡献）
  弹窗：文件预览 / 建群 / 用量 / 版本 / 设置页签族（overlay/页签贡献）
```

### 2.2 与后端能力树的镜像（工具卡映射表）

| 后端行（能力域） | UI 卡行 | 卡片（tool-card:result-view 贡献） |
|---|---|---|
| ac-shell-tools | **ac-client-ui-shell**（新） | bash → ToolResultTerminal |
| ac-fs-tools + ac-str-replace-editor | **ac-client-ui-fs**（新） | read → Code / write → Write / edit → Edit |
| ac-web-tools | **ac-client-ui-web**（新） | web_search + 浏览器族正则 → Web |
| browser 域 | **ac-client-ui-browser**（新） | browser → Browser（多动作 tab） |
| ac-subagent | **ac-client-ui-subagent**（新） | subagent → Subagent |
| ac-goal | **ac-client-ui-goal**（新，§4.1 原案） | goal → Goal + GoalBar + useGoalTracking + goalApi |
| ac-todo | ac-client-ui-todo（已行） | todo 卡（已贡献）+ TodoPanel |
| 无卡（回落文本渲染，不动） | — | math / fs-search / adt_* / mcp 动态工具 |

镜像的卸载语义自动对齐：卸后端工具域 → 该域 UI 卡行同卸/静默空态。
**未列出的工具域不建卡行**——无卡可拆时行不存在（三刹车之一）。

### 2.3 树全景（与 webui-slot-tree.md 逐 seat 对应）

```
root ─ layout（壳）
├─ sidebar ─ sidebar（活动栏壳）＋ plugin-actions ← 各域动作
├─ list-panel ─ sidebar（面板壳）
│   ├─ agents 面板 ← ui-agents
│   ├─ sessions 面板 ← ui-singles × ui-workspace
│   └─ tracking 面板 ← ui-runview × ui-jobs
├─ main
│   ├─ main:perspective ← talk（conversation 出厂）/ group（ui-group）/
│   │                     single（ui-singles）/ pair（ui-runview）
│   │   ├─ message:final-view ← user/assistant（内置）+ 专用卡
│   │   ├─ tool-card:result-view ← 各工具卡行（§2.2）
│   │   ├─ chat:composer ← composer（T7 裁决）
│   │   └─ chat:composer-docks ← tracking:dock-widget（todo/goal/
│   │       queue/ask_questions——三态契约已实施）
│   ├─ 运行矩阵 ← ui-runview
│   └─ 工作区树 ← ui-workspace
└─ overlay
    ├─ 设置面板 ← settings 壳（页签 ← 各域贡献）
    ├─ 文件预览 / EntryPicker ← ui-workspace
    ├─ 建群弹窗 ← ui-group
    ├─ 用量面板 ← ui-usage
    └─ 版本弹窗 ← ui-system
```

## 3. 裁决记录（T1-T9）

- **T1 宿主退化定义**：宿主包 = 席位声明 + 解析面 + 壳容器 + 域核心
  服务（conversation 的 sessions 服务是数据服务非视图，不退化）。
  退化终点：宿主包近乎零「可摘除语义」视觉资产——一切可摘除视觉
  都在贡献行。
- **T2 贡献行自然单位 = 后端能力域**：不按单卡/单组件拆——read 与
  edit 分属两行无独立摘除语义；fs 一行三卡（同后端 ac-fs-tools）。
- **T3 数据面归属 = 跟域走**（修正 M27.2 的「跟消费面走」）：资产
  属于哪个域就归哪个域行；跨域消费经包 import（domain→base 合法）
  或服务面/inject，不经资产借用。
- **T4 依赖方向**：base 宿主不得 runtime 依赖 domain 行（phase 序）；
  贡献行依赖宿主（注入席位/服务）恒合法。跨包 .vue 互引不构成 R5
  环（环检测只看 .ts 运行时值边——M27.2 实录）。
- **T5 拆分三刹车**：① 纯函数不成行（format/tokens/mention/
  starColor/streamingMarkdown/clipboardFile → 下沉 webui-kit /
  ac-client-runtime）；② 无独立摘除语义不成行（user/assistant 消息
  视图留 conversation 内置出厂；queue/ask dock 留 conversation 出厂
  贡献——同为会话域动作）；③ 行数管理成本（yml/TREE 两表 + 测试 +
  portb-e2e 行集断言 + 视觉基线插件目录行随行数线性涨）——全族
  上限 ~28 行，超过即合并。
- **T6 视角行化归属**：talk 留 conversation 出厂（域核心视图）；
  group/single/pair 视角由 ui-group/ui-singles/ui-runview 行贡献
  （视角组件 = 跨包引用 DialogView 内核 + 域 props——domain→base
  合法）。四视角的 AppFrame 内置注册批次退役。
- **T7 composer 席位与输入域（开工裁定点）**：slot-tree 的
  `chat:input ⚠【替】` 逃生口「建议仅宿主内部使用」。保守案（默认）：
  ChatInput/InputMention/mention 留 conversation（输入 = 会话域动作
  核心，与 ChatCore 深耦合）；激进案：开 `chat:composer` 席位拆
  ui-composer 行。**P2 开工时以「拆出后 conversation 是否仍内聚」
  为判据裁决**，不预设。
- **T8 内置出厂批次保留集**：user/assistant 消息视图、talk 视角、
  queue/ask dock、内置工具卡解析语义——这些是「宿主语义地基」，
  保留为 owning 件出厂注册（tier 0）；其余视觉内容一律行化。
- **T9 词汇与目录治理**：toolLabel/toolIcon 的 per-tool 词条随卡行
  走（卡片行自带 label/icon meta，解析面只做 election）；slotCatalog
  （LEGACY_SLOT_CATALOG）迁 ac-webui-extensions（宿主注册表行——
  第三方 manifest 声明面与其注册面同宿主）。

## 4. 机制前置（P0——三个缺口，P1 开工前补齐）

1. **overlay/main 内联默认项 → 席位贡献**：AppFrame 的 overlay/
   main 已是 SlotOutlet，RunTracking/WorkspaceTree/TokenUsage/
   VersionDialog/CreateGroupDialog/文件预览目前是 outlet 内联
   SlotOutletItem——切出为各域行注册贡献。此动作与 P1 的视图迁行
   **合并执行**（迁行时直接以贡献形态落位）。
2. **视角出厂贡献化**：AppFrame builtins 四视角批次 → T6 归属的
   出厂贡献（registerPerspective 走 slot 注册表，机制现成）。
3. **面板贡献化**：ListPanelsHost 内联三面板 → 各域行经 list-panel
   席位贡献（壳按 ui.listPanel 三选一选举——选举谓词随贡献 meta）。
4. （随 P2 T7 裁决）`chat:composer` 席位开设与否。

## 5. 阶段计划

### 5.1 P1 域资产归位（行完整——数据面 + 视图随域走）

先数据面（无 UI 变化、纯门面改写），后视图（以席位贡献形态落位）。
逐资产迁移表：

| 资产 | 现居 | 去处 | 动作 |
|---|---|---|---|
| goalApi / useGoalTracking / GoalBar | conversation | **ui-goal（新行）** | §4.1 原案 |
| goalCard + ToolResultGoal | tool | ui-goal | 卡+管线随行 |
| skillsApi | conversation | **ui-skill（新行）** | §4.1 |
| usageApi + TokenUsage | layout | **ui-usage（新行）** | §4.1；overlay 贡献 |
| TimerPane | settings | **ui-timer（新行）** | §4.1；settings 页签贡献 |
| systemApi 全量 + VersionDialog | sidebar + layout | **ui-system（新行）** | 版本入口仍由 sidebar 更多菜单触发（动作跨行消费合法）；或并 sidebar——开工裁定点 |
| groupApi ×4 + CreateGroupDialog | conversation + layout | **ui-group（增重）** | 建群弹窗以 overlay 贡献落位 |
| rosterApi + agentsStore | conversation | **ui-agents（增重）** | agentsStore 走 §4.2 退役方向（消费面切 ctx.roster） |
| fileApi + EntryPickerModal + FilePreviewModal + WorkspaceTree(/Node) + workspaceFile | conversation + layout + tool | **ui-workspace（增重）** | 文件预览以 overlay 贡献落位 |
| RunTracking + RunTrackingPanel | layout + sidebar | **ui-runview（增重）** | 矩阵以 main 贡献、面板以 list-panel 贡献落位 |
| ConversationJobsChip | conversation | **ui-jobs（增重）** | 随 DialogView 头部消费（跨包 import） |
| slotCatalog | settings | ac-webui-extensions | T9 |
| format / tokens / streamingMarkdown / clipboardFile / mention / starColor | conversation / sidebar | webui-kit / ac-client-runtime | **P3 下沉**（P1 不动，先保消费面零改动） |

**P1 顺序**（依赖序：先收容大户，再减负大户）：
workspace 增重 → group → runview → agents → goal/usage/timer/skill/
system 四+一新行 → conversation 减负收口。每步独立提交。

### 5.2 P2 宿主退化（贡献席位化）

| 宿主 | 退化动作 | 退化后 |
|---|---|---|
| tool | 内置 8 卡 → §2.2 五个卡行（fs 行先立样板） | ~15KB：席位+解析面+选举语义 |
| conversation | 视角行化（T6）；queue/ask dock 改出厂贡献形态；composer 按 T7 裁决 | ~280KB：sessions 服务 + 消息流骨架 + 出厂批次 |
| sidebar | 三面板 → 域行 list-panel 贡献 | ~60KB：活动栏 + 壳 + uiStore |
| layout | 视角 builtins 退役（随 P0-2） | ~55KB：壳三件 + 解析面 |
| settings | AgentPane/AgentListPane → ui-agents 页签贡献；PoolManager → **ui-llm-pool（新行）** 页签贡献；插件库四件 → **ui-plugin-registry（新行）** 页签贡献 | ~200KB：壳 + 左树 + 保存编排 + 解析面 |

### 5.3 P3 收尾

纯函数下沉 kit/runtime（上表末行）；webui api/ 门面层随消费面收敛
退役（§4.4）；stores 四门面退役 + feed 分区 store 座位实例轴（§4.2）；
~230 建议名插口按需开口（§4.3）；插件目录视觉基线改抽样断言（行数
增长后目录页滚屏——见 §8 风险缓解）；webui 终态复核 + 全量验收。

## 6. 提交模板与逐行验收

沿用 M27 出包模板（`m27-handoff.md` §7 机制沉淀），要点复述：

- 新行 `src/ac-client-ui-<域>/`：package.json（agentchat.plugin +
  client 清单 phase；卡行/面板行 = 'domain'，纯 base 例外按现状）+
  src/index.ts（宿主半边 declareClient，派生名三处同名）+ client/ +
  tests（node 宿主半边 / jsdom client 半边分文件）+ **双向摘除用例**
  （卸 UI 行 → 消费面消失；卸后端行 → RPC 失败三态静默）。
- 组合根两表（cordis.yml + TREE）同步；portb-e2e 行集断言
  （**目录序 = localeCompare**）；boot-graph-http phase 断言；视觉
  基线重建（新行 → AGENTCHAT_VISUAL_UPDATE=1 后复跑零 diff）。
- 门禁：双 typecheck + 全量测试 + check-deps（R5 只看 .ts 运行时
  值边——跨包 .vue 互引不触发）+ webui:build。
- 包内数据函数 rpc 必传；解析面单测链不触 .vue；CRLF 批量替换匹配
  `\r\n`；pinia 门面双定义形态沿用（webui 测试族拦截面不动）。

## 7. 行数与体积终态预估

| 层 | 行 | 体积区间 |
|---|---|---|
| 宿主 7 件 | theme/renderer/layout/sidebar/conversation/tool/settings | 4KB–280KB（conversation 最大，sessions 核心+消息流） |
| 域行（完整） | agents/todo/jobs/workspace/singles/group/runview/goal/usage/timer/skill | 11 行，5–60KB |
| 工具卡行 | shell/fs/web/browser/subagent | 5 行，8–25KB |
| 弹窗/页签行 | system/llm-pool/plugin-registry（+composer 若 T7 激进案） | 3–4 行，10–40KB |
| **合计** | **26–27 行**（M27 收口 14 行） | 单包 ≤280KB，巨石消失 |

## 8. 风险与回退

1. **管理成本线性涨**（两表/断言/基线随行数）：全族上限 ~28 行（T5）；
   插件目录视觉基线改抽样断言；portb-e2e 行集断言考虑生成化。
2. **跨包 .vue import 增多**（DialogView 被三域视角行引用）：domain→
   base 方向合法；bundling 由 vite 行 client 模块块天然隔离；若出现
   运行时环，回落「视角组件留 conversation 出厂 + 域行仅贡献 props
   工厂」的保守形态。
3. **数据面迁移的测试族换源**：vi.mock 键随迁移换源（M27.2 实录——
   grep `vi.mock('../src/…')` 对照迁移清单）。
4. **贡献行丢失后回落**：所有席位保持四态回落/三态契约（slot-tree
   §5 语义）——行卸载 = 席位贡献消失，宿主壳不残废（M27 双向摘除
   纪律延续，逐行测试锁定）。
5. **回退策略**：P1 每步独立提交且 webui 门面 re-export 保旧路径——
   任一步可单独 revert；P2 席位化以「内联默认项 → 出厂贡献」渐进而
   非 Big Bang，每宿主独立提交。

## 9. 与 m27-handoff §4 后置项的收编对照

| §4 后置项 | 本文落点 |
|---|---|
| 1. goal/usage/timer/skill 直达新形态 | §5.1 四新行 |
| 2. stores 四门面退役 + feed store 座位实例轴 | §5.3（P3） |
| 3. QueueDock/InteractionBar 迁席位贡献；~230 插口按需开口 | T5②/T8（出厂贡献形态）+ §5.3 |
| 4. api 薄包装层退役；主文档 CSP；HMR 热卸载 | §5.3 + 不变（另行推进） |

—— M28 施工期间 `m27-handoff.md` 转入只读存档；进度实录记入本文
附节（开工后追加「执行进度」段，与 M27 文档同款式）。

## 10. 执行进度（2026-11-08 开工 session 实录）

> 状态标注：本文头部「计划（待实施）」改读作「P0/P1 已实施、
> P2/P3 待续」。每步独立提交，全量门禁绿（双 typecheck / 全量测试 /
> check-deps R1-R6 / 视觉门〔新行基线重建后复跑零 diff〕/ webui:build
> 经视觉门内置重建）。

### 已收口（P0 + P1 全部）

| 步骤 | 提交 | 内容 |
|---|---|---|
| P1-1 workspace 增重 | `d5f775c` | fileApi/EntryPickerModal/FilePreviewModal/WorkspaceTree(/Node)/workspaceFile 随域迁入；文件预览 = overlay 贡献（order 90）、工作区树 = 新席 main:workspace 贡献（壳按席位占用门控：rail/把手随行卸载隐藏）；chatPresence 上传登记解耦为 conversation 消费门面 |
| P0-2 视角出厂贡献化 | `7139f0d` | AppFrame 四视角内置批次退役：talk → conversation（T8 tier 0）、group/single/pair → 域行；落位机制 = **slots.inject 声明存活期效应**（席位在场即注册/缺席即等待/塌缩或卸载即回收）——解 base 批次名序（ui-conversation 恒先于 ui-layout 装载）与裸 client 测试两态；视角组件 defineAsyncComponent 惰性化（node 环境消费行 client 模块不求值 .vue 链）；Perspective 接口增 order（pair 10 < talk 20 < group 30 < single 40 保持原选举序） |
| P1-2 group 增重 | `5bdcadd` | groupApi ×4 + CreateGroupDialog 随域迁入；建群弹窗 = overlay 贡献（order 95） |
| P1-3 runview 增重 + P0-3 | `5810a65` | RunTracking → main:tracking 单席贡献（让位协议壳留 layout，chat 区按席位占用门控直显）；RunTrackingPanel → **list-panel:domain 选举席**（新机制：壳按 ui.listPanel × 贡献 meta.panel 选举渲染——选举席与外层 list-panel outlet 分离防叠加〔视觉门首跑红修正〕）；agents/sessions 面板暂内联（P2） |
| P1-4 agents 增重 | `92027d4` | rosterApi（名册/池/Token/模型发现）随域迁入；VIEWER_ID 本地常量防 conversation↔agents 包环 |
| P1-5 四+一新行 | `efbbced` `0a21170` `c0d9ad5` | **ui-goal**（goal 卡 + GoalDockCard order 20 + goalCard/goalApi/useGoalTracking/GoalBar——TaskDock 退化为纯席位宿主、tool 零任务追踪卡）；**ui-usage**（TokenUsage overlay 贡献 order 96 + usageApi + chart.js/d3-chord 随域自 layout 迁入）；**ui-skill**（skillsApi 数据面行）；**ui-system**（systemApi + VersionDialog overlay 贡献 order 97——AppFrame overlay 内联项清零）；**ui-timer**（TimerPane 视图资产行） |

### 行数现状

M27 收口 14 行 → **19 行**（+goal/usage/skill/system/timer 五域行；
§7 预估终态 26-27 行，P2 卡行/页签行拆分后到位）。

### 裁决注记（实施中显形，供 P2/P3 续作）

1. **agentsStore 不随 P1-4 迁移**：其文件头既定「conversation 收尾时
   退役，消费面切 ctx.roster」——feed-core/chat-core（sessions 服务
   核心）深耦合 useAgentStore，此刻翻转 = 基础件核心反向依赖域行；
   按 §4.2 退役方向留 P3（stores 四门面退役同期）。
2. **ui-timer 全局 sys.timer 页签贡献留 P2**：SettingsPanel 内联块
   （g-timer）与设置树编排深耦合；P2 settings 退化（AgentPane/
   AgentListPane/PoolManager/插件库页签贡献化）同期经
   settings:main-view 席位落位，避免两次动同一树。
3. **T9 slotCatalog 迁 ac-webui-extensions 留 P3**：slotCatalog 是
   浏览器模块（clientRuntime 依赖）而 ac-webui-extensions 是服务端
   纯包——迁移需随 P3 api/门面层退役的客户端/服务端接缝设计同期
   （toolLabel/toolIcon 词条随卡行走同批——数据注册表化是 P3 批次）。
4. **视角组件跨包形态**：域行视角 = defineAsyncComponent 异步引用
   DialogView/PairDialogView 内核（domain→base 合法 + node 环境安全）。
5. **overlay DOM 序锚**：贡献 order 显式定序保持原 AppFrame 内联序
   （文件预览 90 → 建群 95 → 用量 96 → 版本 97 → 设置 100 缺省）——
   视觉门零 diff 的机制保证。

### 剩余工作（下轮从这里继续）

- **P2 宿主退化**（§5.2）：tool 内置 7 卡 → 五个卡行（fs 行先立样板，
  workspaceFile 跨包消费随之收口）；sidebar agents/sessions 面板 →
  域行 list-panel:domain 贡献；settings 四大件页签贡献化（AgentPane/
  AgentListPane → ui-agents；PoolManager → ui-llm-pool 新行；插件库
  → ui-plugin-registry 新行；TimerPane 全局页签 → ui-timer）+
  T7 composer 裁决（「拆出后 conversation 是否仍内聚」判据）；
  conversation queue/ask dock 改出厂贡献形态。
- **P3 收尾**（§5.3）：纯函数下沉 kit/runtime；stores 四门面退役
  （agentsStore 消费面切 ctx.roster）；api/门面层收敛退役；T9
  slotCatalog + toolLabel/toolIcon 词条随行；~230 插口按需开口；
  插件目录视觉基线改抽样断言；webui 终态复核。
