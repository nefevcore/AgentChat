# AgentChat src 轨道前端（WebUI）功能全景

> 对象：`src/ui/webui`（包 `@agentchat/webui`）——src 轨道的全部前端能力。
> 依据：对 `src/ui/webui/src` 约 120 个源文件（≈1MB）的逐文件精读整理，并与 `docs/plugins/webui.md`、`docs/frontend-code-review.md`、后端 `src/host/server` API 面交叉核对。
> 本文只陈述代码中实际存在的能力；"明确不具备的能力"单列一节，不做臆测。

---

## 1. 定位与技术栈

| 项 | 内容 |
|---|---|
| 产品形态 | 多 Agent 聊天桌面风格 SPA（自建 UI 设计系统「星群×工坊」双主题） |
| 技术栈 | Vue 3（`<script setup>` + Composition API）、Pinia、Vite 5、TypeScript |
| 渲染 | markdown-it + markdown-it-texmath + KaTeX（公式）、highlight.js（含自定义 ABAP 语言） |
| 图表 | chart.js（柱状图）、d3-chord（弦图） |
| 通信 | 同源 REST（自研 fetch 封装）+ WebSocket（自研客户端） |
| 三重身份 | ① 服务端 cordis 插件行（自托管 SPA + HTTP/WS）；② 深度 UI 扩展宿主；③ iframe 隔离插件沙箱运行时 |
| 构建 | 双入口（主 SPA + `ui-plugin-iframe.html` 沙箱容器页）；vendor chunk 拆分 vue / markdown / chart；生产 CSP meta |
| 端口 | 生产 3830（WebUIServer 托管内置 dist）；Vite dev 3831（`/api`、`/ws` 代理到 3830） |

## 2. 总体架构

```
┌────────────────────────────────────────────────────────────────────┐
│                          服务端（@agentchat/server）                 │
│  WebUIServer：HTTP(3830) + WS(/ws) + SPA 静态托管（内置 dist）        │
│  路由：/api/*（业务） · /api/ui（UI 扩展目录） · /ui-plugin/*（插件资源）│
└──────────────┬───────────────────────────────────┬─────────────────┘
        REST（~37 端点）                      WS（13 出 + 34 入事件）
┌──────────────┴───────────────────────────────────┴─────────────────┐
│ core/api/client + endpoints        services/websocket（重连/心跳/队列）│
│      │                                    │                        │
│      │                            core/events/contract（事件契约）    │
│      │                                    │                        │
│      │                      core/registry/eventHandlers（单一分发点） │
│      │                              ┌─────┼──────────┐             │
│      ▼                              ▼     ▼          ▼             │
│  Pinia stores（10 个）          feed(消息流)  chat(业务)  groups/singles…│
│      │                              │                               │
│      ▼                              ▼                               │
│  视图层：App.vue 四层布局 + PerspectiveHost 视角容器                   │
│    ├─ perspectives 注册表（pair/talk/group/single + 插件视角）         │
│    ├─ messageViews / toolResultViews 注册表（消息与工具卡渲染扩展点）   │
│    └─ settings 域（schema 驱动设置面板 · 插件库 · 池管理）              │
│                                                                      │
│  core/extensions（UI 插件宿主：bridge/host/slots/isolated/p5.5-policy）│
└──────────────────────────────────────────────────────────────────────┘
```

数据流核心原则：**feed store 是消息单一真相源**（per-dialog `rawMessages` + 纯函数派生 `turns`，memo 增量构建）；**WS 单一分发**（`ws.onMessage` 只调 `dispatchEvent`，各模块自行注册处理器）；**视图即注册项**（视角/消息视图/工具卡视图全部走注册表，插件与内置同一套机制）。

## 3. 应用外壳与布局

### 3.1 四层布局（App.vue，flex 水平，100vh/100vw）

```
┌──┬──────────────┬───────────────────────────────┬──────────┐
│侧 │ 列表槽位       │            主区               │ 工作区    │
│边 │ (可拖宽)      │  ┌───────────────────────┐   │ 文件树    │
│栏 │              │  │ RunTracking 运行矩阵    │   │ (可拖宽)  │
│48 │ AgentList /  │  │ （大画布，v-if）         │   │          │
│px │ SessionList /│  └───────────────────────┘   │ 收起时右  │
│   │ RunTracking  │  聊天区 PerspectiveHost        │ 缘悬浮把  │
│   │ Panel 三选一  │  （v-show 保活：流式/草稿     │ 手展开    │
│   │              │   不因看矩阵而丢失）           │          │
└──┴──────────────┴───────────────────────────────┴──────────┘
  ①图标栏   ②列表槽(160px+，ResizeHandle)  ③主区     ④工作区(180~480px)
```

- **移动端（≤768px）**：列表槽变 fixed 全高抽屉（z-120）+ 半透明遮罩；工作区为覆盖式面板并隐藏悬浮把手。
- **列表槽三面板**由侧边栏活动栏切换（`ui.listPanel`，localStorage 持久化刷新保持）：Agent 列表 / 会话列表 / 运行跟踪。
- **拖拽调宽**：`stores/ui.startResize(kind)`，钳位 list≥160 / 聊天≥320 / 工作区 180–480；`e.buttons===0` 兜底释放（鼠标移出窗口松开防悬挂）。
- **全局单例弹窗**：文件预览、建群、设置面板、Token 用量、版本信息。
- **启动流**（onMounted）：WS init → groups init → singles refresh + 恢复上次独立会话 → UI 扩展宿主 init。

### 3.2 视角系统（前端的"路由"，注册表驱动，非 URL）

| 视角 | id | active 条件 | 组件 | 说明 |
|---|---|---|---|---|
| 会话对（只读） | `pair` | `ui.pairView` 非空 | PairDialogView | 注册在最前，active 时覆盖 talk；矩阵格子进入，双方左气泡 |
| 会话（默认） | `talk` | 无群/独立会话选中 | DialogView | direct 模式，props `{group:null, single:null}` |
| 群聊 | `group` | `activeGroupId` 非空 | DialogView | 群对象注入 |
| 独立会话 | `single` | `activeSingleId` 非空 | DialogView | single 对象注入 |

