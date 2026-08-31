# 星群层样式对齐规格：src 轨道 → preview 原生面

> 目的：为「preview 原生面 vs src 轨道页面布局/风格完全对齐」提供 src 轨道【星群层】
> （活动栏 + 列表面板 + 主区视角容器 + 星卡/按钮视觉语言）的精确规格。
>
> 事实源（全部完整读取）：
> - src：`src/ui/webui/src/{App.vue, components/Sidebar.vue, components/SessionList.vue,
>   components/AgentList.vue, components/dialog/GroupDrawer.vue,
>   components/layout/{PerspectiveHost,ResizeHandle}.vue, ui/{StarCard,Button}.vue}`
> - src 支撑：`ui/tokens.css`、`assets/main.css`、`ui/{StarAvatar,StatusDot,Avatar}.vue`、
>   `utils/starColor.ts`、`stores/ui.ts`、`ui/index.ts`
> - preview 对照：`preview/webui/src/{App.vue, components/ActivityRail.vue,
>   components/AgentGroupList.vue, views/GroupView.vue, ui/{Button,StarCard}.vue,
>   ui/tokens.css, assets/main.css}`
>
> **全局前置结论（先读）**：src 与 preview 的 `ui/tokens.css`（203 行）与
> `assets/main.css`（234 行）**字节级一致**——令牌层已完全对齐，`--color-*` 别名层、
> 双主题色值、几何/间距/动效令牌全同。因此本轮对齐的差异**全部落在组件形态与密度**
> （行高/头像尺寸/选中态/滚动条/入口形态/层级），而非令牌值。改预览组件即可，无需动令牌。

---

## 1. App.vue（应用外壳）

### A. DOM 结构树

```
div.app-layout                       # flex row, 100vw×100vh
├─ Transition[name=sidebar-overlay]
│   └─ div.sidebar-overlay           # v-if ui.sidebarVisible（移动端遮罩）
├─ Sidebar                           # 第一层：48px 活动栏
├─ div.list-panel-wrapper            # 第二层：列表槽位，v-if ui.listVisible, width=ui.listWidth px
│   ├─ AgentList | SessionList | RunTrackingPanel   # 按 ui.listPanel 三选一（v-if/v-else-if/v-else）
│   └─ ResizeHandle[kind=list]       # 列表右缘拖拽条
├─ div.main-area                     # 第三层：主区
│   ├─ RunTracking                   # v-if ui.trackingViewVisible && !ui.pairView（运行矩阵大画布）
│   └─ div.chat-area                 # v-show !trackingViewVisible || pairView（保活）
│       ├─ PerspectiveHost           # 视角容器（pair/talk/group/single）
│       ├─ template[v-if ui.workspaceVisible]
│       │   ├─ ResizeHandle[kind=workspace]
│       │   └─ WorkspaceTree         # width=ui.workspaceWidth px
│       └─ button.workspace-rail     # v-show !workspaceVisible（右侧悬浮把手）
├─ FilePreviewModal                  # 全局单例（visible 控制）
├─ CreateGroupDialog                 # v-if groupsStore.showCreateGroup
├─ SettingsPanel                     # visible 控制
└─ TokenUsage                        # visible 控制
(模板根外) VersionDialog             # visible 控制
```

### B. 布局规格

| 项 | 值 |
|---|---|
| 外壳方向 | `display:flex`（行向）；`height:100vh; width:100vw; overflow:hidden; position:relative` |
| 三层结构 | 活动栏 48px → 列表槽位（`flex-shrink:0`，宽 `ui.listWidth` 默认 **260px**）→ 主区（`flex:1; min-width:0`） |
| 主区 | `.main-area { flex:1; display:flex; min-width:0; height:100vh; overflow:hidden; position:relative }` |
| 聊天区 | `.chat-area { flex:1; display:flex; min-width:0; overflow:hidden; height:100% }`（`v-show` 保活，流式/草稿不丢） |
| 工作区把手 | `.workspace-rail`：`position:absolute; top:calc(var(--layout-header-height,48px)+12px); right:0; 36×40px; border-radius:8px 0 0 8px; z-index:90` |
| 列表宽度拖拽 | `stores/ui.ts`：MIN_LIST=160，MAX = `视口宽 - 48(活动栏) - 320(MIN_CHAT)`；工作区 MIN 180 / MAX 480 |
| 移动端断点 | `@media (max-width:768px)`：列表槽位 → `position:fixed; left/top/bottom:0; z-index:120`；把手 `display:none` |
| z-index 层 | 活动栏 10 → 工作区把手 90 → ChatView header 100 → 遮罩 110 → 移动端列表 120 → 下拉菜单 300 → more 菜单 9999 |

### C. 关键 CSS 规则提炼

