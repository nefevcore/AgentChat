# m17-recon · src 轨「工坊层（会话/消息区）」布局与样式精确规格

> 基准：仓库根 `src/ui/webui/src/`（@agentchat/webui，旧轨）。纯读分析，未修改任何 src 文件。
> 对照物：`preview/webui/src/`（原生面）——`views/ChatView.vue`、`components/ChatInput.vue`、`components/chat/TurnItem.vue`、`components/chat/ToolCard.vue`、`views/FilePreviewModal.vue`（另补充预览面的 `InteractionBar.vue`、`shared/TypingIndicator.vue` 与 `ui/tokens.css`）。
> 用途：为「preview 原生面 vs src 轨道页面布局/风格完全对齐」提供工坊层（会话头部 + 消息滚动区 + 输入区 + turn/气泡/工具卡/文件预览）逐文件规格、令牌映射与迁移落点。
>
> **令牌层关键事实**（全文 CSS 规则都建立在此之上）：
> - 双令牌体系并存。`assets/main.css` 定义 `--color-*`（业务旧层）+ 若干独有变量；`ui/tokens.css`（**后加载**）定义 `--bg-* / --text-* / --primary / --line / --r-* / --space-N`（L0 新层），并以**别名层**把 `--color-*` 重定向到 L0（`--color-primary: var(--primary)` 等）。
> - 未纳入别名、仍由 main.css 独有维护的变量：`--color-bg-user-container`、`--color-bg-assistant`、`--color-code-bg`、`--color-code-border`、`--color-code-toolbar`、`--color-danger-light`、`--layout-header-height`(48px)、`--layout-content-max-width`(840px)、`--layout-sidebar-width`(260px)、`--space-xl`(40px)、`--transition-fast/normal/slow`。
> - preview 与 src 的 `ui/tokens.css` **内容完全一致**（203 行逐字节相同），所以 L0 令牌两轨通用；差异只在业务组件是否走 `--color-*` 别名（src 全线走，preview 新文件如 FilePreviewModal/`ui/*` 已直接写 `--text-*/--line/--r-*`）。
> - 圆角/间距刻度：`--r-sm/md/lg/full = 4/8/12/999px`；`--space-1..6 = 4/8/12/16/20/24px`；别名 `--space-md = --space-4 = 16px`、`--space-sm = --space-2 = 8px`。
> - 主题：深空 Nebula（默认/`html.dark`）主色 `#818cf8`；晨曦 Aurora（`html.light`）主色 `#6366f1`。`--glow-primary/--glow-soft = none`（工坊层已扁平化，无发光）。

---

## §1 `components/dialog/DialogView.vue` —— 会话主视图

### A. DOM 结构树

```
div.chat-view                                   (v-if="dialogId"; flex column, flex:1, overflow hidden)
├─ div.chat-header                              (height var(--layout-header-height)=48px; padding 0 16px; border-bottom; backdrop blur 8px; z-index 100)
│  ├─ button.hamburger-btn                      (窄屏才显示; svg 三横线 20px)
│  ├─ div.header-info
│  │  └─ span.agent-label                       (15px / 600 / text-primary)
│  ├─ span.participant-count                    (仅 group; 12px / tertiary)
│  └─ div.header-actions                        (margin-left auto; gap 2px)
│     ├─ div.session-token-gauge                (仅 direct & messageCount>0; .gauge-bar>.gauge-fill + .gauge-pct)
│     ├─ div.compress-wrap                      (仅 direct; .compress-btn + .compress-feedback + .busy-feedback)
│     ├─ button.settings-btn                    (direct/single; System Prompt 预览, Icon file-text 18)
│     ├─ button.settings-btn                    (direct/single 非预设; Agent 配置, Icon settings 18)
│     ├─ div.more-menu-wrapper                  (direct/single; .settings-btn + .more-dropdown > .dropdown-item/.dropdown-divider)
│     └─ button.settings-btn                    (仅 group; Icon more-horizontal 18)
├─ div.connection-status                        (断线横幅, 非 group; [WARN] 文案)
├─ div.chat-body                                (flex:1; flex row; overflow hidden)
│  ├─ div.chat-main                             (flex:1; flex column; min-width 0)
│  │  ├─ div.messages-wrapper                   (flex:1; position relative; overflow hidden)
│  │  │  ├─ div.messages-container              (ref=messagesContainer; @scroll=shell.onScroll; overflow-y auto; padding var(--space-md)=16px)
│  │  │  │  └─ div.messages-content             (flex column; gap var(--space-sm)=8px; width 100%; max-width 100%; min-height 100%)
│  │  │  │     ├─ div.empty-state               (空态: svg 图标 + 一句话 / history-spinner)
│  │  │  │     ├─ div.history-loading           (顶部续拉指示: .history-spinner + text)
│  │  │  │     ├─ div.time-separator            (> span.time-separator-text)
│  │  │  │     ├─ div.event-separator           (> span.event-separator-time + span.event-separator-text)
│  │  │  │     ├─ div.error-separator           (> span.error-separator-time + span.error-separator-text)
│  │  │  │     └─ TurnDisplayItem (v-else; 每 turn 一条)
│  │  │  └─ button.scroll-to-bottom-btn         (v-if=isUserScrolledUp; 回到底部, svg chevron)
│  │  └─ ChatInput                              (group 走 onSend/disabled; 否则 :single)
│  └─ GroupDrawer                               (仅 group; drawer-slide transition)
├─ Modal (width 380; 删除确认 .delete-dialog)
├─ Modal (width 700; System Prompt 预览 .system-prompt-dialog)
└─ Modal (width 700; 工具定义预览, 复用 .system-prompt-dialog)
```

### B. 布局规格

| 项 | 值 |
|---|---|
| 气泡最大宽 | 由 `TurnDisplayItem .turn-item { max-width:70% }` 统一管控（相对 `messages-content` 100% 宽）；本文件不设宽 |
| 对齐规则 | 用户/本人 turn 右对齐（`.turn-right { margin-left:auto; align-items:flex-end }`）；助手/他人左对齐 |
| 消息区 padding | `messages-container padding: var(--space-md)` = **16px**（≤768px 窄屏降为 `var(--space-sm)` 8px） |
| 消息列间距 | `messages-content gap: var(--space-sm)` = 8px |
| 最大内容宽 | **无**（`max-width:100%` 撑满容器，不居中收窄；`--layout-content-max-width:840px` 在 src 会话视图里**未被使用**） |
| 头部 | 固定高 `48px`，`padding 0 16px`，`gap 10px`，底边框 1px，`backdrop-filter blur(8px)` + `z-index 100`（毛玻璃吸顶观感） |
| 滚动容器语义 | `messages-container` 自持滚动（`overflow-y:auto; overflow-x:hidden`），配合 `useChatShell`（`onScroll` → `isUserScrolledUp` → 回到底部按钮 + 顶部阈值触发加载更多）；滚动条 6px 定制 |
| 回到底部按钮 | `position:absolute; bottom:12px; right:16px; 40×40px` 圆形，border + `box-shadow 0 2px 8px rgba(0,0,0,.12)`，hover 上浮 |

### C. 关键 CSS 规则提炼