talk/group/single 共享 DialogView 内核仅 props 不同；插件可经 `registerPerspective` 追加视角。选中切换 watch：任一"新选中"→ 收起矩阵与 pair 覆盖层；清空选择不打断矩阵浏览（同值重选由各面板显式收起兜底）。

### 3.3 侧边栏（48px 图标活动栏）

- 用户头像按钮（当前 viewer，点击打开其 Agent 设置）。
- 三个列表槽位切换按钮（active 左侧主色指示条）。
- Token 用量按钮；主题切换按钮（亮/暗）。
- **插件侧边栏动作区**（sidebar-action slot，插件填空）。
- 全局设置按钮。
- **更多菜单**（Teleport 定位、300ms 延迟关闭）：数据备份（`POST /api/backup`，成功显示文件/大小/保留份数，busy 防重入）；检查更新（红点驱动，含 localStorage `simulateUpdate` 模拟开关）。

## 4. 对话核心（DialogView / PairDialogView / 消息组件群）

### 4.1 DialogView 三模式统一内核（886 行）

| 维度 | direct（1v1） | group（群聊） | single（独立会话） |
|---|---|---|---|
| 分区 key | `direct:<agentId>` | `group:<groupId>` | `single:<sessionId>` |
| Token 仪表盘 | ✅（进度条 + 四档配色，title 显示 token/消息数/归档提示） | ❌ | ❌ |
| 归档/压缩按钮 | ✅（`session.compress` 归档整理记忆） | ❌ | ❌（归档走更多菜单） |
| System Prompt 预览弹窗 | ✅ | ❌ | ✅（带 session 使 [工作目录] 与实际 run 一致） |
| 工具定义预览弹窗 | ✅（序列化为 `<functions>` XML 展示） | ❌ | ✅ |
| Agent 配置入口 | ✅（预设 Agent 不显示） | ❌ | ✅ |
| 删除入口 | 删除 Agent | 删除群组 | 归档独立会话 |
| 消息操作按钮 | ✅ | ❌（只读） | ✅ |
| 输入框 | ChatInput 直连 sendMessage | 群发送（回复期锁定 + `group.delivered` 解锁 + 10s 兜底） | ChatInput + 三个下拉（工作区/Agent/模型） |
| 历史加载 | WS `history.request` 分页（页 5） | REST 群历史分页（页 50） | WS（带 session 路由） |
| 断连横幅 | ✅（"连接已断开，正在重连…"） | — | — |

### 4.2 消息渲染管线

```
feed.rawMessages（分区，单一真相源）
  → buildTurns 纯函数派生（增量 memo：签名全同零重建，尾变更只重建最后一个 turn）
  → DisplayItem[]：turn 项 / event 分隔符（定时·归档·继续·重启等系统事件，居中）
                   / error 分隔符（红色居中）/ 时间分隔符（5 分钟间隔插入）
  → 稳定 key（agent_id+时间戳+内容长度+步骤数；历史前插不重建列表、展开态不丢）
  → TurnDisplayItem（单轮）
       ├─ 纯文本轮：messageViews 注册表解析 → UserMessage / AssistantMessage（插件可覆盖）
       └─ 含过程轮：头像 → 发言人名 → 思维链折叠栏（PulseTrace）→ final 气泡
            折叠栏：标题"思考过程（共 N 步，共用时 M 秒）"；流式强制展开；
            header 吸顶；turnInProgress 结束统一折叠本次流式轮（不动历史轮与手动展开）
```

- **UserMessage**：纯文本 pre-wrap 气泡（无 markdown）；附件 chips（文件名+大小，点击可预览）；复制；行内编辑（Enter 确认/Esc 取消，空或未修改不发）。
- **AssistantMessage**：思考区（ThoughtIcon + label + 折叠）+ markdown 正文 + 操作行（复制/重新推理/删除，流式中禁用）；代码块复制（事件委托）；文件路径链接点击预览；流式中无内容时 TypingIndicator 三点动画。
- **ToolMessage**（通用卡壳）：工具名/label + 状态徽标（running 三点 / OK / ERR / BLK）；结果 JSON 流式短路解析（尾部非 `}`/`]` 直接 null，防每 delta 全量 parse 的 O(n²)）；**运行中即以参数构造预览卡**（bash 显命令、edit 显文件名等，流式输出实时喂入）；运行中自动展开；write 工具点标签栏直接弹文件内容 Modal。

### 4.3 工具结果专用视图（toolResultViews 注册表，7 种内置）

| 工具名 | 视图组件 | 展示内容 |
|---|---|---|
| `bash` | ToolResultTerminal | 命令块（$ 提示符 + cwd）+ stdout + stderr 独立块（红字）+ exit N 徽标 + 截断/超时警告 |
| `read` | ToolResultCode | 目录清单模式（文件/夹图标+计数）；文件模式：语言徽标 + 元信息（大小/行数/范围/version）+ 高亮代码（60vh 视口）；`skill_read` 走 markdown |
| `write` | ToolResultWrite | 行内文件名链接 → 1000px Modal（路径+语言+字符数+高亮内容）；失败可重试 |
| `edit` | ToolResultEdit | 文件名 + "N 处替换（含 M 处模糊）" + 首变更行号 + **行级 diff**（`-`红/`+`绿/`...`分隔/上下文） |
| `web_search` | ToolResultWeb | 搜索头（query/耗时/条数/积分）+ AI 摘要 + 结果列表（安全链接/URL/摘要/相关性分数，clamp 展开式） |
| `browser` 及 `fetch_webpage`/`open_browser_page`/`navigate_page`/`read_page`/`click_element`/`type_in_page`/`screenshot_page`/`hover_element`/`drag_element`/`handle_dialog`/`run_playwright_code` | ToolResultBrowser / ToolResultWeb | 批量 steps（统计+失败标+动作徽标）；截图懒加载 base64 预览（hover 放大）；页面正文/eval 结果/HTML 字数；抓取模式（安全 URL + 大小/类型/截断 + 正文 clamp） |
| `subagent` | ToolResultSubagent | 按 action 四型：spawn（创建卡）/ await（结果+耗时）/ list（活跃清单）/ kill（终止卡）；状态徽标 running/done/error/timeout/killed |
| 未注册工具 | ToolMessage 内 `<pre>` | 原始文本 fallback |