- `.app-layout` → `flex / 100vh / 100vw / overflow:hidden / position:relative`（无背景色声明，依赖 body）
- `.main-area` → `flex:1; display:flex; min-width:0; position:relative`
- `.chat-area` → `flex:1; display:flex; min-width:0; overflow:hidden`
- `.list-panel-wrapper` → `display:flex; flex-shrink:0; overflow:hidden`（宽度由内联 `style` 注入）
- `.workspace-rail` → 右贴悬浮块：`border:1px solid var(--color-border-secondary,#e0e0e0); border-right:none; radius:8px 0 0 8px; background:var(--color-bg-page,#fff); color:var(--color-text-muted,#999); box-shadow:-2px 0 8px rgba(0,0,0,.06); z-index:90`；hover → `--color-bg-surface` + `--color-text-primary`
- `.sidebar-overlay` → `position:fixed; inset:0; background:rgba(0,0,0,.35); z-index:110`；进出场 `transition: opacity .2s`
- 移动端：`.list-panel-wrapper:not(.sidebar-mobile-visible){pointer-events:none}`；`.sidebar-mobile-visible{box-shadow:2px 0 12px rgba(0,0,0,.15); pointer-events:auto}`

### D. 与 preview 对应物（App.vue）差异清单

- src 活动栏驱动**三个列表槽位面板**（agents/sessions/tracking 互切，只换侧栏不动主区）；preview 活动栏是「1 个列表开关 + 独立覆盖视图按钮」（tracking 是覆盖视图，无 sessions 页）
- src 主区「运行矩阵」用 `v-if` + 聊天区 `v-show` **保活**（流式不丢）；preview 主区 `v-if` 直接切 `GroupView/ChatView/welcome`，无矩阵保活语义
- src 列表宽度由 `ui.listWidth`（260 默认 / 160 下限 / 视口减 48 减 320 上限）+ 复用 `ResizeHandle` 组件；preview 由 `var(--layout-sidebar-width)`=260 或 `ui.listWidth`（180–560）+ App 内联 `.drag-handle`
- src 有**右侧工作区分屏**（WorkspaceTree + 悬浮把手 + ResizeHandle）；preview 无工作区树（显式缩水）
- src 弹窗层为常驻挂载组件（`visible`/`v-if` 控制）；preview 为 `v-if` 单例（SettingsPanel/UsagePanel/RunTrackingView/FilePreviewModal/SystemPanel）
- src 移动端抽屉 `left:0`（覆盖活动栏之上，z-120）；preview 移动端抽屉 `left:48px`（避开活动栏）
- src z-index 用 90/100/110/120 层；preview 用 10/40/50 层

### E. 迁移落点建议

1. 改 `preview/webui/src/App.vue`：对齐三层骨架命名/断点与移动端抽屉 `left` 语义。
2. 决定「列表宽度拖拽」是否抽成 `ResizeHandle` 组件（preview 内联 `.drag-handle` 可保留，仅对齐命中条视觉）。
3. 工作区树属 src 特有（preview 无后端面），**不搬**；仅记录差异。
4. 视角容器（PerspectiveHost）preview 已用显式 `v-if`，可保留更简形态，不必引容器。

---

## 2. components/Sidebar.vue（活动栏 48px 图标条）

### A. DOM 结构树

```
div.sidebar                          # 48px 列
├─ button.sidebar-avatar-btn > Avatar(size 30)     # 顶部当前用户头像
├─ button.sidebar-btn[agents]  > svg(stroke 1.8)   # Agent 列表入口（active 高亮）
├─ button.sidebar-btn[sessions] > Icon message-circle
├─ button.sidebar-btn[tracking] > svg(stroke 1.8)
├─ div.sidebar-spacer                               # flex:1 推底
├─ button.sidebar-btn[Token 用量] > svg
├─ button.sidebar-btn[主题切换] > svg(sun/moon)
├─ button.sidebar-btn[v-for 插件动作] > Icon        # sidebar-action slot
├─ button.sidebar-btn[全局设置] > svg
└─ div.more-wrapper > button.sidebar-btn.more-trigger[更多] > svg + span.more-dot
(Teleport→body)
└─ Transition[name=more-fade]
    └─ div.agentchat-more-menu
        ├─ button.agentchat-more-item[数据备份] > svg + span
        ├─ div.agentchat-more-backup-msg            # v-if backupMsg
        └─ button.agentchat-more-item[检查更新] > svg + span + span.agentchat-more-item-dot
```

### B. 布局规格

- `.sidebar`：`width:48px; flex-direction:column; align-items:center; flex-shrink:0; padding:8px 0; gap:4px; border-right:1px solid; position:relative; z-index:10`
- 头像按钮 `36×36px`，`margin-bottom:8px`
- 图标按钮 `40×40px`，`border-radius:6px`（图标 SVG 22×22，stroke-width 1.8）
- `.sidebar-spacer { flex:1 }` 把下半组（用量/主题/插件动作/设置/更多）推到底
- more 菜单：`Teleport body`，`position:fixed`（JS 计算 left=触发点右缘+4，bottom=视口-触发点底），`min-width:180px; z-index:9999`

### C. 关键 CSS 规则提炼

