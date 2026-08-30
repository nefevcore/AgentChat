# M18 布局与风格全量迁移计划：src 页面观感 → preview 原生面

> 生成于 2026-08-23（M17 收官当日，用户反馈"src 轨道的布局风格样式对不上"后立项）。
> 本文是 src/ui/webui 页面布局与风格向 preview/webui 原生面**完全对齐**的迁移地图。
> **事实源 = src 全部视图源码**（唯一参考；`docs/archive/*` 归档文档不参考，用户指令）+
> `docs/m17-recon/style-parity-*.md`（本计划的三份逐视图侦察，均基于 src 实测）。

---

## 0. 一句话诊断

**地基 100% 在，观感差异全在视图层。**

- preview 的 `assets/{base,main,markdown}.css`、`ui/tokens.css` 与 src **逐字节一致**（MD5 实证）；
- preview 的 `ui/` 组件库 14 件与 src **逐字节一致**；
- 主题机制（html.dark/.light + `theme-changed` + hljs 联动 + localStorage）语义一致；
- **但**：M16 原生重写按"无面即无视图"原则重排了每个视图的 DOM 结构与 scoped CSS，
  M17 新写的视图（设置面板/运行跟踪/用量/系统面板）用的是**简化版式**。差异三根因
  （按影响排序）：① **版式**——气泡 82% vs 70%、圆角 12px vs 6px、思维链/工具卡
  卡片化 vs 裸行+竖线缩进、内容 840px 居中 vs 撑满（最大头）；② **令牌混态**——src
  内部 NEW/OLD 两套交叉并存（别名层已让两者视觉等价，但 `html.dark` 硬编码底色
  #11151d/#1e2530 等**不走令牌**，是"暗色下对不上"的直接来源）；③ **签名元素缺失**——
  accent 竖条、继承/覆盖竖线徽章、gauge 进度条、3×3 群头像、星卡选中描边等辨识度
  细节未搬。

## 1. 已完全对齐的资产（无需迁移，防回归即可）

| 资产 | 证据 | 备注 |
|---|---|---|
| `assets/base.css`（重置/字体/行高） | MD5 一致 | 字号 15px / line-height 1.6 / Inter 栈 |
| `assets/main.css`（`--color-*` 双主题令牌层 + 滚动条 + reduce-motion + 断点变量） | MD5 一致 | `@layer design-tokens/base/components`；prefers-color-scheme 兜底 |
| `assets/markdown.css`（.markdown-body 全件：标题/引用/表格/代码块横幅/KaTeX） | MD5 一致 | 342 行渲染样式原样 |
| `ui/tokens.css`（星群×工坊 L0 令牌：`--bg-*`/`--text-*`/`--line`/`--r-*`/发光/呼吸） | MD5 一致 | `html[data-theme]` 潜伏层（两边都无 JS 驱动——见 §3 待决项） |
| `ui/` 组件库 14 件（Avatar/Button/Icon/Modal/StarAvatar/StarCard/StatusDot/PulseTrace/ThinkingIcon/ThoughtIcon/Tooltip/icons/tokens/index） | MD5 一致 | StarCard/PulseTrace 是 src 的组件（**preview 页面当前未用到，迁移后应启用**） |
| 主题 store 语义（theme/light/dark + theme-changed 事件 + localStorage `agentchat.theme`） | src `stores/theme.ts` ≡ preview `stores/ui.ts` 主题块 | preview 无独立 theme store，语义同 |
| `index.html` + CSP + iframe 壳页 | 一致（M17-F csp-audit 测试钉住） | — |
| `useMarkdown` 渲染管线（parseFileTags/linkifyFilePaths/复制按钮/表格包裹/主题联动） | M16 已搬（preview useMarkdown 与 src 同构） | markdown 输出类名与 src 一致（.md-code-block 等由 markdown.css 消费） |

## 2. 差距总表：视图层映射

### 2.1 外壳层序事实（src App.vue 亲测，迁移基准）

- 三层：Sidebar（48px）→ 列表槽位（**三面板轮换**：AgentList / SessionList / RunTrackingPanel，
  由活动栏切换；宽度 `ui.listWidth` 拖拽）→ 主区。
- 主区双态：`RunTracking v-if`（矩阵大画布）与 `chat-area v-show`（**保活**——流式/草稿
  不因查看矩阵丢失）；chat-area 内 = PerspectiveHost + 可选 WorkspaceTree 分屏（ResizeHandle）
  + 右侧悬浮工作区把手（绝对定位，`--layout-header-height + 12px` 避头，z-index 90）。
- 移动端（≤768px）：list-panel-wrapper `position:fixed` 覆盖层 z-index 120（盖 header z-100
  与 overlay z-110）；收起时 `pointer-events:none` + 无阴影；展开才有阴影 + 指针。
- 遮罩 Transition（opacity 0.2s）；跟踪页打开时选中新会话 → 自动让位回聊天（watch 三元组）。
- **preview 缺口**：单列表（AgentGroupList）无三面板轮换；无矩阵/聊天保活切换（M17-D 的
  RunTrackingView 是弹窗，src 是主区大画布）；无工作区悬浮把手/分屏；移动端 z-index 层序不同。