安全：外部 URL 经 `safeUrl()` 仅放行 http(s)（防 `javascript:` 注入）；解析优先级：精确名 > 正则族 > priority，插件可覆盖内置。

### 4.4 流式处理与滚动行为

- **流式渲染**：`useChunkedMarkdown` 分块——内容按"安全切点"（代码围栏外空行）切为 committed 前缀（HTML 缓存复用）+ pending 尾部（转义纯文本近零成本追加）；rAF 按帧合并（同帧多次 delta 只渲染一次）；流结束 flush 全量保证终态。消除每 token 全量 markdown-it+hljs+KaTeX 的 O(n²)。
- **滚动**（useChatShell，三视图共用）：方向检测暂停自动跟随（一次上滚即停）；距底 <80px 恢复；双 rAF 滚底；signal=消息数+流式尾长按帧合并触发；悬浮"回到底部"按钮。
- **历史加载**（顶部 ≤50px 阈值）：direct 走 WS 分页 + 前插滚动位置补偿 + 会话身份守卫（切换后不按新会话补偿）+ 8s 超时兜底 + 不满屏递归续拉；group/pair 走 REST 前插（记录 prevScrollHeight 恢复位置；群聊不递归续拉防空群死循环）。

### 4.5 消息操作与输入框

- **消息操作**（实际接线）：复制（消息/代码块/System Prompt/工具定义/工具卡）；编辑（仅 viewer 轮）；重新推理与删除（**仅含思维链轮接线**，纯文本轮按钮渲染但未挂监听——实况）；"继续生成"链路存在但 prop 未传不渲染（实况）。
- **ChatInput**：多行 textarea（rows 3）；Enter 发送 / Shift+Enter 换行；`contextBusy` 时发送按钮橙色脉冲"打断并发送"（先 interrupt 再发）；附件多选上传（FormData 逐个，目标 Agent 循环前固定防串目录；chip 可移除）；**思考强度选择器**（关 / low / high 默认 / max → deepThink + reasoningEffort）；**single 专属三下拉**（互斥单开、向上弹出）：工作区（PATCH workspaceId）、Agent（默认预设+预设+常规；**已有消息的会话锁死** 409）、模型（池列表 + "默认模型"，null 回落）；草稿不持久化（切换即清空防串台）；placeholder 态（归档中/群回复中/默认）。

### 4.6 InteractionBar（ask_questions 决策交互）

- 形态：输入框上方紧凑药丸触发器 + 弹出菜单（非弹窗）：asker 徽标 + 完整问题 + 选项按钮 + 自定义输入框（Enter/按钮提交）。
- 流程：WS `chat.interaction` → `interactionState`（全局单槽）→ 归属门控（`agent_id` 匹配当前上下文 Agent 才显示，防跨会话串台）→ 新交互自动展开一次 → 作答 `chat.interact.respond`。
- 超时：`timeout_ms` 到点且 id 未变自动 dismiss。
- 边界（实况）：无独立"工具审批 approve/deny"UI——工具被阻止仅以 ToolMessage ⛔ BLK 状态呈现。

### 4.7 文件预览（FilePreviewModal，全局单例）

- 支持类型：HTML（`<iframe srcdoc sandbox="allow-scripts">`，无 allow-same-origin + 新窗口打开）；图片 png/jpg/jpeg/gif/webp/svg/ico（base64 data URL）；Markdown（markdown 渲染）；代码/文本（hljs 按扩展名高亮 + 行号列，约 40 种语言映射）；二进制非图片（仅头部信息）。
- 路径容错：原路径 404 且无 `files/` 前缀时回退 `files/<agentId>/<path>`。
- 竞态：请求序号守卫（快速连点防"标题 B 正文 A"）；ESC/遮罩关闭；复制按钮。

## 5. 列表面板

### 5.1 AgentList（Agent + 群组名册）

- 混排：Agent 与群组按 `lastActivity` 降序浮顶；搜索（名称不区分大小写）；空态/无匹配态。
- Agent 条目：StarAvatar 36px（星色随主题）+ 名称 + 最后消息摘要（user 发送加 "你: " 前缀）+ 未读徽章（>99 显 99+，点击清除）。
- 群组条目：九宫格拼接头像（1~9 人自适应网格）+ "N 个参与者"；群组刻意不做运行光环（是否发言由 Agent 自行 send_group 决定，无法可靠预判）。
- 运行光环：`direct` 分区 streaming → StarAvatar 流转光环。
- **行序冻结**：pointerdown 冻结行序快照、pointerup 后 600ms 解冻（防流式活动重排导致快速连点落错行）。
- 新建菜单：「新增 Agent」（弹窗：ID 可选自动 UUID / 名称 / 模型池下拉内联池配置）/「创建群组」。
- 不具备（实况）：编辑/删除/启停 Agent 入口（删除在聊天页更多菜单与设置面板，编辑在设置面板）。

### 5.2 SessionList（独立会话 × 工作区树）

- 结构：「新增」整行按钮（`createQuick`，`?reuse=1` 复用已有空会话）→ 工作区工具栏（新增工作区）→ 树列表。
- 工作区语义：用户登记的本机文件夹（白名单区域），挂其下的会话运行时把该文件夹并入沙箱路径白名单（后端 extraAllowedPaths 链路）。
- 会话条目：15px StarAvatar（头像+运行光环）+ 标题 + hover 删除；tooltip = 标题·agent·相对时间。
- 排序：工作区根按名称 localeCompare；组内会话按 lastActivity 降序；未挂的归"未分组"根（排末尾）；默认全展开、可收起（本地记忆）。
- 新增工作区：`POST /api/browse/folder` 唤起**系统原生文件夹选择对话框**（10 分钟有效）+ 手动输入/粘贴绝对路径兜底；名称可选。
- 工作区「更多」菜单：重命名（Modal 校验）/ 删除（确认：**会话保留移入未分组，文件夹不受影响**）。
- 删除会话：确认弹窗（红色警示，硬删 `?purge=1` 元数据+消息不可恢复）。
- 不具备（实况）：置顶/归档入口（归档在聊天页）/会话重命名（自动标题）/未读/搜索。

### 5.3 CreateGroupDialog / GroupDrawer