| 选择器 | 声明要点 | 令牌变量 |
|---|---|---|
| `.chat-view` | `flex:1; min-width:0; flex-direction:column; overflow:hidden` | `--color-bg-page` |
| `.chat-header` | `height 48px; padding 0 16px; gap 10px; border-bottom 1px; backdrop-filter blur(8px); z-index 100; flex-shrink 0` | `--layout-header-height` / `--color-border-secondary` / `--color-bg-page` |
| `.agent-label` | `font-size 15px; font-weight 600` | `--color-text-primary` |
| `.messages-container` | `overflow-y auto; overflow-x hidden; padding 16px` | `--space-md` |
| `.messages-content` | `flex column; gap 8px; width/max-width 100%; min-height 100%` | `--space-sm` |
| `.messages-container::-webkit-scrollbar` | `width 6px`（thumb `--color-border-primary`，hover `--color-primary`） | — |
| `.time-separator-text` | `12px; letter-spacing .5px; padding 2px 12px` | `--color-text-muted` |
| `.event-separator` | `居中列; max-width 720px; margin 4px auto; padding 0 42px` | — |
| `.error-separator-text` | `12px; text-align center` | `--color-error` |
| `.scroll-to-bottom-btn` | `40×40 圆形; border 1px; shadow; transition .2s; hover translateY(-1px)` | `--color-border-primary` / `--color-bg-page` / `--color-text-secondary` |
| `.session-token-gauge .gauge-bar` | `72×6px; radius 3px; overflow hidden` | `--color-bg-hover`(fallback rgba) |
| `.gauge-fill.low/.moderate/.high/.critical` | 宽度百分比填充；四档硬编码 `#22c55e/#eab308/#f97316/#ef4444` | 硬编码状态色 |
| `.more-dropdown` / `.dd-menu` / `.ib-menu` | 同一套 `radius 10px; padding 4px; shadow-pop` 弹出语义 | `--bg-raised` / `--line` / `--shadow-pop` |
| `.dropdown-item` | `8px 12px; radius 6px; 13px; hover 底色` | `--text-1` / `--role-hover-bg` |

### D. 与 preview 对应物（`ChatView.vue`）差异清单

| 维度 | src `DialogView` | preview `ChatView` |
|---|---|---|
| 头部 | 固定 48px + `backdrop blur(8px)`；`hamburger` + 标题 + token 进度条 gauge + 压缩 + 多个 icon `settings-btn` + 更多菜单 | `padding 10px 16px` 无固定高、无 blur；标题 + token-meter 药丸文字 + 文字型 `header-btn`（归档/设置） |
| 内容宽 | `messages-content max-width:100%` 撑满 | `messages-container max-width:var(--layout-content-max-width)=840px` 居中收窄 |
| 时间分隔 | 纯居中文字（无横线） | `sep-line` 两侧横线 + 中间 label |
| 历史渲染 | 完整 `TurnDisplayItem` + `UserMessage/AssistantMessage` 组件树 | `record-row / record-bubble` 简化内联 + `TurnItem`（live） |
| token 仪表 | `gauge-bar` 进度条 + 百分比四档色 | `token-meter` 药丸文字（≈N tokens · M 条 · 状态） |
| 空态 | svg 图标（opacity .2）+ 一句话，居中 | `empty-title`(16px) + `empty-hint`(13px) |
| 消息区结构 | `chat-body > chat-main > messages-wrapper > messages-container`（wrapper 是定位容器，container 才滚动） | `messages-wrapper` 直接作为滚动容器（`ref=container` + `@scroll`） |

### E. 迁移落点建议

1. 头部对齐：改 `padding 10px 16px` 为固定 `height:48px` + `padding:0 16px` + `backdrop-filter:blur(8px)` + `z-index:100`；把文字型 `header-btn` 换成 icon `settings-btn`（`padding 6px; radius-sm; hover 底色`）。
2. token 仪表：把 preview 的 `token-meter` 药丸升级为 `gauge-bar` 进度条 + 百分比（`.gauge-fill` 四档色），保留 `usagePercent` 语义。
3. 决定内容宽策略：若追求"完全对齐"，preview 需去掉 `840px` 居中，改为 `max-width:100%` 撑满；若保留收窄需在文档标注为 preview 有意差异。
4. 时间分隔：preview 保留 `sep-line` 或对齐 src 的纯文字居中（二选一，需决策）。
5. 滚动容器语义已基本一致（`useChatShell`），仅需把 `messages-wrapper`/`messages-container` 的层级命名对齐 src（wrapper=定位层、container=滚动层）。

---

## §2 `components/ChatInput.vue` —— 输入区（星港）

### A. DOM 结构树

```
div.chat-input                                (flex column; gap 6px; padding 10px; radius-lg 12px; margin 0 10px 10px; border; shadow)
├─ div.file-preview-bar                       (v-if attachedFiles; .file-chip > .file-chip-name + button.file-chip-remove)
├─ InteractionBar                             (ask_questions 触发器, 输入框上方)
├─ textarea                                   (v-model; rows=3; min-height 56px; transparent; placeholder 动态)
└─ div.input-toolbar                          (flex; justify-content space-between; gap 8px)
   ├─ div.toolbar-left                        (flex; gap 4px; flex-wrap; min-width 0)
   │  ├─ div.dd (工作区, 仅 single)            > button.select-btn (.open) + Transition>div.dd-menu>button.dd-option
   │  ├─ div.dd (Agent, 仅 single)             > button.select-btn.agent-btn (.locked) + dd-menu (Avatar 18 / Icon sparkles)
   │  ├─ div.dd (模型, 仅 single)              > button.select-btn + dd-menu (默认模型 + pools)
   │  └─ div.dd (思考强度, 常显)               > button.select-btn (.off) + dd-menu (思考·关/Low/High/Max)
   └─ div.toolbar-right                       (flex; gap 4px; flex-shrink 0)
      ├─ button.icon-btn                       (附件; Icon paperclip 17; uploading-spinner 覆盖)
      └─ button.icon-btn.send-btn              (发送; Icon send 16; .interrupting 变橙 + pulse)
```

### B. 布局规格

| 项 | 值 |
|---|---|
| 输入区容器 | `padding 10px; gap 6px; border 1px var(--color-border-secondary); border-radius var(--radius-lg)=12px; margin 0 10px 10px; box-shadow 0 1px 3px rgba(0,0,0,.05)`；背景 `--color-bg-page`（非 surface） |
| textarea | 无边框透明；`min-height 56px; font-size 14px; line-height 1.5; resize none; outline none`；focus 无 outline |
| 圆角 | 容器 12px（`--radius-lg`）；textarea/select-btn/icon-btn 8px（`--radius-md`）；file-chip 4px（`--radius-sm`） |
| 聚焦态 | 无外框；下拉按钮 `.open` 用 `#eff0f1`（dark `#1a1f2c`）底 + 选中文字 `#4f46e5` |
| 工具栏高度 | `select-btn` 高 28px（`padding 0 8px`）；`icon-btn` 30×28px |
| 下拉 | 向上弹出 `bottom: calc(100% + 6px)`；`min-width 160px; max-height 260px; radius 10px; padding 4px; box-shadow shadow-pop` |
| 发送按钮 | `icon-btn.send-btn` 30×28px 主色实底圆角方块 + `box-shadow var(--shadow-primary)`；hover 主色 hover + 扩 shadow；打断态橙色 + `pulse-interrupt` 呼吸 |

### C. 关键 CSS 规则提炼