- `.sidebar` → `48px / bg var(--color-bg-subtle,#333) / flex column center / padding 8px 0 / gap 4px / border-right var(--color-border-secondary, rgba(255,255,255,.08)) / z-10`
- `.sidebar-avatar-btn` → `36×36 / radius 6 / margin-bottom 8 / transition transform,box-shadow .15s`；hover `scale(1.1) + box-shadow:0 0 0 2px var(--color-primary,#4f46e5)`
- `.sidebar-btn` → `40×40 / radius 6 / color var(--color-text-tertiary, rgba(255,255,255,.5)) / transition color,background .15s`；hover `color var(--color-text-primary,#fff) + background var(--color-bg-hover, rgba(255,255,255,.08))`
- `.sidebar-btn.active::before` → **左缘竖条**：`left:0; top:8px; bottom:8px; width:2px; background var(--color-primary,#4f46e5); radius:0 2px 2px 0`
- `.more-dot` → `8×8 / #ef4444 / radius 50% / border 1.5px solid var(--color-bg-subtle,#333)`
- `.agentchat-more-menu` → `min-width:180 / bg var(--bg-raised,var(--color-bg-page)) / border 1px var(--line,var(--color-border-secondary)) / radius 10 / shadow var(--shadow-pop,0 4px 16px rgba(0,0,0,.12)) / padding 4 / z-9999`
- `.agentchat-more-item` → `gap 8 / padding 8px 12px / radius 6 / font 13 / color var(--text-1,var(--color-text-primary)) / transition background .1s`；hover `background var(--role-hover-bg,var(--bg-hover))`；`svg → var(--text-3,var(--color-text-tertiary))`
- `.more-fade` → `opacity + translateY(-4px), 0.15s ease`

### D. 与 preview 对应物（ActivityRail.vue）差异清单

- src 顶部有**当前用户头像按钮**（Avatar size 30）；preview 无头像，仅图标
- src 活动栏 = **3 个列表面板入口**（agents/sessions/tracking）+ 独立用量/主题按钮；preview = 1 个列表开关 + 独立 run-tracking/token/system/theme/settings 按钮
- src 图标为**SVG stroke**（stroke-width 1.8/2）；preview 用 **emoji**（💬🛰️📊💾☀️🌙⚙️）
- src 有「**更多**」菜单（数据备份/检查更新，Teleport 下拉 + 更新红点）；preview 无更多菜单（备份/版本并入 SystemPanel）
- src 有**插件侧边栏动作 slot**（`sortedSidebarActions` 底部循环）；preview ActivityRail 明言「原生面无版本弹窗与插件动作」
- src active 指示条 `left:0; top/bottom:8px`；preview `left:-6px; top/bottom:6px`（等效 rail 左缘，尺寸略不同）
- src 栏背景 `--color-bg-subtle`（=--bg-hover，暗 #252525）；preview `--color-bg-surface`（暗 #2d2d2d）——**色阶差一档**
- src 有 `z-index:10` + `border-right`；preview 无显式 z-index、`border-right` 用 `--color-border-light`

### E. 迁移落点建议

1. 改 `preview/webui/src/components/ActivityRail.vue`：对齐栏背景令牌（`--color-bg-subtle`）、`gap:4`、按钮 40×40 radius 6、active 指示条位置/尺寸。
2. 决定是否补顶部头像按钮（需用户头像数据，preview 可先略）。
3. 图标 emoji→SVG stroke 属风格对齐（可选，非功能）。
4. 插件动作 slot / 更多菜单：preview 已「无面即无视图」，保留缩水，不改。

---

## 3. components/SessionList.vue（会话列表：singles/workspaces 树）

### A. DOM 结构树

```
div.session-list
├─ div.create-row > button.create-btn            # 「新增」占满一行（虚线幽灵）
├─ div.ws-toolbar
│   ├─ span.ws-label「工作区」
│   └─ div.ws-toolbar-actions
│       ├─ button.ws-add-btn > Icon folder-plus
│       └─ button.mobile-close-btn > svg
├─ div.tree-scroll                              # 树列表滚动容器（零宽滚动条）
│   ├─ v-for group in treeGroups
│   │   ├─ div.ws-node[.ungrouped]              # 根节点（整行点击展开/收起）
│   │   │   ├─ span.ws-icon > Icon folder/folder-open(size 15)
│   │   │   ├─ span.ws-name
│   │   │   └─ v-if workspace
│   │   │       ├─ div.ws-more-wrap > button.ws-act[更多] + Transition > div.ws-menu > button.ws-menu-item×2
│   │   │       └─ button.ws-act[+]             # 新增会话
│   │   └─ div.ws-children(v-if !collapsed) > v-for div.list-item[.active]
│   │       ├─ div.item-avatar-wrap > StarAvatar(size 15, fallback-icon bot, running)
│   │       ├─ div.item-info > div.item-name
│   │       └─ button.item-delete > svg
│   └─ div.empty
├─ Modal[删除会话]  .del-dialog
├─ Modal[新增工作区] .ws-dialog
├─ Modal[重命名工作区] .ws-dialog
└─ Modal[删除工作区] .del-dialog
```

### B. 布局规格