- 建群弹窗：群 ID（可选自动）/名称（必填）/描述（可选）+ 参与者多选（fetchAgents 排除 viewer，勾选图标+头像+名称+id，"已选 N"徽章，加载态/错误态）。
- 群信息抽屉（280px）：成员区（按 **id** 搜索过滤，4 列网格，viewer "我"角标）；群名编辑（保存禁用条件齐备，成功本地回写 + fetchGroups，按钮 2s 变绿）；简介 textarea（随名称保存一并提交）；删除群组（红色按钮 emit 父级）。
- 不具备（实况）：退出群聊（后端无 group.leave 契约）、成员增删管理。

## 6. 运行跟踪（RunTracking 矩阵 + RunTrackingPanel）

数据：`stores/runs` 单一轮询快照（3s，页面不可见跳过；1s 本地时钟驱动时长显示；in-flight 防护 + 内容签名比对避免无谓 computed 级联）。侧栏面板与主区矩阵共用同一快照。

### 6.1 运行矩阵（主区大画布，696 行）

```
      │ agent1 │ agent2 │ 群A │ system │ …
──────┼────────┼────────┼─────┼────────┼──────
agent1│▓对角线  │ 1v1格  │参与格│  1v1格 │   ← 行头 sticky 左
agent2│ (自会话)│▓对角线 │参与格│  斜纹   │
 群A │        │        │▓群本体│  —    │   ← 列头 sticky 顶
──────┴────────┴────────┴─────┴────────┘
 着色 = 时间窗内消息量 log 归一化 5 档热力；运行中格 = 深底 + 旋转光环；
 hover 十字聚焦（行列底色带 + 非十字置灰 + 行列头同步高亮 + rAF tooltip）
```

- **追踪对象**：会话 × 消息量 × 运行态（members 六类：agent/virtual/preset/group/system/unknown；1v1 会话、群会话、群周归档证据、运行中 run、覆盖面统计）。非轮次/工具/token 明细。
- 时间范围：1h/1天/3天/1周(默认)/1月/全部；旧后端无 windows 字段强制"全部"并禁用其余。
- 格子语义：上下三角共享会话数据（均可点击）；对角线 = 自会话/群本体；agent×群 = 参与证据格；上三角无数据 = 斜纹不可点、有数据弱化可进。
- **点击三分支**：群相关 → 群聊视图；viewer 参与的 pair → 直接对话（补 loadHistory + 清未读 + chatSubscribe）；其余（Agent↔Agent/自会话/↔system）→ **pair 只读视角**（不关矩阵，可返回）。
- tooltip：两端点头像×名称、关系标签、范围内 N 条·共 M 条·字节、最近活跃、证据、运行中明细（来源中文标签+时长+summary）。
- 覆盖面分析（可折叠）：已入矩阵会话数、矩阵外独立会话数、残留端点说明。

### 6.2 运行面板（侧栏第三面板）

- 运行总览节点 = 矩阵入口（badge = 运行中数量）。
- 运行中列表：每会话叶节点（运行光环 + 标题 + 实时已运行时长 mm:ss/h:mm:ss）+ hover 中断按钮（`POST /api/runs/interrupt` 软中断，防重 Set）；点击跳转（single/群/viewer 1v1，补完整导航仪式；Agent↔Agent 1v1 仅展示不可跳）。
- 活跃子 Agent 节点：子名·父名（dim）、父头像、时长、title 任务描述。

## 7. Token 用量统计（TokenUsage，1167 行 Modal）

- 数据：`GET /api/usage/tokens`（overall/by_agent/by_day/by_pair/by_day_llm/range）；打开即载 + 30s 自动刷新 + 手动刷新；请求序号守卫。
- **范围筛选**（左侧栏，作用全部页签）：近 7/30(默认)/90 天/全部/自定义（起止 date + 应用；颠倒自动交换）；显示后端实际覆盖区间。
- **摘要**：缓存命中/总输入（数值 K/M + 百分比 + 进度条）、总输出、总步数（react steps）、请求数。
- **总览 Tab——Agent 协作弦图**（d3-chord 手写 SVG，660×660）：外环弧段 = Agent（弧长∝流量，id 哈希 18 色恒定色，<2% 合并"其他"保底 top5）；弦 = 1v1 流量对（宽度∝流量、两端渐变、悬停联动高亮：弦→只亮该弦+两端弧；弧→点亮全部弦）；径向逐字符竖排标签（top10，左半圆翻转，超 12 字符截断）；自定义 HTML tooltip。<2% 合并；默认排除 user/self 与群聊（checkbox 可含 user/self；群聊明确排除，注释"后续单独群聊图谱"）；防闪烁（数据/SVG/主题未变跳过重绘）。
- **用量统计 Tab——按日堆叠柱状图**（Chart.js）：两种统计方式——「缓存」三段堆叠（缓存绿/未缓存靛蓝/输出紫）与「模型」透视 by_day_llm（模型名归一化去 provider 前缀，top7 + "其他(N 个模型)"堆底）；柱顶圆角逐柱 scriptable；external HTML tooltip（色点+数值右对齐+合计）；x 轴 MM-DD 可 45° 旋转；明暗主题切换重算配色。
- 不具备（实况）：导出（CSV/图片）、按群聊维度、按独立会话维度。

## 8. 设置子系统（settings 域，schema 驱动）

### 8.1 SettingsPanel（统一全屏弹窗：左树 + 右内容 + Footer）

- 左树：Agent 设置 / 模型管理 / 搜索引擎 / 扩展与工具 / 插件库 / 定时任务（全局）+ **插件动态页签**（settings-tab:global slot，props 注入 globalConfig/nsSchemas/pools）。
- Header：`● 未保存` 徽标（globalDirty || agentDirty || 装配需保存）；Footer：错误/成功消息（3.5s 消失）、**重启后端按钮**（确认弹窗 + WS `system.restart` + 30s 兜底解锁）、**保存配置**（按 dirty 分别 saveGlobal/saveAgent）。
- 关闭守卫：脏状态弹确认"放弃未保存的更改?"；关闭即 `resetAgent()`（面板常驻挂载，防放弃的编辑复活）。
- `initialAgentId` 入口：打开即定位到该 Agent 编辑（聊天页/侧边栏跳入）。

