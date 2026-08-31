# WebUI src→preview 布局对齐分析（M18-F）

> 2026-08-23。目标：全面分析 src 轨道 webui（`src/ui/webui`）的布局、风格与
> 功能，将 preview 轨道 webui（`preview/webui`）的界面对齐 src——布局与风格
> 优先，功能在 preview 现有后端能力（wire RPC + 事件目录）范围内尽量对齐。
> "无面即无视图"：preview 后端没有的能力（singles 独立会话 / workspaces
> 工作区树 / 版本检查更新）不造假 UI。

## 一、src 轨道 webui 全景（分析结论）

### 1. 三层标准布局模型（App.vue）

```
.app-layout (flex row, 100vh)
├── 第一层 Sidebar (48px 图标条, z-10)
├── 第二层 列表槽位 .list-panel-wrapper (260px, ResizeHandle 拖拽 160~视口-48-320)
│     └── 按 ui.listPanel 三选一：AgentList | SessionList | RunTrackingPanel
├── 第三层 .main-area (flex:1)
│     ├── RunTracking 运行矩阵大画布 (v-if, 选中会话时让位)
│     └── .chat-area (v-show 保活——流式状态/草稿不因看矩阵丢失)
│           ├── PerspectiveHost（视角注册表：pair → talk → group → single）
│           ├── ResizeHandle + WorkspaceTree (280px 右侧分屏, 悬浮把手展开)
│           └── …
└── 全局浮层：FilePreviewModal / CreateGroupDialog / SettingsPanel /
      TokenUsage / VersionDialog
```

核心交互律（src "标准布局模型"）：

- **活动栏只换侧边栏面板，不直接决定主区**（`ui.openListPanel(panel)`：
  点当前页 = 收起/展开；点另一页 = 切换并展开；页签持久化 localStorage）。
- **主区由侧边栏选择驱动**：watch 选中三元组（agent/group/single）出现
  非空变化 → `closeTrackingView()` 矩阵让位回聊天；矩阵/清单面板的导航
  入口各自显式收起覆盖层（同值重选不触发 watch）。
- 移动端（≤768px）：列表槽位 fixed 抽屉（z-120 盖过遮罩 z-110 与 header
  z-100），收起时 pointer-events 穿透；DialogView 头部显示汉堡按钮。

### 2. Sidebar（48px 活动栏）自上而下

| 按钮 | 图标 | 行为 |
|---|---|---|
| 观察者头像 | Avatar 30 | 打开 viewer Agent 设置 |
| Agent 列表 | users (22) | `openListPanel('agents')`，active = 列表可见且当前页 |
| 会话列表 | message-circle | `openListPanel('sessions')`（独立会话页） |
| 运行跟踪 | activity 波形 | `openListPanel('tracking')` |
| — spacer — | | |
| Token 用量 | clock | 打开 TokenUsage 面板 |
| 主题切换 | moon/sun | `themeStore.toggleTheme()` |
| 插件动作 slot | 各插件 | sidebar-action 扩展槽（底部） |
| 全局设置 | 齿轮 | 打开 SettingsPanel |
| 更多 | 三点 | Teleport 菜单：数据备份 / 检查更新（红点） |

视觉语言：背景 `--color-bg-subtle`，按钮 40×40 radius 6，active 左缘
2px 竖条（top/bottom 8px，主色），hover `--color-bg-hover`。

### 3. 主聊天区 DialogView（direct/group/single 同一渲染内核）

- **头部**（48px，border-bottom + blur + z-100）：汉堡（移动端）→ 标题 →
  Token 仪表盘（72×6 进度条 + 四档色 + 百分数，title 明细）→ 归档按钮
  （压缩 icon + pending spinner + 反馈气泡）→ System Prompt 预览
  （file-text）→ Agent 配置（settings）→ 更多菜单（more-horizontal：
  工具定义预览 XML / 删除[Agent/归档 single] danger 项）→ 群聊抽屉开关。
