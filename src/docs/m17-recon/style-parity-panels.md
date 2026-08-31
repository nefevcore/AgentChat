# 面板层（统计 / 跟踪 / 弹窗 / 设置）布局与样式规格

> 迁移文档：preview 原生面 ↔ src 轨道页面布局/风格对齐。
> 侦察对象：`src/ui/webui/src/` 下 12 个文件（组件 + 设置 + UI 库）。
> 对照基准：`preview/webui/src/views/{UsagePanel,RunTrackingView,SystemPanel}.vue` + `settings/**` + `ui/{Modal,Tooltip,Button}`。
> 只读分析产出，仅本文件为输出。

---

## 0. 先决结论：令牌层已经分层，这是「观感不一致」的根因

src 轨道内部存在 **两套令牌体系并行**，直接决定对齐工作的起点：

| 令牌层 | 使用文件 | 特征 |
| --- | --- | --- |
| **新令牌（已对齐 tokens.css）** | `ui/tokens.css`、`ui/Modal.vue`、`ui/Tooltip.vue`、`ui/Button.vue`、`TokenUsage.vue`、`settings/**`（SettingsPanel / AgentPane / ConfirmDialog） | 引用 `--bg-*` / `--text-*` / `--line` / `--r-*` / `--input-*` / `--role-*`，无 `html.dark` 硬编码 |
| **旧令牌（`--color-*` + 硬编码 dark 覆盖）** | `RunTracking.vue`、`RunTrackingPanel.vue`、`PairDialogView.vue`、`CreateGroupDialog.vue`、`VersionDialog.vue`、`WorkspaceTree.vue` / `WorkspaceTreeNode.vue` | 引用 `--color-*`（`--color-bg-page` / `--color-text-primary` / `--color-border-secondary` 等），配 `html.dark .xxx { background:#11151d }` 之类硬编码 + rgba 兜底 |

preview 侧的对照物也同样是**混态**：

- **preview 已 NEW 令牌**：`views/RunTrackingView.vue`、`views/SystemPanel.vue`、`views/SettingsPanel.vue`、`settings/components/{AgentPane,ConfirmDialog}.vue`、`ui/*`。
- **preview 仍残留 OLD 令牌**：`views/UsagePanel.vue`、`components/CreateGroupDialog.vue`（注意：preview 这两处反而用了 `--color-*`，而 src 的 `TokenUsage.vue` 已 NEW——两轨道在「谁更先进」上是错位的）。

**结论**：对齐不能只做「src → preview 单向搬运」。src 的 `TokenUsage.vue` 与整个 `settings/**` 已经是 preview 想要的目标形态（NEW 令牌 + 结构化布局）；src 的 RunTracking / 树 / 弹窗系列是旧令牌遗留。真正要做的是「把 src 的结构化布局规格抄过来，同时把 OLD 令牌替换为 NEW 令牌」，并顺手把 preview 里残留的 `--color-*` 也洗掉。

---

## 1. `components/TokenUsage.vue` —— 用量统计（全仓最大组件，53K）

### A. DOM 结构树

```
<Modal title="Token 用量统计" :width="1120" height="min(80vh, 780px)">        ← ui/Modal 外壳
├─ #head-extra → span.last-updated            （"更新于 HH:mm:ss"，12px --text-3）
├─ div.usage-body                              （display:contents，直连 Modal flex）
│  ├─ div.status-msg / .status-msg.error       （加载中 / 错误占位）
│  └─ div.usage-layout                          （flex 行）
│     ├─ aside.usage-side                       （左侧栏，216px 定宽，竖向）
│     │  ├─ div.range-filter                    （日期筛选，底部 1px --line 分隔）
│     │  │  ├─ div.range-head → span.range-title + span.range-dirty（"未应用" --warn）
│     │  │  ├─ select.range-select              （近7/30/90天·全部·自定义）
│     │  │  ├─ div.range-custom → input.range-date ×2 + span.range-sep + button.range-apply
│     │  │  └─ div.range-coverage               （"数据覆盖 from ~ to" 或 "范围内暂无记录"）
│     │  ├─ div.summary-bar                     （摘要，单条进度条形态）
│     │  │  ├─ div.summary-bar-label → span.summary-bar-title + span.summary-bar-value[strong + span.summary-bar-pct]
│     │  │  ├─ div.progress-track → div.progress-fill        （缓存命中率进度条）
│     │  │  └─ div.summary-bar-mini → span×3   （总输出 / 总步数 / 请求）
│     │  └─ div.tab-bar                          （竖向页签）
│     │     └─ button ×2                         （总览 / 用量统计；active = primary）
│     └─ div.usage-main                          （右侧内容，flex:1，overflow-y auto）
│        ├─ div.cloud-tab                        （总览 = 弦图）
│        │  ├─ div.cloud-hint                    （说明文字，--text-3）
│        │  ├─ label.cloud-toggle → input[checkbox]（"包含 user / self 流量"）
│        │  ├─ div.cloud-canvas-wrap             （relative，flex:1 填满）
│        │  │  ├─ svg.cloud-svg                  （viewBox 0 0 660 660，响应式铺满）
│        │  │  ├─ div.cloud-tip                  （绝对定位自绘 tooltip，z-index 5）
│        │  │  └─ div.cloud-empty → div + div.cloud-empty-sub（无协作流量引导）
│        │  └─ div.status-msg                    （暂无数据）
│        └─ div.chart-tab                        （用量统计 = 堆叠柱状图）
│           ├─ div.chart-toolbar
│           │  ├─ div.seg-control[role=tablist] → button ×2   （缓存 / 模型 分段切换）
│           │  └─ span.chart-hint                （口径说明）
│           ├─ div.chart-wrapper → canvas + div.chart-tip    （自绘 tooltip，z-index 5）
│           └─ div.status-msg
└─ #footer → Button[ghost icon=refresh-cw 刷新] + Button[ghost 关闭]
```

### B. 布局规格

- **外壳**：Modal `width:1120`，`height:min(80vh, 780px)`（固定高度防内容切换跳变，body 内部滚动）。
- **左右分栏**：`usage-layout` = flex 行；左 `usage-side` **216px** 定宽（`flex-shrink:0`，`border-right:1px solid var(--line)`，`background:var(--bg-raised)`，`padding:14px 16px`，自身 `overflow-y:auto`）；右 `usage-main` `flex:1 min-width:0`，`flex-direction:column`，`overflow-y:auto`。
- **竖向页签条**：`.tab-bar` 纵向 flex，按钮 `padding:8px 12px`、`text-align:left`、`border-radius:var(--r-sm)`；hover `--bg-hover`；active `color:var(--primary)` + `background:var(--primary-light)` + `font-weight:500`。
- **图表区高度**：无固定高度，`.cloud-tab` / `.chart-tab` 均为 `flex:1 min-height:0`；`.cloud-canvas-wrap` / `.chart-wrapper` 也是 `flex:1 min-height:0` —— 图表吃满 Modal 剩余高度（约 660px viewBox 等比缩放）。
- **摘要进度条**：`.progress-track` 高 8px，`border-radius:var(--r-full)`，底 `--bg-hover`；`.progress-fill` `background:var(--ok)`，`transition:width .4s`。
- **分段切换（图表内）**：`.seg-control` `inline-flex`，`padding:2px`，`border:1px solid var(--line)`，`border-radius:var(--r-md)`，底 `--bg-hover`；active 按钮 `background:var(--bg-raised)` + `box-shadow:0 1px 3px rgba(0,0,0,.12)`。
- **z-index**：`cloud-tip` / `chart-tip` 均 `z-index:5`（相对各自 wrapper 定位，非全局）。

### C. 关键 CSS 规则提炼

| 选择器 | 声明要点 | 令牌 |
| --- | --- | --- |
| `.usage-side` | `width:216px; flex-shrink:0; border-right; bg; padding:14px 16px; overflow-y:auto` | `--line` / `--bg-raised` |
| `.range-select` / `.range-date` | 输入框：`border:1px solid`、`border-radius:var(--r-sm)`、`bg`、`font-size:11-12px` | `--line` / `--r-sm` / `--bg-base` / `--text-1` |
| `.range-apply` | 主色实底小按钮，`background:var(--primary); color:#fff; border-radius:var(--r-sm)`，`:disabled{opacity:.45}` | `--primary` / `--r-sm` |
| `.tab-bar button.active` | `color:var(--primary); background:var(--primary-light); font-weight:500` | `--primary` / `--primary-light` |
| `.summary-bar-value strong` | 命中数用成功色强调 | `--ok` |
| `.progress-fill` | `height:100%; background:var(--ok); border-radius:var(--r-full)` | `--ok` / `--r-full` |
| `.seg-control button.active` | `color:var(--primary); background:var(--bg-raised); font-weight:500; box-shadow:0 1px 3px rgba(0,0,0,.12)` | `--primary` / `--bg-raised` |
| `.cloud-tip` / `.chart-tip` | 自绘 tooltip 卡片：`border:1px solid var(--line); border-radius:var(--r-md); background:var(--bg-raised); box-shadow:0 4px 16px rgba(0,0,0,.18); pointer-events:none` | `--line` / `--r-md` / `--bg-raised` |
| `.chart-tip .ct-val` / `.tt-row` | 数值 `font-variant-numeric:tabular-nums` | — |