### 8.2 AgentListPane → AgentPane（5 页签 + 插件页签）

- 列表：头像/名称/ID/虚拟徽章/能力标签 chips（title 提示：base/admin/dev/conductor/领域标签）；搜索（名称/ID/标签）；新建（名称必填+ID 自动+Provider 下拉+模型默认值）；删除（danger 确认）。
- **基本信息**：头像上传（≤2MB，png/jpeg/webp/svg，blob 预览 + revoke 防泄漏，hover 移除）；昵称；只读 agent_id；**能力标签**（base 固定不可移除 + admin/dev/conductor + 目录 requires 出现的标签 + 自定义领域标签回车添加，旧 'agent' 视为 base）；**SYSTEM.md / AGENT.md**（启用开关 + textarea 覆盖）。
- **模型页签**（schema 驱动亮点）：模型池下拉（"默认(继承全局)"+ 池条目，选中拷贝池字段进 `raw.llm={$ref,...}`）；"当前生效"摘要条（model/provider + **四级来源推导**：本 Agent 显式 → 模型池 → 全局配置 → 全局默认池）；字段分组渲染（基础/推理/采样/边界，隐藏 logprobs/top_logprobs/tool_choice）；**字段级来源徽章**（"本 Agent/继承"）+ 被覆盖字段高亮 + **恢复继承按钮**；**模型列表读取**（按 raw/effective→池→全局解析 base_url，经**后端代理** `GET /api/agents/models` 拉取，OpenAI 兼容 /models 与 Ollama /api/tags，避免浏览器跨域 401）。
- **定时任务**：内嵌 TimerPane（见 8.5）。
- **安全**：路径穿透白名单 allowedPaths（textarea 每行一路径，本地 draft 保留原样、同步 trim 数组）。
- **扩展与工具**：内嵌 ExtToolsPane agent 模式；**legacy 只读模式**（旧 plugins 契约：黄色横幅"保存后自动迁移"）。

### 8.3 ExtToolsPane（插件 / 钩子 / 工具装配，全局与 Agent 双模式）

- **插件组**：presets 开关（启用=加入候选集）；来源徽章（builtin/installed/dev/session）；版本；**权限徽章三态**（default 默认授予[fs/network]/granted 已授予/required 需显式）+ "声明但未授予"黄色警告；**停用插件同步修剪**其钩子启用条目与工具意图（与后端一致）。全局模式只读目录。
- **钩子区（7 种阶段）**：runStart/stepStart/toolExecutionStart/toolExecutionEnd/stepEnd/runEnd/fallback；**清单即启用集**；开启按 RECOMMENDED_HOOK_ORDER **锚点插入**（不打乱既有相对顺序）；**拖拽排序**（仅启用区）；`automatic` 基础设施钩子虚线徽章不可停用；详情弹窗（描述 + 命名空间 schema 配置表单 NsFieldList 或 security 只读指引）。
- **工具区**：include/exclude 单一意图（exclude 优先）；三态徽章（默认 auto/显式 explicit/已停用 off）；**requires 标签门禁**（缺失标签或插件未启用时开关禁用，chips 主色/灰提示）；详情弹窗（描述+命名空间配置）。

### 8.4 插件库（PluginLibraryPane，4 页签 + 人审流）

- **已安装**：卡片（名称/版本/来源/owner/安装时间/provides 统计"提供 N 工具/M 钩子"/权限三态）；卸载（danger 确认：目录移 `<workspace>/plugins/.backup/<name>-<version>-<ts>`，presets 引用保留自动跳过）。
- **待审暂存**：manifest 名/版本/owner/hash 前 8 位/requiredGrants 标签；**StagingReviewModal**（760px）：概览 + hash 复制 + **grants 强制勾选**（ui 警告"浏览器会话上下文执行"、process/shell 警告；未勾全批准禁用"x/y"）+ **文件树与只读内容审查**（请求序号守卫）；Footer 拒绝并删除 / 批准安装。
- **开发目录**（`<workspace>/plugins/<agentId>/<name>/` 一层扫描）：**注册会话**（`session/register` watch:true 热重载，重启即失；高危权限先弹 grants 勾选；成功自动加入 owner presets）/ 卸载会话 / **发布 stage**（暂存待审，自动跳待审 tab）。
- **市场**（GitHub topic:agentchat-plugin 发现）：搜索 + **本地缓存索引**（零网络离线可用）+ stale 警告；卡片（repo/stars/更新时间/权限标签高危高亮）；安装一步 `market/install`——**缺高危 grants 返回 400 时自动回落人审流**（market/stage 转待审）。
- WS 实时刷新（plugin.catalog.changed / plugin.reloaded → 目录+装配，带序号守卫防事件风暴乱序）。

### 8.5 PoolManager（模型池 / 搜索凭据池）

- 两类池：`llmProviders`（模型池）与 `searchProviders`（搜索凭据池：tavily/serpapi/brave/deepseek…）；Provider 下拉**由 schema 键动态生成**（无硬编码）；切换 provider 保留名称应用新 schema 默认值；password 掩码 + 按住眼睛 reveal。
- 列表：默认条目 ★ 星标 + 主色边框；设为默认/编辑/删除；保存清理（空字段删除、ratio 无 default 且==min 视为 API 默认、重命名删旧键、首条自动默认）。
- **设为默认的引用重写**：`applyLlmPoolDefault/applySearchPoolDefault` 确定性重写全局 `llm`/`tool.web_search` 为 `{$ref}` 并剥离遮蔽字段（修"设为默认被显式引用遮蔽不生效"）；落盘走 Footer 保存配置（sanitize：$ref 折叠 + 掩码清理）。

### 8.6 TimerPane + 全局定时任务

- Agent 级 TimerEntry：5 种模式（time 定时/delay 延时/random 随机/workday 法定工作日/holiday 法定节假日）+ 重复次数（0=永久）+ 提示内容 + 目标（逗号分隔，默认 user）+ maxSteps；启用/暂停 checkbox（停用删除线）；独立"保存定时配置"按钮（也并入 agentDirty 随总保存）。
- 全局 timer.tasks：`{time, hint, targets[], builtin?}`；**系统机制任务**（不走 LLM）：`__archive_all__` 全局归档（深夜批量归档 1:1 会话）、`__backup_all__` 数据备份（每周）；builtin 任务**不可删除**（按钮禁用+代码双保险）、类型锁定；占位符 `{{now}}/{{time}}/{{date}}`；目标留空=全部（`'*'`）。