- `.session-list`：`flex:1; min-width:0; background:var(--color-bg-surface); border-right:1px solid var(--color-border-secondary); flex-direction:column; z-index:210`；`html.dark → background:var(--bg-deep,#0a0d14)`
- 新增行 `.create-row { padding:10px 12px 4px }`；`.create-btn { width:100%; height:32px }`
- 工具栏 `.ws-toolbar { padding:8px 14px 6px; gap:6px }`
- 树滚动 `.tree-scroll { flex:1; overflow-y:auto; padding:var(--space-xs); scrollbar-width:none }`（`::-webkit-scrollbar{width:0;height:0}`，零宽滚动条）
- 根节点 `.ws-node { height:30px; padding:0 8px; margin-bottom:var(--space-xs); gap:8px }`
- 叶节点 `.ws-children .list-item { height:30px; padding:0 8px 0 28px; margin-bottom:var(--space-xs); gap:8px }`（左缩进 28px）
- 移动端 `≤768px`：`position:fixed; width:min(280px,80vw); transform:translateX(-100%); visibility:hidden`；`.sidebar-mobile-visible → translateX(0)/visible`；`.mobile-close-btn → display:flex`

### C. 关键 CSS 规则提炼

- `.session-list` / `.tree-scroll` 暗色 `html.dark → var(--bg-deep,#0a0d14)`（与内容区 #1a1a1a 拉开层次）
- `.create-btn` → `dashed 1px var(--color-border-secondary,#c5c5c5) / radius var(--radius-md) / bg var(--color-bg-page,#fff) / color var(--color-text-primary,#2c3e50) / 13px 600 / transition var(--transition-fast)`；hover `border-color var(--color-primary,#6366f1) + bg var(--color-primary-light,rgba(99,102,241,.05))`；active `scale(.985)`
- `.ws-label` → `12px 600 / letter-spacing .5px / color var(--color-text-tertiary,#a8abb2)`
- `.ws-add-btn` → `26×26 / radius 6 / color --color-text-tertiary`；hover `bg --color-bg-subtle + color --color-primary`
- `.ws-node` → `30px / radius var(--radius-md) / color --color-text-secondary / 13px / transition var(--transition-fast) / border 1px transparent`；hover `bg var(--role-hover-bg,var(--color-bg-page)) + border-color var(--color-border-secondary) + shadow 0 1px 3px rgba(0,0,0,.05)`
- `.ws-act` → `22×22 / radius 5 / display:none` → `.ws-node:hover .ws-act{display:flex}`；hover/active `bg --color-bg-subtle + color --color-primary`
- `.ws-menu` → `top:100%; right:0; min-width:130; bg var(--bg-raised,var(--color-bg-page)) / border var(--line,var(--color-border-secondary)) / radius 8 / shadow var(--shadow-pop,...) / padding 4 / z-300`；`.ws-menu-danger → var(--err,#e74c3c)`，hover `color-mix(in srgb,var(--err) 12%,transparent)`
- `.ws-children .list-item` → 同 30px / radius / hover 同根节点；`.active → background var(--role-selected-bg,#e6eaff); border-color transparent`（名称保持默认色）
- `.item-name` → `13px 500 / color --color-text-primary / ellipsis`
- `.item-delete` → `22×22 / opacity:0` → hover 条目 `opacity:1`；hover `rgba(231,76,60,.1) + #e74c3c`
- 弹窗 `.del-confirm → #e74c3c`（hover #c0392b）；`.ws-save-btn → var(--color-primary,#6366f1)`（hover --color-primary-hover）
- `.menu-fade` → `opacity + translateY(-4px), .12s`

### D. 与 preview 对应物差异清单

- **preview 无此页**：singles/workspaces 在 preview 显式缩水（规约 2「conversationId 直用」），无对应面——整节 src 特有
- src 树节点「文件夹开合图标即状态 + hover 浮现更多/新增」交互模式 preview 无
- src 叶节点 **30px 行高 + 头像 size 15** 紧凑密度；preview 列表项 `padding 8px 10px + 头像 size 30`
- src 树滚动条**零宽度**（hover/聚焦才浮现，且此处始终不浮现）；preview 用全局 6px 滚动条

### E. 迁移落点建议

- **不搬**（无后端面）。本轮对齐不涉及 SessionList；若未来恢复 singles/workspaces 才另开规格。

---

## 4. components/AgentList.vue（Agent + 群组列表）

### A. DOM 结构树

```
div.agent-list
├─ div.header                                 # height --layout-header-height
│   ├─ div.search-box > svg.search-icon + input.search-input
│   ├─ div.add-btn-wrap > button.add-btn[+] + Transition > div.create-menu
│   │   └─ button.menu-item[新增 Agent] / button.menu-item[创建群组]
│   └─ button.mobile-close-btn
├─ div.list-scroll(ref)                       # 零宽滚动条 + JS .scroll-visible 浮现
│   ├─ v-for div.list-item[.active]
│   │   ├─ agent: div.item-avatar-wrap > StarAvatar(size 36, running) + span.unread-badge
│   │   ├─ group: div.group-avatar(grid 3×3) > img|span.group-avatar-cell（或空态 svg）
│   │   └─ div.item-info > div.item-name + div.item-last-msg
│   └─ div.empty
└─ Modal[新增 Agent] .dialog-panel
```

### B. 布局规格