### D. 图表视觉主题（只提炼视觉，不抄 render 代码）

- **堆叠柱状图（chart.js `bar`）**：图例关闭（`legend.display:false`，颜色含义经悬停 tooltip 呈现）；tooltip 用 **external HTML**（`enabled:false` + 自绘 `.chart-tip` 两列卡片：色点 + 名称左 / 数值右对齐，底部合计分隔线）。
- **柱体圆角**：仅柱顶两角圆角 `6px`（`BAR_CORNER_R=6`），底部落轴直角；堆叠顶段数值为 0 时圆角顺延到下方首个可见段（scriptable `borderRadius`）。
- **网格**：竖网格线移除（`x.grid.display:false`），仅横向刻度线；网格色 dark `rgba(255,255,255,0.06)` / light `rgba(0,0,0,0.06)`；刻度字 11px，`maxRotation:45`。
- **堆叠配色（缓存视图，自上而下）**：输出 `#a78bfa`(dark)/`#8b5cf6`(light)、未缓存 `#818cf8`/`#6366f1`、缓存 `#34d399`/`#10b981`。
- **模型视图配色**：18 色哈希调色板 `CLOUD_COLORS`（`#6366f1 #8b5cf6 #ec4899 #f43f5e #f59e0b #10b981 #06b6d4 #3b82f6 #a855f7 #ef4444 #84cc16 #14b8a6 #f97316 #d946ef #22d3ee #fb7185 #a3e635 #facc15`），"其他" 段 `#8b93a7`/`#9ca3af`。
- **弦图（d3-chord 自绘 SVG）**：画布 viewBox **660×660**；外环弧带宽 **18**、弧段圆角 **3**；弦（ribbon）用两端色渐变、`opacity 0.35~0.85`；标签径向排列（12px / 700），左半环翻转 180° 防倒字；主 agent top10 标签 + 「其他」；悬停高亮走事件委托（弦/弧压暗到 `0.05`/`0.25`）。

### E. 与 preview 对应物差异清单（vs `views/UsagePanel.vue`）

| 维度 | src TokenUsage | preview UsagePanel |
| --- | --- | --- |
| 结构 | 左 216px 栏（筛选+摘要+竖向页签）+ 右内容（弦图 / 柱状图 二选一） | 无侧栏，纯纵向堆叠：5 摘要卡 + 220px 柱状图 + 协作排行条 + 双表格 |
| 摘要 | 单条「缓存命中/总输入」进度条 + 3 迷你指标 | 5 张 `.summary-card`（输入/输出/总/run 数/缓存命中） |
| 协作流量 | **弦图**（d3-chord，660×660，自绘 tooltip） | **排行条**（`.chord-row` 横条 + run 数） |
| 图表 | 堆叠柱状图：去图例 + 自绘 HTML tooltip + 柱顶圆角 + 缓存/模型分段切换 | 堆叠柱状图：chart.js 默认图例 + 硬编码 `#7f8c8d` 轴色，无分段切换 |
| 日期筛选 | 有（select + 自定义起止 + 应用按钮 + 数据覆盖提示） | 无 |
| 令牌 | **NEW**（`--bg-*`/`--text-*`/`--line`/`--r-*`） | **OLD**（`--color-*`） |

### F. 迁移落点建议

1. **左侧 216px 栏 + 竖向页签 + 摘要进度条是 preview 缺失的形态**，建议整体移植 `usage-layout` / `usage-side` / `tab-bar` / `summary-bar`（progress-track/fill）三块 CSS；摘要进度条（`.progress-fill` 用 `--ok`）可作为 preview「缓存命中率」的新表达，替代单调的数值卡。
2. **弦图是重资产**（d3-chord + 自绘 tooltip + 事件委托 + 渐变 defs）。preview 用排行条替代属合理 C 档缩水；若要对齐，最低成本是把排行条升级为「扇形/环形」占位，或直接复用 src 的 `renderCloud` 成品——但需同步引入 d3-chord 依赖。
3. **柱状图视觉主题**（去图例、自绘 HTML tooltip 卡片、柱顶圆角 6、横向网格线、11px 刻度）是可移植的纯视觉规范，不抄 `renderChart` 的定位逻辑即可；preview 当前 `drawChart` 里的硬编码 `#7f8c8d` 轴色应替换为 `--text-2`/`--text-3` 令牌。
4. preview 的 `UsagePanel` 残留 `--color-*`，应先洗成 NEW 令牌（`--bg-surface`→`--bg-raised`、`--color-border-light`→`--line`、`--radius-md`→`--r-md` 等），否则对齐后仍观感割裂。

---

## 2. `components/RunTracking.vue` —— 运行矩阵（大画布）

### A. DOM 结构树

```
div.run-page                                     （flex:1，占满主区，非 Modal）
├─ div.page-header                               （高 48px，border-bottom）
│  ├─ span.page-title「运行跟踪」                  （15px 700）
│  ├─ div.range-toggle → button.range-btn ×6     （1h/1天/3天/1周/1月/全部；active 浮起）
│  └─ div.header-side → span.snap-time            （快照时间，tabular-nums）
├─ div.load-error                                 （可选，红字）
├─ div.tab-body → div.matrix-scroll → div.matrix-wrap（居中）
│  ├─ div.matrix-grid                             （CSS grid；--cell:40px；gap:5px；gridTemplateColumns:190px repeat(N,var(--cell))）
│  │  ├─ div.cross-track.cross-row / .cross-col   （十字底色带，absolute z-index:0）
│  │  ├─ div.corner                               （左上角，sticky top-left z-index:5）
│  │  ├─ div.col-head ×N                          （列头头像，sticky top z-index:2；Avatar 30 或 .head-ic）
│  │  └─ template per row
│  │     ├─ div.row-head                          （行头头像+名，sticky left z-index:1；Avatar 26）
│  │     └─ div.cell ×N                           （40×40 圆角方块，heat 浓度类；运行格内嵌 svg.cell-ring）
│  ├─ div.legend                                  （span.lg ×4：运行中 / 活跃度色阶 / 群参与 / 说明）
│  ├─ button.coverage-toggle                      （chevron 展开「覆盖面分析」）
│  └─ div.coverage → div.coverage-body → p ×3
└─ Teleport to body → div.mx-tip                  （fixed，z-index:10000，宽 270px）
   ├─ div.tip-head → div.tip-avatars + div.tip-names
   ├─ div.tip-rel
   ├─ div.tip-row ×N（消息 / 活跃 / 证据 / 运行）
   └─ div.tip-foot
```

### B. 布局规格

- **页面级**：`.run-page{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;overflow:hidden}`。
- **头部**：`.page-header` 高 `var(--layout-header-height,48px)`，`padding:0 20px`，`gap:16px`，`border-bottom:1px solid var(--color-border-secondary)`。
- **矩阵几何（关键常量 `CROSS`）**：列头宽 `headW:190`，列头高 `headH:48`，格子 `cell:40`，`gap:5`。矩阵 grid `grid-template-columns:190px repeat(N, 40px)`；行轨道 `48px repeat(N, 40px)`。
- **吸顶/吸左**：`.corner` sticky 左上（z5）；`.col-head` sticky top（z2，40px 宽 48px 高，`border-radius:10px`）；`.row-head` sticky left（z1，40px 高，`gap:8px`，`padding:0 10px 0 4px`）。
- **格子**：`.cell{width/height:var(--cell); border-radius:10px; box-shadow:inset 0 0 0 1px rgba(127,127,127,.1)}`；hover 主色描边 2px；`.diag` 虚线 `outline:1px dashed rgba(127,127,127,.5); outline-offset:-4px`。
- **十字高亮**：`.cross-track` absolute、`border-radius:8px`、`background:color-mix(in srgb,var(--color-primary) 10%,transparent)`；横带 top=`48 + row×(40+5)`、高=`40+2×5`；纵带 left=`190 + col×(40+5)`、宽同。
- **十字置灰**：`.matrix-grid.cross-active .cell:not(.hl):not(:hover){opacity:.22}`，行头/列头非 hl `opacity:.35`（只用 opacity，GPU 合成）。
- **浓度色阶**：5 档 `color-mix` 主色浓度 `c1 6% / c2 12% / c3 20% / c4 30% / c5 42%`；运行中 `heat-live 48%`；群参与证据 `heat-evidence #10b981 16%`。
- **运行光环**：`.cell-ring` SVG viewBox 100，圆 r=46，`stroke-width:7`；`.ring-main` 白、`.ring-sub` `--accent`；`.ring-spin` `transform-box:view-box` 旋转 `1.15s`，副环 `1.9s` delay `-.6s`。
- **tooltip**：`.mx-tip` fixed `z-index:10000`，宽 270px，`border-radius:12px`，`box-shadow:0 8px 28px rgba(0,0,0,.16)`；`tip-k` 左标签列 `min-width:38px`。
- **z-index 链**：`cross-track 0 → cell/row-head 1 → col-head 2 → corner 5 → mx-tip 10000`。