| 选择器 | 声明要点 | 令牌变量 |
|---|---|---|
| `.chat-input` | `flex column; gap 6px; padding 10px; border 1px; radius 12px; margin 0 10px 10px; shadow .05` | `--color-border-secondary` / `--radius-lg` / `--color-bg-page` |
| `textarea` | `min-height 56px; 14px; line-height 1.5; resize none; background transparent` | `--color-text-primary` |
| `.select-btn` | `height 28px; padding 0 8px; 12px/500; radius-md; transition-fast` | `--color-text-secondary` |
| `.select-btn.open` | `background #eff0f1; color #4f46e5`（`html.dark` 下 `#1a1f2c`） | `--role-selected-text`(fallback #4f46e5) |
| `.dd-menu` | `bottom calc(100%+6px); min-width 160px; max-height 260px; radius 10px; padding 4px; shadow-pop; z-index 300` | `--bg-raised` / `--line` / `--shadow-pop` |
| `.file-chip` | `2px 8px; radius-sm; 12px` 主色底 + 主色描边 | `--color-primary-light` / `--color-primary` |
| `.send-btn` | `30×28px; radius-md; bg primary; color #fff; shadow-primary` | `--color-primary` / `--shadow-primary` |
| `.send-btn.interrupting` | `bg warning; animation pulse-interrupt 1.5s`（box-shadow 扩散 0→6px） | `--color-warning` |
| `@keyframes pulse-interrupt` | `0%/100% 0 0 0 0 rgba(230,126,34,.4)` → `50% 0 0 0 6px rgba(230,126,34,0)` | 硬编码橙 |

### D. 与 preview 对应物（`ChatInput.vue`）差异清单

| 维度 | src | preview |
|---|---|---|
| 容器背景 | `--color-bg-page` + `box-shadow 0 1px 3px .05` | `--color-bg-surface`，无 shadow |
| 工具栏左侧 | 4 个 `select-btn` 下拉（工作区/Agent/模型/思考强度；前 3 个仅 single 显示） | 仅 `attach-btn`（"📎 附件"文字按钮）+ `input-hint`（忙碌提示） |
| 发送按钮 | icon 方块（Icon send 16，30×28px，主色底） | 文字按钮"发送"（`padding 6px 16px; radius-md; 13px`） |
| 附件 chip | 主色药丸 `file-chip`（primary-light 底 + primary 描边，radius-sm） | `attach-chip` 白底圆角 999px + 主色 `chip-file` 文字 |
| 打断态 | `store.contextBusy` → send 变橙 + 呼吸动画 | `busy` → send 文案变"打断并发送"（`#f97316` + pulse 1.2s） |
| textarea 行高 | `line-height 1.5` | `line-height 1.6` |
| 思考强度 | **有**（`reasoningEffort ''/low/high/max`，默认 high，映射 `deepThink/reasoningEffort`） | 无此下拉 |

### E. 迁移落点建议

1. 容器 `bg-surface → bg-page` + 加 `box-shadow 0 1px 3px`。
2. 引入思考强度下拉（src 默认 high，是 P4 语义，preview 需接 `deepThink` 字段）；single 场景补工作区/Agent/模型三下拉（preview 的 single 语义是否已有对应数据源需核对后端面）。
3. 发送按钮从文字改为 icon 方块（保留打断态变橙 + 呼吸）。
4. 附件 chip 改主色药丸（去白色底）。
5. 下拉统一为向上弹出（`bottom calc(100%+6px)`）+ 10px 圆角 + 4px padding。

---

## §3 `components/InteractionBar.vue` —— ask_questions 决策条

### A. DOM 结构树

```
div.interaction-bar                           (position relative; flex; margin-bottom 8px)
├─ button.ib-trigger                          (药丸; .open 态)
│  ├─ span.ib-trigger-dot   (●, 8px)
│  ├─ span.ib-trigger-text  (question, 溢出省略 max-width 220px)
│  └─ span.ib-trigger-caret (▾, 10px)
└─ (Transition dropdown) div.ib-menu          (v-if menuOpen; absolute top calc(100%+4px) left 0; width max-content)
   ├─ div.ib-menu-header
   │  ├─ span.ib-asker     (agent_id 药丸, 11px/600 primary-light 底)
   │  └─ span.ib-question  (13px/1.45 text-primary)
   ├─ button.ib-item (v-for options)          (span.ib-item-text + span.ib-item-arrow ›)
   └─ div.ib-item.ib-item-custom              (input.ib-custom-input + button.ib-custom-send 回复)
```

### B. 布局规格

| 项 | 值 |
|---|---|
| 触发器 | 非全宽药丸 `inline-flex; gap 6px; padding 5px 12px; border 1px var(--color-primary-light); radius 999px; bg var(--color-primary-light); 12px`；文字色 `--color-primary` |
| 触发器文本 | `max-width 220px; ellipsis nowrap` |
| 菜单 | 非全宽 `width:max-content; min-width 240px; max-width min(340px, 82vw); top calc(100%+4px); radius 10px; padding 4px; box-shadow shadow-pop; z-index 300` |
| 选项 | `.ib-item` `8px 12px; radius 6px; 13px; hover role-hover-bg; active primary-light` |
| 自定义输入 | `.ib-custom-input` `6px 10px; radius 6px; 13px; focus 主色描边`；`.ib-custom-send` 主色实底 `6px 12px; radius 6px; 12px` |

### C. 关键 CSS 规则提炼

| 选择器 | 声明要点 | 令牌变量 |
|---|---|---|
| `.ib-trigger` | `5px 12px; radius 999px; 主色 light 底 + 主色描边; 12px` | `--color-primary-light` / `--color-primary` |
| `.ib-trigger.open` | 底加深 + 描边变主色 | `--color-primary` |
| `.ib-menu` | `max-content; min 240px; max min(340px,82vw); radius 10px; padding 4px; shadow-pop` | `--bg-raised` / `--line` / `--shadow-pop` |
| `.ib-asker` | `11px/600; primary-light 底; radius 999px; padding 1px 8px` | `--color-primary` / `--color-primary-light` |
| `.ib-item:hover` | `role-hover-bg` | `--role-hover-bg` |
| `.ib-custom-send` | `6px 12px; radius 6px; 主色底白字` | `--color-primary` |
| `.dropdown-*` | `0.12s; opacity + translateY(-4px)` | — |

### D. 与 preview 对应物（`InteractionBar.vue`）差异清单

| 维度 | src | preview |
|---|---|---|
| 状态源 | `chatStore.interaction` 单槽 + `interaction_id` 门控 + `timeout_ms` 自动关闭 + `agent_id` 会话归属门控 | `interactionStore` 队列（`questions[]` 数组，逐题作答 `answers[]`） |
| 触发器宽度 | 非全宽（内容宽，`max-width:100%`） | `width:100%` 全宽 |
| 菜单宽度 | 非全宽 `max-content`（max 340px） | `left:0; right:0` 全宽（max-width 340px 但拉满） |
| 忽略按钮 | 无 | 有 `ib-menu-footer > ib-dismiss`（"忽略"） |
| 徽标 | `.ib-asker` 显示 `agent_id` 文本 | `.ib-badge` 显示 `owner` |
| 视觉令牌 | 完全一致（primary-light 药丸 + 999px + 10px 菜单） | 同源 |

### E. 迁移落点建议

视觉上基本照搬即可（src 与 preview 同源，差异只在数据面）。迁移动作：① 保留 preview 的队列逐题语义（比 src 单槽更完整）；② 触发器从全宽改非全宽（`width:max-content` 语义，或至少 `inline-flex` 不拉满）；③ 补"忽略"按钮（preview 已有）；④ 菜单圆角统一 10px。

---

## §4 `components/chat/ScrollableViewport.vue` —— 滚动容器

### A. DOM 结构树

```
div.scrollable-viewport        (:style max-height = props.maxHeight || '60vh')
└── <slot />
```

### B. 布局规格

| 项 | 值 |
|---|---|
| 滚动 | 仅 `overflow-y:auto`（横向不限制，交给内部组件） |
| 高度 | `max-height` 由 prop 控制，默认 `60vh`；无 padding、无滚动条定制（继承全局 `*::-webkit-scrollbar 8px`） |
| 语义 | **纯工具组件**，只给工具卡内部视口（Terminal 命令区 260px/输出 40vh/30vh、Code 视口、Edit diff 视口）用；**会话主滚动区不走它**（DialogView 用自己的 `messages-container` + `useChatShell`） |

### C. 关键 CSS 规则提炼

| 选择器 | 声明要点 | 令牌变量 |
|---|---|---|
| `.scrollable-viewport` | `overflow-y:auto` | — |

### D. 与 preview 对应物差异清单

preview 存在同名 `ScrollableViewport.vue`（结构一致）。差异仅在使用处：preview `ToolCard` 用 `<ScrollableViewport max-height="40vh">` 整体包裹专用组件；src `ToolMessage` 内联渲染专用组件，由各专用组件（Terminal/Code）内部自行分块 `ScrollableViewport`（命令 260px、输出 40vh/30vh）。

### E. 迁移落点建议

原样平移；`maxHeight` 默认 60vh 保留。迁移时注意把 preview ToolCard 的「整体 40vh」改为 src 的「各专用组件分段高度」以获得更精确的终端/代码视口。

---

## §5 `components/chat/Message/TurnDisplayItem.vue` —— turn 容器

### A. DOM 结构树

```
div.turn-item                    (:class .turn-right(本人) / .turn-left(他人); flex column; gap 8px; max-width 70%)
│
├─ (无链 && final) 纯文本分支:
│  ├─ div.turn-bubble.turn-bubble-right   (finalViewId==='user') > UserMessage
│  ├─ div.turn-bubble.turn-bubble-left    (assistant)            > AssistantMessage
│  └─ div.turn-bubble...                  (插件 renderer)         > <component :is>
│
└─ (有链 hasChain) 含折叠栏分支:
   └─ div.turn-chain-row                  (flex; gap 10px; width 100%)
      ├─ div.turn-avatar                  (仅 !isSelf && senderAvatar; Avatar size 32)
      └─ div.turn-chain-col               (flex column; gap 6px; flex 1)
         ├─ div.turn-sender-name          (仅 !isSelf; 12px / text-secondary)
         ├─ div.chain-header              (@click toggleExpand; .expanded 时 sticky)
         │  ├─ ThinkingIcon (14, .chain-icon)
         │  ├─ span.chain-label           ("思考过程（共 N 步，共用时 X 秒）")
         │  ├─ span.streaming-dots        (v-if 流式且 running; .dot.dot-yellow + .dot.dot-gray×2)
         │  └─ svg.collapse-chevron       (.expanded rotate 90deg)
         ├─ div.chain-body                (v-show expanded; border-left; 每步)
         │  ├─ AssistantMessage (compact, show-copy false, 仅 thinking)
         │  ├─ ToolMessage × N
         │  └─ div.chain-step-content > AssistantMessage (compact, 步正文)
         └─ div.turn-bubble.turn-bubble-right/left (finalMsg; AssistantMessage with regenerate/delete)
```

### B. 布局规格

| 项 | 值 |
|---|---|
| 气泡最大宽 | **`max-width: 70%`**（turn-item 顶层；预览面为 82%，是核心差异） |
| 对齐 | `.turn-left { align-items:flex-start }`；`.turn-right { align-items:flex-end; margin-left:auto }` |
| 头像 | 左侧 32×32px 圆形（`.turn-avatar` / `.msg-avatar`），有链才在 turn 层显头像；无链时头像在 UserMessage/AssistantMessage 内部 |
| 思维链头 | `.chain-header` 裸文本行（`gap 6px; 12px/500`）；**展开时 `position:sticky; top:calc(var(--space-md)*-1)=-16px`** 吸附到消息区顶部（抵消容器 padding，滚动途中可快速折叠），`z-index 5; bg page` |
| 步链缩进 | `.chain-body` `border-left 1px var(--color-border-secondary); margin-left 7px(对齐14px图标中心); padding-left 14px`；内部 AI 气泡正文字号降为 12px |
| 流式点 | `dot-yellow #e6a817` / `dot-gray #a8abb2`，4×4px，`dot-pulse 1.4s` |

### C. 关键 CSS 规则提炼

| 选择器 | 声明要点 | 令牌变量 |
|---|---|---|
| `.turn-item` | `flex column; gap 8px; max-width 70%` | — |
| `.turn-right` | `align-items flex-end; margin-left auto` | — |
| `.turn-chain-row` | `flex; gap 10px; width 100%` | — |
| `.turn-sender-name` | `12px; padding 0 2px` | `--color-text-secondary` |
| `.chain-header` | `flex; gap 6px; 12px/500; cursor pointer; transition color .15s` | `--color-text-secondary` |
| `.chain-header.expanded` | `position sticky; top -16px; z-index 5; bg page` | `--space-md` / `--color-bg-page` |
| `.chain-body` | `flex column; gap 6px; border-left 1px; margin-left 7px; padding-left 14px` | `--color-border-secondary` |
| `.chain-body :deep(.assistant-bubble .markdown-body)` | `font-size 12px` | — |
| `.dot-yellow` / `.dot-gray` | `#e6a817` / `#a8abb2`；`@keyframes dot-pulse 1.4s` | 硬编码 |

### D. 与 preview 对应物（`TurnItem.vue`）差异清单

| 维度 | src `TurnDisplayItem` | preview `TurnItem` |
|---|---|---|
| 最大宽 | **70%** | **82%** |
| 头像 | 左侧独立 32px 圆形 `Avatar` 列 | 内联在 sender-name 行的 `StarAvatar` 22px |
| 思维链形态 | 裸文本行 `chain-header`（展开时 sticky 吸附顶部） | 带边框卡片 `chain`（border 1px + radius-md + bg-surface；header `8px 12px` 13px） |
| 步链缩进 | `chain-body` margin-left 7px + border-left + padding-left 14px | `chain-step` border-left + padding-left 10px（外层还有 chain-body padding 0 12px 12px） |
| 组件拆分 | 拆 `UserMessage`/`AssistantMessage`/`ToolMessage` 独立组件 | 全部内联 + `ToolCard` |
| 气泡圆角 | 6px（下游气泡组件） | 12px（内联气泡） |
| 动作行 | 在 AssistantMessage/UserMessage 内（hover 显现 icon 按钮） | turn 级 `turn-actions` 文字按钮（↻ 重新生成 / ＋ 继续生成 / 删除） |
| sender-name | 有链时显示在 turn 列顶 | 始终显示（含 StarAvatar + 状态文字"（已中断）/（出错）"） |

### E. 迁移落点建议

1. `max-width: 82% → 70%`（最影响观感的一处）。
2. 头像策略：preview 的 `StarAvatar 22px` 内联可保留为身份色点缀，但需在"有链"的助手轮把头像上提到左列 32px（对齐 src 的 `turn-chain-row` 结构）；或全盘换成 src 的 32px `Avatar` 列 + 顶部 sender-name。
3. 思维链去卡片化：`chain`（边框盒）→ 裸行 `chain-header` + `chain-body`（border-left 缩进）；并补 `.expanded` 的 sticky 吸附语义。
4. 气泡圆角 `12px → 6px`（连带 §6/§7）。
5. 动作行从常显文字 → hover 显现 icon（`opacity:0 → hover 1` 或 src 的 hover 变色），"继续生成"移到用户消息左侧。
6. 保留 src 的流式点（`dot-yellow`/`dot-gray` 4px）。

---

## §6 `components/chat/Message/UserMessage.vue` —— 用户气泡

### A. DOM 结构树

```
div.message-item.message-user       (flex column; align-items flex-end)
└─ div.user-message                 (flex; justify-content flex-end; gap 10px)
   ├─ div.user-msg-body             (order:-1; min-width 0)
   │  ├─ div.user-bubble            (bg user-container; radius 6px; padding 8px 12px; shadow)
   │  │  ├─ div.edit-area           (编辑态; textarea.edit-input + div.edit-actions > .edit-btn.confirm/.cancel)
   │  │  ├─ div.user-files          (附件列表; .user-file-chip > svg + .user-file-name + .user-file-size)
   │  │  └─ p.user-text             (14px/1.5; pre-wrap; word-break)
   │  └─ div.user-btn-row           (右对齐 gap 2px)
   │     ├─ button.continue-btn     (继续生成, margin-right auto, opacity 0→hover 1)
   │     ├─ button.user-msg-btn     (复制)
   │     └─ button.user-msg-btn     (编辑)
   └─ div.msg-avatar                (v-if senderAvatar; Avatar size 32)
```

### B. 布局规格

| 项 | 值 |
|---|---|
| 气泡 | `background var(--color-bg-user-container); border-radius 6px; padding 8px 12px; box-shadow 0 1px 2px rgba(0,0,0,.05)`（**无描边**）；`max-width 100%`（宽度仍由 turn-item 70% 管控） |
| 正文 | `14px; line-height 1.5; pre-wrap; word-break break-word` |
| 附件 chip | `3px 8px; radius 5px; 12px; bg rgba(255,255,255,.65); border 1px secondary`；hover `border-color 主色`；`max-width 200px`；文件大小 11px tertiary |
| 头像 | 右侧 32px 圆形 |
| 动作行 | 右对齐；按钮 14px icon（padding 3px），`color tertiary`，hover 变 secondary；复制成功 `#22c55e`；编辑态输入 `radius 4px`，focus 主色描边 |

### C. 关键 CSS 规则提炼

| 选择器 | 声明要点 | 令牌变量 |
|---|---|---|
| `.user-bubble` | `radius 6px; padding 8px 12px; shadow .05; overflow hidden` | `--color-bg-user-container` |
| `.user-text` | `14px/1.5; pre-wrap; word-break` | `--color-text-primary` |
| `.user-file-chip` | `3px 8px; radius 5px; 12px; hover 主色描边` | `--color-border-secondary` / `--color-primary` |
| `.continue-btn` | `margin-right auto; opacity 0; hover opacity 1; 12px` | `--color-text-tertiary` |
| `.user-msg-btn.copied` | `#22c55e` | 硬编码 |

### D. 与 preview 对应物差异清单

preview 无独立 `UserMessage` 组件；用户气泡 = `TurnItem` 内联 `.user-bubble`（radius 12px、padding 8px 14px、**有 1px 描边**）+ `ChatView` 的 `record-bubble.user-bubble`（同 12px + 描边）。差异：① src 无描边 + 6px 圆角 + shadow；preview 有描边 + 12px 圆角；② src 附件 chips 内嵌在气泡内（`message.files`）；preview 附件在 ChatInput 的 `attach-chips`（发送前暂存，不进入气泡）；③ src 动作行 hover 显现（复制/编辑/继续）；preview `record-actions` 常显文字（编辑/删除）。

### E. 迁移落点建议

1. 气泡 `radius 12px → 6px`、去 1px 描边、加 `box-shadow 0 1px 2px .05`。
2. 附件 chips 从 ChatInput 暂存改为进入用户气泡（`user-files`，发送后按 `message.files` 渲染）；发送前暂存保留在输入框（src 是 `file-preview-bar`）。
3. 动作行 hover 图标化（复制/编辑 + 左侧"继续生成"），删除入口移至 assistant 侧（src 语义）。

---

## §7 `components/chat/Message/AssistantMessage.vue` —— 助手消息

### A. DOM 结构树

```
div.message-item.message-assistant   (align-items flex-start)
├─ div.assistant-row                 (flex; gap 10px)
│  ├─ div.msg-avatar                 (v-if senderAvatar; Avatar 32)
│  └─ div.assistant-col              (flex column; gap 6px; flex 1)
│     ├─ div.sender-name             (v-if senderName; 12px / text-secondary)
│     ├─ div.think-content-section   (v-if hasThinking; .in-group / .no-content-below)
│     │  ├─ div.think-content-label  (@click toggleThinking; ThoughtIcon 14 + span(thinkingLabel) + streaming-dots + collapse-chevron)
│     │  └─ div.think-content-body.markdown-body (v-show; reasoningHtml + .streaming-pending)
│     ├─ div.assistant-bubble        (v-if hasContent; .markdown-body + .streaming-pending; 错误态 .error-message)
│     └─ div.copy-btn-row            (copy-message-btn + msg-action-btn(regenerate) + msg-action-btn.danger(delete))
└─ div.assistant-row                 (typing indicator 分支, v-if shouldShowTyping)
   ├─ div.msg-avatar
   └─ div.assistant-col > TypingIndicator
```

### B. 布局规格

| 项 | 值 |
|---|---|
| 气泡 | `padding 8px 12px; background var(--color-bg-assistant); border 1px solid var(--color-bg-assistant)(同色,视觉无描边); radius 6px; shadow 0 1px 2px rgba(0,0,0,.04)` |
| 思考区 | label `12px/500`（含后端耗时 label，如"已思考（用时 N 秒）"）；body `12px/1.7`，`border-left 1px secondary; margin-left 7px; padding-left 14px`；内嵌代码 11px；h1-h3 12px/600 |
| 错误态 | `.error-message` `bg danger-light; border 1px error; radius 8px; padding 12px` |
| 动作行 | `.copy-btn-row` 左对齐 gap 2px；icon 按钮（padding 4px）tertiary → hover secondary；danger hover 红色 |
| 流式点 | `dot-red #e74c3c` / `dot-gray #a8abb2`（思考中） |
| 文件链接 | `:deep(.file-path-link)` / `:deep(.file-tag)` 主色 light 底 + 主色文字 + 4px 圆角 + mono，hover 下划线 + 描边 |

### C. 关键 CSS 规则提炼

| 选择器 | 声明要点 | 令牌变量 |
|---|---|---|
| `.assistant-row` | `flex; gap 10px; width 100%` | — |
| `.assistant-bubble` | `8px 12px; radius 6px; 同色描边; shadow .04; overflow hidden` | `--color-bg-assistant` |
| `.think-content-body` | `12px/1.7; border-left 1px; margin-left 7px; padding-left 14px; max-width 100%` | `--color-border-secondary` / `--color-text-secondary` |
| `.error-message` | `12px; radius 8px; padding 12px; border 1px error` | `--color-error` / `--color-danger-light` |
| `.msg-action-btn.danger:hover` | `color error` | `--color-error` |
| `:deep(.file-path-link)` | `1px 6px; radius 4px; primary-light 底; mono; hover 下划线+描边` | `--color-primary-light` / `--color-primary` |

### D. 与 preview 对应物差异清单

preview 无独立 `AssistantMessage`；助手渲染在 `TurnItem` 内联。差异：① 气泡 `radius 12px; padding 10px 14px; line-height 1.7; border 1px secondary`（preview）vs `radius 6px; padding 8px 12px; 同色描边; shadow`（src）；② 思考区 preview 是 per-step `think-block`（💭 思考 + think-body 12px padding 4px 8px border-left）；src 是带耗时 label 的 `think-content-section`（结构化，含"已思考（用时 N 秒）"）；③ 动作 preview 常显文字；src hover 图标化；④ src 有 `file-path-link`/`file-tag` 可点击文件链接（发 previewFile 事件），preview 依赖 markdown.css 的 file-path-link。

### E. 迁移落点建议

1. 气泡 `radius 12px → 6px`、`padding 10px 14px → 8px 12px`、去 1px 描边（改同色描边）、加 shadow。
2. 思考区补后端耗时 label（`thinkingLabel`，preview 需接 `message.label` 或本地计时）。
3. 动作行 hover 图标化（复制/重新推理/删除）。
4. 文件链接 `file-path-link`/`file-tag` 样式对齐（主色 light 底 + mono + hover 下划线）。

---

## §8 `components/chat/Message/ToolMessage.vue` —— 工具卡

### A. DOM 结构树

```
div.message-item.message-tool      (flex column; align-items flex-start)
└─ div.tool-section                (width 100%)
   ├─ div.tool-label               (@click handleLabelClick; 裸行, 非卡片)
   │  ├─ svg.tool-label-icon       (齿轮, 14px, 静态 stroke)
   │  ├─ span.tool-label-name      (displayName, 12px/500)
   │  ├─ span.tool-label-hint      (write 工具; 文件图标, opacity 0→hover 1)
   │  ├─ span.streaming-dots       (running; .dot-yellow + .dot-gray×2) | span.tool-status-done OK | tool-status-error ERR | tool-status-blocked BLK
   │  └─ svg.collapse-chevron      (.chevron-expanded rotate 90deg)
   └─ div.tool-body                (v-show expanded; border-left 缩进)
      ├─ JSON 分支: .tool-json-error/.tool-json-warning/.tool-json-blocked + .tool-json-title + ResultComponent / pre.tool-output
      ├─ ResultComponent 分支      (loading 态)
      └─ pre.tool-output / .tool-loading / .tool-empty
```

### B. 布局规格

| 项 | 值 |
|---|---|
| 标签栏 | 裸文本行（**无卡片边框**）`flex; gap 6px; 12px/500; padding 2px 0; hover text-primary` |
| 状态徽标 | 纯文字 11px/700：`OK #22c55e` / `ERR #ef4444` / `BLK #f59e0b`（**无底色药丸**） |
| 流式点 | `5×5px; dot-yellow #f39c12 / dot-gray #d1d5db; gap 3px; dotPulse 1.5s` |
| 内容体 | `.tool-body` `margin-top 4px; margin-left 7px; border-left 1px secondary; padding-left 14px`（与思维链同套缩进语言） |
| 原文输出 | `tool-output` `12px/1.7; mono; pre-wrap; overflow-x auto` |
| write 工具 | 标签栏文件图标 `opacity 0 → hover 1`（点击 open 预览 Modal） |

### C. 关键 CSS 规则提炼

| 选择器 | 声明要点 | 令牌变量 |
|---|---|---|
| `.tool-label` | `flex; gap 6px; 12px/500; padding 2px 0; hover text-primary` | `--color-text-secondary` |
| `.tool-status-done/.error/.blocked` | `11px/700; #22c55e / #ef4444 / #f59e0b` | 硬编码 |
| `.tool-body` | `margin-top 4px; margin-left 7px; border-left 1px; padding-left 14px` | `--color-border-secondary` |
| `.tool-output` | `12px/1.7; mono; pre-wrap` | `--color-text-secondary` |
| `.tool-json-title` | `12px/600` | `--color-text-primary` |

### D. 与 preview 对应物（`ToolCard.vue`）差异清单

| 维度 | src `ToolMessage` | preview `ToolCard` |
|---|---|---|
| 容器 | 裸行（无边框） | 带边框卡片 `border 1px secondary; radius-md; bg-surface; overflow hidden` |
| 标签栏 | 裸行 `padding 2px 0` | `padding 8px 12px; 13px`（卡片内 header） |
| 齿轮 | 静态 svg stroke | `⚙` 字符 + running 时 `spin-icon` 旋转变色 |
| 状态徽标 | 纯文字 OK/ERR/BLK | 药丸底色徽标（`color-mix 12%` 底）+ 齿轮变色 |
| 内容体缩进 | `border-left 1px + margin-left 7px + padding-left 14px` | `padding 4px 12px 12px 26px + border-top` |
| 专用组件 | 内联渲染（各组件自管 ScrollableViewport 分段高度） | 外层 `<ScrollableViewport max-height=40vh>` 整体包裹 |
| 状态色 | OK `#22c55e`/ERR `#ef4444`/BLK `#f59e0b` | ok `--color-success`/err `--color-error`/running `--color-warning` |

### E. 迁移落点建议

1. 工具卡去卡片化：`tool-card`（边框盒）→ 裸行 `tool-label` + `tool-body`（border-left 缩进）。
2. 状态徽标改纯文字（去药丸底色）；running 保留流式点（dot-yellow/dot-gray）。
3. 齿轮：可保留 preview 的 running 旋转作为动效增强，但视觉密度对齐 src 的 12px。
4. 专用组件改内联 + 分段 ScrollableViewport（与 §4 一致）。
5. 补 write 工具的标签栏文件预览图标（hover 显现）。

---

## §9 `components/chat/shared/TypingIndicator.vue` —— 输入指示

### A. DOM 结构树

```
div.typing-indicator
├─ span.typing-dot
├─ span.typing-dot
└─ span.typing-dot
```

### B. 布局规格

| 项 | 值 |
|---|---|
| 容器 | `flex; gap 4px; padding 12px 16px; bg var(--color-bg-surface); radius 12px; width fit-content` |
| 点 | `8×8px; radius 50%; bg var(--color-text-muted)`；`typing` 1.4s bounce（`translateY(-6px)`，第 2/3 点 delay 0.2s/0.4s） |

### C. 关键 CSS 规则提炼

| 选择器 | 声明要点 | 令牌变量 |
|---|---|---|
| `.typing-indicator` | `gap 4px; padding 12px 16px; radius 12px; fit-content` | `--color-bg-surface` |
| `.typing-dot` | `8px; radius 50%` | `--color-text-muted` |
| `@keyframes typing` | `0%/60%/100% translateY(0) opacity .4 → 30% translateY(-6px) opacity 1` | — |

### D. 与 preview 对应物差异清单

**完全一致**（两轨 `shared/TypingIndicator.vue` 45 行逐字节相同）。迁移：无差异，直接复用。

---

## §10 `chat/ToolResult/ToolResultTerminal.vue` + `ToolResultCode.vue` —— 终端/代码质感

### A. DOM 结构树

`ToolResultTerminal.vue`：
```
div.tool-result-terminal             (padding 4px 0; flex column; gap 10px)
├─ div.term-block.term-cmd           (hasCommand; radius 10px; bg code-bg; border code-border)
│  ├─ div.term-banner                (高 36px; padding 0 16px; bg code-toolbar)
│  │  ├─ span.term-banner-label      ("终端命令", 12px/600 uppercase)
│  │  └─ span.term-banner-hint       (cwd, 11px tertiary ellipsis)
│  └─ ScrollableViewport(260px) > div.term-cmd-body ($ prompt + code.term-cmd-text)
├─ div.term-loading                  (loading 无输出; 3 loading-dot + text)
├─ div.term-error / div.term-guidance
├─ div.term-block                    (stdout; banner "终端输出"/"含 stderr"/exit N + ScrollableViewport(40vh) pre)
├─ div.term-block.term-stderr        (banner-err "标准错误" + ScrollableViewport(30vh) pre)
└─ div.term-truncated                (⚠ 截断/超时)
```

`ToolResultCode.vue`：
```
div.tool-result-code                 (radius 10px; border 1px border-light; bg page; overflow hidden)
├─ (目录) div.code-header.code-header-dir + div.dir-list > div.dir-item(svg + .item-name)
└─ (文件) div.code-header            (padding 10px 14px; bg surface; border-bottom)
   │  ├─ div.code-header-left        (svg.code-file-icon + span.code-file-name + span.code-lang-badge)
   │  └─ div.code-header-right       (code-meta-badge×N + button.code-copy-btn)
   ├─ div.code-loading               (loading; 3 loading-dot + text)
   ├─ ScrollableViewport.code-viewport (bg code-bg)
   │  ├─ div.code-body-md            (skill_read; v-html markdown)
   │  └─ div.code-area-wrapper > div.code-area (v-html 围栏高亮)
   └─ div.code-truncated-banner      (内容截断)
```

### B. 布局规格

| 项 | 值 |
|---|---|
| 终端块 | `term-block radius 10px; overflow hidden; bg var(--color-code-bg); border 1px var(--color-code-border)` |
| 终端 banner | `高 36px; padding 0 16px; bg var(--color-code-toolbar)`；label 12px/600 uppercase letter-spacing .3px |
| 命令区 | **硬编码深色** `bg #0f1117`；`$` prompt `#4ade80` 12px/700；命令文本 `#e2e8f0` 12px/1.5 mono |
| 输出 pre | `padding 16px 20px; 12px/1.65; mono; pre-wrap`；stderr 红色 |
| 代码卡 | `radius 10px; border 1px border-light; bg page`；header `10px 14px bg surface border-bottom` |
| 语言徽标 | `code-lang-badge 10px/600 uppercase; primary 底白字; radius 4px; opacity .85` |
| 代码视口 | `bg code-bg`；覆盖 `md-code-block`（margin 0 / radius 0 / banner 隐藏 / pre padding 16px 20px / code 12px 1.65 mono） |
| 目录项 | 文件夹图标 `#e6a817`；`.name-dir` 同色 500 |

### C. 关键 CSS 规则提炼

| 选择器 | 声明要点 | 令牌变量 |
|---|---|---|
| `.term-block` | `radius 10px; overflow hidden; border 1px` | `--color-code-bg` / `--color-code-border` |
| `.term-banner` | `高 36px; padding 0 16px` | `--color-code-toolbar` |
| `.term-cmd-body` | `bg #0f1117; padding 10px 16px`（命令区恒深色） | 硬编码 |
| `.term-prompt` | `$; #4ade80; 12px/700` | 硬编码 |
| `.term-block pre` | `16px 20px; 12px/1.65; mono; pre-wrap` | `--color-code-bg` / `--color-text-primary` |
| `.term-stderr pre` | `color error` | `--color-error` |
| `.tool-result-code` | `radius 10px; border 1px; bg page` | `--color-border-light` / `--color-bg-page` |
| `.code-header` | `10px 14px; bg surface; border-bottom` | `--color-bg-surface` / `--color-border-light` |
| `.code-lang-badge` | `10px/600 uppercase; primary 底白字` | `--color-primary` |
| `.code-viewport` | `bg code-bg` | `--color-code-bg` |

### D. 与 preview 对应物差异清单（含其余 ToolResult 概览）

preview 存在**同名全套 `ToolResult*`**（Terminal/Code/Edit/Browser/Subagent/Web/Write），与 src 同源演化。核心差异不在组件内部而在两处：① **令牌**——preview 版多写 `--font-mono/--text-*/--line/--r-*` 新令牌，src 版用 `--color-*` 别名 + 硬编码 `'SF Mono','Cascadia Code','Fira Code'` 字族；② **包裹方式**——preview `ToolCard` 外层 `ScrollableViewport(40vh)`，src `ToolMessage` 内联 + 分段高度。

其余 ToolResult 样式概览（"只扫一眼"）：
- `ToolResultEdit.vue`：radius 10px 卡片；header `10px 14px bg surface`；diff 行 `mono 12px/1.65`，`diff-del` 红底 `rgba(239,68,68,.12)` + `#f87171`、`diff-add` 绿底 `rgba(34,197,94,.1)` + `#4ade80`；`edit-icon #8b5cf6`；复制按钮同 `code-copy-btn`。
- `ToolResultWrite.vue`：卡内 `write-link`（accent 色 mono 下划线）→ Modal(width 1000) 预览；header 同 `code-header`；body `bg code-bg`；`pre padding 20px 24px`。
- `ToolResultBrowser.vue`：12px 主字号；步骤卡 `.brw-step` `bg surface; padding 5px 8px; radius 6px`；动作徽标 emoji + 色值 `11px/600 radius 10px`；截图 `max-height 320px` hover 展开。
- `ToolResultSubagent.vue`：`.sa-panel radius 10px bg surface`；header `6px 12px bg code-toolbar`；状态徽标 `st-running #e6a817 / st-done #16a34a / st-error #ef4444 / st-timeout #f97316 / st-killed #6b7280`。
- `ToolResultWeb.vue`：结果卡 `bg surface; radius 8px; padding 10px 14px`；标题 link 色；摘要 `max-height 80px` 折叠展开。

### E. 迁移落点建议

1. 整套 `ToolResult*` 基本可整组平移（preview 已有同名文件）；重点是统一令牌层到 `--color-*` 别名（preview tokens.css 已就绪）。
2. 终端命令区 `#0f1117` 恒深色 + `$ #4ade80` 是"终端质感"的核心，**不随主题切换**，迁移保留。
3. 代码卡统一 `radius 10px` + `code-header(10px 14px bg-surface)` + 覆盖 `md-code-block`（margin/radius 归零、banner 隐藏）。
4. 分段 `ScrollableViewport` 高度对齐 src（命令 260px、stdout 40vh、stderr 30vh）。

---

## §11 `components/chat/FilePreviewModal.vue` —— 文件预览弹窗

### A. DOM 结构树

```
Teleport(to="body")
└─ div.file-preview-overlay          (v-if visible; fixed inset 0; z-index 10000; rgba(0,0,0,.5); backdrop blur 2px; @click.self close)
   └─ div.file-preview-modal         (max-width 960px; max-height 90vh; radius 10px; shadow 0 24px 80px .4)
      ├─ div.fp-header               (padding 10px 16px; border-bottom; bg surface)
      │  ├─ div.fp-header-left       (svg.fp-file-icon + span.fp-filename + span.fp-lang-tag + span.fp-size)
      │  └─ div.fp-header-right      (button.fp-btn 复制 + a.fp-btn.fp-btn-open 新窗口 + button.fp-btn.fp-btn-close)
      ├─ div.fp-body                 (flex 1; overflow auto; min-height 0)
      │  ├─ div.fp-loading (spinner) / div.fp-error
      │  ├─ iframe.fp-iframe         (HTML; sandbox="allow-scripts")
      │  ├─ div.fp-image-wrap > img.fp-image   (图片; 棋盘格底)
      │  ├─ div.fp-markdown.markdown-body      (Markdown)
      │  └─ div.fp-code-wrap > div.fp-code-container
      │     ├─ div.fp-line-numbers (span.fp-line-num×N)
      │     └─ pre.fp-code > code (v-html hljs)
      └─ div.fp-footer               (span.fp-path)
```

### B. 布局规格

| 项 | 值 |
|---|---|
| 遮罩 | `fixed inset 0; z-index 10000; background rgba(0,0,0,.5); backdrop-filter blur(2px); padding 24px` |
| 弹窗 | `100%; max-width 960px; max-height 90vh; radius 10px; border 1px; shadow 0 24px 80px rgba(0,0,0,.4)` |
| 头部 | `padding 10px 16px; border-bottom; bg surface`；文件名 13px/600；语言标签 10px `primary-light` 底 + `primary` 文字 |
| 按钮 | `fp-btn 4px 10px; radius 5px; border 1px; bg surface; 12px` |
| 代码区 | 行号列（`bg surface; 右对齐; 12px/1.6; border-right`）+ `pre.fp-code 13px/1.6 mono padding 12px 16px` |
| 图片 | `repeating-conic-gradient` 棋盘格底；`max-height 70vh; object-fit contain` |
| iframe | `sandbox="allow-scripts"`（去 same-origin 防注入）；`height 70vh` |
| 底部 | `fp-path 11px mono tertiary` |
| 主题 | `:global(:root.dark/.light)` 显式覆盖弹窗/头部/按钮/行号背景 |

### C. 关键 CSS 规则提炼

| 选择器 | 声明要点 | 令牌变量 |
|---|---|---|
| `.file-preview-overlay` | `fixed inset 0; z-index 10000; rgba(0,0,0,.5); blur(2px)` | — |
| `.file-preview-modal` | `max-width 960px; max-height 90vh; radius 10px; shadow .4` | `--color-bg-page` / `--color-border` |
| `.fp-header` | `10px 16px; border-bottom; bg surface` | `--color-bg-surface` / `--color-border` |
| `.fp-lang-tag` | `10px; 1px 6px; radius 3px; primary-light 底 primary 文字` | `--color-primary-light` / `--color-primary` |
| `.fp-btn` | `4px 10px; radius 5px; border 1px; bg surface; 12px` | `--color-bg-surface` / `--color-border` |
| `.fp-code` | `12px 16px; 13px/1.6; mono` | `--color-text-primary` |
| `.fp-path` | `11px; mono` | `--color-text-tertiary` |

### D. 与 preview 对应物（`views/FilePreviewModal.vue`）差异清单

| 维度 | src | preview |
|---|---|---|
| 容器 | 自绘 `Teleport` overlay + 自绘 modal（max-width 960px） | 复用 `Modal` 组件（width 720px height 80vh z-index 1300） |
| 代码渲染 | `hljs` 语法高亮 + **行号列**（fp-line-numbers） | 纯 `<pre>` 文本，无行号、无高亮 |
| 图片 | data URL + **棋盘格底**（repeating-conic-gradient） | `rawHref` 直链 `<img>` |
| HTML | `iframe sandbox="allow-scripts"` | 同 iframe 语义（`rawHref` 新窗口） |
| 头部徽标 | 语言标签 + 尺寸 + 复制 + 新窗口 + 关闭（多按钮） | 仅路径 + 大小 + 新窗口 |
| 底部 | `fp-footer` 显示完整路径 | 无 footer |
| 尺寸 | 960px 宽 + 90vh | 720px 宽 + 80vh |

### E. 迁移落点建议

1. 从 `Modal` 方案升级为自绘 overlay（或 Modal 内嵌）并补齐：**行号列 + hljs 高亮**、图片**棋盘格底**、HTML `iframe sandbox`、头部语言标签/尺寸徽章、底部路径栏。
2. 尺寸对齐 src（960px / 90vh）或保留 preview 720px 作为有意差异（需决策）。
3. 明暗主题显式覆盖（`:root.dark/.light`）保留。

---

## §12 工坊层通用结论

### 1. 时间轴节点 / 脉冲轨迹 / 工单卡的视觉语言如何组织

- **时间轴节点**：由 `time-separator`（居中文字，src 无横线）/ `event-separator` / `error-separator` 三类分隔条组织，插入在 turn 列表之间（`insertTimeSeparators`）。event 灰、error 红（`--color-error` + `color-mix 70%` 淡化时间戳）。
- **脉冲轨迹（步链）**：层级用**同一套「竖线 + 7px 内缩」语言**表达——`.chain-body`、`.think-content-body`、`.tool-body` 三者共用 `border-left:1px solid var(--color-border-secondary); margin-left:7px(对齐14px图标中心); padding-left:14px`。这是 src 工坊层「思维链 → 工具卡 → 步正文」三级的骨架，preview 当前用边框卡片（`chain`/`tool-card`）表达同一语义，是迁移的核心改写点。
- **流式脉冲**：一律用 3 点呼吸（`dot-pulse` 1.4s），色对固定为 `dot-yellow #e6a817`（工具/思维链运行）+ `dot-gray #a8abb2`，思考态用 `dot-red #e74c3c`。
- **工单卡**：工具/代码/终端/subagent 结果卡统一「**10px 圆角 + 1px 弱描边（`--color-border-light`/`--color-code-border`）+ 顶部 banner（`10px 14px bg-surface` 或 `36px bg-code-toolbar`）+ code-bg 视口」的"工单"视觉。状态徽标 src 用纯文字（OK/ERR/BLK），终端/代码区 mono 字族 12px。

### 2. 间距与字号基准

| 类别 | 基准 |
|---|---|
| 间距刻度 | `--space-1..6 = 4/8/12/16/20/24px`（4px 基准）；消息区 padding 16px、列 gap 8px、气泡 padding `8px 12px`、卡片 header `10px 14px` |
| 圆角 | `--r-sm 4px`（chip/徽标）、`--r-md 8px`（textarea/按钮）、`--r-lg 12px`（输入区容器/气泡容器/TypingIndicator）、**10px**（工具卡/弹窗/下拉，硬编码但全站一致）、`999px`（药丸：InteractionBar 触发器/agent 徽标） |
| 字号 | 正文气泡 `14px`（src 行高 1.5；preview 1.7，需对齐）；次级 `12px`（sender-name / chain-label / tool-label / think）；辅助 `11-12px`（徽标/时间/尺寸）；代码终端 `12px/1.65 mono`；标题 `15px/600` |
| 气泡 | 用户 `8px 12px` + 主色底 + shadow（无描边）；助手 `8px 12px` + `--color-bg-assistant` 同色描边 + shadow；**圆角统一 6px**（preview 为 12px，关键差异） |
| 头像 | `32px` 圆形（Avatar） |
| 气泡最大宽 | `max-width:70%`（src）vs 82%（preview） |
| 头部 | 固定高 `48px`（`--layout-header-height`）+ `padding 0 16px` + `backdrop blur 8px` |

### 3. 动效（呼吸/流光）清单

| 动效 | 触发场景 | 参数 | 令牌/色 |
|---|---|---|---|
| `dot-pulse` / `term-dot-pulse` / `code-dot-pulse` / `edit-dot-pulse` | 流式运行点 | 1.4s（ToolMessage 1.5s）opacity .3→1 | `dot-yellow #e6a817` / `dot-gray #a8abb2`（ToolMessage `#f39c12`/`#d1d5db`）/ `dot-red #e74c3c` |
| `typing` | TypingIndicator | 1.4s translateY -6px bounce | `--color-text-muted` |
| `history-spin` / `spin` / `fp-spin` / `compress-spin` | spinner | 0.6–0.8s rotate | `--color-border-primary` → `--color-primary` |
| `pulse-interrupt` | 打断发送按钮 | 1.2–1.5s box-shadow 扩散 0→6px | 橙 `#f97316` / `#e67e22` |
| chevron 旋转 | 折叠箭头 | 0.2s rotate 90°（180°） | `--color-text-tertiary` |
| `dropdown` / `menu-fade` | 弹出菜单 | 0.12s opacity + translateY(-4px) | — |
| `fade` | 反馈文案 | 0.25s opacity | — |
| `gauge-fill` | token 进度条 | width 0.4s ease | 四档状态色 |
| `scroll-btn` | 回到底部按钮 | 0.2s opacity + translateY(8px) | — |

**关于"流光"**：src 工坊层当前为**扁平化**（`tokens.css` 明示 `--glow-primary/--glow-soft = none`，`--grad-star = var(--primary)` 实底），因此工坊层**没有真正的发光/流光**；发光语义只在 preview 原生面保留给 `StarAvatar`（`.run-spin` / `.ring-spin` 光环，且被 `prefers-reduced-motion` 豁免）。迁移"布局/风格完全对齐"时：气泡/卡片/思维链的**布局、间距、字号、圆角对齐 src**，`StarAvatar` 光环可作为 preview 特色身份点保留——这是"星群（preview）"与"工坊（src）"在动效层的主要分野，建议在迁移文档中明确为保留项而非对齐项。