- `.agent-list`：同 SessionList 骨架（`flex:1; flex column; bg --color-bg-surface; border-right; z-index:210`；暗色 `--bg-deep`）
- `.header`：`height:var(--layout-header-height)(48px); padding:0 12px; gap:6px; border-bottom:1px solid`
- 搜索框 `.search-input { padding:5px 8px 5px 28px }`（左留 icon）；`.search-icon { left:8px }`
- 新增按钮 `.add-btn { 30×30; radius 6 }`；下拉 `.create-menu { top:100%; right:0; min-width:180px; z-index:300 }`
- 列表滚动 `.list-scroll { flex:1; overflow-y:auto; padding:var(--space-xs); scrollbar-width:none }`；hover 加 `.scroll-visible` 时浮现 6px 滚动条（thumb `--color-border-primary → hover --color-primary`）
- 列表项 `.list-item { padding:10px 12px; margin-bottom:var(--space-xs); border-radius:var(--radius-md); gap:10px; border:1px solid transparent }`
- 头像区：Agent `StarAvatar size 36`；群 `group-avatar 40×40`（grid，`repeat(cols,1fr)/repeat(rows,1fr)`，cols/rows 按人数 1/2/3 分级）
- 移动端 `≤768px`：同 SessionList 抽屉形态

### C. 关键 CSS 规则提炼

- `.list-item` → hover `bg var(--role-hover-bg,var(--color-bg-page)) + border-color var(--color-border-secondary) + shadow 0 1px 3px rgba(0,0,0,.05)`；`.active → bg var(--role-selected-bg,#e6eaff); border-color transparent`
- `.item-name` → `13px 600 / line-height 17px / margin-bottom 1px / color --color-text-primary`
- `.item-last-msg` → `11px / color --color-text-secondary`（Agent 前缀「你: 」，群 =「N 个参与者」）
- `.unread-badge` → `absolute top:-6 right:-8 / min-width 16 / height 16 / radius 999 / #ef4444 / font 10 600 / border 2px solid var(--color-bg-surface,#fff)`
- `.group-avatar` → `40×40 / radius 6 / bg var(--color-primary-light,rgba(79,70,229,.12)) / color var(--color-primary,#4f46e5) / gap 1 / padding 2`；`.group-avatar-cell → radius 2 / font 9 700 / bg var(--color-primary,#4f46e5)`
- `.create-menu` → `bg var(--bg-raised,var(--color-bg-page)) / border var(--line,var(--color-border-secondary)) / radius 10 / shadow var(--shadow-pop,...) / padding 4 / z-300`；`.menu-item → gap 8 / padding 8px 12px / radius 6 / 13px`，hover `bg var(--role-hover-bg,var(--bg-hover))`
- `.scroll-visible::-webkit-scrollbar-thumb → var(--color-border-primary)`（hover `--color-primary`）
- 弹窗 `.btn-save → var(--color-primary,#6366f1)`（hover `--color-primary-hover,#4f46e5`）；`.btn-cancel → --color-bg-page + border --color-border-secondary`
- 移动端同 §3

### D. 与 preview 对应物（AgentGroupList.vue）差异清单

- src 新增入口 = 「+ 下拉菜单」（新增 Agent / 创建群组）；preview = 3 个并排文本按钮（＋Agent / ＋群组 / ↻ 刷新）
- src 群头像 = **3×3 成员头像网格拼图**（`gridLayout` 按人数 1/2/3 分级）；preview 群 = `StarAvatar fallbackIcon=users` 单头像
- src 列表项摘要 = lastMessage（Agent「你: xxx」/ 群「N 个参与者」）；preview 摘要 = description/model 或「N 名参与者」，另有 `item-time` 相对时间 + 未读徽章
- src 排序 = **lastActivity 浮顶**（无未读优先）；preview = **未读优先 > lastActivity > 名称**
- src 指针冻结 = `pointerdown` 冻结 + 600ms 解冻；preview = `mouseenter` 快照冻结 + `mouseleave` 重排
- src 未读徽章定位在头像右上角（带 2px 底色描边）；preview 未读在右列 `item-meta`
- src 有 `mobile-close-btn`；preview 无
- src Agent 头像 size **36**；preview size **30**
- src 选中态 `--role-selected-bg`（#e6eaff 色板）；preview 选中态 `--color-primary-light`（主色 10% 透明）
- src 零宽滚动条 + hover 浮现；preview 全局 6px 滚动条
- src 有 `.virtual-badge` 虚拟端点徽章吗？——**无**（src 无 virtual 概念；preview AgentGroupList 有 `.virtual-badge`）

### E. 迁移落点建议

1. 改 `preview/webui/src/components/AgentGroupList.vue`：对齐行密度（`padding`/`margin-bottom`）、头像尺寸（30→36）、选中态令牌（`--color-primary-light`→`--role-selected-bg`）、未读徽章形态、摘要来源。
2. 决定群头像形态（3×3 网格 vs 单 users 图标）——视觉语言差异，建议对齐 src 网格。
3. 新增入口形态（下拉 vs 文本按钮）可选对齐；指针冻结两实现语义等价，可各留。
4. `virtual-badge` 是 preview 独有（src 无），保留即可。

---

## 5. components/dialog/GroupDrawer.vue（群成员抽屉）

### A. DOM 结构树