### C. 关键 CSS 规则提炼（OLD 令牌 + dark 覆盖）

| 选择器 | 声明要点 | 令牌 / 硬编码 |
| --- | --- | --- |
| `.run-page` | 页面底 | `--color-bg-page` + `html.dark .run-page{background:#11151d}` |
| `.range-btn.active` | `background:var(--color-bg-page); color:var(--color-primary); box-shadow:0 1px 4px rgba(0,0,0,.12)` | `--color-primary` + `html.dark .range-btn.active{background:#1e2530}` |
| `.matrix-grid` | `--cell:40px; display:grid; gap:5px; position:relative` | — |
| `.cross-track` | 主色 10% 底色带 | `color-mix(in srgb, var(--color-primary) 10%, transparent)` |
| `.cell` | `border-radius:10px; box-shadow:inset 0 0 0 1px rgba(127,127,127,.1)` | — |
| `.cell.mirror`（上三角无数据） | 斜纹占位 `repeating-linear-gradient(135deg, transparent 0 4px, var(--color-bg-subtle) 4px 8px)` | `--color-bg-subtle` |
| `.c1~.c5` / `.heat-live` / `.heat-evidence` | 浓度 `color-mix` | `--color-primary` / `#10b981` |
| `.ring-track/.ring-main/.ring-sub` | 白 / 白 / accent 描边 | `--accent` |
| `.mx-tip` | fixed 卡片 | `--bg-raised` + `html.dark .mx-tip{background:#1c222e}` |

### D. 与 preview 对应物差异清单（vs `views/RunTrackingView.vue`）

| 维度 | src RunTracking | preview RunTrackingView |
| --- | --- | --- |
| 承载 | 主区全屏大画布（`run-page` 占满，从侧栏运行面板入口打开） | Modal `900px × 80vh` |
| 矩阵 | 真 N×N grid：十字高亮 + 浓度色阶 + 运行光环 + sticky 表头 | **竖向列表** `.matrix-row`（会话清单，无矩阵） |
| 交互 | hover 十字聚焦 + `mx-tip` 富 tooltip；点格进会话/pair 只读 | 点行 `toggleExpand` 内联展开只读历史 |
| 运行中 | 矩阵格内红点光环 + 侧栏面板软中断 | `running-panel` 内联 + 软中断按钮 |
| 群面 | 群×Agent 参与证据格 | `group-row` 列表 |
| 时间范围 | 6 档 range-toggle（对数归一浓度） | 无 |
| 令牌 | **OLD**（`--color-*` + `html.dark` 硬编码） | **NEW**（`--bg-*`/`--text-*`/`--line`/`--r-*`） |

### E. 迁移落点建议

1. **矩阵大画布是 src 独有重资产**，preview 的列表式是明确的 C 档缩水，不必强行对齐 N² grid。若要「观感对齐」，优先移植可复用的**视觉语言**：格子 `border-radius:10px` + 内描边 `inset 0 0 0 1px`、hover 主色 2px 描边、浓度色阶 `color-mix` 5 档、运行光环（白主弧 + accent 副弧旋转 SVG）。
2. **令牌必须洗**：src 本文件所有 `--color-*` + `html.dark #11151d / #1e2530 / #1c222e` 应替换为 `--bg-base` / `--bg-hover` / `--bg-raised`，`--color-primary`→`--primary`，`--color-bg-subtle`→`--bg-hover`，`--color-border-secondary`→`--line`。这是与 preview 观感一致的第一前提。
3. **tooltip 形态**（`.mx-tip`：fixed、270px、r-lg 圆角、tip-k 左标签列 + tip-v 值列、`tabular-nums`）可直接作为 preview 会话列表的 hover 富提示模板，替代当前「点开才看」的 expand 交互（可选）。

---

## 3. `components/RunTrackingPanel.vue` —— 运行树侧栏

### A. DOM 结构树

```
div.runs-panel                                   （侧栏第三面板，border-right，z-index:210）
├─ div.panel-toolbar                             （标题栏，对齐 SessionList ws-toolbar）
│  ├─ span.toolbar-label「运行跟踪」
│  └─ div.toolbar-actions → button.mobile-close-btn（移动端关闭）
├─ div.load-error
└─ div.tree-scroll                               （flex:1，overflow-y auto，padding var(--space-xs)）
   ├─ div.tree-node.action(.active)              （运行总览 = 矩阵入口）
   │  ├─ span.node-icon.kind-overview            （activity 图标）
   │  ├─ span.node-name
   │  ├─ span.node-badge                         （红色计数徽章）
   │  └─ span.node-action-icon                   （chevron-right / x）
   ├─ div.tree-node                              （运行中）
   │  ├─ span.node-icon（chevron）+ span.node-icon.kind-running（zap）+ span.node-name + span.node-badge
   │  └─ div.node-children
   │     ├─ div.tree-leaf.run(.jumpable) ×N
   │     │  ├─ div.leaf-avatar → StarAvatar(15, running)
   │     │  ├─ span.leaf-name
   │     │  ├─ span.leaf-dur                      （时长 tabular-nums）
   │     │  └─ button.leaf-stop                   （中断，hover 浮现）
   │     └─ div.tree-leaf.stat.dim-leaf          （"没有正在运行的会话"）
   └─ div.tree-node                              （活跃子Agent）
      ├─ span.node-icon + span.node-icon.kind-sub（bot）+ span.node-name + span.node-badge
      └─ div.node-children → div.tree-leaf ×N / .dim-leaf
```

### B. 布局规格

- **面板**：`.runs-panel{flex:1; border-right:1px solid var(--color-border-secondary); z-index:210; flex-direction:column}`；`html.dark` 下 `background:var(--bg-deep,#0a0d14)`。
- **标题栏**：`.panel-toolbar` `padding:10px 14px 6px`；`.toolbar-label` 12px 600，`letter-spacing:.5px`，`--color-text-tertiary`。
- **树节点**：`.tree-node` 高 **30px**，`padding:0 8px`，`margin-bottom:var(--space-xs)`，`border-radius:var(--radius-md)`，`gap:6px`，`border:1px solid transparent`；hover `--role-hover-bg` + border + `box-shadow:0 1px 3px rgba(0,0,0,.05)`。
- **叶节点**：`.tree-leaf` 高 30px，`padding:0 8px 0 28px`（28px 缩进），`gap:8px`。
- **徽章**：`.node-badge` `min-width:16px; height:16px; border-radius:999px; background:#ef4444; color:#fff; font-size:10px`。
- **中断按钮**：`.leaf-stop` 20×20，`border-radius:5px`，`opacity:0`，hover 行浮现（`.tree-leaf:hover .leaf-stop{opacity:1}`），hover `background:rgba(231,76,60,.1)`。
- **移动端**：`position:fixed; width:min(280px,80vw); translateX(-100%)`，`.sidebar-mobile-visible` 展开，`box-shadow:2px 0 16px rgba(0,0,0,.15)`。

### C. 关键 CSS 规则提炼（OLD 令牌）