### 8.7 通用原子与持久化

- SettingField（7 控件：checkbox/select/number/ratio 滑条/file 原生选择/password/text）；NsFieldList（schema 表单 + showWhen 条件显隐 + 搜索 + 非默认值高亮 + 恢复默认；无 schema 时 JSON 兜底编辑）；ConfirmDialog（Promise 风格 `await ask({title,message,danger})`）。
- **持久化全部写后端**（无 localStorage 存聊天/设置数据；localStorage 仅存 UI 偏好：主题/列表页签/lastContext/日志级别等）：`POST /api/config`（全局）、`POST /api/agents/:id/config`（差异配置）、`PUT /api/plugins/assembly/:agentId`（装配：服务端校验+原子写盘+热重载+WS 广播）、`POST /api/agents/:id/timer`。
- 大量竞态防御：loadAgent 序号守卫、catalogSeq、saveAgent 身份快照（防 A 配置写给 B）、saveTimersFor 丢更新保护、refreshAssembly 不前移 dirty 基线（防热重载事件覆盖未保存编辑）。

## 9. 状态层（10 个 Pinia store）

| Store | 职责要点 |
|---|---|
| **feed** ★（1198 行） | 统一信息流单一真相源：per-dialog `rawMessages` 分区 + 派生 turns（增量 memo）；流式 ingest（step/message/thinking/tool 双阶段）；历史分页（requestId stale 丢弃）；resume 快照合并；全局活动索引（cap 500）；跨视图独立性（分区状态与查看上下文解耦，运行中切走不坏状态机） |
| chat | 业务动作（发送/中断/续推/重生成/编辑/删除/压缩/交互/预览）+ 非消息状态；ChatContext 抽象（pair/single）；30s 发送看门狗；非消息 WS 事件分发表 |
| agents | 列表/选中/恢复（lastActivity 排序）、预设目录、bumpById 预览更新（按事件所属 Agent 防串台） |
| groups | 列表/选中/建群弹窗；幂等 init（防处理器累积）；群 WS 事件刷新 |
| singles | 独立会话 CRUD/激活/更新（换 Agent 409/换模型/挂工作区）/归档/硬删；createQuick 复用空会话 |
| runs | 运行快照 3s 轮询（可见性门控 + in-flight + 内容签名）+ 1s 时钟 |
| theme | 亮/暗（localStorage + 系统偏好 + theme-changed CustomEvent 联动 hljs） |
| ui | 列表/工作区/矩阵/pairView/设置/Token/版本/预览可见性与宽度；拖拽 resize |
| websocket | WS 客户端 Pinia 包装（connected + 幂等 init + 收发） |
| workspaces | 用户工作区（文件夹白名单）CRUD |

**DialogId 四形态**：`direct:<agentId>` / `group:<groupId>` / `single:<sessionId>` / `pair:<a>|<b>`（排序双端点，矩阵只读视角）。活跃路由优先级：single > group > agent。

## 10. 通信层

### 10.1 WebSocket 客户端（自研）

- 连接：`${ws|wss}://${host}/ws`；**身份守卫**（旧 socket 迟到事件一律忽略）。
- 重连：退避 2s 起 ×1.5 封顶 30s；成功重置。
- **半开看门狗**：90s 无入站帧主动 close 走重连（后端 30s 协议 ping 保底不误杀）。
- **backlog**：断线发送入队（上限 100 丢最旧）；重连 flush **整体取走队列再逐条发**（单条毒消息异常丢弃不阻塞队列）；发送期间新消息进新队列。
- onMessage/onConnect 返回 disposer；onConnect 已 OPEN 立即回调。

### 10.2 REST client

- 无 baseURL（同源相对路径）；非 2xx 抛 `body.error || HTTP {status}`；jsonPost/Put/Patch/Delete 封装；stripEmpty 清空键；业务禁止直接 fetch。

### 10.3 REST 端点全清单（前端实际调用，37 个）

| 域 | 端点 |
|---|---|
| Agent | GET/POST `/api/agents`；DELETE `/api/agents/:id`；GET `/api/agents/models`；GET `/api/config/pools`；POST/DELETE `/api/agents/:id/avatar`；GET `/api/sessions/:agentId/tokens` |
| 预设 | GET `/api/agent-presets` |
| 群组 | GET/POST `/api/groups`；PATCH/DELETE `/api/groups/:id`；GET `/api/groups/:id/history` |
| 历史/运行 | GET `/api/history`（pair 只读视角）；GET `/api/runs`；POST `/api/runs/interrupt` |
| 独立会话 | GET/POST `/api/singles`（`?reuse=1`）；PATCH `/api/singles/:id`；DELETE（归档）/`?purge=1`（硬删） |
| 系统 | GET `/api/version`（`?simulate=true`）；GET `/api/version/changelog`；POST `/api/version/update`；POST `/api/backup`；GET `/api/usage/tokens`；POST `/api/upload` |
| UI 扩展 | GET `/api/ui/extensions` |
| 工作区 | GET `/api/workspace/tree`；GET `/api/workspace/file`；GET `/api/browse/read-file`；POST `/api/browse/folder` |
| 用户工作区 | GET/POST `/api/workspaces`；PATCH/DELETE `/api/workspaces/:id` |
| 设置域 | GET/POST `/api/config`；`/api/plugins/llm-schemas`、`search-schemas`、`schemas`；GET/PUT `/api/plugins/assembly/:agentId`；`/api/plugins/catalog`、`library`、`permissions`；`library/stage|approve|reject|:name/uninstall`；`market/search|cached|stage|install`；`/api/plugins/session`、`session/register`、`session/:name/unload`；`staging/:id/tree|file`；POST `/api/browse/file` |

> 注：`/api/ui/slots` 端点已删除（无调用方），slot 数据走前端注册表；隔离档策略白名单中仍列有该路径（允许≠调用）。

### 10.4 WS 事件契约（contract.ts 单一来源）