- **消息区**：`.messages-wrapper`（定位容器）> `.messages-container`（滚动，
  6px 细滚动条）> 时间分隔条 / event·error 分隔条 / TurnDisplayItem；
  空态 gate（加载中 spinner vs "开始对话"文案）；上翻触发历史续拉并保持
  滚动位置；右下"回到底部"悬浮圆钮。
- **输入区** ChatInput：附件 chips（上）→ InteractionBar → textarea(3 行)
  → 底部工具栏（左：工作区/Agent/模型/思考强度下拉；右：附件 + 发送方块，
  忙时"打断并发送"橙色）。
- **群聊**：头部多"参与者数"，GroupDrawer 右抽屉（成员 4 列头像网格 +
  搜索 + 群名/简介编辑 + 底部删除）。
- 删除确认 = Modal 380（红色 icon + 不可恢复警示 + 双按钮）。

### 4. 风格体系（tokens.css，两轨已完全一致）

- 双主题：深空 Nebula（`html.dark`，默认）/ 晨曦 Aurora（`html.light`）。
- 基础令牌 `--bg-* / --primary / --text-1~3 / --line / --ok·warn·err /
  --r-sm·md·lg·full / --space-1~6 / --font-ui·mono / --dur-* / --shadow-* /
  --role-hover·selected·active·info`（状态色板 = 色系身份而非浓度渐变）。
- 兼容别名层 `--color-* → 本文件令牌`（单一来源）；业务组件只用 `--color-*`。
- `--layout-header-height: 48px`、`--layout-sidebar-width: 260px`、
  `--layout-content-max-width: 840px` 住 main.css（两轨同款）。

### 5. 视图状态模型（stores/ui.ts）

src 的面板状态：`listVisible / listWidth / listPanel(持久化) /
trackingViewVisible(运行矩阵) / pairView(会话对只读) / sidebarVisible(移动) /
workspaceVisible·Width(右侧分屏) / globalSettingsVisible·settingsAgentTarget /
tokenUsageVisible / versionVisible / preview*(文件预览)` + 统一
`startResize(kind)` 拖拽（resizing 态 + document 监听 + buttons 归零兜底）。
无 URL 路由——视角注册表（perspectives）按 active() 谓词依次判定渲染。

## 二、对齐前差距清单（preview 现状 → src 目标）

| # | 维度 | preview（对齐前） | src（目标） | 本轮处理 |
|---|---|---|---|---|
| 1 | 活动栏 | emoji 图标（💬🛰️📊💾🌙⚙）；单一"列表开关"按钮 | SVG 图标；三列表页签 active 态 + 底部更多菜单 | ✅ 重写 ActivityRail |
| 2 | 列表槽位 | 仅 AgentGroupList 一页；无页签概念 | agents/sessions/tracking 三页签（localStorage 持久化） | ✅ listPanel('agents'\|'tracking')（sessions 无面不设） |
| 3 | 运行跟踪 | Rail 按钮直开 **Modal 弹窗** | 侧边栏运行树面板 + **主区矩阵大画布**双形态 | ✅ 双形态落地 |
| 4 | 主区切换 | 矩阵与聊天互斥 v-if（流式态丢失风险） | 矩阵 v-if + 聊天区 v-show 保活 | ✅ v-show 保活 + 选中让位 watch |
| 5 | 列表拖拽 | App.vue 内联 startDrag（asideRef） | stores/ui.startResize + ResizeHandle 组件（buttons 兜底） | ✅ 统一进 store + 新组件 |
| 6 | 名册头部 | "＋Agent ＋群组 ↻" 三个虚线按钮；新增 Agent 走 prompt() 逐项追问 | 48px 头 = 搜索框(内嵌 icon) + 单「＋」下拉菜单 + 移动端关闭；新增 Agent = Modal 表单(ID/名称/模型) | ✅ 头部重排 + Modal 表单（模型源 llm/providers） |
| 7 | 聊天头部 | 🗿 emoji 按钮 ×2（归档/设置） | 汉堡(移动) + Token 仪表 + 归档 SVG + System Prompt 预览 + 设置 + 更多菜单(工具定义 XML/删除 Agent 确认) | ✅ 全套补齐（RPC agents/system-prompt·tool-defs·delete 均已有） |
| 8 | 群头部 | "N 人"文字按钮 | 参与者数文本 + more-horizontal 图标开抽屉 | ✅ 对齐 |
| 9 | 回到底部钮 | GroupView 用 "↓" 文字 | SVG chevron 圆钮 | ✅ 对齐 |
| 10 | 设计令牌 | tokens/main/base/markdown.css | 同左 | 已一致（MD5 校验，零改动） |