| 选择器 | 声明要点 | 令牌 |
| --- | --- | --- |
| `.runs-panel` | 侧栏底 + border-right | `--color-bg-surface` + `html.dark → --bg-deep` |
| `.tree-node` / `.tree-leaf` | 30px 行高 + `--radius-md` 圆角 + hover 浮起 | `--role-hover-bg` / `--color-border-secondary` |
| `.node-badge` | 红底白字计数 | `#ef4444`（硬编码） |
| `.node-icon.kind-overview/.action` | 主色强调 | `--color-primary` |
| `.node-icon.kind-running` | 运行中黄 | `#f59e0b` |
| `.node-icon.kind-sub` | 子 Agent 紫 | `#8b5cf6` |
| `.tree-node.action.active` | 选中态 | `--role-selected-bg` |
| `.leaf-stop` | 中断按钮 hover 浮现 | `#e74c3c` |

### D. 与 preview 对应物差异

- preview **没有独立运行树侧栏组件**；运行树语义被收编进 `RunTrackingView.vue` 的 `running-panel`（`.section-title` + `.running-row` 列表 + 软中断按钮）。
- src 的树形态（30px 行高 + 缩进 + 红色 badge + hover 浮起 + 移动端抽屉）对齐的是 src 的 SessionList，属「侧栏工作区树」统一语言。
- 令牌：src 本文件 OLD；preview 收编后的 running-panel 用 NEW。

### E. 迁移落点建议

- 若 preview 需要在侧栏（而非 Modal 内）挂运行树，直接沿用 `.tree-node` / `.tree-leaf` 的 30px 行高 + `padding-left:28px` 缩进 + `.node-badge` 红徽章规格即可；令牌替换为 `--role-hover-bg` / `--role-selected-bg` / `--line` / `--r-md`。
- 中断按钮的「hover 浮现」模式（`opacity:0 → 1`）与红色 hover 底是通用语言，可复用到 preview 的 running-row。

---

## 4. `components/PairDialogView.vue` —— pair 只读视角

### A. DOM 结构树

```
div.chat-view                                    （flex column，占满主区）
├─ div.chat-header                               （h=layout-header-height，border-bottom，backdrop blur，z-index:100）
│  ├─ button.back-btn（arrow-left 20）
│  └─ div.header-info → div.pair-title
│     ├─ div.pair-avatars（Avatar/span.ep-ic 26 + span.pair-x「×」+ Avatar/span.ep-ic）
│     ├─ span.agent-label「A × B」                （15px 600）
│     └─ span.pair-sub「只读 · 双方视角」           （11px）
└─ div.chat-body → div.chat-main → div.messages-wrapper
   ├─ div.messages-container(@scroll) → div.messages-content
   │  ├─ div.empty-state（svg + p「这两个对象之间暂无会话记录」）
   │  ├─ div.history-loading（span.history-spinner + span.history-loading-text）
   │  └─ template: div.time-separator / div.event-separator / div.error-separator / <TurnDisplayItem :show-actions=false>
   └─ Transition[name=scroll-btn] → button.scroll-to-bottom-btn（40×40 圆，底部悬浮）
```

### B. 布局规格

- **头部**：`.chat-header` 高 `var(--layout-header-height)`，`padding:0 16px`，`gap:10px`，`border-bottom`，`backdrop-filter:blur(8px)`，`z-index:100`。
- **消息区**：`.messages-container` `height:100%; overflow-y:auto; padding:var(--space-md)`；`.messages-content` `gap:var(--space-sm); max-width:100%`。
- **分隔线**：`.event-separator` / `.error-separator` `max-width:720px; margin:4px auto; padding-left/right:42px`。
- **回到底部**：`.scroll-to-bottom-btn` 40×40，`bottom:12px; right:16px`，`border-radius:50%`，`box-shadow:0 2px 8px rgba(0,0,0,.12)`，`z-index:50`。
- **滚动条**：`.messages-container` 6px，thumb `--color-border-primary` hover `--color-primary`。

### C. 关键 CSS 规则提炼（OLD 令牌）

| 选择器 | 声明要点 | 令牌 |
| --- | --- | --- |
| `.chat-view` | 主区底 | `--color-bg-page` |
| `.chat-header` | 头部 + blur | `--color-border-secondary` / `--color-bg-page` |
| `.back-btn` | 返回钮 hover | `--color-bg-surface` / `--color-text-primary` |
| `.ep-ic` | system 端点圆标 26×26 | `#f59e0b` + `rgba(245,158,11,.15)` |
| `.time-separator-text` | 12px 灰 | `--color-text-muted` |
| `.error-separator-text` | 红字 | `--color-error` |
| `.scroll-to-bottom-btn` | 圆形悬浮 | `--color-border-primary` / `--color-bg-page` |

### D. 与 preview 对应物差异

- preview **无独立 PairDialogView**；pair 只读语义被收编进 `RunTrackingView` 的 `expand-area`（`.readonly-record` + `.readonly-body` 内联卡片）。
- src 复用 DialogView 完整消息管线（`messages-container` / `time-separator` / `event-separator` / `error-separator` / `TurnDisplayItem` / `useChatShell` 滚动外壳），两端点全左气泡（`settingsAgentId = viewer`）。

### E. 迁移落点建议

- preview 若需要「任意会话 pair 只读视角」，把 `expand-area` 升级为 src 的 `.chat-view` 消息区骨架即可：头部双头像 `pair-title` + `messages-container` + 分隔线三类（time/event/error）+ `scroll-to-bottom-btn`。
- 令牌同样需从 `--color-*` 洗成 NEW（`--color-bg-page`→`--bg-base`、`--color-border-secondary`→`--line`、`--color-error`→`--err` 等）；`ep-ic` / `scroll-to-bottom-btn` 的 rgba 阴影保留为硬编码即可。

---

## 5. `components/CreateGroupDialog.vue` —— 建群弹窗

### A. DOM 结构树

```
<Modal :width="420">                              （无 title，自绘头部）
└─ div.dialog                                    （max-height:80vh，flex column，overflow hidden）
   ├─ div.dialog-header                           （padding 16px 20px，border-bottom）
   │  ├─ h3「创建群聊群组」                          （16px）
   │  └─ button.close-btn（×，28×28）
   ├─ div.dialog-body                             （flex:1，overflow-y auto，padding 20px，gap 16px）
   │  ├─ div.form-group ×3（群组ID/名称/描述 → label + input.form-input）
   │  ├─ div.form-group（选择参与者）
   │  │  ├─ div.section-label → span.label-text + span.label-badge（已选 N）
   │  │  ├─ div.participant-list（max-height:300px，overflow scroll）
   │  │  │  └─ label.participant-item(.selected) ×N
   │  │  │     ├─ div.participant-check（check-icon / unchecked svg 圆）
   │  │  │     ├─ div.participant-avatar（32×32 img / 首字母）
   │  │  │     ├─ div.participant-info（span.participant-name + span.participant-id）
   │  │  │     └─ input.hidden-checkbox
   │  │  └─ div.loading-hint（3 个 .loading-dot + .loading-text）
   │  └─ div.error（红底提示）
   └─ div.dialog-footer                           （padding 14px 20px，border-top，justify-end）
      ├─ button.btn-cancel「取消」
      └─ button.btn-create「创建群组」
```

### B. 布局规格

- **外壳**：Modal `width:420`（无 title → 组件内部自绘 `.dialog-header`）。
- **头部**：`.dialog-header` `padding:16px 20px`，h3 16px；`.close-btn` 28×28 `border-radius:4px`。
- **body**：`padding:20px`，`gap:16px`，`overflow-y:auto`。
- **参与者列表**：`.participant-list` `max-height:300px`，`overflow-y:scroll`，`border:1px solid`，`border-radius:8px`；`.participant-item` `padding:7px 10px`，`gap:8px`，底部 1px 分隔（`::after`）。
- **选中态**：`.participant-item.selected{background:rgba(79,70,229,.08)}`（硬编码 indigo）；头像 `.participant-avatar` 32×32 `border-radius:6px`。
- **footer**：`padding:14px 20px`，`gap:8px`；主按钮 `.btn-create` `padding:7px 20px`，`border-radius:6px`，`background:var(--color-primary)`。

### C. 关键 CSS 规则提炼（OLD 令牌 + 硬编码）

| 选择器 | 声明要点 | 令牌 / 硬编码 |
| --- | --- | --- |
| `.dialog-header h3` | 16px 标题 | `--color-text-primary` |
| `.form-input` | `border:1px solid; border-radius:6px; background:transparent; font-size:13px`，focus 主色描边 | `--color-border-secondary` / `--color-primary` |
| `.label-badge` | 主色徽章 | `--color-primary` + `rgba(79,70,229,.12)` |
| `.participant-item.selected` | 选中底 | `rgba(79,70,229,.08/.12)`（硬编码 indigo） |
| `.participant-avatar` | 32×32 圆角头像 | `--color-primary` / `--color-primary-light` |
| `.btn-create` | 主色实底 | `--color-primary` |
| `.loading-dot` | 3 点加载动画 | `rgba(255,255,255,.3)` |