- **出站 13**：chat.send（requestId 幂等/deepThink/reasoningEffort/files）、chat.interrupt、chat.continue、chat.subscribe（附 session 精确匹配）、chat.delete_message、chat.interact.respond、history.request、agent.list、agent.system_prompt、agent.tool_defs、session.compress、system.restart、group.message。
- **入站 34**：消息流 22（chat.start/step.start/step.end/interrupted/end/message.start|update|end|error/thinking.start|update|end/toolcall.start|update|end/tool_execution.start|update|end/session.resume/virtual.receive、history.response、group.message）+ 非消息 11（agent.list.response、agent.profile.updated、chat.send.ack[basy/deduped]、chat.interaction、chat.interact.respond、session.compressed、session.archived、singles.updated、system.restarting、agent.system_prompt.response、agent.tool_defs.response）+ 群组 5（group.created/deleted/join/leave/delivered）+ 插件域 3（plugin.catalog.changed、plugin.reload、agent.assembly.changed）。

## 11. 扩展系统（前端 UI 插件宿主，P5.3–P5.5）

### 11.1 两种信任档

```
【宿主内档（可信插件）】
GET /api/ui/extensions → import('/ui-plugin/<name>/<entry>?v=<version>')
  → createBridge(descriptor) → install(ctx)（15s 超时守护）
  → ctx：vue 子集(h/defineComponent/ref/computed/watch) + 8 类 registerXxx
         （每次 assertSlot 校验 manifest ui.slots 白名单）+ request/wsOn/onUnload
  → 失败：逆序回滚 disposers + 移除样式（单插件隔离，不影响其他）

【iframe 隔离档（不信任插件，P5.5）】
sandbox="allow-scripts"（无 allow-same-origin → opaque origin）iframe
  容器页 CSP：default-src 'none'; script-src 'self'; frame-ancestors 'self'
  → isolated-runtime 校验 name ^[a-z0-9-]+$ / entry 前缀 / 禁 ..
  → install({ name, request, onEvent, onUnload })   ← 仅此三能力
  → request：postMessage → 父窗口白名单代理（仅 GET、8 个只读端点）
  → 事件：仅 4 个插件生命周期事件白名单转发（看不到聊天/文件内容）
  → 双向消息严格校验 source 与 event.source；ready/error 上报
```

- 宿主同步：WS `ui.extensions.changed` → 150ms debounce → diff（version/entry/isolated 变化即换实例）→ 热更新无需刷新。
- 防御点：per-name 在途互斥（防 disposers 丢失）、15s install 超时、失败隔离、事件订阅引用计数（防重复投递）、卸载逆序 dispose + 样式移除。

### 11.2 八类 UI slot（只有宿主内档可注册）

| Slot | 方法 | 贡献 |
|---|---|---|
| `perspective` | registerPerspective | 顶层视角页 |
| `tool-result` | registerToolResultView | 工具结果视图（按名/正则，priority 覆盖内置） |
| `message-view` | registerMessageView | 消息视图（match+priority+renderer） |
| `ws-event` | registerEventHandler | WS 事件处理器 |
| `settings-tab:global` | registerSettingsTab | 全局设置页签（id 自动加插件名前缀） |
| `settings-tab:agent` | registerAgentSettingsTab | Agent 设置页签 |
| `sidebar-action` | registerSidebarAction | 侧边栏动作按钮 |
| `global-style` | registerGlobalStyle | 全局样式（消毒 + `.ui-plugin-<scope>` 前缀，`:root` 仅 `--*` 变量，禁 url()/@import/at-rule/反斜杠转义） |

### 11.3 CSP（生产 dist 有审计测试）