```
div.drawer-panel(v-if visible)               # 280px 右侧抽屉
├─ div.drawer-section
│   ├─ div.drawer-section-title「群成员 (N)」
│   ├─ div.drawer-search-box > svg.search-icon + input.drawer-search-input
│   └─ div.drawer-member-list(grid 4 列)
│       └─ v-for div.drawer-member-item
│           ├─ div.member-avatar-wrap > Avatar(size 40, shape circle) + span.member-me
│           └─ span.member-name
├─ div.drawer-section
│   ├─ div.drawer-section-title「群聊名称」
│   └─ div.drawer-name-row > input.drawer-name-input + button.drawer-save-btn[.saved]
├─ div.drawer-section
│   ├─ div.drawer-section-title「群聊简介」
│   └─ textarea.drawer-desc-input(rows 3)
└─ div.drawer-section.drawer-section-bottom > button.drawer-delete-btn
```

### B. 布局规格

- `.drawer-panel`：`width:280px; flex-shrink:0; border-left:1px solid var(--color-border-secondary); background:var(--color-bg-surface); flex-direction:column; overflow-y:auto`
- `.drawer-section { padding:14px 16px; border-bottom:1px solid }`
- 成员网格 `.drawer-member-list { grid-template-columns:repeat(4,1fr); gap:8px 4px; max-height:320px; overflow-y:auto; padding:4px 0 }`
- 成员项 `.drawer-member-item { flex column center; gap:4px; padding:6px 2px; border-radius:8px }`
- 「我」徽章 `.member-me { position:absolute; right:-5px; bottom:-3px }`
- 底部删除区 `.drawer-section-bottom { border-bottom:none; margin-top:auto }`（推到底部）
- 无响应式断点（固定 280px 右抽屉）

### C. 关键 CSS 规则提炼

- `.drawer-section-title` → `13px 600 / color var(--color-text-primary) / margin-bottom 8`
- `.drawer-search-input` → `padding 5px 8px 5px 28px / radius 6 / 12px`；focus `border-color var(--color-primary)`
- `.drawer-member-item` → hover `bg var(--color-bg-hover,rgba(0,0,0,.04))`
- `.member-me` → `9px 600 / bg var(--color-primary,#6366f1) / border 1.5px solid var(--color-bg-surface) / radius 8`
- `.member-name` → `11px / ellipsis / nowrap`
- `.drawer-save-btn` → `bg var(--color-primary,#6366f1) / radius 4 / 12px`；`.saved → #27ae60`；`:disabled opacity .5`
- `.drawer-desc-input` → `radius 6 / min-height 52px / resize:vertical / line-height 1.5`
- `.drawer-delete-btn` → `color #e74c3c`；hover `#fdecea`
- `.drawer-error` → `11px #e74c3c`

### D. 与 preview 对应物（GroupView.vue）差异清单

- src 用**右侧 280px 抽屉**承载成员（4 列网格头像）/成员搜索/名称编辑/简介/删除；preview GroupView **无抽屉**——成员以 `.member-chip` 行内 chip 展示、重命名为 header 内联行、删除为 header 按钮 `confirm()`
- src 成员 = `Avatar 40 circle + 「我」徽章 + 名字`；preview 成员 chip 无头像、无「我」标记
- src 有成员搜索框；preview 无
- src 有群聊简介 textarea 编辑；preview 无简介字段
- src 删除在抽屉底部独立按钮；preview 删除在 header 右侧

### E. 迁移落点建议

1. 改 `preview/webui/src/views/GroupView.vue`：决定是否引入 280px 成员抽屉（建议对齐：成员头像网格 + 名称/简介编辑 + 抽屉底部删除）。
2. 至少对齐成员展示形态（chip → 头像+名字，或引入「我」徽章）。
3. 若引入抽屉，需补 `drawer-panel`/`drawer-section` 令牌引用（`--color-bg-surface`/`--color-border-secondary`/`--color-primary`）。

---

## 6. components/layout/PerspectiveHost.vue + ResizeHandle.vue

### PerspectiveHost.vue

**A. DOM 结构树**：无静态结构——单 `<component :is="active?.component" v-bind="buildProps()" @group-deleted=... />`（注册表驱动动态组件）。

**B. 布局规格**：无自身 CSS。渲染 `activePerspective()`（`core/registry/perspectives`，随 `perspectiveVersion` 重解析）。App.vue 注册 4 个视角：`pair`（PairDialogView，active 时覆盖）/ `talk` / `group` / `single`（后三者共享 DialogView 内核，按选中态切换 props）。

**C. 关键 CSS 规则**：无。

**D. 差异清单**
- src 主区 = **视角容器驱动**（PerspectiveHost + perspectives 注册表 4 视角）；preview App.vue 用**显式 `v-if`** 切 `GroupView/ChatView/welcome`（preview 也有 `registry/perspectives.ts` 但用于消息视角注册，非页面容器）
- src 视角切换走注册表解耦（新增视角=注册项，不改主框架）；preview 改主区需改 App 模板

**E. 迁移落点建议**：preview 显式 `v-if` 更简，可保留；若追求「主区视角可扩展」再引 PerspectiveHost（非对齐必需）。

### ResizeHandle.vue

**A. DOM 结构树**：`div.resize-handle[.active]`（`@mousedown=startResize`）。