### D. 与 preview 对应物差异清单（vs `components/CreateGroupDialog.vue`）

| 维度 | src CreateGroupDialog | preview CreateGroupDialog |
| --- | --- | --- |
| 外壳 | Modal `width:420`，**自绘** `.dialog-header/.dialog-body/.dialog-footer` | Modal `title="创建群组"`，body 直排 + `.form-footer` |
| 字段 | 群组 ID（可选）/ 名称 / 描述 | 名称 / 描述（无 ID） |
| 参与者 | 头像 32×32 + name + id 双行；圆形 check-icon svg | 圆形 `.check-box` ✓；name + description/model 副行 |
| 加载态 | `.loading-dot` 三点动画 | 无 |
| 主按钮 | `.btn-create` 独立类 | `.btn.primary` |
| 令牌 | OLD（`--color-*`） | OLD（`--color-*`，同样未 token 化） |

### E. 迁移落点建议

- 两个实现**令牌都停留在 OLD 层**，是"半斤八两"——对齐时统一洗成 NEW 即可（`.form-input` 用 `--input-bg/--input-border/--input-focus`，`.label-badge`/`.btn-create` 用 `--primary`/`--primary-light`）。
- 结构上 preview 用 `Modal title` + 直排 body 更简洁，src 的自绘 header 是历史包袱（`Modal` 已支持 title），建议 preview 保持现状、不引入自绘 header；仅吸收 src 的 `.section-label` + `.label-badge`（「已选 N」计数）与 `.participant-item` 的底部分隔线语言。

---

## 6. `components/VersionDialog.vue` —— 版本弹窗

### A. DOM 结构树

```
<Transition name="modal">
└─ div.version-overlay                            （fixed inset:0，z-index:1001，bg rgba(0,0,0,.3)）
   └─ div.version-panel                           （width:700，max-width:90vw，max-height:80vh，radius:10）
      ├─ div.panel-header                          （padding 12px 18px，border-bottom）
      │  ├─ h3「版本信息」                           （15px 600）
      │  └─ button.close-btn（×）
      └─ div.panel-body                            （flex:1，overflow-y auto，padding 20px）
         ├─ div.status-msg(.error)                 （检查中 / 错误）
         └─ template
            ├─ div.version-compare                  （当前 → 最新 对比卡）
            │  ├─ div.version-card(.highlight) → div.vc-label + div.vc-version
            │  ├─ div.version-arrow「→」
            │  └─ div.version-card.latest → div.vc-label + div.vc-version
            ├─ div.version-status.update/.current   （新版本可用 / 已是最新）
            ├─ div.version-actions → a.version-btn.secondary「查看 Release」
            ├─ div.version-update-msg
            └─ details.version-changelog[open] → summary + div.markdown-body
```

### B. 布局规格

- **遮罩**：`.version-overlay` fixed，`z-index:1001`（**高于 settings 面板的 1000**），`background:rgba(0,0,0,.3)`。
- **面板**：`width:700px`，`max-width:90vw`，`max-height:80vh`，`border-radius:10px`（**硬编码 10，非 `--r-lg` 12**），`box-shadow:0 8px 32px rgba(0,0,0,.12)`。
- **对比卡**：`.version-compare` `justify-content:center; gap:16px`；`.version-card` `min-width:100px`，`padding:12px 18px`，`border-radius:8px`，`border:2px solid transparent`；`.latest` `border-color:var(--color-primary)` + `background:var(--color-primary-light)`。
- **状态条**：`.version-status` `border-radius:6px`，`padding:8px 12px`；`.update` 用硬编码 `#fef3c7/#92400e`（琥珀），`.current` 用 `#ecfdf5/#065f46`（绿）。
- **changelog**：`.markdown-body` `max-height:300px; overflow-y:auto`。
- **过渡**：`.modal-*` `scale(0.95)` 进出场 0.2s。

### C. 关键 CSS 规则提炼（OLD 令牌 + 硬编码状态色）

| 选择器 | 声明要点 | 令牌 / 硬编码 |
| --- | --- | --- |
| `.version-overlay` | 全屏遮罩 z1001 | `rgba(0,0,0,.3)` |
| `.version-panel` | 700px 面板 radius 10 | `--color-bg-page` / `--color-border-secondary` |
| `.version-card.latest` | 最新版本主色描边 | `--color-primary` / `--color-primary-light` |
| `.version-status.update` | 琥珀状态条 | `#fef3c7` / `#92400e`（硬编码） |
| `.version-status.current` | 绿状态条 | `#ecfdf5` / `#065f46`（硬编码） |
| `.version-btn.primary` | 主色实底按钮 | `--color-primary` |

### D. 与 preview 对应物差异清单（vs `views/SystemPanel.vue` 的版本 section）

| 维度 | src VersionDialog | preview SystemPanel |
| --- | --- | --- |
| 载体 | 独立自定义 overlay 弹窗（700px，z1001） | `views/SystemPanel` 的 Modal 640×70vh 内「版本」section |
| 内容 | 当前/最新双卡对比 + npm 检查 + 更新 + changelog | 单行 `version-row`（名称 + v当前），**无更新检查**（C 档显式缩水） |
| 状态色 | 硬编码琥珀/绿状态条 | 无 |
| 令牌 | OLD | NEW |

### E. 迁移落点建议

- preview 已明确缩水（无 npm 检查/自更新，更新走 supervisor 进程层），**不必恢复对比卡**。
- 但 src 的 `.version-compare`（双卡 + `→` 箭头 + 主色 latest 描边）与状态条（`#fef3c7/#92400e` 更新、`#ecfdf5/#065f46` 最新）是可复用的**视觉组件**；若 preview 日后要展示"当前 vs 最新"，应把这些硬编码状态色 token 化（`--warn` 系 / `--ok` 系）后再用。

---

## 7. `components/WorkspaceTree.vue` + `WorkspaceTreeNode.vue` —— 工作区树

### A. DOM 结构树

```
div.workspace-tree                               （右栏，width:280，border-left）
├─ div.wt-header                                 （h=layout-header-height，padding 0 12px，border-bottom）
│  ├─ span.wt-title（folder svg + "工作区"）
│  └─ button.wt-close（28×28）
├─ div.wt-loading / div.wt-error
└─ div.wt-body                                   （padding 8px 6px，overflow-y auto）
   └─ <WorkspaceTreeNode> ×N                     （递归）
```
`WorkspaceTreeNode`（递归）：
```
div.wtn-node
├─ div.wtn-row.wtn-dir（span.wtn-arrow[open] + span.wtn-icon folder + span.wtn-name）
│  └─ div.wtn-children（margin-left:14px，border-left guide line，padding-left:4px）→ 递归
├─ div.wtn-row.wtn-file(.active)（span.wtn-arrow + span.wtn-icon[按扩展名着色] + span.wtn-name + span.wtn-size）
└─ div.wtn-row.wtn-more（"加载失败" 占位）
```

### B. 布局规格

- **面板**：`.workspace-tree` `width:280px; flex-shrink:0; height:100%`，`border-left:1px solid`（右栏），`background:var(--color-bg-surface)`。
- **头部**：`.wt-header` 高 `var(--layout-header-height,48px)`，`padding:0 12px`。
- **节点行**：`.wtn-row` `padding:3px 6px; border-radius:4px; gap:4px; white-space:nowrap`。
- **缩进**：`.wtn-children` `margin-left:14px; border-left:1px solid; padding-left:4px`（guide line 缩进）。
- **箭头**：`.wtn-arrow` 12px，open `rotate(90deg)`，过渡 0.15s。
- **小屏**：`position:fixed; right:0; top:0; bottom:0; z-index:130; box-shadow:-2px 0 16px rgba(0,0,0,.15)`。

### C. 关键 CSS 规则提炼（OLD 令牌 + 硬编码文件色）

| 选择器 | 声明要点 | 令牌 / 硬编码 |
| --- | --- | --- |
| `.workspace-tree` | 280px 右栏 | `--color-bg-surface` / `--color-border-secondary` |
| `.wtn-row` | `padding:3px 6px; border-radius:4px` | — |
| `.wtn-row.active` | 选中态 | `--color-primary-light` |
| `.wtn-children` | guide line 缩进 | `--color-border-secondary` |
| `.wtn-icon`（文件色） | 按扩展名 | 硬编码 `#4a90d9`(code) `#2ea44f`(term) `#a855f7`(img) `#d97706`(archive) `#e6a817`(json) `#0ea5e9`(md) |