- 主 SPA：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; object-src 'none'` 等，无外站脚本。
- 隔离容器页：`default-src 'none'; script-src 'self'; frame-ancestors 'self'`，无内联脚本。

## 12. 设计系统与主题（src/ui + assets）

- **分层**：L0 `tokens.css`（令牌）→ L1 原语（Icon/Button/Avatar/Modal）→ 工具（StatusDot/Tooltip）→ L2 组合（StarAvatar/StarCard/PulseTrace）+ 专属 ThinkingIcon/ThoughtIcon。
- **图标**：unplugin-icons 自动导入 lucide，注册表 52 个名，未注册兜底 info。
- **Button**：primary/soft/ghost/danger × sm/md，loading spinner，令牌驱动。
- **Avatar**：三级回退（图片 → 图标 → 首字）；StarAvatar 加身份色首字底 + **SVG 运行光环**（主副双流光、渐变 id 唯一化、reduce-motion 功能性豁免）。
- **Modal**：Teleport + ESC 关闭 + 淡入缩放；height 固定防内容切换跳动；zIndex 可调。
- **StatusDot**：thinking/running/idle|ok/offline/err 六态（文字+颜色双表达，色盲友好）；Tooltip 纯 CSS。
- **StarCard**：星色描边选中态；**PulseTrace**：思维链折叠容器（星点 + 脉冲线流光 + meta + chevron）。
- **双主题**：Nebula（暗，默认）/ Aurora（亮）；`html[data-theme]` + 兼容 `html.dark/.light`；跟随 `prefers-color-scheme` + 手动切换 + localStorage；hljs 主题（One Light/Night Owl 含 ABAP）经 `theme-changed` CustomEvent 联动；兼容别名层把旧 `--color-*` 映射到新令牌；Element Plus 变量适配。
- **星色系统**：agent_id 稳定哈希 → 8 色星板（双主题各一套），用户固定白金；头像光晕/星卡/思维链标题统一取色。
- **markdown.css**：`.markdown-body` 排版（表格横滚容器、代码块 banner + 语言标签 + 复制按钮胶囊、KaTeX display 横滚、内联 code 双主题色、kbd 键帽、任务列表 checkbox）。
- **reduce-motion**：全局降级 0.01ms，豁免 `.run-spin/.ring-spin`（运行光环是功能性状态指示）。

## 13. Markdown 渲染能力（useMarkdown）

- markdown-it 双实例：完整（texmath+KaTeX，`$...$`/`$$...$$`）与轻量 renderPlain（思考内容等性能敏感场景）。
- `html:false` + `linkify:true`（fuzzyLink 关闭防 `TODO.md` 误链）+ `breaks:true`。
- 语法高亮：hljs + 自定义 ABAP 语言；未知语言回退转义；**双主题内联主题**动态切换。
- fence：语言标签取首词 + escapeHtml（防 v-html 注入）；uuid `data-code-id` + 复制按钮结构。
- **`<file path>` 标签**：安全占位符穿越渲染管线后还原为可点击 `file-tag`。
- **文件路径 linkify**：渲染后 HTML 中识别工作区路径（~47 已知扩展名），三步保护正则（已有标签占位保护 → 文本替换 → 还原）生成可点击 `file-path-link`。
- 表格包裹横滚容器；渲染异常全文转义兜底。

## 14. 性能与稳定性工程（横切）

| 机制 | 位置 | 作用 |
|---|---|---|
| 流式分块 markdown | useChunkedMarkdown + streamingMarkdown | 安全切点分 committed/pending，消除每帧全量渲染 O(n²) |
| turns 增量 memo | utils/feed buildTurnsIncremental | 签名全同零重建；尾变更只重建末 turn |
| 工具结果流式短路 | useToolResult | 尾部非 `}`/`]` 直接 null，避免反复 JSON.parse 抛栈 |
| 快照内容签名 | stores/runs | 内容未变保留引用，防 3s 轮询全量 patch 400+ 格子 |
| 矩阵 hover 优化 | RunTracking | tooltip 坐标独立 ref、rAF 合并、非十字仅 opacity |
| 行序冻结 | AgentList | 指针期间冻结排序防连点落错行 |
| 请求序号守卫 | TokenUsage/FilePreview/StagingReview/loadAgent/loadPluginCatalog/Token 仪表盘 | 慢响应乱序落地防护 |
| 身份快照 | useSettings.saveAgent | 保存中切 Agent 不串写 |
| 看门狗族 | 30s 发送 / 8s 历史 / 90s WS 空闲 / 15s install / 10s 群发送解锁 / 30s 重启按钮 | 事件链断裂的兜底回落 |
| 竞态守卫族 | 切换 onCleanup、requestId stale 丢弃、in-flight 防护、resume 合并去重 | 快速切换/重连场景数据正确性 |
| 可见性门控 | runs 轮询 | 页面隐藏跳过 |
| 稳定 key | DisplayItem/step/tool | 历史前插不重建列表、状态不丢 |

测试（`tests/`，10 个文件）：feed 并行工具归属 / 快速切换 / resume 合并 / WS backlog flush / 历史渲染性能 / markdown 渲染性能 / p5.5 策略（CSS 消毒+白名单正反例）/ CSP 审计（dist 产物）/ LLM 池默认 / 搜索池默认。

## 15. 明确不具备的能力（代码核实，非遗漏）

- 输入框：@提及、引用回复、历史命令上下翻、草稿持久化、图片粘贴上传（仅文件选择器）。
- 消息：搜索、导出；"继续生成"按钮未接通渲染；纯文本 assistant 轮的重新推理/删除事件未挂监听。
- 独立"工具审批（approve/deny）"UI（durable interaction 仅 ask_questions 决策一种呈现；工具阻止以 BLK 徽标呈现）。
- AgentList 无编辑/删除/启停入口；SessionList 无置顶/归档/重命名/未读/搜索；群组无退出、无成员增删。
- 工作区文件树只读（无新建/删除/重命名/右键/拖拽）。
- TokenUsage 无导出、无按群聊/独立会话维度（弦图明确排除群聊）。
- 无 URL 路由（视角为注册表驱动，刷新靠 lastContext 恢复）。
- 长列表无虚拟化、feed 分区缓存无 LRU 上限、fetch 层无超时/取消（均为已知遗留，见 frontend-code-review.md 第五节）。

## 16. 附录：源码地图

```
src/ui/webui/
├─ index.html / ui-plugin-iframe.html     两入口（主 SPA / 沙箱容器，各带 CSP meta）
├─ vite.config.ts                          双入口 + vendor chunk + dev 代理
├─ src/
│  ├─ main.ts / App.vue / constants.ts     引导与外壳（VIEWER_ID）
│  ├─ index.ts / plugin.ts                 服务端 cordis 插件行（inject webServerHost+http）
│  ├─ isolated-runtime.ts                  iframe 内插件运行时
│  ├─ components/
│  │  ├─ AgentList / SessionList / Sidebar / ChatInput / InteractionBar
│  │  ├─ RunTracking(Panel) / TokenUsage / VersionDialog
│  │  ├─ CreateGroupDialog / WorkspaceTree(Node)
│  │  ├─ dialog/   DialogView（三模式内核）/ PairDialogView / GroupDrawer
│  │  ├─ chat/     Message/（User·Assistant·Tool·TurnDisplay）· ToolResult/（7 卡）·
│  │  │            FilePreviewModal · ScrollableViewport · TypingIndicator
│  │  └─ layout/   PerspectiveHost · ResizeHandle
│  ├─ composables/  useChatShell · useMarkdown · useChunkedMarkdown · useToolResult
│  ├─ stores/       feed★ · chat · agents · groups · singles · runs · ui · theme · websocket · workspaces
│  ├─ services/     websocket.ts（WS 客户端）
│  ├─ core/
│  │  ├─ api/       client + endpoints×9
│  │  ├─ events/    contract.ts（WS 契约单一来源）
│  │  ├─ registry/  eventHandlers · messageViews · perspectives · toolResultViews
│  │  └─ extensions/ host · bridge · slots · isolated · p5.5-policy · types
│  ├─ settings/     api/schema/types/useSettings + components×14
│  ├─ ui/           设计系统（tokens + 9 组件 + icons）+ Thinking/ThoughtIcon
│  ├─ utils/        feed★（纯函数派生）· format · lastContext · logger · starColor ·
│  │                streamingMarkdown · switchTrace · abap-hljs
│  └─ assets/       base/main/markdown 三份 CSS
└─ tests/           10 个测试文件（见 §14）
```

## 相关文档

- [plugins/webui.md](./plugins/webui.md) —— 插件行与扩展宿主细节
- [frontend-code-review.md](./frontend-code-review.md) —— 缺陷修复史与遗留建议
- [tutorial/09-webui-and-events.md](./tutorial/09-webui-and-events.md) —— 事件与插件 UI 教程
