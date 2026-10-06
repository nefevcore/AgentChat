# 标准控件库（webui-kit）：提案 → 定案 → 落地全记录

> 本文合并 cr-116 提案（2026-10-02 制定）与 cr-157 定案（2026-10-03 落地、
> DatePicker 增补 cr-254/260 于 2026-10-05）两份文档——两轮已完成，本文转为
> **已收口的设计裁决存档**（cr-269 文档治理轮合并，2026-10-06）。kit 现状以
> `src/ac-webui-kit` 源码为准；陈列对照页 `src/webui/design/gallery.html`。

## 一、两轮裁决链（谁取代谁）

| 轮次 | 时间 | 裁决 | 状态 |
|---|---|---|---|
| cr-116 提案 | 2026-10-02 | 删减（2 组件 + 4 死形态 + 1 死出口）+ 合并三原语（BusyRing/CollapseRow/DockCard）+ 组合形态归位业务行 | 已落地 |
| cr-121 契约增补 | 2026-10-02 | 对比度定档（三判据）+ 焦点/动效/命中区/可达性四类契约入 kit | 已落地 |
| cr-157 定案 | 2026-10-03 | 表单层（fx-*）与业务层（bx-*）19 族形态标准件化——kit 只有底座/反馈/浮层/结构四层的散乱根因收口 | 已落地 |
| cr-254/260 | 2026-10-05 | DatePicker 表单标准件增补（原生 date 弹层不可定制，自建月历弹层归 kit） | 已落地 |

后续视觉演进（cr-125~131 徽章/行/忙指示收敛、cr-135 色彩丰度、cr-169 表单
迁标准件、cr-214~217 Token 面板链）不在本文范围，见 cr-log.md。

## 二、cr-116 提案（现行有效部分——消费面数据与判定已落地）

### 2.1 webui-kit 出口与消费强度（2026-10-02 实测）

| 控件 | 消费面 | 判定（已执行） |
|---|---|---|
| Icon | 46 文件 | 保留（底座） |
| Modal / Button / Avatar / StarAvatar / starColor / Sheet / PullToRefresh / ThinkingIcon / formatDurationMs / formatFileSize / formatRelativeTime / StatusDot / Tooltip / FeedbackNotice / ToastHost+toast() / RingProgress | 各 1-39 文件 | 保留 |
| StarCard / PulseTrace | **0** | **已删除**（零消费预留原语） |

### 2.2 删减清单（已全部执行）

- **Button**：soft 变体收编进 ghost（soft 仅 2 处 vs ghost 26 处，hover 态全同）——`variant` 收窄为 `primary | ghost | danger`。
- **Avatar**：square 形态零消费裁除，恒为圆形。
- **Sheet**：full 形态与 keepAlive 形态零消费裁除（cr-157 增 right 抽屉形态）。
- **StatusDot**：idle 态与 ok 同色同逻辑且零消费，status 收窄为 `thinking | running | ok | err | offline`。
- **toast**：toastInfo 具名出口零消费裁除（info 经 `toast(text, {tone:'info'})` 仍可达）。

### 2.3 合并原语（已全部入 kit）

- **BusyRing**：琥珀忙指示单源化——原 4 组件 + main.css 各自复制同一 recipe（13px 环 + 琥珀 border-top + 0.8s 旋转），收敛为单原语（size prop）。
- **CollapseRow**：工具卡行 × 思考卡行同构收敛（icon 位 ⇄ 忙指示切换 + 单行截断标题 + 左竖线 + 限高视口 + 吸底跟随）。
- **DockCard**：5 处 dock 卡外壳 recipe 收敛（eyebrow + 标题 + 收起/关闭 + dock 密度）。

### 2.4 组合形态（归位业务行，不进 kit）

消息气泡、输入卡、会话头、审批/提问/排队 dock 卡、工具结果卡——组合方式
标准化但语义耦合深，保留在各业务行包（强迁违反「最少抽象」）。

## 三、cr-121 契约增补（已落地）

### 3.1 对比度定档三判据

1. **徽章 tint 底是最坏底**——状态徽章 / `.tt-*` 标签 / 星色必须按「本色 × 自身 tint 底」校验，而非裸底。
2. **能力标签色相必须双档**：暗底取 300/400 档、亮底取 700/800 档——单值色相不可能同时过两种底。
3. **星色是文字色**（首字/图标）+ 自身 14% tint 底：两个主题各自取档；用户白金色不参与哈希但同样校验。

（具体色值档位表见 cr-121 评审记录，已沉淀进 tokens.css——令牌现值以源码为准。）

### 3.2 四类契约

| 奙约 | 内容 |
|---|---|
| 焦点 | `--focus-ring / -width / -offset` + tokens.css 全局 `:focus-visible`；「input 透明覆盖」形态由 row.css 把环画到可见元素 |
| 动效 | `--motion-scale`：一切时长 `calc(Xs * var(--motion-scale))`，`prefers-reduced-motion` 归零；StarAvatar 运行光环按既有裁决豁免 |
| 命中区 | 统一 `--hit-min`（详见 cr-121） |
| 可达性 | 交互件双通道（title + aria-label）等（详见 cr-121） |
| 对比度 | 8 契约测试锁定（contrast 契约面在 kit 测试） |

## 四、cr-157 表单层/业务层标准件定案（已落地）