**B. 布局规格**
- `width:3px; flex-shrink:0; cursor:col-resize; transition:background .15s`
- `kind='list'`：列表右缘（右移变宽）；`kind='workspace'`：工作区左缘（右移变窄，方向相反）
- 拖拽逻辑集中在 `stores/ui.ts`（`startResize`/`onResizeMove`/`onResizeEnd`；`resizing` 驱动 `.active`）

**C. 关键 CSS 规则提炼**
- `.resize-handle` → `3px / transparent`；hover/active → `background:var(--color-primary,#6366f1)`

**D. 差异清单**
- src 抽成**复用组件**（3px 命中条 + hover 主色高亮）；preview App.vue 内联 `.drag-handle`（6px 宽、`right:-3px` 越界、hover `--color-primary-light`）

**E. 迁移落点建议**：可保留 preview 内联 `.drag-handle`，仅对齐命中条视觉（宽 3px、hover 主色而非 primary-light）；或抽 `ResizeHandle` 组件复用（次要）。

---

## 7. ui/StarCard.vue（星卡：列表项视觉语言）

### A. DOM 结构树

```
div.ui-star-card[.selected]（--sc 自定义属性注入星色） > slot
```

### B. 布局规格

- `display:flex; gap:10px; align-items:flex-start; padding:9px 10px; border-radius:var(--r-md); cursor:pointer; border:1px solid transparent`
- 选中态：`background:var(--bg-surface)` + 星色 40% 描边

### C. 关键 CSS 规则提炼

- `.ui-star-card` → `gap 10 / align-items flex-start / padding 9px 10px / radius var(--r-md) / transition background var(--dur-fast) var(--ease-out), border-color var(--dur-fast)`
- `.ui-star-card:hover` → `background:var(--bg-hover)`
- `.ui-star-card.selected` → `background:var(--bg-surface); border-color:color-mix(in srgb, var(--sc) 40%, transparent)`（**星色描边 = 选中语义，替代发光**）

### D. 与 preview 对应物差异清单

- src 与 preview `StarCard.vue` **字节级相同**（两轨均已搬运）
- 但 src 星群层列表**实际未使用 StarCard**（AgentList/SessionList 用手写 `.list-item`）；preview AgentGroupList 同样未用 StarCard——两轨均为「已定义未使用」的 L2 组合件

### E. 迁移落点建议

- 若要统一「星色描边选中态」，可让两轨列表项改用 `<StarCard>`（替代 `.list-item.active` 的 `--role-selected-bg` 色板选中）——属视觉语言升级，非对齐必需。

---

## 8. ui/Button.vue（按钮形态）

### A. DOM 结构树

```
button.ui-btn.ui-btn--{variant}.ui-btn--{size}（:disabled=disabled||loading）
├─ span.ui-btn-spinner(v-if loading)
├─ Icon(v-else-if icon; size sm=14/md=16)
└─ span.ui-btn-label(v-if $slots.default) > slot
```

### B. 布局规格

- 基态 `display:inline-flex; align-items:center; justify-content:center; gap:6px; border-radius:var(--r-md)`
- 尺寸：`sm → height 28px, padding 0 10px, font 12px`；`md → height 32px, padding 0 14px, font 13px`

### C. 关键 CSS 规则提炼

- `.ui-btn` → `gap 6 / radius var(--r-md) / font var(--font-ui) 13px 500 / color var(--text-2) / transition background var(--dur-fast) var(--ease-out), color/box-shadow/transform var(--dur-fast) / white-space nowrap`
- `.ui-btn:disabled → opacity .5; cursor not-allowed`
- `.ui-btn--primary` → `#fff / bg var(--primary) / box-shadow var(--shadow-primary)`；hover `bg var(--primary-strong) + 0 6px 22px rgba(99,102,241,.32)`；active `scale(.97)`
- `.ui-btn--soft` → `bg var(--bg-hover) / color var(--text-1)`；hover `color var(--primary)`
- `.ui-btn--ghost` → hover `bg var(--bg-hover) + color var(--primary)`
- `.ui-btn--danger` → `bg color-mix(in srgb, var(--err) 14%, transparent) / color var(--err)`；hover 24%
- `.ui-btn-spinner` → `12×12 / border 2px color-mix(currentColor 30%, transparent) / border-top currentColor / ui-spin .7s linear infinite`

### D. 与 preview 对应物差异清单

- src 与 preview `Button.vue` **字节级相同**
- 两轨星群层列表实际都**手写 button**（`.add-btn`/`.create-btn`/`.del-confirm`/`.ws-save-btn` vs `.add-btn`/`.header-btn`），未走 `ui/Button` 变体

### E. 迁移落点建议

- 对齐时可选择「星群层按钮统一走 `ui/Button` 变体」或保持手写——令牌已一致，不影响视觉；若要收敛建议优先改 preview 的 `.add-btn`/`.header-btn` 为 `ui/Button`。

---

## 星群层通用结论

### 设计语言特征