### D. 与 preview 对应物差异

- preview **无 WorkspaceTree 对应物**（不在本任务列出的 preview 对照物中；preview 有 `views/FilePreviewModal.vue` 但无目录树面板）。属 src 独有形态。

### E. 迁移落点建议

- 若 preview 需要工作区目录树，可整体移植：280px 右栏 + 递归节点 + `margin-left:14px` guide line 缩进 + 12px 箭头旋转 + 按扩展名的文件图标配色（建议把 `getFileIcon` 的硬编码色值收敛为语义令牌，如 code=`--primary`、term=`--ok`、img=`--accent` 等，避免跨主题失真）。
- 令牌从 `--color-*` 洗成 NEW。

---

## 8. `settings/components/SettingsPanel.vue` —— 设置面板壳

> 注意：任务清单写作 `settings/SettingsPanel.vue`，实际路径为 `src/ui/webui/src/settings/components/SettingsPanel.vue`。本文件**只提炼布局与样式，不提炼状态逻辑**。

### A. DOM 结构树

```
<Transition name="modal">
└─ div.sp-overlay                                （fixed inset:0，z-index:1000，bg rgba(0,0,0,.4)）
   └─ div.sp-panel                               （82vw max1100px × 82vh max88vh，radius r-lg，shadow-panel）
      ├─ div.sp-header                           （padding 9px 16px，border-bottom）
      │  ├─ span.sp-accent                       （4×14 主色竖条，签名元素）
      │  ├─ h3.sp-title「设置」                    （13px 600）
      │  ├─ span.sp-subtitle                      （当前节点名，11px）
      │  ├─ span.sp-dirty-badge「● 未保存」         （--warn）
      │  └─ button.sp-close（×）
      ├─ div.sp-body                             （flex，padding:0，overflow hidden）
      │  ├─ div.sp-sidebar                       （宽 200px，border-right，padding 12px 8px，overflow-y auto）
      │  │  └─ div.sp-tree-group ×N
      │  │     ├─ div.sp-tree-cat（svg.sp-arrow[open] + span + span.sp-tree-count）   ← category（当前树未用）
      │  │     └─ div.sp-tree-leaf(.sp-root-leaf)(.active)                            ← 实际全是 leaf
      │  └─ div.sp-main                          （flex:1，overflow-y auto）
      │     ├─ div.sp-status                      （加载中）
      │     └─ 内容分支（AgentListPane / AgentPane / PoolManager / ExtToolsPane / PluginLibraryPane / NsFieldList / g-timer / plugin-settings-tab）
      ├─ div.sp-footer                           （padding 9px 16px，border-top）
      │  ├─ div.sp-footer-left
      │  │  ├─ span.sp-error / span.sp-success / span.sp-hint
      │  │  └─ button.sp-restart-minor「重启后端」   （11px 低调钮，hover --role-active-bg + --warn）
      │  └─ div.sp-footer-actions → Button[ghost 关闭] + Button[primary 保存配置]
      ├─ <Modal :width="440" :z-index="1200">     （定时任务编辑弹窗；.sp-modal-body → .sp-field/.sp-input/.sp-textarea）
      └─ <ConfirmDialog ref>                       （未保存/重启确认）
```

### B. 布局规格

- **遮罩/面板**：`.sp-overlay` fixed，`z-index:1000`，`background:rgba(0,0,0,.4)`；`.sp-panel` `width:82vw; max-width:1100px; height:82vh; max-height:88vh`，`border-radius:var(--r-lg)`，`border:1px solid var(--line)`，`box-shadow:var(--shadow-panel)`。
- **头部**：`.sp-header` `padding:9px 16px`，`gap:10px`；`.sp-accent` **4×14 主色竖条**（`width:4px; height:14px; border-radius:2px; background:var(--primary)`）。
- **左侧树**：`.sp-sidebar` **宽 200px**，`border-right:1px solid var(--line)`，`padding:12px 8px`；`.sp-tree-cat` 13px 600，`.sp-arrow` open `rotate(90deg)` + `filter:drop-shadow(0 0 2px var(--primary))`；`.sp-tree-count` `--bg-hover` 圆角计数；`.sp-tree-leaf` `padding:6px 10px 6px 24px`（根叶 10px），`border-radius:var(--r-md)`，active `background:var(--primary-light)` + `color:var(--primary)` + `border-color:color-mix(in srgb,var(--primary) 45%,transparent)`。
- **右侧内容**：`.sp-main` `flex:1; overflow-y:auto`；`.sp-main > *{padding:12px 16px}`（统一内容内边距）。
- **底部栏**：`.sp-footer` `padding:9px 16px`，`border-top:1px solid var(--line)`，左右分布；`.sp-footer-left` 左对齐状态文案（error/success/hint）+ `.sp-restart-minor`（11px，hover 黄底 `--role-active-bg` + `--warn`）；`.sp-footer-actions` 右对齐 `Button[ghost/primary]`。
- **内层弹窗**：定时任务编辑用 `ui/Modal`，`z-index:1200`（高于面板 1000）。
- **过渡**：`.modal-enter-from .sp-panel{transform:scale(.96) translateY(8px)}`。

### C. 关键 CSS 规则提炼（**NEW 令牌**）

| 选择器 | 声明要点 | 令牌 |
| --- | --- | --- |
| `.sp-panel` | 82vw/1100 × 82vh/88vh，r-lg 圆角，面板阴影 | `--bg-raised` / `--line` / `--r-lg` / `--shadow-panel` |
| `.sp-accent` | 4×14 主色竖条 | `--primary` |
| `.sp-sidebar` | 200px 导航树 | `--line` |
| `.sp-tree-leaf.active` | 选中态主色底 + 半透明描边 | `--primary-light` / `--primary` + `color-mix` |
| `.sp-footer` | 底部栏 | `--line` |
| `.sp-restart-minor:hover` | 黄底重启钮 | `--role-active-bg` / `--warn` |
| `.sp-input / .sp-textarea` | 输入框 | `--input-bg` / `--input-border` / `--input-focus` |
| `.sp-status` | 加载占位 | `--text-3` |

### D. 与 preview 对应物差异清单（vs `views/SettingsPanel.vue`）

| 维度 | src SettingsPanel（settings/components/） | preview views/SettingsPanel |
| --- | --- | --- |
| 壳 | **自绘 overlay**（`.sp-overlay/.sp-panel`，82vw×82vh，z1000） | **ui/Modal**（`960px × 78vh`，z600） |
| 头部 | accent 竖条 + 标题 + 副标题 + dirty-badge，内嵌在面板 | Modal title + 主区内 `.settings-head`（标题 + head-dirty） |
| 导航 | `.sp-sidebar` **200px** 树（category 折叠 + count 徽章 + leaf 缩进 24px） | `.settings-nav` **208px** 扁平（emoji 图标 + label + dirty ●） |
| 底部 | 左状态区（error/success/hint + 重启后端 minor）+ 右 `Button`（关闭/保存配置） | footer-flash + 自绘 `.btn`（重启后端/关闭），**无保存按钮**（保存内移到各 pane） |
| 保存 | 壳级「保存配置」统一按钮 | AgentPane 内独立保存 |
| 令牌 | NEW | NEW |

### E. 迁移落点建议

1. **两者令牌层都已对齐 NEW**，观感差异集中在「壳形态」：src 是大面板（82vw）+ accent 条 + 树形导航；preview 是 960 Modal + 扁平导航。若 preview 要对齐 src，最经济的是**保留 Modal 承载**，但补两处签名视觉——① 头部加 4×14 `--primary` accent 竖条；② 导航宽度对齐（200 vs 208 已接近，可统一为 200）。
2. **树形导航**（category + count + 缩进 leaf）是 src 特有结构，preview 当前扁平列表更简单；若不需要多级分组，保持扁平即可，仅需把 `.nav-item.active` 从纯底色升级为「`--primary-light` 底 + `color-mix` 半透明描边」（src `.sp-tree-leaf.active` 的语言），提升选中态辨识度。
3. **底部栏**：src 的「左状态文案 + 右按钮」布局值得移植到 preview 的 `.settings-footer`（preview 已是该结构，仅按钮实现自绘 `.btn`，建议统一为 `ui/Button`）。

---

## 9. `settings/components/AgentPane.vue` —— 五页签 + 页签条

### A. DOM 结构树

