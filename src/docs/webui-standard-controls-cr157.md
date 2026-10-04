# 标准控件库 cr-157：表单层与业务层标准件定案

> 背景：`webui-gallery.html` 业务区陈列暴露的散乱根因——kit 只有底座/反馈/浮层/结构四层，
> 表单层（fx-*）与业务层（bx-*）的 recipe 在各 ac-client-ui-* 包内各自抄写（同名 dd-menu 两处、
> tabs 五套、chip 两套、seg 三套、confirm 三套、树行两套……），视觉细节随每次抄写漂移。
> cr-125~131 收敛了徽章/行/忙指示；本批收敛剩余的 19 族形态。

## 一、新增 kit 组件（base/，纯展示零依赖）

| 组件 | 归一对象（现居副本） | API 要点 |
|---|---|---|
| Chip | ChatInput file-chip、UserMessage user-file-chip | icon/name/removable/dim；remove 钮命中区 --hit-min |
| Dropdown | ChatInput dd-*、TagChoice tc-option | 无状态容器：trigger slot + menu slot；menu/option/divider/group-label 配方类 .ui-dd-* |
| Tabs | AgentPane agent-tab、TokenUsage tab-bar(竖)、brw-log-tab | items/v-model/variant: line(下划线)/pill(竖栏) |
| DocTabs | FilePreviewPanel fpp-tab、WebSearchPanel wsp-tab | 可关闭文档页签（icon+title+close+add 钮位） |
| Segmented | RunTracking range-toggle、TokenUsage/FileEditsPanel seg-control | items/v-model；凹槽+浮起激活块 |
| OptionRow | InteractionBar ib-option、ChatInput 选项 | 单/多选行（radio/checkbox 语义、selected 态、序号位） |
| PickTag | CreateGroupDialog label-badge、PluginLibraryPane 筛选 | 隐式多选标签钮（on = primary 描边+tint） |
| Progress | TokenUsage progress-track、AgentList 用量条 | value/tone；细进度条 |
| Breadcrumb | EntryPickerModal entry-crumbs | items(label/cur) + click emit |
| IconAction | 9 处 -x / close-x 小关闭钮 | icon=x/chevron-*；视觉 16px、命中 --hit-min |
| ConfirmBody | 3 处 delete-dialog + StorageHost confirm-body | title/text/confirmText/danger；emit confirm/cancel；居中排版单源 |

## 二、扩展既有件

- row.css：`.ui-row--tree`（细行紧凑：3px 6px、fs-sm）、`.ui-row--tree.is-active`（primary-light 底）、
  `.ui-row--pool`（两行主从：name fs-md 500 + detail fs-xs text-3）——树行（WorkspaceTreeNode wtn、RunTrackingPanel）、
  池行（PoolManager/SearchPool pool-entry）迁此。
- Avatar：`badge?: number | true`——右上角标（计数红底 --err-rgb / 红点），替换 AgentList unread-badge、
  MobileTabBar 内联角标（--ef4444 硬编码随之退役为令牌派生）。
- Sheet：`side: bottom|right`——右抽屉形态（GroupDrawer drawer-panel 迁此；宽 320、滑入 ≤200ms）。

## 三、不进 kit 的业务形态（语义耦合，维持原位）

tc-pill 三段胶囊（启停+档位双触发）、TokenGauge（RingProgress 组合）、QR 框、resize 手柄、
member 网格、drawer 分节列表——组合件/域语义，强迁必改行为。

## 四、迁移面（Phase C 逐包）

conversation（ChatInput dd/chip、InteractionBar、FileEditsPanel seg、UserMessage chip、EntryPicker 无）、
workspace（FilePreviewPanel/DocTabs 化、WorkspaceTreeNode tree-row、EntryPickerModal crumb）、
agents（AgentPane Tabs、TagChoice option→Dropdown 配方、AgentList badge）、usage（Tabs+Segmented+Progress）、
runview（Segmented）、web（DocTabs）、browser（Tabs line）、group（Sheet right、PickTag、ConfirmBody）、
singles（ConfirmBody）、desktop-storage（ConfirmBody）、llm-pool/search-pool（pool 行变体）、
layout（MobileTabBar 角标→Avatar badge 语义、IconAction）。

## 五、画廊重建

`webui-gallery.html` 重写：kit 六层 + 表单层 + 业务层三段结构保留，业务区陈列**只列 kit 标准件实物**，
不再陈列散乱副本；kit 片段仍由 build-webui-preview.mjs 注入（新组件样式块加入注入清单）。

## 六、落地记录（2026-10-03）

- Phase A：12 组件 + dropdown.css + row.css --tree/--pool 变体 + Avatar badge + badge.css 角标全局配方 +
  Sheet side=right 全部落地；index.ts/package.json 出口齐。
- Phase B：画廊新增「7.5 标准件层」（9 陈列格，双主题截图过目）；业务层瘦身为真业务形态（tc 胶囊/gauge/
  drawer/qr/layout）；注入清单 14→25 组件 + dropdown.css，preview-kit-sync 测试锁同步。
- Phase C：conversation（dd 族→ui-dd 配方 65 处、file-chip→Chip、ib-option→OptionRow、user-file-chip→Chip dim）、
  workspace（wtn→ui-row--tree、fpp-tab→DocTabs、entry-crumbs→Breadcrumb）、agents（agent-tab→Tabs、
  tc-option→ui-dd 配方、unread-badge→ui-avatar-badge）、usage（tab-bar→Tabs pill、seg-control→Segmented、
  progress-track→Progress）、runview（range-toggle→Segmented）、web（wsp-tab→DocTabs）、browser（brw-log-tab→
  Tabs）、group（delete-dialog→ConfirmBody）、singles（archive→ConfirmBody）、desktop-storage（confirm→
  ConfirmBody left）、layout/jobs（角标→ui-avatar-badge，#ef4444 硬编码 5 处全数退役）。
- 判定修正：FileEditsPanel「seg」命中为 diff segment 数据词（非分段器）不迁；PoolManager/SearchPool 池行
  cr-125 已迁 ui-row 横排带行内 actions（--pool 纯展示变体为画廊陈列形态，业务无消费者）。
- 验证：pnpm typecheck / webui:typecheck / test:unit（2342 passed）/ check:deps / 定向 eslint / contrast 8 契约 /
  preview-kit-sync / tag-choice 选择器同步 / activity-bar-unread——全绿。

## 七、验证

每包迁移后：`pnpm typecheck && pnpm webui:typecheck && npx vitest run src/webui/tests` + 定向 eslint；
全批完成后 `pnpm test:unit && pnpm check:deps`，画廊 `node scripts/build-webui-preview.mjs` 注入同步。