# WebUI 插槽化调研 · Slot 树（v1，未实施）

> 目的：为「前端 WebUI 插槽化」里程碑做前期调研——全面盘点 `src/webui/src`
> 全部页面可视元素，归并成**一颗带填充语义标注的 slot 树**。本文是调研产物
> 与设计输入，不改动任何代码；slot id 均为**建议名**，落地时另行裁决。
> 配套文档：`docs/webui-plugin-ownership.md`（v2，对齐 DSH webui 设计——
> 本树定义插口的形状与语义，归属表定义每个插口的 owning client-ui 包；
> 实施时本树升为 SlotMap 声明集：每 slot 增 kind/scope/cell 选举/store
> 座位，见该文档 §4 升级指引）。
>
> 方法：布局骨架与扩展基建由主线通读（App.vue / stores/ui.ts / core/extensions/*
> / core/registry/* / ac-webui-extensions / tokens.css / vite.config 等）；约 50 个
> 组件的可视元素由 6 组并行盘点全覆盖（侧边栏层 / 主聊天区 / 消息与工具结果 /
> 运行跟踪与用量 / 弹窗与抽屉 / 设置面板），每组均全文读取组件源码后输出
> 「可视区域树 + 现有扩展缝 + slot 化候选」。

---

## 1. 既有插槽基建（现状层）

插槽化不是从零开始，前端已有完整的一套扩展宿主机制（P5.3–P5.5 落地）：

- **加载链**：`core/extensions/host.ts` 拉 `/api/ui/extensions` → 动态 import
  `/ui-plugin/<name>/<entry>` → `install(bridgeCtx)` → disposers 逆序回收；
  同名加载互斥、install 15s 超时回滚、单插件失败隔离；WS
  `webui/extensions-changed` 驱动 diff 同步（150ms debounce）。
- **白名单门**：`bridge.ts` 的 `assertSlot` 要求 manifest `ui.slots` 声明过目标
  slot 才可注册（运行时不可超出声明）；页签/动作 id 自动加插件名前缀防撞。
- **isolated 档**：不信任插件走 sandbox iframe（无 allow-same-origin），
  仅 GET 白名单代理 + 生命周期事件白名单（`p5.5-policy.ts`），**不进 slot
  注册表**（拿不到 slot 填充能力）。
- **global-style 消毒**：只允许普通规则 + `:root` CSS 变量块，强制
  `.ui-plugin-<scope>` 前缀，禁 at-rule / url() / 反斜杠转义。
- **既有 8 个 UISlotId**（协议 shim `shims/@agentchat/protocol.ts`；后端
  `ac-webui-extensions` BUILTIN_SLOTS 对外开口 6 个）：
  `perspective` / `tool-result` / `message-view` / `ws-event` /
  `settings-tab:global` / `settings-tab:agent` / `sidebar-action` / `global-style`。
- **三个前端注册表**（先于 slot 系统存在，机制同构：同 id 替换、版本号驱动
  响应式重解析、priority 覆盖）：
  - `perspectives.ts` —— 视角注册表（pair/talk/group/single 四内置，App.vue
    注册；PerspectiveHost 渲染激活项，「视图即筛选」）。
  - `messageViews.ts` —— final 消息视图（user/assistant 二内置 + match/priority）。
  - `toolResultViews.ts` —— 工具结果视图（10 个内置工具卡，精确名 → 正则族 →
    priority 链，未命中回落文本）。
- **UI 原子与令牌**：`ui/`（L0 tokens.css 双主题 Nebula/Aurora → L1
  Icon/Button/Avatar/Modal → L2 StarAvatar/StarCard/PulseTrace）；填充物直接
  复用 `--color-*`/`--role-*` 变量与 ui-badge 色语言（ok/err/warn/info/dim）。

## 2. 填充语义分类学

六组盘点统一使用四类视觉语义，本树追加两类非视觉语义：

| 标记 | 语义 | 契约要点 |
|---|---|---|
| 【替】 | 替换型 | 整块换成插件内容；**未填充回落宿主默认渲染**；高危者另标 ⚠ |
| 【填】 | 填充型 | 向固定容器追加条目/区块，宿主默认保留；order 缺省 100 稳定排序 |
| 【饰】 | 装饰型 | 在既有条目上附着角标/附加行/行内按钮；默认不渲染；行点击导航语义宿主所有 |
| 【覆】 | 覆盖型 | 浮层叠加，不替换底层内容；自行处理点击穿透 |
| 【◆】 | 数据声明/注册表型 | 非视觉 slot：注册表或声明驱动（fields/icon/label/parser） |
| ★ | 已有缝 | 现网即可注册（8 个 UISlotId + 三注册表 + fields 声明机制） |
| ⚠ | 高风险替换 | 替换将丢失宿主语言（热力/导航/生命周期/折叠语义），建议宿主保留或要求实现宿主接口 |

**核心裁决（贯穿全树）**：整卡/整页替换归**注册表**（messageViews /
toolResultViews / perspectives 已承担），slot 树主打**填充/装饰/覆盖**——两层
不重叠、不双轨；能用数据声明（fields/showWhen/enum）表达的不开视觉 slot
（ExtensionSettingsModal 已验证该路线）。

## 3. 布局骨架（树的地基）

App.vue 三层 + 覆盖层，全部面板开关集中在 `stores/ui.ts`：

```
[① Sidebar 活动栏 48px] [② 列表槽位面板 260px± 三选一] [③ 主区]
                                                ├─ 运行矩阵大画布（trackingView 让位协议）
                                                └─ 聊天区（v-show 保活）
                                                   ├─ PerspectiveHost（视角容器）
                                                   └─ ④ 工作区分屏（右侧 rail + WorkspaceTree）
[⑤ 全局覆盖层] FilePreviewModal / CreateGroupDialog / SettingsPanel / TokenUsage / VersionDialog
```

---

## 4. SLOT 树（主交付物）

> 读法：树按物理布局六级展开；节点 = 建议的宿主插口（挂载点在括号内组件）。
> 每行标注语义与一句话说明；★/⚠/◆ 见 §2 图例。

```text
app ····················································· App.vue（.app-layout）
│
├─ ① sidebar（活动栏 · Sidebar.vue）
│  ├─ sidebar:avatar                 【饰/替】用户头像钮：角标/在线状态，或整替
│  ├─ sidebar:top-actions            【填】头像与面板切换组之间
│  ├─ sidebar:panel-switches         【填】面板切换组内追加第 4+ 入口
│  │  └─ sidebar:button-badge        【饰】任意活动栏按钮的角标位（more-dot 泛化，按 button id）
│  ├─ sidebar:tool-actions           【填】底部工具区（Token 用量/主题切换周围）
│  ├─ sidebar:plugin-actions       ★【填】既有 sidebar-action（宿主钉位：主题与全局设置之间）
│  ├─ sidebar:bottom-actions         【填】全局设置与更多之间
│  └─ sidebar:more-menu
│     ├─ sidebar:more-menu-items     【填】菜单项（复用 icon+label+红点+disabled 契约）
│     └─ sidebar:more-menu-footer    【饰】菜单底部反馈条位（FeedbackNotice 同位）
│
├─ ② list-panel（列表槽位面板 · App.vue 挂载，agents/sessions/tracking 三选一）
│  ├─ sidebar:list-panel           【替/覆】◆面板注册表化：三内置面板成为注册项，
│  │                                    插件注册第 4 面板（须联动 listPanel 高亮/持久化协议）
│  ├─ roster（Agent 名册 · AgentList.vue）
│  │  ├─ roster:header            【替】头部整段（搜索+新建+移动端关闭）
│  │  ├─ roster:header-suffix     【饰】新建按钮旁追加动作钮
│  │  ├─ roster:toolbar           【填】头部与列表之间工具条（过滤器/分组开关）
│  │  ├─ roster:create-menu-items 【填】新建下拉追加项
│  │  ├─ roster:item              【替】整行渲染权（agent|group 两形态；行序冻结机制宿主所有）
│  │  ├─ roster:item-avatar-badge 【饰】头像角标位（与 unread 徽章错峰规则）
│  │  ├─ roster:item-suffix       【饰】行尾徽章/状态点（不得劫持行点击）
│  │  ├─ roster:item-subline      【饰】名称/末消息下附加行（token 仪表样式已有预留）
│  │  ├─ roster:empty             【替】两分支空态（无数据/无命中）
│  │  ├─ roster:footer            【填】面板底部统计条/快捷动作
│  │  └─ roster:create-dialog-fields 【饰】新增 Agent 弹窗追加字段（需字段收集协议）
│  ├─ session-list（会话树 · SessionList.vue）
│  │  ├─ session-list:create-row     【填/饰】新增按钮旁（「从模板新建」等）
│  │  ├─ session-list:toolbar-actions【填】工具栏动作区（folder-plus 旁）
│  │  ├─ session-list:root-prefix    【填】树根前插虚拟分组节点（固定分组/插件分组）
│  │  ├─ session-list:root-suffix    【填】树根后插虚拟分组节点
│  │  ├─ session-list:group-node     【替】工作区根节点行渲染权
│  │  ├─ session-list:group-actions  【填】根节点 hover 操作区（更多/加号旁）
│  │  ├─ session-list:group-menu-items【填】更多菜单追加项（复用 ws-menu-item 契约）
│  │  ├─ session-list:item           【替】会话叶节点整行
│  │  ├─ session-list:item-suffix    【饰】行尾（删除钮旁；注意 hover 浮现协调）
│  │  ├─ session-list:item-subline   【饰】标题下附加行（agent/时间/运行态的信息扩容位）
│  │  ├─ session-list:empty          【替】空态
│  │  └─ session-list:footer         【填】面板底部
│  └─ runs（运行清单 · RunTrackingPanel.vue）
│     ├─ runs:toolbar-actions        【填】标题栏动作区
│     ├─ runs:overview-entry       ⚠【替】「运行总览」入口整行（须保留 toggleMatrix 语义）
│     ├─ runs:overview-entry-extra   【饰】总览叶行内附加
│     ├─ runs:tree-section           【填】新分组节点+子行（插件清单分区，如 cron 触发器）
│     ├─ runs:running-item-extra     【饰】运行会话行时长旁徽标
│     ├─ runs:running-item-actions   【填】stop 钮旁追加（遵循 hover 浮现规则）
│     ├─ runs:job-item-actions       【填】后台/子Agent 任务行动作
│     ├─ runs:job-settled-section    【填】终态清单下汇总行
│     └─ runs:panel-footer           【填】树底部区块
│
├─ ③ main（主区 · App.vue .main-area）
│  ├─ main:perspective            ★【替·注册表】视角容器（PerspectiveHost：pair/talk/group/single
│  │                                   四内置；props() 工厂 + 事件透传构成宿主↔视角协议）
│  ├─ main:overlay                  【覆】主区全幅覆盖（矩阵 trackingView/pair 让位协议收编为声明式）
│  │
│  ├─ chat（聊天内核 · DialogView.vue，direct/group/single 三视角共享）
│  │  ├─ chat:header
│  │  │  ├─ chat:header-title           【饰/替】标题区（状态徽标/副标题；视角上下文）
│  │  │  ├─ chat:header-actions         【填】核心候选：8 类内置控件聚集地（thinking 开关/
│  │  │  │                                   jobs chip/token 仪表等可逐步收编为内置贡献者）
│  │  │  ├─ chat:header-gauge-panel-section【填】token 占用弹层追加行（插件自报上下文开销）
│  │  │  ├─ chat:header-notice          【填】头部下挂反馈 chip 锚（compress/busy/archivePending 同位）
│  │  │  ├─ chat:header-menu-items      【填】更多菜单追加项（danger 样式宿主提供）
│  │  │  └─ chat:connection-banner      【覆】断线横条位通告条
│  │  ├─ chat:messages
│  │  │  ├─ chat:messages-empty         【替】空态（可按视角分发）
│  │  │  ├─ chat:messages-top           【饰】消息列顶部附加条（置顶公告/上下文摘要）
│  │  │  ├─ chat:messages-item-aside    【饰】time/event/error 三类分隔条附着
│  │  │  └─ chat:page-overlay           【覆】消息区浮动层（避让回底钮 z 序）
│  │  │
│  │  ├─ turn（轮次外壳 · TurnDisplayItem.vue）
│  │  │  ├─ turn:above / turn:below     【填】整轮之上/之下（事件卡/系统提示条）
│  │  │  ├─ turn:avatar-badge           【饰】头像右下角标（状态点/插件标记）
│  │  │  ├─ turn:sender-name-suffix     【饰】名称后标识（模型名/角色 tag）
│  │  │  ├─ turn:chain-header-prefix    【饰】链头摘要前附加（token 统计；B/C 两分支同生效）
│  │  │  ├─ turn:chain-header-suffix    【饰】链头摘要后附加（阶段标签）
│  │  │  ├─ turn:chain-header-replace ⚠【替】链头整行（自定义折叠交互，高门槛）
│  │  │  ├─ turn:step-prefix/suffix     【填】每个步骤组前后（步骤注解/耗时角标）
│  │  │  ├─ turn:final-prefix/suffix    【填】final 气泡前后（引用来源条/署名行；三处渲染点同生效）
│  │  │  ├─ turn:footer-actions         【填】轮级动作行（点赞/反馈/收藏，与消息级区分）
│  │  │  └─ turn:watermark              【覆】整轮水印/来源标记
│  │  │
│  │  ├─ message（final 消息 · AssistantMessage / UserMessage）
│  │  │  ├─ message:final-view        ★【替·注册表】messageViews 整卡替换（本树不另设 final 整替）
│  │  │  ├─ message:bubble-header      【填】气泡上方（引用条/生成元信息）
│  │  │  ├─ message:bubble-footer      【填】气泡下方、动作行上方（tokens/耗时/来源）
│  │  │  ├─ message:actions            【填】动作行追加钮（内建复制/重发/删除保留）
│  │  │  ├─ message:actions-replace    【替】动作行整替（只读场景）
│  │  │  ├─ message:thinking-header-suffix【饰】思考标签行尾部（耗时徽标）
│  │  │  ├─ message:thinking-body-suffix  【填】思考体末尾（摘要卡）
│  │  │  ├─ message:content-replace    【替】正文渲染（保留外壳；须兼容流式 markdown 管线）
│  │  │  ├─ message:avatar-overlay     【覆】头像角标
│  │  │  ├─ message:streaming-indicator【饰】流式附加指示（现由链栏 dots 承担，可下放）
│  │  │  └─ user 变体：message:user-bubble-header / user-bubble-footer /
│  │  │     user-attachments-suffix / user-actions / user-edit-actions / user-text-replace
│  │  │
│  │  ├─ tool-card（工具卡外壳 · ToolMessage.vue）
│  │  │  ├─ tool-card:result-view     ★【替·注册表】toolResultViews 整卡替换（按工具名 match）
│  │  │  ├─ tool-card:icon             ◆图标注册表（静态表 toolIcon.ts 注册化——否则插件工具
│  │  │  │                                「有卡无名无图标」）
│  │  │  ├─ tool-card:label            ◆显示名注册表（toolLabel.ts 同构注册化）
│  │  │  ├─ tool-card:header-prefix    【饰】图标前附着（工具提供方标识）
│  │  │  ├─ tool-card:header-suffix    【饰】标签后、状态前徽标（耗时/成本/重试）
│  │  │  ├─ tool-card:header-actions   【饰】状态区与箭头之间头部动作
│  │  │  ├─ tool-card:label-replace    【替】自定义标签合成
│  │  │  ├─ tool-card:status-replace   【替】状态呈现（进度替代 OK/ERR；状态词汇宿主固定）
│  │  │  ├─ tool-card:body-prefix/suffix【填】结果体内专用组件前后（参数回显/后续建议）
│  │  │  ├─ tool-card:error-suffix / warning-suffix / blocked-suffix【填】三类状态条下修复建议
│  │  │  ├─ tool-card:loading-replace  【替】执行中呈现
│  │  │  ├─ tool-card:overlay          【覆】结果体覆盖（水印/敏感遮罩）
│  │  │  └─ 数据面：tool-result:envelope-parser / status-mapper / data-normalizer ◆
│  │  │
│  │  ├─ 内置工具卡内部（装饰型为主，次级插口可后置）
│  │  │  ├─ browser-card: header-suffix / step-prefix / step-suffix /
│  │  │  │   step-summary-replace / screenshot-overlay / footer
│  │  │  ├─ code-card: header-actions / meta-suffix / body-prefix / body-suffix /
│  │  │  │   line-suffix(谨慎) / footer / dir-item-suffix / lang-replace
│  │  │  ├─ edit-card: header-actions / stat-suffix / diff-prefix / diff-suffix /
│  │  │  │   line-annotate(谨慎) / footer
│  │  │  ├─ term-card: in-suffix / divider-replace / out-suffix / footer / stream-overlay
│  │  │  ├─ web-card: search-header-suffix / answer-suffix / search-item-suffix /
│  │  │  │   fetch-tags-suffix / footer / item-replace
│  │  │  ├─ write-card: link-suffix / dialog-header-actions / dialog-footer / body-replace
│  │  │  │   （write 的 open() expose 是外壳↔卡唯一命令式通道，slot 化须保留等价通道）
│  │  │  ├─ subagent-card: head-suffix / body-suffix / result-replace / item-suffix /
│  │  │  │   kind-extend（新 action kind 卡体注册位）
│  │  │  ├─ todo-card: title-suffix / item-suffix / item-replace / footer
│  │  │  └─ goal-card: row-suffix / phase-replace / footer
│  │  │
│  │  ├─ chat:composer-docks（composer 上方 dock 卡列 · DialogView）
│  │  │  ├─ tracking:dock-widget      【填】核心候选：dock 卡列追加（TaskDock/QueueDock/
│  │  │  │   InteractionBar 为首批内置贡献者；三态契约 undefined=不可用静默/
│  │  │  │   null|[]=不渲染；refresh 钩子对齐 tool/after-execute·loop/after-run 模式）
│  │  │  ├─ chat:queue-item-actions   【填】排队条目行级动作
│  │  │  ├─ chat:ask-extra-actions    【填】决策卡底部动作
│  │  │  ├─ chat:ask-option-aside     【饰】选项行内角标
│  │  │  └─ chat:jobs-panel-section   【填】会话任务弹层追加节
│  │  │
│  │  └─ chat:input（输入区 · ChatInput.vue）
│  │     ├─ chat:input-toolbar          【填】左工具组四个下拉后追加（宿主提供 select-btn/dd-menu
│  │     │                                   样式协议）
│  │     ├─ chat:input-toolbar-right    【填】附件与发送之间（慎用，避抢主钮视觉）
│  │     ├─ chat:input-attachments      【填】附件栏尾部追加非文件类 chip
│  │     ├─ chat:input-attachment-renderer【替】按附件 kind 替换 chip 渲染（命中则默认不渲染）
│  │     ├─ chat:input-mention-groups ◆【填】mention 弹层分组/条目贡献注册表（插件命令/资源
│  │     │                                   引用最自然入口；建议数据贡献而非纯 Vue slot）
│  │     ├─ chat:input-mention-bar      【填】@ 模式导航头快跳位 chips
│  │     ├─ chat:input-token-renderer   【替】高亮层 token 芯片渲染/新语法着色（与 mention 配套）
│  │     ├─ chat:input-overlay          【覆】输入框浮动层（避让 mention 弹层 z-320）
│  │     ├─ chat:input-row              【饰】工具栏下附加信息行（字数/配额）
│  │     └─ chat:input                ⚠【替】整个 composer 逃生口（破坏其余 input slot 语义，
│  │                                         建议仅宿主内部使用）
│  │
│  ├─ pair（只读会话对 · PairDialogView.vue）
│  │  ├─ pair:header-start / pair:header-actions【填】返回钮前 / 头部右侧（导出/跳矩阵）
│  │  ├─ pair:header-endpoints          【替】端点头像组+名称对（关系图/状态灯）
│  │  ├─ pair:header-subtitle           【饰】只读标签旁徽标（轮次数/最近活跃）
│  │  ├─ pair:messages-top              【填】消息列顶部（上下文摘要条）
│  │  ├─ pair:empty                     【替】空态
│  │  ├─ pair:separator-time / separator-event / separator-error【替】三类分隔条
│  │  ├─ pair:turn-suffix / turn-actions【饰/填】气泡后附着 / 只读轮次操作（引用/收藏）
│  │  ├─ pair:scroll-to-bottom-suffix   【饰】回底钮角标
│  │  ├─ pair:footer                    【填】底部条（现无此区域，slot 化时补插口）
│  │  └─ pair:overlay                   【覆】整视图覆盖
│  │
│  └─ tracking（运行矩阵 · RunTracking.vue）
│     ├─ tracking:header-side           【填】快照时间旁控件
│     ├─ tracking:range-toggle-extra    【填】范围按钮组旁筛选（需宿主开放 windowValue 口径）
│     ├─ tracking:matrix-corner         【填】左上 190×48 角块（现空白）
│     ├─ tracking:axis-head-badge       【饰】行/列头徽标（sticky 头内小尺寸）
│     ├─ tracking:matrix-cell-overlay   【饰】格子级叠加（pointer-events:none；40px 格仅容 ≤8px 角标）
│     ├─ tracking:matrix-cell-tooltip-section【填】tooltip 数据行追加（MatrixCell 上下文）
│     ├─ tracking:tooltip-footer-action 【填】tooltip 脚注动作
│     ├─ tracking:legend-extra          【填】图例追加（插件新增着色语义须配图例）
│     ├─ tracking:coverage-section      【填】覆盖面面板追加段
│     ├─ tracking:below-canvas          【填】矩阵+图例+覆盖面之下区块
│     ├─ tracking:canvas-overlay        【覆】画布覆盖（引导/框选缩放；自行处理穿透）
│     └─ tracking:matrix-view         ⚠【替】整矩阵替换（失去热力/十字/tooltip 全套语言）
│
├─ ④ workspace（右侧工作区 · App.vue rail + WorkspaceTree.vue）
│  └─ workspace-tree: header-actions【填】标题与关闭之间 / toolbar【填】头部下工具条 /
│     body【替】树体（须接管 loading/error 态语义）/ loading【替】/ error【替】/
│     root-prefix / root-suffix【填】根列表前后虚拟节点（最近文件/收藏伪目录）/
│     footer【填】面板底部 / node-row【替】整行（递归组件需透传渲染上下文）/
│     node-icon【替】图标位（自定义文件类型图标）/ node-suffix【饰】行尾标记
│     （git 态/搜索命中）/ node-menu【填】行级菜单项（需宿主先建菜单原语）/
│     children-prefix【饰】子列表前行（目录摘要）
│
├─ ⑤ overlays（全局覆盖层 · App.vue 挂载）
│  │
│  ├─ modal（通用弹窗骨架统一层 · 先行批次）
│  │  │   现状三种骨架并存：ui/Modal 壳 / 自绘 overlay+Transition / Teleport(body)——
│  │  │   slot 化先统一基础插口，再叠组件级插口
│  │  └─ modal: header【替】/ header-actions【填】/ body【替】/ body-extra【填】/
│  │      footer【替】/ footer-actions【填】/ overlay【覆】
│  │
│  ├─ file-preview（文件预览 · FilePreviewModal.vue）
│  │  ├─ file-preview:viewer            核心候选【替】按扩展名/contentType 注册类型化渲染器
│  │  │   （CSV/PDF/音视频/JSON 树……），优先级高于内置分支
│  │  ├─ file-preview:viewer-override  【覆】接管内置渲染（图片缩放/旋转工具条）
│  │  ├─ file-preview:header-meta-suffix【饰】语言/大小之后（mtime/归属 Agent）
│  │  ├─ file-preview:header-actions   【填】复制与关闭之间（下载/分享）
│  │  ├─ file-preview:code-toolbar     【填】代码区工具条（换行/跳行）
│  │  ├─ file-preview:code-line-suffix 【饰】行尾注解（谨慎）
│  │  ├─ file-preview:loading / error  【替】两态
│  │  ├─ file-preview:binary-fallback  【替】二进制非图片替代展示（现为隐式空白）
│  │  ├─ file-preview:footer           【填】路径旁（hash/历史版本）
│  │  └─ file-preview:overlay          【覆】水印/批注
│  │
│  ├─ create-group（建群向导 · CreateGroupDialog.vue）
│  │  ├─ create-group:fields-top       【填】ID 字段前（选模板/复制现有群）
│  │  ├─ create-group:field-*-suffix   【饰】各输入框后（随机名/冲突校验）
│  │  ├─ create-group:extra-fields     【填】参与者组前/表单尾追加字段（随 create 载荷提交）
│  │  ├─ create-group:participants-toolbar【填】列表上方搜索/过滤/全选（现无搜索）
│  │  ├─ create-group:participant-item-suffix【饰】行尾（能力标签/禁选态）
│  │  ├─ create-group:participant-item 【替】行整替（低优先）
│  │  ├─ create-group:participants-list / -empty / -loading / -error【替】列表体及三态
│  │  ├─ create-group:form-error       【替】结构化错误展示
│  │  └─ create-group:footer-actions / overlay【填/覆】
│  │
│  ├─ usage（Token 用量 · TokenUsage.vue）
│  │  ├─ usage:head-extra              【填】更新时间旁
│  │  ├─ usage:panel-section           核心候选【填】左侧栏摘要与页签间追加块（预算卡/Top 榜；
│  │  │                                   216px 窄栏纵向滚动天然容多块）
│  │  ├─ usage:summary-metric         【填】迷你指标行追加（label+value 对）
│  │  ├─ usage:tab                    【填】页签按钮+内容面板成对注册（「按工具」「按会话」）
│  │  ├─ usage:tab-cloud / tab-daily  【替】默认两页签内容（保留页签壳）
│  │  ├─ usage:cloud-toolbar / cloud-tooltip-section【填】弦图工具栏/tooltip 追加行
│  │  ├─ usage:cloud-overlay / chart-overlay【覆】图表覆盖（660 viewBox 注意坐标系）
│  │  ├─ usage:chart-toolbar-action   【填】柱状图工具栏
│  │  └─ usage:footer-action          【填】刷新/关闭旁
│  │
│  ├─ version（版本信息 · VersionDialog.vue）
│  │  └─ version: header-actions【填】/ compare【替】/ compare-card-suffix【饰】/
│  │     status【替】/ actions【填】/ update-msg【替】/ body-extra【填】/
│  │     changelog【替】/ footer【填】/ overlay【覆】
│  │
│  └─ settings（全局设置 · SettingsPanel.vue 左树+右内容）
│     ├─ settings:main-view          ★【替】= settings-tab:global 收编（左树 ui-tab:* 叶 +
│     │                                   右区 <component :is>；base props globalConfig/nsSchemas/pools）
│     ├─ settings:sidebar-section      【填】左树底部导航段
│     ├─ settings:header-actions       【填】头部关闭钮左
│     ├─ settings:footer-status        【饰】底部状态区插件指示
│     ├─ settings:footer-actions-prepend【填】底部按钮组前
│     ├─ settings:timer-task-actions   【饰】全局任务行内（内置任务保护语义）
│     ├─ settings:timer-editor-fields  【填】任务编辑弹窗字段
│     ├─ settings:panel-decor          【饰】面板角落水印/横幅
│     │
│     ├─ agent-settings-list（Agent 池列表 · AgentListPane.vue）
│     │  └─ agent-settings-list: header-actions / item-badges / item-actions /
│     │     create-form-extra（需扩展 create payload 通道）/ empty
│     │
│     ├─ agent-pane（Agent 编辑页 · AgentPane.vue）
│     ├─ agent-pane:tab              ★【替】= settings-tab:agent 收编（页签条追加 +
│     │                                   内容容器；base props agentId/raw/effective/emit）
│     │  ├─ agent-pane:header-actions   【填】导航 spacer（上/下一个旁）
│     │  ├─ agent-pane:info-sections    核心候选【填】基本信息四卡之后追加配置段
│     │  │                                （Agent 级插件自定义配置区自然落点）
│     │  ├─ agent-pane:identity-fields  【饰】身份卡字段列追加
│     │  ├─ agent-pane:tag-badge-extra  【饰】能力徽章区（慎用：标签有门禁语义）
│     │  ├─ agent-pane:llm-field        【覆】按 field.key 覆盖模型字段控件
│     │  └─ agent-pane:llm-sections-append【填】模型页签末尾段
│     │
│     ├─ agent-ext（Agent 插件配置 · ExtToolsPane.vue 三视图）
│     │  └─ agent-ext: side-nav-append + views-append（配对【填】第 4 视图）/
│     │     plugin-card-badges / plugin-card-actions / tool-card-badges /
│     │     tool-card-actions / event-leaf-actions（均【饰】；与插件库治理分层）/
│     │     anno【覆】说明条
│     │
│     ├─ agent-timer（Agent 定时 · TimerPane.vue）
│     │  └─ agent-timer: header-actions / item-actions / item-schedule-extra（饰/填）/
│     │     editor-fields【填】/ mode-options ◆新调度类型注册
│     │
│     ├─ plugin-library（插件库 · PluginLibraryPane.vue 三页签三视图）
│     │  └─ plugin-library: banner【饰】/ header-actions / tabs-append /
│     │     directory-tools / directory-row-actions / config-side-nav-append +
│     │     config-view-append（配对）/ catalog-item-menu / local-item-actions /
│     │     tool-item-badges / tool-item-actions / event-leaf-actions /
│     │     market-result-actions / gov-modal-extra（填/饰）/
│     │     market-empty【覆】
│     │
│     ├─ pool（连接池 · PoolManager.vue）
│     │  └─ pool: header-actions / entry-detail / entry-actions / model-row-actions（饰）/
│     │     editor-fields-append 核心候选【填】（provider 插件连接级配置落点）/
│     │     provider-templates ◆模板清单数据覆盖（宜注册制）
│     │
│     ├─ extension-settings（扩展配置弹窗 · ExtensionSettingsModal.vue）
│     │  └─ extension-settings: field-control ◆自定义控件类型注册 / fields-append【填】/
│     │     field-meta【饰】/ note【覆】/ footer-prepend【填】
│     │  └─ 原子层：setting-field:control ◆ / setting-field:suffix【饰】；
│     │     ns-field-list: fields-append / item-suffix / json-fallback
│     │
│     ├─ entry-picker（路径选择 · EntryPickerModal.vue）
│     │  └─ entry-picker: row-suffix / footer-prepend（饰/填）/ roots ◆快捷根清单
│     ├─ staging-review（暂存人审 · StagingReviewModal.vue）
│     │  └─ staging-review: overview-extra / grant-warn ◆权限警示注册 /
│     │     file-actions / footer-prepend
│     └─ confirm（通用确认 · ConfirmDialog.vue）
│        └─ confirm: body-extra / footer-prepend（ask() 命令式协议保留）
│
├─ ⑥ global（全局层）
│  ├─ global:style                   ★【◆】CSS 变量/scoped（消毒 + 前缀重写不变）
│  ├─ global:event                   ★【◆】ws-event 数据订阅（非视觉）
│  └─ 候选：global:toast / global:command-palette（宿主先建原语再开口）
│
└─ 数据声明层（非视觉 · 「声明优先于 slot」原则的落点）
   ├─ message-view ★ / tool-result-view ★ / perspective ★（整卡/整页替换归注册表）
   ├─ tool-icon / tool-label ◆静态表注册化（镜像 registerToolResultView 幂等/priority）
   ├─ extension fields/showWhen ★（ExtensionSettingsModal 声明式范式，最成熟）
   ├─ 保护行/承重行/状态标签/落点标签/权限警示等前端硬编码表 ◆转注册制
   └─ tool-result: envelope-parser / status-mapper / data-normalizer ◆
```

**规模小结**：全树约 240 个候选插口。其中 ★ 既有缝 11 处（8 UISlotId + 三注册表
+ fields 机制）；⚠ 高风险替换 5 处（tracking:matrix-view、runs:overview-entry、
chat:input 整替、usage:modal、各整面板替换）；约 2/3 为装饰型/填充型轻插口。

## 5. 横切约定（六组盘点的共性结论）

1. **四态模式统一**：loading / error / empty / content 四态在几乎所有组件重复出现。
   每个替换型插口必须遵守「**未填充时回落宿主默认渲染**」；四态本身是对应
   替换型插口的天然子插口。
2. **弹窗骨架先行统一**：三种弹窗骨架（ui/Modal / 自绘 overlay / Teleport）应先
   收敛到 `modal:*` 基础插口层，再叠组件级插口——否则每个弹窗要开一套重复插口。
3. **z-index 配额秩序**：现状 Modal(600) → 设置域 Modal(1200) →
   ExtensionSettings/StagingReview/安装确认(1250) → 治理确认(1280) →
   EntryPicker(1300) → 更多菜单(9999) → FilePreview(10000) → mention 弹层(320)。
   插件弹窗/浮层需要宿主**统一发配额**，禁止插件自选高位。
4. **行点击导航语义宿主所有**：roster/session-list/runs 的整行点击承担导航；
   装饰型附着必须 `click.stop` 且不触发列表重排（roster 有行序冻结机制）。
5. **门控正交性**：slot 内容可见性与 `ui.showThinking` / continuation /
   showActions / compact 等门控正交（除非内容本身属于链体语义）。
6. **状态词汇宿主固定**：OK/ERR/BLK + running dots（工具卡标签栏）、
   error/warning/blocked 条（结果体）、六态徽章 ui-badge 色语言——插件只能
   附着不能换（除显式 replace slot）。
7. **移动端行为继承**：三个列表面板共用「≤768px 左抽屉 +
   .sidebar-mobile-visible + closeSidebar inject」模式，WorkspaceTree 为右侧
   覆盖——**替换型 slot 必须继承对应移动端行为**（替换型的最大隐性成本）。
8. **命令式通道保留**：ToolResultWrite 的 `open()` expose、ConfirmDialog 的
   `ask()`、SettingsPanel 的 initialAgentId/initialSection 入口定位——slot 化
   不破坏等价命令式协议。
9. **启停两层分家不可绕开**：patch 强制停用（插件目录）/ 软停用（全局默认层）/
   差异层（Agent ext）是全库最强结构语义；任何 card-actions 类 slot 不得提供
   第四条启停路径。
10. **安全边界不变式**：isolated 档不进 slot 注册表；iframe 沙箱属性不可被
    插件放宽；global-style 消毒管道不变；只读上下文（pair 视角）的 slot 需
    携带 readonly 声明。
11. **命名与替换语义**：`<域>:<元素>[-<位置/方向>]` param-case；同 id 后注册
    替换（幂等）、order 缺省 100 稳定排序——延续 slots.ts/三注册表现行语义。

## 6. 既有 UISlotId 收编映射

| 现有 UISlotId（8） | 树中节点 | 动作 |
|---|---|---|
| `perspective` | `main:perspective` ★ | 命名收编；注册表机制不变 |
| `tool-result` | `tool-card:result-view` ★ | 命名收编 |
| `message-view` | `message:final-view` ★ | 命名收编 |
| `ws-event` | `global:event` ★ | 非视觉，保留 |
| `settings-tab:global` | `settings:main-view` ★ | 命名收编（渲染口不变） |
| `settings-tab:agent` | `agent-pane:tab` ★ | 命名收编 |
| `sidebar-action` | `sidebar:plugin-actions` ★ | 命名收编 |
| `global-style` | `global:style` ★ | 保留 |

实现期注意：`UISlotId` 是封闭 TS union，后端 `BUILTIN_SLOTS` 是静态数组——
扩槽需同步 shim union、bridge 注册方法、后端白名单三处；树级命名方案先行
定稿可避免 union 反复改（或裁决改为 string + 后端 declareSlot 目录校验）。

## 7. 分批落地建议（供里程碑规划参考）

- **P0 规范收编**（不改行为）：树级命名规范定稿；8 个既有缝按 §6 收编改名；
  `modal:*` 骨架统一 + 四态回落约定 + z-index 配额表文档化；
  `sidebar:list-panel` / `usage:tab` / `agent-ext:views-append` 这类
  「按钮+内容成对注册」的容器注册表抽象。
- **P1 高价值填充**：`chat:header-actions`、`chat:composer-dock`（三 dock 卡
  迁入为内置贡献者）、`tracking:dock-widget`、`chat:input-toolbar` +
  `chat:input-mention-groups`（数据贡献）、`file-preview:viewer`、
  `agent-pane:info-sections`、`pool:editor-fields-append`、`usage:panel-section`。
- **P2 装饰细粒度**：各 `*-item-suffix` / `*-badge` / `*-menu-items` 族
  （约百个；收益大风险小，可随宿主组件改版分批顺带开口）。
- **P3 数据注册表并行批**：toolIcon / toolLabel / 保护行·承重行·状态标签等
  硬编码表注册化（不依赖视觉 slot 进度）。
- **克制项**：⚠ 高风险替换（整矩阵/整 composer/整弹窗）建议列为宿主保留
  扩展点，或要求实现对应宿主接口后再开放。

## 8. 覆盖面与方法

- 主线通读：App.vue、stores/ui.ts、core/extensions/{slots,types,host,bridge,
  isolated,p5.5-policy}.ts、core/registry/{perspectives,messageViews,
  toolResultViews}.ts、shims/@agentchat/protocol.ts（UISlotId 节）、
  ac-webui-extensions/src/service.ts、ui/index.ts、ui/tokens.css、
  vite.config.ts、ui-plugin-iframe.html、stores/feed.ts（头部）、
  src/README.md（可视化层）。
- 六组并行盘点（每组全文读取）：① Sidebar/AgentList/SessionList/
  WorkspaceTree(Node)/PerspectiveHost/ResizeHandle；② DialogView/ChatInput/
  InteractionBar/ConversationJobsChip/InputMention/QueueDock/
  ScrollableViewport/useChatShell；③ TurnDisplayItem/AssistantMessage/
  UserMessage/ToolMessage + 9 个 ToolResult*/useToolResult/toolIcon/toolLabel；
  ④ RunTracking/RunTrackingPanel/GoalBar/TaskDock/TodoPanel/TokenUsage/
  useTaskTracking；⑤ PairDialogView/GroupDrawer/CreateGroupDialog/
  VersionDialog/FilePreviewModal；⑥ settings 域 13 组件 + schema.ts。
- 未覆盖（后续补）：`desktop/` 壳层、`isolated-runtime.ts` 细节、CSS 逐类
  契约清单（可从各盘点报告的样式契约描述提炼）。