## 三、本轮落地（M18-F）

```
preview/webui/src/
├── App.vue                       三层布局骨架：Rail + 列表槽位(页签) + 主区
│                                 (矩阵 v-if / 聊天 v-show) + 选中让位 watch
├── components/ActivityRail.vue   重写：users/activity 页签 + clock/sun·moon/
│                                 settings/三点(more→SystemPanel) SVG 图标
├── components/AgentGroupList.vue 头部：搜索(内嵌 icon)+「＋」下拉菜单(新增
│                                 Agent/创建群组/刷新)+移动关闭；新增 Agent
│                                 Modal 表单(ID/显示名/模型 llm/providers)
├── components/RunTrackingPanel.vue  新增：侧边栏运行树（运行总览=矩阵入口 /
│                                 运行中[头像·时长·软中断·跳转] / 群组）
├── components/layout/ResizeHandle.vue  新增：拖拽分隔条（store 驱动）
├── views/RunTrackingView.vue     Modal → 主区大画布（页头 48px + 运行树 +
│                                 会话矩阵 + 群面；共享轮询）
├── views/ChatView.vue            头部：汉堡/归档 SVG/System Prompt 弹窗/
│                                 设置/更多菜单(工具定义 XML·删除 Agent 确认)
├── views/GroupView.vue           头部：more-horizontal 抽屉钮 + 回底 SVG 钮
├── stores/ui.ts                  + listPanel/openListPanel(持久化)/
│                                 closeSidebar/startResize(buttons 兜底)
└── stores/runs.ts                新增：runs/snapshot 3s 共享轮询（引用计数，
                                  矩阵与清单面板单一轮询源；空闲零定时器）
```

### 功能对齐映射（src 功能 → preview 落点）

| src 功能 | preview 落点 | 数据面 |
|---|---|---|
| Sidebar 三页签 | agents + tracking 两页签 | sessions 无后端面，不设 |
| 运行矩阵大画布 | RunTrackingView 主区视图 | `runs/snapshot`（3s 共享轮询） |
| 运行树面板 | RunTrackingPanel | 同上 + `runs/interrupt` |
| 更多菜单·数据备份/检查更新 | Rail「三点」→ SystemPanel（版本/备份/重启三合一） | `system/version`·`backup/run`·`system/restart` |
| 新增 Agent Modal 表单 | AgentGroupList 内 Modal（模型下拉） | `agents/create` + `llm/providers` |
| System Prompt 预览弹窗 | ChatView 头部 file-text 按钮 | `agents/system-prompt` |
| 工具定义预览（XML） | ChatView 更多菜单 | `agents/tool-defs` |
| 删除 Agent 确认 | ChatView 更多菜单 danger 项 → Modal | `agents/delete` |
| 会话列表（独立会话/工作区树） | **不设**（preview 无 singles/workspaces 会话面） | — |
| 右侧工作区树分屏 | **不设**（preview workspace 面走文件预览弹窗，M17-E） | — |
| 观察者头像/PairDialogView | **不设**（preview 会话键=conversationId，无 pair 双端点矩阵语义） | — |

## 四、验证