```
div.agent-pane                                   （flex column，gap 12px，height 100%）
├─ div.agent-nav                                 （顶部导航，flex wrap）
│  ├─ button.agent-nav-back「← 返回 Agent 列表」    （11px）
│  ├─ span.agent-nav-name                        （14px 600）
│  ├─ span.agent-nav-id                          （11px mono）
│  ├─ div.agent-nav-spacer
│  └─ button.agent-nav-btn ×2（上一个 / 下一个）
├─ div.agent-tabs                                （border-bottom，下划线式）
│  └─ button.agent-tab ×5（基本信息/模型/定时任务/安全/扩展与工具）+ 动态插件页签
├─ div.agent-tab-body                            （flex:1，overflow-y auto）
│  ├─ div.agent-info > div.info-grid > div.info-item ×4
│  │  ├─ .info-identity（头像 56×56 + identity-fields + avatar-remove-x）
│  │  ├─ 能力标签（tag-badges → tag-badge + tag-custom → tag-chips）
│  │  ├─ SYSTEM.md（info-toggle + info-textarea.code rows=11）
│  │  └─ AGENT.md（同上）
│  ├─ div.llm-pane > div.llm-fields
│  │  └─ div.llm-item(.is-non-default) ×N（pool select + llm-group-title 分组 + SettingField + llm-models-btn + llm-reset + llm-effective 摘要条）
│  ├─ <TimerPane>
│  ├─ div.agent-sec > div.info-grid > div.info-item（路径白名单 textarea）
│  ├─ div.ext-pane（ExtToolsPane mode=agent）
│  └─ div.agent-plugin-tab（动态插件页签）
```

### B. 布局规格

- **容器**：`.agent-pane` `gap:12px; height:100%; min-height:0; overflow:hidden`；`.agent-tab-body` `flex:1; min-height:0; overflow-y:auto`（导航/页签固定，仅内容滚）。
- **页签条（下划线式）**：`.agent-tabs{display:flex; gap:2px; border-bottom:1px solid var(--line)}`；`.agent-tab{padding:8px 16px; border:none; border-bottom:2px solid transparent; margin-bottom:-1px}`；hover `--bg-hover` + 上圆角 `border-radius:var(--r-sm) var(--r-sm) 0 0`；active `color:var(--primary); border-bottom-color:var(--primary); font-weight:500`。
- **基本信息**：`.info-grid` 纵向 `gap:2px`；`.info-item{padding:9px 12px; border-bottom:1px solid var(--line); gap:6px}`；`.info-label` 13px 500；`.info-desc` 11px `--text-3`。
- **头像**：`.avatar-preview` **56×56**，`border-radius:var(--r-md)`，底 `--primary-light`；`.avatar-remove-x` 16×16，`top:-5px; right:-5px`，hover 浮现；`.info-identity` 横向布局 `gap:16px`。
- **能力标签**：`.tag-badge` `padding:2px 9px; border-radius:var(--r-full); font-size:11px`，on 态 `--primary-light` 底 + `--primary` 字。
- **模型页**：`.llm-item{padding:8px 12px; border-bottom:1px solid var(--line); border-left:3px solid transparent}`，`.is-non-default{border-left-color:var(--primary)}`（继承/覆盖竖线）；`.llm-group-title{margin-top:8px; padding:4px 0 4px 10px; border-left:3px solid var(--primary)}`；`.llm-effective` 摘要条 `background:var(--primary-light)` + `border:1px solid color-mix(in srgb,var(--primary) 30%,transparent)`；`.llm-source.is-override/.is-inherit` 来源徽章（主色底/灰底）。
- **输入框**：`.info-input/.info-textarea` `--input-bg/--input-border/--input-focus`，focus `box-shadow:0 0 0 3px var(--primary-light)`。
- **旧契约横幅**：`.ext-legacy-banner` `color-mix(in srgb, var(--warn) 10%/45%, transparent)`。

### C. 关键 CSS 规则提炼（**NEW 令牌**）

| 选择器 | 声明要点 | 令牌 |
| --- | --- | --- |
| `.agent-tabs` / `.agent-tab` | 下划线页签条 | `--line` / `--text-2` / `--primary` / `--bg-hover` |
| `.info-item` | 字段行 + 底分隔线 | `--line` |
| `.avatar-preview` | 56×56 头像 | `--r-md` / `--primary-light` |
| `.tag-badge.on` | 徽章选中态 | `--primary-light` / `--primary` / `--r-full` |
| `.llm-group-title` | 分组左竖线 | `--primary` |
| `.llm-item.is-non-default` | 覆盖字段左竖线 | `--primary` |
| `.llm-effective` | 生效摘要条 | `--primary-light` + `color-mix` |
| `.info-input:focus` | 聚焦光晕 | `--input-focus` / `--primary-light` |
| `.ext-legacy-banner` | 迁移横幅 | `--warn` / `--err` + `color-mix` |

### D. 与 preview 对应物差异清单（vs `settings/components/AgentPane.vue`）

| 维度 | src AgentPane | preview AgentPane |
| --- | --- | --- |
| 页签文案 | 基本信息 / 模型 / 定时任务 / 安全 / 扩展与工具 | 信息 / 模型 / 定时 / 安全 / 扩展工具（语义同，措辞略差） |
| 顶部导航 | `agent-nav`（返回 + name + id + **上一个/下一个切换**） | `agent-head`（返回 + title + dirty + **保存 + 删除**） |
| 页签 active 字重 | `font-weight:500` | `font-weight:600` |
| 页签 padding | `8px 16px` | `var(--space-2) var(--space-3)`（8px 12px） |
| 基本信息 | 头像上传 + 能力标签徽章 + SYSTEM.md/AGENT.md（11 行） | 表单（model/provider/描述/maxSteps/virtual/system/hooks JSON）+ AGENT.md 文档 + 凭据 + prompt 预览 |
| 模型页 | schema 驱动 + pool select + effective 摘要条 + 继承/覆盖徽章 + 读取模型 + reset | 硬编码 `field-grid` 2 列 + `llm-group` + `details.advanced` |
| 安全页 | 路径白名单 textarea | 能力门禁 `tools-table` |
| 令牌 | NEW | NEW |

### E. 迁移落点建议

1. **页签条已同构**（下划线式 + `border-bottom:2px` + active 主色），只需统一两个数值：active 字重（500 vs 600）与 padding（`8px 16px` vs `8px 12px`）；建议以 src 为准（16px 横向更透气）。
2. **顶部导航形态不同**：src 是「prev/next 切换 + 返回」的列表导航语义，preview 是「返回 + 保存 + 删除」的单体编辑语义。两者功能目标不同（src 从 AgentList 进入、preview 从 AgentList 进入但带保存删除），**不建议强行对齐**；仅建议把 src 的 `.agent-nav-name`（14px 600）+ `.agent-nav-id`（11px mono）标题排版吸收进 preview 的 `.agent-title`。
3. **模型页的「继承/覆盖」视觉语言**（`.llm-item` 左侧 3px 主色竖线 + `.llm-source` 徽章 + `.llm-effective` 摘要条）是 src 的签名细节，preview 当前硬编码表单缺这套表达；若要对齐，可移植 `.llm-group-title`（左竖线分组标题）与 source 徽章两段 CSS（依赖 `color-mix` 与 `--primary-light`）。

---

## 10. `settings/components/ConfirmDialog.vue` —— 确认弹窗形态

### A. DOM 结构树

```
<Modal :title="state?.title" :width="440" :z-index="1200">
├─ div.cd-body → div.cd-msg                   （body 内距 14px 20px）
└─ #footer → Button[ghost 取消] + Button[primary|danger 确认]
```

### B. 布局规格

- **外壳**：`ui/Modal`，`width:440`，`z-index:1200`（高于设置面板 1000）。
- **body**：`.cd-body{padding:14px 20px}`；`.cd-msg{font-size:13px; line-height:1.6; color:var(--text-1); white-space:pre-line}`。
- **按钮**：`Button[ghost]` 取消 + `Button[primary]/[danger]` 确认（危险操作主按钮转红）。

### C. 关键 CSS 规则提炼（**NEW 令牌**）

| 选择器 | 声明要点 | 令牌 |
| --- | --- | --- |
| `.cd-body` | `padding:14px 20px` | — |
| `.cd-msg` | 13px 消息 | `--text-1` |

### D. 与 preview 对应物差异清单（vs `settings/components/ConfirmDialog.vue`）