1. **光晕（glow）语义已扁平化降级**：`tokens.css` 中 `--glow-primary`/`--glow-soft` 双主题均为 `none`。
   发光只保留在两个「功能性状态」处：
   - `StarAvatar` running 光环：SVG stroke 三环 = 底环（身份色 `opacity .16`）+ 主流光（38% 周长渐隐弧，`1.15s` 匀速旋转）+ 副流光（accent 色 16% 短弧，`1.9s` 错相）；`prefers-reduced-motion` 下**不降级**（运动即语义，已豁免）。
   - `StatusDot` 呼吸：`box-shadow:0 0 8px 同色` + opacity .45↔1 / scale .9↔1.08，`1.4s`。
   - 其余「发光」用替代物：`StarCard.selected` = 星色 40% `color-mix` 描边；`Button--primary` = `--shadow-primary` 阴影。

2. **星色（star color）系统**：`utils/starColor.ts` 8 色星板，`agent_id` 稳定哈希（31 进制滚动 `>>>0`）→ `0..7`；user 固定白金。
   双主题各一套（`nebula` 亮彩 / `aurora` 深彩），列表按 `theme==='dark'?'nebula':'aurora'` 响应式取色。
   星色经 `--sc` CSS 变量注入：头像首字底色（`color-mix(--sc 14%)`）、运行光环、星卡描边、思维链标题。

3. **状态灯（StatusDot）**：`thinking`=琥珀 `--warn` 呼吸 / `running`=靛蓝 `--primary` 呼吸 / `idle·ok`=绿 `--ok` / `err`=红 `--err` / `offline`=灰 `--text-3`。原则「文字+颜色双表达」（色盲友好），点尺寸默认 8px。

4. **密度与间距基准**：
   - 间距 4px 刻度（`--space-1..6` / 业务别名 `--space-xs=4 / --space-sm=8 / --space-md=16 / --space-lg=24`）
   - 列表行高：树/叶节点 **30px**（紧凑，头像 15）、Agent 列表项 **40px**（头像 36，`padding 10px 12px`）；行间距统一 `margin-bottom:var(--space-xs)=4px`
   - 圆角 4/8/12/999（`--r-sm/md/lg/full` 与 `--radius-sm/md/lg` 等价）
   - 动效：`--dur-fast .12s` / `--dur-base .2s` / `--ease-out cubic-bezier(.22,1,.36,1)`；业务层常用 `.15s ease`（`--transition-fast`）、移动端抽屉 `.25s ease`、下拉菜单 `.12s`
   - 字号阶：11（摘要/时间）→ 12（标签/占位）→ 13（名称/正文/按钮）→ 15（标题）→ 22（welcome）

5. **选中态 / hover 语言**：选中 = **角色色板**（`--role-selected-bg` 淡色底 + 名称保持默认色，非浓度渐变）；hover = `--role-hover-bg` + 1px 边框（`--color-border-secondary`）+ `0 1px 3px` 微阴影。星色描边（StarCard）为备选选中语义。

### --color-* 与 tokens.css 双体系在星群层的实际分工

- **L0 单一来源**：`ui/tokens.css` 是唯一真源（`--bg-*`/`--text-*`/`--line`/`--primary`/`--r-*`/`--space-*`/`--dur-*`/`--role-*`）。
- **别名桥接**：`tokens.css` 末尾「业务兼容别名层」把 `--color-*` 全部 aliasing 到 L0 变量（`--color-primary=var(--primary)`、`--color-bg-page=var(--bg-base)`、`--color-text-tertiary=var(--text-3)`、`--radius-md=var(--r-md)`、`--space-xs=var(--space-1)` …），实现单一来源；`main.css` 里的 `--color-*` 重复定义可逐步移除。
- **星群层内分工**：
  - **UI 库组件**（Button/StarCard/StarAvatar/Avatar/StatusDot/Modal）只引用 **tokens 变量**（`--primary`/`--bg-hover`/`--r-md`/`--dur-fast`/`--ease-out`/`--err`/`--warn`/`--ok`/`--text-1/2/3`/`--shadow-*`/`--role-*`），零硬编码色值。
  - **业务组件**（App/Sidebar/SessionList/AgentList/GroupDrawer）主要引用 **`--color-*` 别名**（`--color-bg-surface`/`--color-border-secondary`/`--color-text-primary`/`--color-primary`…），部分规则「双写带 fallback」：`var(--bg-raised, var(--color-bg-page))`、`var(--role-hover-bg, var(--color-bg-page))`、`var(--line, var(--color-border-secondary))` —— 即「先试 tokens 变量，缺省回退 `--color-*`」。
  - 两者**视觉等价**（别名对齐），差异只在「写哪个名字」；`main.css` 独有且 tokens 无对应者：`--color-bg-user-container`、`--color-bg-assistant`、`--color-danger-light`、`--color-code-*`、`--layout-*`（header-height 48 / sidebar-width 260 / content-max-width 840）、`--space-xl`、`--transition-*`。

**迁移结论**：src 与 preview 的 `tokens.css` + `main.css` 已字节级一致，**无需改任何令牌**；本轮对齐只改 preview 组件形态与密度（活动栏背景/行高/头像尺寸/选中态令牌/群头像形态/成员抽屉/滚动条/入口形态），并将 preview 业务组件里的 `--color-*` 引用按需补 tokens fallback 即可与 src 视觉一致。