- `pnpm --filter ac-webui-app typecheck`（vue-tsc 零错误）
- `pnpm preview:typecheck`（轨道 tsc 零错误）
- `pnpm preview:test`（576 通过；含 webui 35 + CSP 审计）
- `pnpm --filter ac-webui-app build`（生产构建 ✓；dist CSP 审计 4/4）
- `pnpm preview:smoke`（组合根冒烟 ✓）

## 五、M18-G：四个功能缺口补齐（用户复审反馈）

用户指出四项"src 有、preview 无"的深层缺口——都是 M16 原生重写时被
收敛掉的重资产。本轮全部补齐：

### ① singles 独立会话（"建工作区、用 Agent 预设会话的那个"）

后端缺面 → **新建能力域**（首个 preview 原生新增域）：

```
ac-singles/（ctx.singles；元数据 owning 服务）
├── src/contract.ts    SingleSessionMeta / Create·UpdateInput
├── src/events.ts      singles/updated（emit；action = created|updated|archived|removed）
├── src/service.ts     CRUD + 空白会话唯一 + 规则 1 + 跨域校验（ctx.get 可选）
└── tests/             8 测试（CRUD/唯一性/规则1/校验/归档硬删/事件/重启恢复）
```

关键设计（src SinglesService 语义按 preview 规约重述）：
- **消息流零新写路径**：conversationId = sid，ac-session 按键分桶
  （规约 2）——归档/统计/历史全部复用既有会话域；硬删经
  `ctx.session.clear(sid)`（owning 写口）。
- **模型覆盖真接线**：`conversation/deliver` 增 `model` 参数 →
  `ConversationDeliverOptions.model` → `RouterSendOptions.model` →
  信封 `model: options.model ?? agent.model`（router 源码级改动）。
- 组合根：cordis.yml `singles` 行 + TREE 同步 + 根 package.json 链接。

前端链：`stores/singles.ts`（list RPC + updated 事件轻量合并 + 首条
用户消息自动标题）、`stores/workspaces.ts`（HTTP CRUD）、
`components/SessionList.vue`（src 树形态：工作区根节点/会话叶/未分组根/
更多菜单；工作区登记=手动路径输入——preview 无 browseFolder 端点）、
ChatInput single 模式（工作区/Agent/模型三下拉即时 PATCH + 规则 1 锁定）、
ChatView single 适配、App 三元路由、**reducer 形态分类器**
`setKindClassifier`（sid 名册 → 'single'，消息过滤语义同 1v1——
缺省推导无法区分 sid 与 gid，两者都是 agent ≠ convId）。

### ② 用量统计弦图（d3-chord）

`components/UsageChord.vue`：src TokenUsage 弦图搬回。preview 无
by_pair（Agent↔Agent）数据——诚实推导：**节点 = user ∪ agents ∪ 群，
流量 = byConversation**（key 命中 Agent → user↔agent 弦；命中群 → 群
对角自环）。src 几何常量与 mapSub 弧段重映射原样保留；主题切换重绘。

### ③ 运行总览 N² 矩阵

RunTrackingView 主体改为 src 矩阵形态：轴 = [user] ∪ Agent（流量降序）∪
群（members 名单进 snapshot）；落格 user×agent / 群对角；密度
`ln(1+min(v,3000))/ln(3001)` 五档 color-mix；运行光环 + hover 十字
（src 同款 cross-track）；点击展开只读历史保留。

### ④ 设置面板视觉对齐

壳（Modal/导航树/footer/放弃确认）+ AgentPane（页签/密度/竖线）+
AgentListPane 重写（agent-pool 形态）+ **头像上传/删除/预览**（后端
/api/agents/:id/avatar 三端点已有）。仍缺且留差距注释：模型池运行时
CRUD、tags/allowedPaths、hook 拖拽排序、插件 presets、schema 驱动表单
（preview 后端无对应面——后续里程碑议）。

### M18-G 验证

- webui `vue-tsc` + `preview:typecheck` 零错误
- `preview:test` **589 通过**（新增：ac-singles 8 + web-api singles 2 +
  reducer 分类器 3）
- `vite build` + dist CSP 审计 + `preview:smoke` 全绿