| 维度 | src ConfirmDialog | preview ConfirmDialog |
| --- | --- | --- |
| API | **命令式** `ask(): Promise<boolean>`（ref 驱动） | **声明式** props（visible/message/confirm-text/danger/busy/zIndex） |
| 按钮 | `ui/Button`（ghost/primary/danger） | 自绘 `.btn`（`.primary`=accent 粉、`.danger-solid`=err 红） |
| z-index | 硬编码 1200 | `zIndex` prop，缺省 1200 |
| 宽度 | `440`（number） | `440px`（string） |
| 主按钮危险色 | `Button[danger]` = err 14% 底 | `.danger-solid` = err 实底 |

### E. 迁移落点建议

- **形态完全一致**（Modal 440 + title + body + footer 双钮），差异只在 API 风格与按钮实现。
- preview 已迁成声明式 props（更贴合 Vue 组件习惯），建议**保持 preview 的声明式 API**；唯一需要统一的是按钮实现——把自绘 `.btn` 换成 `ui/Button`，消除 `.primary`（accent 粉）与 `ui/Button.primary`（主色紫）的语义冲突，危险钮统一走 `Button[danger]`。

---

## 11. `ui/Modal.vue` + `ui/Tooltip.vue` —— 弹窗/提示形态

### 结论：**已完全对齐（逐字节相同）**

经比对，`src/ui/webui/src/ui/Modal.vue`、`Tooltip.vue`、`Button.vue`、`tokens.css` 与 `preview/webui/src/ui/` 下同名文件**内容一致**（含注释与空行）。preview 的「已搬」状态属实，本节无需迁移。

### 已锁定的统一形态（供其余各节引用）

- **Modal**：`.ui-modal` fixed inset:0，默认 `z-index:600`；`.ui-modal-overlay` `rgba(0,0,0,.35)`；`.ui-modal-panel` `background:var(--bg-raised)`、`border-radius:var(--r-lg)`(12px)、`border:1px solid var(--line)`、`box-shadow:var(--shadow-panel)`、`max-width:92vw; max-height:86vh`。
- **标题条**：`.ui-modal-head` `padding:10px 16px 8px`，`border-bottom:1px solid var(--line)`；标题 14px 600；`.ui-modal-close` 24×24，`border-radius:var(--r-sm)`，hover `--bg-hover`。
- **footer**：`.ui-modal-footer` `padding:8px 16px 10px`，`border-top:1px solid var(--line)`，右对齐 `gap:8px`。
- **动效**：enter/leave `opacity 0.18s var(--ease-out)`，panel `translateY(8px) scale(0.98)`。
- **Tooltip**：`.ui-tip::after` `background:var(--bg-raised)`、`border:1px solid var(--line)`、11px、`padding:4px 8px`、`border-radius:var(--r-sm)`、`box-shadow:var(--shadow-pop)`、`z-index:700`；placement top/bottom。

---

## 12. 面板层通用结论

### 12.1 弹窗 / 面板的统一形态

| 元素 | 规格 |
| --- | --- |
| 圆角 | `--r-sm 4px`（输入框/小按钮/close）、`--r-md 8px`（卡片/列表项/分段切换）、`--r-lg 12px`（Modal 面板 / settings 面板）；**注意 src 存在硬编码 10px（VersionDialog、矩阵 cell）与 6px（CreateGroupDialog 输入框/按钮），属未收敛遗留** |
| 阴影 | 面板 `--shadow-panel`，浮层/tooltip `--shadow-pop`；自绘 tooltip 常用 `0 4px 16px rgba(0,0,0,.18)` / `0 8px 28px rgba(0,0,0,.16)` 硬编码 |
| 遮罩 | Modal `rgba(0,0,0,.35)`；settings overlay `rgba(0,0,0,.4)`；VersionDialog `rgba(0,0,0,.3)`（未统一） |
| 标题条 | Modal 标准：14px 600 + `padding 10px 16px 8px` + close 24×24；src settings 增加 **accent 竖条 4×14 `--primary`**（签名元素，preview 缺）；CreateGroupDialog 自绘 16px h3（历史遗留，应弃用改 Modal title） |
| z-index 链 | `Modal 600 → Tooltip 700 → settings overlay 1000 → VersionDialog 1001 → ConfirmDialog/内层 Modal 1200 → mx-tip 10000`；WorkspaceTree 小屏 `130`，RunTrackingPanel `210` |

### 12.2 表格与图表的视觉规范

- **表格**：`border-collapse:collapse`，`font-size:12px`，行底 `1px solid var(--line)`，表头 `--text-2` 600（preview UsagePanel 用 `--color-text-secondary` 老令牌）；数值列右对齐、首列左对齐；首列（id/模型名/文件名）用 `--font-mono`。
- **图表（TokenUsage 是唯一参考基准）**：去图例、自绘 HTML tooltip（`border-radius:var(--r-md)` + `border:1px solid var(--line)` + `background:var(--bg-raised)` + 硬编码阴影）、柱顶圆角 6px、竖网格线移除仅横向、刻度 11px、数值 `tabular-nums`。preview 的 chart.js 默认图例 + 硬编码 `#7f8c8d` 轴色是**观感割裂点**，应替换为 src 的自绘 tooltip + 令牌轴色。

### 12.3 设置面板与 src 的观感差异根源（核心结论）

1. **令牌层错位（第一根因）**：src 的 `TokenUsage.vue` 与整个 `settings/**` 已 NEW 令牌；但 src 的 RunTracking / RunTrackingPanel / PairDialogView / CreateGroupDialog / VersionDialog / WorkspaceTree **仍是 OLD 令牌 + `html.dark` 硬编码底色（`#11151d`/`#0a0d14`/`#1c222e`/`#1e2530`）+ rgba 兜底**。preview 的 M17-B settings 已 NEW，但 UsagePanel / CreateGroupDialog 又残留 OLD——**两套色值来源在两轨道间交叉并存**，是「怎么看都不齐」的直接原因。对齐第一步应是**统一令牌层**，而非只搬布局。
2. **壳形态差异**：src 设置面板 = 自绘 82vw 大面板 + accent 条 + 200px 树形导航；preview = ui/Modal 960px + 208px 扁平导航。导航宽度接近（200 vs 208），但「大面板 + accent 条 + 树」与「Modal + 扁平」在整体气场上有明显落差。
3. **按钮语义冲突**：src 弹窗 footer 已统一 `ui/Button`（primary=主色紫）；preview settings 自绘 `.btn`（`.primary`=accent 粉、`.danger-solid`=err 红）。同一「主按钮」在两处语义不同，需统一到 `ui/Button`。
4. **硬编码色值未收敛**：src 的状态色（VersionDialog `#fef3c7/#92400e/#ecfdf5/#065f46`）、文件图标色（`#4a90d9` 等 6 色）、计数徽章 `#ef4444`、运行/子 Agent 图标色（`#f59e0b`/`#8b5cf6`）、loading-dot `rgba(255,255,255,.3)`、participant 选中 `rgba(79,70,229,.08)` 均未 token 化，跨主题会失真。
5. **圆角未收敛**：令牌体系是 4/8/12，但 src 残留 10px（矩阵 cell、VersionDialog panel）、6px（CreateGroupDialog 输入框/按钮），preview 若对齐应统一到 `--r-sm/md/lg` 语义。

### 12.4 建议的执行顺序

1. **先统一令牌层**：把 src 的 6 个 OLD 令牌文件与 preview 的 2 个 OLD 令牌文件全部替换为 NEW 令牌（`--color-bg-page→--bg-base`、`--color-bg-surface→--bg-raised/--bg-surface`、`--color-border-secondary→--line`、`--color-text-*→--text-*`、`--radius-*→--r-*`），删掉所有 `html.dark` 硬编码底色。
2. **再搬结构化布局**：优先搬「低成本高辨识度」的签名元素——TokenUsage 左侧 216px 栏 + 摘要进度条 + 竖向页签、settings 的 accent 竖条与树形选中态（`--primary-light` + `color-mix` 描边）、AgentPane 模型页的左竖线分组与继承/覆盖徽章、RunTracking 的浓度色阶与格子描边语言。
3. **重资产（弦图 / N² 矩阵 / 目录树）按需取舍**：preview 的排行条 / 列表 / 无树均是显式缩水，不必强搬；如需升级，优先复用视觉主题（配色、圆角、tooltip 卡片）而非整套 render 逻辑。
4. **统一按钮与 z-index**：全仓弹窗 footer 收敛到 `ui/Button`；z-index 采用「Modal 600 / 面板 1000 / 面板内弹窗 1200 / 全局 tooltip 10000」阶梯。

---

*（本文档为纯读分析产出；仅 `style-parity-panels.md` 一个输出文件，未改动任何其他文件。）*