> 背景：`webui/gallery.html` 业务区陈列暴露散乱根因——kit 只有底座/反馈/浮层/结构四层，
> 表单层（fx-*）与业务层（bx-*）的 recipe 在各 ac-client-ui-* 包内各自抄写（同名 dd-menu 两处、
> tabs 五套、chip 两套、seg 三套、confirm 三套、树行两套……），视觉细节随每次抄写漂移。
> cr-125~131 收敛了徽章/行/忙指示；本批收敛剩余 19 族形态。

### 4.1 新增 kit 组件（base/，纯展示零依赖）

| 组件 | 归一对象（现居副本） | API 要点 |
|---|---|---|
| Chip | ChatInput file-chip、UserMessage user-file-chip | icon/name/removable/dim；remove 钮命中区 --hit-min |
| Dropdown | ChatInput dd-*、TagChoice tc-option | 无状态容器：trigger slot + menu slot；配方类 .ui-dd-* |
| Tabs | AgentPane agent-tab、TokenUsage tab-bar(竖)、brw-log-tab | items/v-model/variant: line(下划线)/pill(竖栏) |
| DocTabs | FilePreviewPanel fpp-tab、WebSearchPanel wsp-tab | 可关闭文档页签（icon+title+close+add 钮位） |
| Segmented | RunTracking range-toggle、TokenUsage/FileEditsPanel seg-control | items/v-model；凹槽+浮起激活块 |
| OptionRow | InteractionBar ib-option、ChatInput 选项 | 单/多选行（radio/checkbox 语义、selected 态、序号位） |
| PickTag | CreateGroupDialog label-badge、PluginLibraryPane 筛选 | 隐式多选标签钮（on = primary 描边+tint） |
| Progress | TokenUsage progress-track、AgentList 用量条 | value/tone；细进度条 |
| Breadcrumb | EntryPickerModal entry-crumbs | items(label/cur) + click emit |
| IconAction | 9 处 -x / close-x 小关闭钮 | icon=x/chevron-*；视觉 16px、命中 --hit-mini |
| ConfirmBody | 3 处 delete-dialog + Sheet 内容区 | 标题/描述/左钮/右钮语义槽 |
| TreeRow | WorkspaceTreeNode wtn、runview 树行 | 两级缩进 + 展开钮 + 行内 actions |
| DatePicker | （cr-254/260 新增） | 自建月历弹层：ui-dd 同语言 + Teleport fixed 锚定 + 方向键可达；200px 定宽 7×24 日格、月↔年两级视图 |

（Sheet 增 `side: bottom|right`——右抽屉形态 GroupDrawer 迁此，宽 320、滑入 ≤200ms。）

### 4.2 不进 kit 的业务形态（语义耦合，维持原位）

tc-pill 三段胶囊（启停+档位双触发）、TokenGauge（RingProgress 组合）、QR 框、resize 手柄、
member 网格、drawer 分节列表——组合件/域语义，强迁必改行为。

### 4.3 落地记录（Phase A/B/C 全批 + DatePicker）

- **Phase A**：12 组件 + dropdown.css + row.css --tree/--pool 变体 + Avatar badge + badge.css 角标全局配方 + Sheet side=right 全部落地；index.ts/package.json 出口齐。
- **Phase B**：画廊新增「7.5 标准件层」（9 陈列格，双主题截图过目）；业务层瘦身为真业务形态；注入清单 14→25 组件 + dropdown.css，preview-kit-sync 测试锁同步。
- **Phase C**：conversation（dd 族→ui-dd 配方 65 处、file-chip→Chip、ib-option→OptionRow、user-file-chip→Chip dim）、workspace（wtn→ui-row--tree、fpp-tab→DocTabs、entry-crumbs→Breadcrumb）、agents（agent-tab→Tabs、tc-option→ui-dd 配方、unread-badge→ui-avatar-badge）、usage（tab-bar→Tabs pill、seg-control→Segmented、progress-track→Progress）、runview（range-toggle→Segmented）、web（wsp-tab→DocTabs）、browser（brw-log-tab→Tabs）、group（delete-dialog→ConfirmBody）、singles（archive→ConfirmBody）、desktop-storage（confirm→ConfirmBody left）、layout/jobs（角标→ui-avatar-badge，#ef4444 硬编码 5 处全数退役）。
- **判定修正**：FileEditsPanel「seg」命中为 diff segment 数据词（非分段器）不迁；PoolManager/SearchPool 池行 cr-125 已迁 ui-row 横排带行内 actions（--pool 纯展示变体为画廊陈列形态，业务无消费者）。
- **验证**：pnpm typecheck / webui:typecheck / test:unit（2342 passed）/ check:deps / 定向 eslint / contrast 8 契约 / preview-kit-sync / tag-choice 选择器同步 / activity-bar-unread——全绿。

## 五、裁决链终点与现状

kit 目标形态（底座/反馈/浮层/结构 + 表单层 + 业务层标准件 + 四类契约）已全部落地。
后续控件演进不再经本文——直接以 kit 源码与 gallery 陈列页为事实源，新控件入 kit
走正常 CR 流程。

---

## 附：合并记录（2026-10-06，cr-269）

- `webui-standard-controls-proposal.md`（cr-116 提案，14.9KB）与
  `webui-standard-controls-cr157.md`（cr-157 定案，6.2KB）合并为本文件。
  两份原件已 `git mv` 至 `src/docs/archive/`（历史可溯）。
- 合并原则：两轮裁决均已落地，过程性「提案 → 评审 → 定案」叙事压缩为裁决链
  一览表 + 现行有效内容分节保留；消费面数据标注实测日期。