| src 视图 | preview 对应物 | 差距等级 | 差异一句话 |
|---|---|---|---|
| App.vue（外壳） | App.vue | 中 | preview 三栏骨架在，但列表面板/主区细节与 src 布局语义不同（见星群层） |
| Sidebar.vue | ActivityRail.vue | 中 | 结构近，按钮形态/发光/底部用户头像细节缺 |
| SessionList/AgentList | AgentGroupList.vue | **大** | src 是分节树（会话/singles/工作区），preview 是混排平列表 |
| DialogView.vue | ChatView.vue | **大** | src 头部/消息时间轴/输入编排与 preview 简化版差异大 |
| ChatInput.vue | ChatInput.vue | **大** | 星港形态（渐变描边/聚焦光晕/占位文案/布局）未对齐 |
| TurnDisplayItem/UserMessage/AssistantMessage/ToolMessage | TurnItem.vue/ToolCard.vue | **大** | src 气泡骨架（头像列/时间戳/动作行/工具卡标签栏）未对齐 |
| TokenUsage.vue | UsagePanel.vue | **大** | src 53K 组件（页签/云图/弦图/堆叠柱/表格），preview 简化卡表 |
| RunTracking/RunTrackingPanel | RunTrackingView.vue | **大** | src 矩阵大画布 vs preview 列表式 |
| SettingsPanel/AgentPane 等 | settings/**（M17-B） | 中 | 功能齐；样式用了 tokens 体系且版式简化 |
| CreateGroupDialog/VersionDialog/PairDialogView/GroupDrawer/WorkspaceTree | 部分有（CreateGroupDialog/SystemPanel/RunTrackingView 内嵌） | 中 | 形态简化 |
| FilePreviewModal | FilePreviewModal.vue | 小 | M17-E 新写，样式接近但按 src 规格核对 |
| InteractionBar | InteractionBar.vue | 小 | M16 已搬（接近） |

## 3. 令牌体系与风格铁律（迁移期必须遵守）

### 3.1 双体系按域分工（src 实测事实，勿凭直觉）

src 的令牌分工是**按功能域**而非"页面 vs 组件库"（对全部 41 个 src 视图做令牌引用计数实测）：

| 体系 | 文件 | src 使用者（实测） | 迁移铁律 |
|---|---|---|---|
| `--color-*`（Soft UI 双主题） | assets/main.css | **聊天主区/列表/跟踪**：Sidebar、SessionList、AgentList、DialogView、ChatInput、InteractionBar、TurnDisplayItem/UserMessage/AssistantMessage/ToolMessage、ToolResult 七件、PairDialogView、RunTracking(+Panel)、WorkspaceTree、GroupDrawer、CreateGroupDialog 等 | 上述域迁移时引 `--color-*`/`--space-*`/`--radius-*`/`--layout-*`/`--transition-*` |
| `--bg-*`/`--text-*`/`--line`/`--r-*`/`--primary`（星群×工坊 L0） | ui/tokens.css | **统计与设置**：TokenUsage（star×67 零 color）、settings 全部 13 组件（零 color）+ ui/ 组件库 | 统计/设置域引星群体系；ui/ 组件库内部自洽 |

**preview 现状实测（令牌引用计数）**：

| 域 | 结论 |
|---|---|
| 聊天/列表/工具卡/输入/群/交互（ChatView/GroupView/ChatInput/AgentGroupList/ActivityRail/TurnItem/ToolCard/ToolResult 七件/InteractionBar/CreateGroupDialog） | ✅ 版式待对齐（体系见下） |
| settings 全部组件（M17-B） | ✅ 体系正确（星群 tokens，与 src settings 同款） |
| UsagePanel | ⚠️ 命名错位：用 --color-*，src TokenUsage 用星群 tokens——**视觉等价**（tokens.css 别名层已把 --color-* 桥接到 L0 同一来源），仅代码卫生问题，低优先 |
| RunTrackingView | ⚠️ 同上（命名错位、视觉等价） |
| SystemPanel/FilePreviewModal（无 src 直接对应） | 按所在域归队即可 |

**关键事实（tokens.css 末尾"业务兼容别名层"，203 行处）**：`--color-primary = var(--primary)`、
`--color-bg-page = var(--bg-base)`、`--color-text-* = var(--text-*)`、`--radius-* = var(--r-*)`、
`--space-* = var(--space-*)`——**两体系是同一来源的两套名字，视觉完全等价**；main.css 独有且
无 tokens 对应者仅 `--color-bg-user-container`/`--color-bg-assistant`/`--color-danger-light`/
`--color-code-*`/`--layout-*`/`--space-xl`/`--transition-*`。因此：
**"颜色对不上"不是问题——全部观感差异都在版式/结构/密度**（DOM 结构与 scoped CSS 的简化重排），
由 §4-6 逐视图规格解决。

### 3.2 基准规格（src 实测事实汇总，出自三份侦察）

- 布局令牌（main.css）：`--layout-content-max-width: 840px`、`--layout-header-height: 48px`、
  `--layout-sidebar-width: 260px`（≤768px → min(280px,80vw)、内容宽 100%）。
  **注意**：840px 在 src 会话视图**未被使用**（消息区撑满）——已按用户裁决对齐。
- 间距刻度 4px 基准（`--space-1..6` = 4/8/12/16/20/24；别名 xs/sm/md/lg = 4/8/16/24）；
  圆角 4/8/12/999（另有全站一致的硬编码 10px：工具卡/矩阵格/部分弹窗）。
- 字号阶：11（摘要/时间）→12（标签/次级）→13（名称/正文/按钮）→14（正文气泡）→
  15（标题/agent-label）→22（welcome）；代码终端 12px/1.65 mono；数字 `tabular-nums`。
- 动效：≤200ms 页面级；呼吸/流光只挂在功能性状态（StarAvatar 光环 1.15s/1.9s、
  StatusDot 1.4s、流式点 dot-pulse 1.4s、打断脉冲 1.2-1.5s、下拉 fade .12s）；
  `prefers-reduced-motion` 全局豁免 `.run-spin`/`.ring-spin`（运动即语义）。
- 状态必须"文字 + 颜色"双重表达（工具卡 OK/ERR/BLK 纯文字、忙闲、断开警示条）。

### 3.3 待决项（已裁决）

1. `html[data-theme]` 潜伏层：**不启用**（html.dark/.light 已够，保留兼容层注释）。
2. StarCard/PulseTrace/ThinkingIcon/ThoughtIcon：src 与 preview **同为"已定义未使用"**
   ——对齐 = 维持现状（两轨都不用），不启用。
3. **消息区内容宽**：用户已裁决**对齐 src 撑满**（`max-width:100%`，去 840px 居中；
   气泡最大宽 70% 保证可读性）——§5.1 原"二选一"定案。
4. **实施方式**：用户已批准 M18-A→E 全序实施（2026-08-23）；src 轨道保持冻结
   （只修 bug）——"洗令牌"只作用于 preview 侧文件与迁移中新建的 preview 代码，
   src 的 OLD 令牌文件作为版式参考不动。
5. **事实源纪律（用户指令）**：`docs/archive/*` 为归档文档，**不作为参考**——
   一切对齐以 `src/ui/webui/src/**` 实际布局样式为准（本计划已全文改引 src 实测）。

## 4. 星群层迁移规格（活动栏/列表/外壳）

> **层原则（src 实测，出自星群层侦察通用结论）**：
> glow 已扁平化（`--glow-*: none`），发光仅存于 StarAvatar running 三环光环
> （1.15s/1.9s 错相，reduce-motion 豁免）与 StatusDot 呼吸（1.4s）；
> 选中态 = 角色色板（`--role-selected-bg` 淡底 + 名称默认色，非浓度渐变）；
> hover = `--role-hover-bg` + 1px 边框 + 微阴影；密度基准 = 树行 30px /
> 列表行 40px（头像 36）、行距 `--space-xs=4px`；圆角 4/8/12/999；
> 动效 .12s/.15s/.2s；字号阶 11（摘要/时间）→12（标签）→13（名称/正文/按钮）
> →15（标题）→22（welcome）。
>
> 完整 A(DOM)/B(布局)/C(CSS 提炼)/D(差异)/E(落点) 逐文件规格见
> `docs/m17-recon/style-parity-star-layer.md`；本节为其可执行摘要。

### 4.1 App.vue 外壳（迁移：`preview/webui/src/App.vue`）

| 项 | src 规格 | preview 现状 | 动作 |
|---|---|---|---|
| 三层骨架 | 活动栏 48px → 列表槽位（`ui.listWidth` 260 默认/160 下限/视口-48-320 上限，ResizeHandle 3px 命中条 hover 主色）→ 主区 | 同骨架；`.drag-handle` 6px 内联、限 180–560 | 拖拽条对齐 3px + hover `--color-primary`；限幅对齐 |
| 主区双态 | RunTracking `v-if` + `chat-area` `v-show` 保活（流式/草稿不丢） | `v-if` 直切视图，无保活 | M18-D 引保活语义（矩阵改主区大画布时一并） |
| 工作区 | 右侧 WorkspaceTree 分屏 + 悬浮把手（`--layout-header-height+12px`，36×40，z-90） | 无（显式缩水） | 不搬，记录 |
| 移动端 | 列表抽屉 `left:0` z-120（盖 header 100/遮罩 110）；收起 `pointer-events:none` 无阴影 | 抽屉 `left:48px` z-50/遮罩 40 | 对齐 left/z-index/pointer-events 语义 |
| 弹窗层 | 常驻组件 visible 控制 | v-if 单例 | 等价，可保留 |

### 4.2 Sidebar → ActivityRail（迁移：`preview/webui/src/components/ActivityRail.vue`）

- 栏背景 `--color-bg-subtle`（src）vs preview `--color-bg-surface`（**色阶差一档**）→ 改。
- 按钮 40×40 radius 6、`gap:4`、`padding:8px 0`、z-10 + border-right；图标 SVG stroke 1.8（preview emoji——可选对齐）。
- active 指示条 `left:0; top:8px; bottom:8px; width:2px`（preview `left:-6px; top/bottom:6px`）→ 对齐。
- hover：color `--color-text-primary` + bg `--color-bg-hover`；顶部头像按钮 36×36 hover `scale(1.1)`+主色描边（preview 无头像——可略）。
- 三面板入口（agents/sessions/tracking）/ 更多菜单（备份/更新红点）/ 插件 sidebar-action slot → preview 缩水保留（tracking 入口保留、SystemPanel 承担备份/版本）。
- 迁移顺序建议：`AgentGroupList.vue`（密度/头像/选中态/群头像）→ `ActivityRail.vue` → `App.vue`（抽屉/拖拽）→ `GroupView.vue`（成员抽屉）。

### 4.3 AgentList → AgentGroupList（迁移：`preview/webui/src/components/AgentGroupList.vue`）

- 行密度：`padding:10px 12px; margin-bottom:var(--space-xs); gap:10px; border:1px solid transparent`；头像 **30→36**。
- hover：`--role-hover-bg` + border `--color-border-secondary` + `0 1px 3px rgba(0,0,0,.05)` 微阴影。
- 选中：`--role-selected-bg` 淡底 + 名称默认色（preview 用 `--color-primary-light`——改）。
- 群头像：src 3×3 成员网格拼图（40×40，1/2/3 级列数；cell 星色/主色）vs preview 单 users 图标 → 对齐网格。
- 摘要：Agent = lastMessage「你: xxx」；群 =「N 个参与者」；未读徽章 = 头像右上角 absolute（`top:-6; right:-8`、2px `--color-bg-surface` 描边）vs preview 右列 meta → 对齐。
- 排序：src lastActivity 浮顶（无未读优先）vs preview 未读优先>活动>名称 → 对齐 src。
- 指针冻结：src `pointerdown` 冻结+600ms 解冻 vs preview mouseenter 快照 → 语义等价，可各留。
- 零宽滚动条 + hover 浮现（thumb `--color-border-primary`→hover 主色）vs preview 全局 6px → 对齐。
- 新增入口：src "+下拉菜单"（新增 Agent/创建群组）vs preview 三文本按钮 → 可选对齐；`virtual-badge` 为 preview 独有，保留。

### 4.4 SessionList（src 特有，不搬）

singles/workspaces 树（30px 行高/头像 15/文件夹开合图标/hover 浮现更多菜单/零宽滚动条）在 preview 无后端面——显式缩水，未来恢复时按 `style-parity-star-layer.md` §3 另开规格。

### 4.5 GroupDrawer → GroupView（迁移：`preview/webui/src/views/GroupView.vue`）

- src = 右侧 280px 抽屉：成员 4 列网格（Avatar 40 circle +「我」徽章 + 名字）、成员搜索、群名编辑、简介 textarea、底部删除；preview = 内联 chip + header 行内操作 → 建议对齐抽屉形态。
- 若引入：`drawer-panel` 280px / `border-left` / `--color-bg-surface`；section `padding:14px 16px` + 底部分隔；「我」徽章 `--color-primary` 9px 描边。

### 4.6 星群层组件复用裁决

StarCard / ui-Button 两轨字节一致但列表均手写按钮未使用。迁移**不强推**改用（视觉等价），仅记录；若后续做"星色描边选中"语言升级再统一。



## 5. 工坊层迁移规格（会话/消息/输入）

> **层原则（src 实测，出自工坊层侦察通用结论 §12）**：
> 消息区 = 时间轴 turn 节点（time/event/error 三类分隔条，纯居中文字）；
> 思维链/工具卡/步正文三级共用「竖线 + 7px 内缩」语言（`border-left:1px +
> margin-left:7px + padding-left:14px`）；工单卡 =「10px 圆角 + 1px 弱描边 +
> 顶部 banner（10px 14px bg-surface 或 36px bg-code-toolbar）+ code-bg 视口」；
> 状态徽标纯文字（OK #22c55e / ERR #ef4444 / BLK #f59e0b，文字+颜色双表达）；
> 流式一律 3 点呼吸（dot-pulse 1.4s：黄 #e6a817/灰 #a8abb2/思考红 #e74c3c）；
> 终端命令区 `#0f1117` 恒深 + `$ #4ade80` 不随主题；气泡 6px/70%/去描边+shadow；
> 输入区 = `--color-bg-page` 底 + icon 发送方块 + 思考强度下拉；占位
> "输入消息… (Enter 发送, Shift+Enter 换行)"（preview 已同款）；
> **工坊层无发光**（StarAvatar 光环为 preview 保留特色，不作对齐项）。
>
> 完整逐文件 A-E 规格见 `docs/m17-recon/style-parity-workshop-layer.md`；本节为可执行摘要。

### 5.1 DialogView → ChatView（迁移：`preview/webui/src/views/ChatView.vue`）

| 项 | src | preview | 动作 |
|---|---|---|---|
| 头部 | 固定 `height:48px` + `padding:0 16px` + `backdrop-filter:blur(8px)` + z-100；icon `settings-btn` 组 | `padding:10px 16px` 无固定高/无 blur；文字 `header-btn` | 固定高 + blur + icon 按钮 |
| 内容宽 | `messages-content max-width:100%` 撑满（840px 布局令牌**未用于会话视图**） | `messages-container max-width:840px` 居中收窄 | 去 840 居中（或记录为有意差异） |
| 时间分隔 | 纯居中文字（无横线） | 两侧横线 + label | 二选一决策（建议对齐 src 纯文字） |
| 消息区层级 | `chat-body > chat-main > messages-wrapper(定位) > messages-container(滚动)` | `messages-wrapper` 直接滚动 | 层级命名对齐 |
| token 仪表 | `gauge-bar` 72×6 进度条 + 四档色（#22c55e/#eab308/#f97316/#ef4444）+ 百分比 | `token-meter` 药丸文字 | 升级为 gauge 进度条 |
| 历史渲染 | 完整 `TurnDisplayItem` 组件树（历史与 live 同组件） | `record-row/record-bubble` 内联 + `TurnItem`（live） | 随 §5.3-5.5 组件化后统一 |

### 5.2 ChatInput（迁移：`preview/webui/src/components/ChatInput.vue`）

- 容器：bg `--color-bg-surface`→`--color-bg-page` + `box-shadow:0 1px 3px rgba(0,0,0,.05)`；`line-height 1.6→1.5`。
- 发送按钮：文字"发送"→ icon 方块（Icon send 16，30×28，主色实底 + `--shadow-primary`；打断态橙 + `pulse-interrupt`）。
- 附件 chip：白底 999px → 主色药丸（`--color-primary-light` 底 + `--color-primary` 描边 + `--radius-sm`）。
- 工具栏：src 四下拉（工作区/Agent/模型仅 single 显示 + **思考强度常显**：关/low/high/max，默认 high）；preview 无 → 思考强度下拉对齐（接 deepThink 语义）；下拉统一向上弹出（`bottom:calc(100%+6px)`、10px 圆角、4px padding、`--shadow-pop`）。

### 5.3 TurnDisplayItem → TurnItem（迁移：`preview/webui/src/components/chat/TurnItem.vue`）

- **气泡最大宽 `82%→70%`**（最影响观感处）。
- 有链助手轮：头像上提左列 32px（`turn-chain-row` 结构：Avatar 32 + `turn-chain-col`）；sender-name 12px 列顶（有链时）。
- 思维链**去卡片化**：`.chain`（边框盒）→ 裸行 `.chain-header`（12px/500，展开时 `sticky top:-16px` 吸附顶部可快速折叠）+ `.chain-body`（border-left 缩进）；流式点 `dot-yellow #e6a817`/`dot-gray #a8abb2` 4px。
- 动作行：常显文字 → hover 显现 icon（复制/重新推理/删除）；"继续生成"移到用户消息左侧（`margin-right:auto`）。
- 气泡圆角 `12px→6px`（连带 §5.4/5.5）。

### 5.4 UserMessage / AssistantMessage（preview 内联 → 拆分组件）

- 用户气泡：`--color-bg-user-container` + radius 6 + padding `8px 12px` + `box-shadow 0 1px 2px .05` + **去描边**；附件 chips 内嵌气泡（`user-files`，3px 8px / radius 5 / 12px，hover 主色描边）；动作行 hover icon（复制/编辑 + 左侧继续生成）。
- 助手气泡：`--color-bg-assistant` 同色描边（视觉无描边）+ radius 6 + padding `8px 12px` + shadow .04；思考区补耗时 label（"已思考（用时 N 秒）"——preview 需接 label 或本地计时）；错误态 `--color-danger-light` 底 + `--color-error` 描边；`file-path-link` 主色 light 底 + mono + hover 下划线。
- 正文 `line-height 1.7→1.5`。

### 5.5 ToolMessage → ToolCard（迁移：`preview/webui/src/components/chat/ToolCard.vue`）

- **去卡片化**：边框盒 → 裸行 `tool-label`（12px/500 + 静态齿轮 + `padding:2px 0`）+ `tool-body`（border-left 7px 缩进）。
- 状态徽标：药丸底色 → 纯文字 11px/700（OK `#22c55e` / ERR `#ef4444` / BLK `#f59e0b`）；running 保留流式点。
- 专用组件（ToolResult 七件 preview 已有同名同源）：统一令牌层到 `--color-*` 别名；分段 `ScrollableViewport`（命令 260px / stdout 40vh / stderr 30vh）替代 ToolCard 外层整体 40vh；终端命令区恒深 `#0f1117` + `$ #4ade80` 保留；代码卡 10px 圆角 + `code-header(10px 14px bg-surface)` + `md-code-block` 覆盖（margin/radius 归零、banner 隐藏）；write 工具标签栏文件预览图标 hover 显现。

### 5.6 InteractionBar / TypingIndicator / FilePreviewModal

- InteractionBar：视觉同源（primary-light 药丸 + 999px + 10px 菜单）；触发器全宽 → 非全宽（`inline-flex`）；保留 preview 队列逐题语义与"忽略"按钮。
- TypingIndicator：**两轨逐字节相同**，零迁移。
- FilePreviewModal：src 自绘 overlay（960px/90vh/z-10000 + blur 2px）含 **hljs 高亮 + 行号列**、图片**棋盘格底**（repeating-conic-gradient）、HTML `iframe sandbox`、语言标签/尺寸徽章、底部路径栏；preview 是 Modal 720px + 纯 pre。→ 补齐行号列/高亮/棋盘格/iframe/徽章；尺寸 960/90vh 或记录为有意差异。

## 6. 面板层迁移规格（用量/跟踪/设置/弹窗）

> **层原则（src 实测，出自面板层侦察通用结论 §12）**：
> 弹窗统一形态 = Modal（`--bg-raised` + `--r-lg` 12px + `--shadow-panel` +
> 标题条 10px 16px 8px + close 24×24）；设置面板签名 = 头部 4×14 主色 accent
> 竖条 + 200px 导航树（选中态 `--primary-light` 底 + `color-mix(--primary 45%)`
> 半透明描边）；数字 `tabular-nums`；表格 12px/行底 1px `--line`/表头 `--text-2`
> 600/数值列右对齐/首列 `--font-mono`；图表 = 去图例 + 自绘 tooltip 卡片 +
> 柱顶圆角 6 + 仅横网格 + 刻度 11px；z-index 阶梯 Modal 600 → Tooltip 700 →
> settings overlay 1000 → 面板内弹窗 1200 → 全局 tooltip 10000；
> 统计与设置域用星群 NEW 令牌（§3.1 实测分工）。
>
> 完整逐文件 A-E 规格见 `docs/m17-recon/style-parity-panels.md`；本节为可执行摘要。
> **面板层根因**（panels 侦察 §12.3）：src 内部两套令牌交叉并存（TokenUsage 与
> settings 已 NEW；RunTracking/PairDialogView/CreateGroupDialog/VersionDialog/
> WorkspaceTree 仍 OLD + `html.dark` 硬编码 #11151d/#1e2530/#1c222e）；preview 的
> UsagePanel/CreateGroupDialog 反留 OLD。**对齐第一步 = 统一令牌层，不是搬布局**。

### 6.1 TokenUsage → UsagePanel（迁移：`preview/webui/src/views/UsagePanel.vue`）

- 结构：左 **216px 侧栏**（`--bg-raised`/`--line` 右分隔，padding 14px 16px）= 日期筛选（7/30/90 天 + 自定义起止 + "未应用"标记 + 数据覆盖提示）+ **缓存命中率进度条**（`--ok` 8px 圆角轨道）+ 竖向页签（active `--primary` + `--primary-light`）；右侧内容 `flex:1 min-height:0` 图表吃满。
- 图表视觉主题（可移植纯视觉，不抄 render）：去图例 + 自绘 HTML tooltip 卡片（`--bg-raised`/`--line`/`--r-md`）+ 柱顶圆角 6px + 仅横向网格线（dark `rgba(255,255,255,.06)`）+ 刻度 11px + `tabular-nums`；堆叠配色 输出 `#a78bfa`/`#8b5cf6`、未缓存 `#818cf8`/`#6366f1`、缓存 `#34d399`/`#10b981`；模型视图 18 色板 + "其他" `#8b93a7`。
- 弦图（d3-chord 660×660，弧带宽 18/圆角 3，渐变弦 opacity .35-.85，径向标签左半环翻转）= 重资产；preview 排行条保留为 C 档缩水（升级时复用视觉主题）。
- preview 现状：无侧栏/摘要卡×5/排行条/默认图例 + 硬编码 #7f8c8d 轴色 → 按上替换（轴色 → `--text-2`/`--text-3`；令牌洗 NEW）。

### 6.2 RunTracking/RunTrackingPanel → RunTrackingView（迁移：`preview/webui/src/views/RunTrackingView.vue`）

- 承载：src = 主区全屏大画布（从侧栏第三面板入口打开）vs preview = Modal 900×80vh 列表。**N² 矩阵属重资产，preview 列表保留为显式缩水**；迁移只搬视觉语言：
  - 格子 `radius:10px` + 内描边 `inset 0 0 0 1px rgba(127,127,127,.1)` + hover 主色 2px 描边 + 浓度色阶 5 档 `color-mix(--primary 6/12/20/30/42%)` + 运行光环（白主弧 1.15s + accent 副弧 1.9s 旋转）。
  - tooltip 形态（fixed 270px r-lg + tip-k 左标签列 + tabular-nums）可作 preview 会话行 hover 富提示模板（替代"点开才看"）。
  - 树形态（若侧栏挂运行树）：30px 行高 + 28px 缩进 + 红徽章 + hover 浮现中断按钮（`opacity:0→1`）。
- 令牌：src 本域 OLD + html.dark 硬编码 → 洗 NEW（`--color-bg-page→--bg-base`、`--color-primary→--primary`、`--color-bg-subtle→--bg-hover`、`--color-border-secondary→--line`）。

### 6.3 settings 三件（迁移：`preview/webui/src/settings/**`）

- SettingsPanel 壳：preview 保留 Modal 承载（不引 src 自绘 82vw overlay），补两处签名视觉：① 头部 **4×14 `--primary` accent 竖条**；② 导航选中态升级「`--primary-light` 底 + `color-mix(--primary 45%)` 半透明描边」（src `.sp-tree-leaf.active` 语言）；导航宽统一 200px；footer 按钮统一 `ui/Button`（ghost/primary）。
- AgentPane：页签条已同构（下划线式 + active `border-bottom:2px`），只统一两数值——active 字重 500、padding `8px 16px`；标题排版吸收 `.agent-nav-name`(14px 600) + `.agent-nav-id`(11px mono)；模型页移植「继承/覆盖」视觉语言（`.llm-item` 左 3px 主色竖线 + source 徽章 + `.llm-effective` 摘要条）——preview 当前硬编码表单缺这套签名。
- ConfirmDialog：形态一致；自绘 `.btn` 统一 `ui/Button`（消除 `.primary`=accent 粉 vs `ui/Button.primary`=主色紫的语义冲突；危险钮走 `Button[danger]`）。
- 基本信息：src 头像 56×56 + 能力标签药丸（`--primary-light` 底 + `--primary` 字 + `--r-full`）+ SYSTEM.md/AGENT.md 11 行 textarea——preview 头像/能力标签显式缩水（§2 记录），仅吸收字段行 `padding:9px 12px + 底分隔` 的排版密度。

### 6.4 弹窗三件与工作区树

- CreateGroupDialog：两轨都 OLD → 统一洗 NEW（`--input-bg/--input-border/--input-focus`）；吸收 `.section-label` + `.label-badge`（"已选 N"）+ 参与者项底部分隔线；preview 保留 Modal title 形态（src 自绘 header 是历史包袱，不引）。
- VersionDialog：preview 已显式缩水（SystemPanel 版本 section），**不恢复对比卡**；若日后展示"当前 vs 最新"，硬编码状态色（`#fef3c7/#92400e` 更新、`#ecfdf5/#065f46` 最新）token 化（`--warn`/`--ok` 系）再用。
- WorkspaceTree：src 独有（280px 右栏 + guide line 缩进 + 按扩展名图标色 6 硬编码）；preview 无树面板——不搬；若日后恢复，文件图标色收敛为语义令牌（code=`--primary`/term=`--ok`/img=`--accent` 等）。
- Modal/Tooltip/Button：**两轨逐字节相同，零迁移**（已锁定统一形态：Modal z-600/panel `--bg-raised` r-lg shadow-panel；head 10px 16px 8px；footer 8px 16px 10px；Tooltip z-700）。

### 6.5 面板层执行顺序（panels 侦察 §12.4）

① 统一令牌层（src 6 个 OLD 文件 + preview 2 个 OLD 文件 → NEW，删 html.dark 硬编码）→ ② 搬签名元素（TokenUsage 216px 侧栏+进度条+竖向页签 / settings accent 竖条+树选中态 / AgentPane 左竖线分组+继承覆盖徽章 / RunTracking 浓度色阶+格子描边）→ ③ 重资产按需取舍（弦图/N² 矩阵/目录树保留缩水，升级时复用视觉主题）→ ④ 统一按钮（ui/Button）与 z-index 阶梯（Modal 600 / 面板 1000 / 面板内弹窗 1200 / 全局 tooltip 10000）。

## 7. 移动端与响应式

src 断点事实（`@media (max-width: 768px)`，全部来自 src 源码实测）：

| 面 | src 行为 | preview 现状 | 动作 |
|---|---|---|---|
| 全局断点变量 | `--layout-content-max-width:100%`、`--layout-sidebar-width:min(280px,80vw)`（main.css 已一致，无需动） | 同 | — |
| 列表抽屉 | `position:fixed; left:0; top:0; bottom:0; z-index:120`（盖 header z-100 与遮罩 z-110）；`width:min(280px,80vw)`；收起 `pointer-events:none` + 无阴影；展开 `box-shadow:2px 0 12px rgba(0,0,0,.15)`；过渡 `.25s ease` | `left:48px`、z-50、遮罩 z-40、`transition:.18s ease` | 对齐 left/层序/pointer-events/阴影/时长 |
| 遮罩 | `position:fixed; inset:0; rgba(0,0,0,.35); z-index:110` + opacity .2s Transition | 同但 z-40 | 对齐层序 |
| 工作区 | 覆盖式面板（自带关闭）+ 隐藏悬浮把手 | 无（不搬） | — |
| 列表内 mobile-close-btn | 抽屉内关闭按钮（display:flex 仅移动端） | 无 | 可选补 |
| 会话切换后 | 选中会话 → 关闭抽屉（src App watch 三元组 + 各面板入口显式 close） | M17-C 已实现（ui.activeConversationId watch） | ✅ 语义已对齐 |

z-index 全层序（src）：活动栏 10 → 工作区把手 90 → ChatView header 100 → 移动遮罩 110 →
移动抽屉 120 → 下拉菜单 300 → more 菜单 9999。迁移时 preview 全站按此表统一。

## 8. 迁移顺序与分步验收

按"先统一令牌层，再骨架，再签名元素；先高频后低频；每步可独立验收"：

- **M18-A 令牌层统一（并入各层重写，不单独成步）**：别名层已使两体系视觉等价
  （§3.1），且 UsagePanel/CreateGroupDialog 本就要在 M18-D 重写——令牌清洗随各层
  重写一并落地（统计/设置域写 NEW 星群令牌，聊天/列表域沿用 `--color-*` 别名与
  src 同款；禁引 `html.dark` 硬编码底色）。验收 = §8.1-A 计数法 + 无硬编码底色。
- **M18-B 工坊层（最高频）**：ChatView 头部/内容宽/分隔条 → TurnItem 去卡片化 +
  气泡 70%/6px/去描边 → UserMessage/AssistantMessage 组件化 → ToolCard 裸行化 →
  ChatInput 星港（icon 发送/思考强度下拉/chip 药丸）→ InteractionBar 非全宽 →
  FilePreviewModal（行号/hljs/棋盘格/iframe）。
- **M18-C 星群层**：AgentGroupList（密度/头像 36/选中态 `--role-selected-bg`/
  群头像 3×3 网格/未读徽章贴头像/零宽滚动条/lastActivity 浮顶）→ ActivityRail
  （背景 `--color-bg-subtle`/按钮 40×40/指示条）→ App.vue（抽屉 left:0 层序/
  拖拽条 3px）→ GroupView 成员抽屉（280px/4 列网格/「我」徽章）。
- **M18-D 面板层**：UsagePanel（216px 侧栏 + 进度条 + 竖向页签 + 图表视觉主题）→
  settings 签名（accent 竖条/树选中态/模型页继承覆盖竖线/ui-Button 统一）→
  RunTrackingView（浓度色阶/格子描边/tooltip 形态；矩阵大画布保留缩水）→
  CreateGroupDialog 洗令牌 + 徽章语言。
- **M18-E 动效与收尾**：流式点/呼吸/打断脉冲/下拉 fade 按 §5 动效清单上齐（工坊层
  无发光——StarAvatar 光环为 preview 保留特色）；空态文案对齐 src
  （"开始对话 — 发送第一条消息吧" / "群聊开始 — 发送第一条消息吧"）；
  移动端抽屉观感（§7）；csp-audit/format/race 测试保持绿；README 与本文对账。

每步验收（沿用 M17 口径）：
`pnpm --filter ac-webui-app typecheck` + `pnpm exec vitest run preview/webui/tests` +
`pnpm preview:test`（后端不动时可选）+ `pnpm --filter ac-webui-app build` +
boot 真连目检（桌面亮/暗 + ≤768px 抽屉 + reduce-motion 仿真）。

### 8.1 可重复核对方法（每步跑一遍，防"改了又漂"）

**A. 令牌体系核对**（每个视图的体系引用计数；本计划 §3.1 的实测即此法）：

```powershell
$files = Get-ChildItem preview/webui/src/views,preview/webui/src/components,preview/webui/src/settings -Recurse -Filter *.vue
  | Where-Object { $_.FullName -notmatch '\\ui\\' }
foreach ($f in $files) {
  $color = (Select-String -Path $f.FullName -Pattern 'var\(--color-[\w-]+\)' -AllMatches | % { $_.Matches.Count } | Measure-Object -Sum).Sum
  $star  = (Select-String -Path $f.FullName -Pattern 'var\(--(bg|text|primary|accent|line|r-|dur|ok|warn|err|font|input|glow|grad)[\w-]*\)' -AllMatches | % { $_.Matches.Count } | Measure-Object -Sum).Sum
  '{0,-52} color={1,3} star={2,3}' -f $f.FullName.Replace('C:\Users\xiaofeng\Documents\Dev\AgentChat\preview\webui\src\',''), $color, $star
}
```

判据：聊天/列表/跟踪域 → color 主导（star 仅个别 ui/ 组件内部项）；统计/设置域 →
star 主导。**任何"color 与 star 双高并存"或"域与体系反转"都是回归**。

**B. 地基防漂核对**（对齐资产不可再动；每次迁移后跑）：

```powershell
$src='src/ui/webui/src'; $pv='preview/webui/src'
foreach ($f in @('assets\base.css','assets\main.css','assets\markdown.css','ui\tokens.css')) {
  $a = Get-FileHash "$src\$f" -Algorithm MD5; $b = Get-FileHash "$pv\$f" -Algorithm MD5
  '{0} {1}' -f $f, $(if ($a.Hash -eq $b.Hash) {'OK'} else {'DRIFT!'})
}
Get-ChildItem "$src\ui" -File | ForEach-Object {
  $a = Get-FileHash $_.FullName -Algorithm MD5
  $b = Get-FileHash "$pv\ui\$($_.Name)" -Algorithm MD5
  if ($a.Hash -ne $b.Hash) { "DRIFT! ui\$($_.Name)" }
}
```

判据：全 OK。若 ui 组件有意演化（如 StarAvatar 加参数），必须同步改 src 或在本计划
记录为"有意分叉"，不得静默漂移。

**C. 观感目检清单**（boot 真连，桌面暗/亮 × 移动端各一遍）：
① 列表行密度/选中色板/群头像 3×3/未读徽章贴头像 ② 消息时间轴（气泡 70%/6px/去描边/
头像列/动作行悬停）③ 思维链裸行 + 工具卡标签栏四态纯文字 ④ 输入区 icon 发送 + 思考强度下拉
⑤ 用量面板 216px 侧栏 + 进度条（tabular-nums）⑥ 设置导航树选中描边 + accent 竖条 +
弹窗 12px 圆角 ⑦ 空态 src 文案（"开始对话 — 发送第一条消息吧"/"群聊开始 — 发送第一条消息吧"）
⑧ ≤768px 抽屉层序与遮罩 ⑨ 系统 reduce-motion 下光环仍动、其余静止。

## 10. 实施进度（2026-08-23 落地记录）

| 步 | 内容 | 状态 |
|---|---|---|
| M18-A 令牌统一 | 并入各层重写；§8.1-A 审计全绿（聊天/列表域 color 主导、统计/设置域 star 主导） | ✅ |
| M18-B 工坊层 | ChatView（头部 48px+blur/撑满/纯文字分隔/gauge 进度条/气泡 6px+70%）；TurnItem 去卡片化 + 头像左列 32px + sticky 链头 + 竖线缩进；Message/UserMessage + Message/AssistantMessage 组件化（含内部流式分块渲染器）；ToolCard 裸行化 + 纯文字状态 + 分段滚动；ChatInput（icon 发送/思考强度下拉/chip 药丸/容器 bg-page）；InteractionBar 非全宽；FilePreviewModal（hljs 高亮+行号列/棋盘格/iframe/语言标签/路径栏） | ✅ |
| M18-C 星群层 | AgentGroupList（密度/头像 36/`--role-selected-bg`/3×3 群头像/未读贴头像/零宽滚动条/lastActivity 浮顶）；ActivityRail（`--color-bg-subtle`/40×40/指示条）；App（拖拽 3px、抽屉 left:0 + z 110/120 + pointer-events）；GroupView 成员抽屉（280px/4 列网格/「我」徽章/搜索/群名编辑/底部删除） | ✅ |
| M18-D 面板层 | UsagePanel 重写（216px 侧栏/日期筛选/缓存命中率进度条/竖向页签/柱图 src 主题）；设置 accent 竖条 + 树选中态描边 + footer ui-Button；ConfirmDialog/ui-Button 统一；AgentPane 信息页密度 + 模型页分组左竖线；RunTrackingView 浓度色阶 + 格子内描边；CreateGroupDialog 洗 NEW + 已选徽章 + 分隔线 | ✅ |
| M18-E 动效与收尾 | 流式点/呼吸/打断脉冲/dropdown fade 随各视图落地；空态文案对齐 src（"开始对话 — 发送第一条消息吧"/"群聊开始 — 发送第一条消息吧"）；移动端抽屉层序；README 对账 | ✅ |

**已知偏差（有意保留，随文档记录）**：
1. 思考强度下拉：本地 ref 待接 conversation/deliver 信封字段（后端尚无 reasoningEffort）；
2. 群简介 textarea：preview 群组无 description 字段 → 占位禁用（显式缩水）；
3. FilePreviewModal 保留 Modal 承载（不引 src 自绘 overlay，内容已对齐）；
4. live 用户轮行内编辑无 message_id → 以"新消息重发"语义（历史记录仍走 truncateAfter）；
5. 矩阵大画布/弦图/工作区树 = 重资产 C 档缩水保留（视觉语言已搬：浓度色阶/排行条）。
6. TurnItem 步链图标用 💭 emoji（src ThoughtIcon 在 AssistantMessage 思考块内已用）。

**验收证据**：`pnpm --filter ac-webui-app typecheck` 零错误 + webui 35 测试通过 +
`vite build` 生产构建成功 + 3830 真连（SPA 200 + /api/workspace/tree JSON 200）+
§8.1-A 令牌审计全绿。

## 9. 附：对照索引

| 内容 | 文件 |
|---|---|
| 星群层逐视图侦察（src 实测） | `docs/m17-recon/style-parity-star-layer.md` |
| 工坊层逐视图侦察（src 实测） | `docs/m17-recon/style-parity-workshop-layer.md` |
| 面板层逐视图侦察（src 实测） | `docs/m17-recon/style-parity-panels.md` |
| src 视图源码（唯一事实源；`docs/archive/*` 归档不参考） | `src/ui/webui/src/{components,settings,ui}/**` |
| preview 视图源码 | `preview/webui/src/{views,components,settings,ui}/**` |
| 令牌/基础样式（两边一致） | `{src,preview}/webui/src/assets/*.css` + `ui/tokens.css` |
