# 现有 UI 文件重构指南（向 v2 标准控件库迁移）

> 依据：`src/docs/webui/v2.html`（目标态全量陈列 · cr-119~123）+ `webui-standard-controls-proposal.md`（cr-116 提案）。
> 本文档回答「存量业务面怎么改」：迁移规则、消费面清单、分批路线与验证阶梯。
> 规范事实源：`.dsh/skills/agentchat-dev/references/webui-style.md`（令牌表/组件表/铁律）。

## 一、目标态一页纸

- **17 项标准控件**（Icon/Button/Avatar/Modal/Sheet/PullToRefresh/RingProgress/StatusDot/Tooltip/BusyRing/CollapseRow/DockCard/FeedbackNotice/toast/ToastHost/StarAvatar + 纯函数），全部从 `@agentchat/webui-kit` 出口消费，禁深路径。
- **三份 L0 css**（tokens/row/badge）是样式的唯一事实源；组件样式只引令牌，禁硬编码色值/圆角/阴影。
- **语义色双档**（cr-123）：文字用墨色档 `--ok/--warn/--err`（4.5 线），图形件（环描边/状态点/色条/折线）用 `-graphic` 后缀（3.0 线）。
- **反馈双通道**：原地持久状态 = FeedbackNotice（恒 chip）；全局瞬时通知 = toast；禁止自建 ref+setTimeout 反馈。
- **验证锁**：`src/webui/tests/contrast-tokens.test.ts`（8 契约：令牌齐备/墨色四底/图形档三底/实底前景/徽章 tint/标签双档/开关三态/星板 tint）+ `preview-kit-sync.test.ts`（v2 注入同步）。

## 二、迁移规则（按改动类型）

### R1 硬编码色 → 令牌（最大头：全仓 ~615 处 hex）

| 你写的 | 应改为 | 说明 |
|---|---|---|
| `#xxx` 文字色 | `var(--text-1/2/3)` 或语义墨色档 | 先判断信息层级 |
| 状态色 hex | `var(--ok/--warn/--err)`（文字）/ `-graphic`（图形件） | 图形件判定：环/点/条/线，非文字 |
| 大色块/装饰底 | `rgba(var(--x-rgb), 0.08~0.14)` tint | 三元组与色值逐位同步（测试锁） |
| 分类色板（图表每项一色） | 保持独立色板 | 语义 ≠ 分类；不要把 --ok 拉进分类板 |
| 旧语义色值散件 | 直接替换为新令牌 | `#22c55e/#eab308` 等是旧档位化石 |

### R2 自建忙指示 → BusyRing（15 文件残留）

凡 `@keyframes` 旋转 + border-top-color 的 spinner，一律 `<BusyRing :size="13" />`（独立等待位加 `label`）。
色轴恒 primary，不再有 busy/running 两档；`--motion-scale` 归一与 reduced-motion 由组件自带。
消息卡忙环例外（cr-125 裁决）：ToolMessage/AssistantMessage/TurnDisplayItem/ToolResultRunCode/ToolResultSubagent 的 label 行内环**保留自建**（cr-122 仅色轴归一 primary，未迁 BusyRing）——label 行承载域动作/sticky/流式语义，超出 BusyRing 配方；其 reduced-motion 豁免见 main.css 清单。

### R3 自建徽章 → .ui-badge 族

状态徽章 `ui-badge ok|err|warn|info|dim`；身份标签 `ui-badge tag` + tt-* 色相类；类型徽记 `ui-badge kind`。
`cfg` 已并入 `info`（cr-122）；色相类必须双档同加（暗亮档，测试⑤锁）。

### R4 盒装卡片清单 → .ui-row

常驻边框 + bg-surface 填充的清单项改 `class="<语义类> ui-row"`；scoped 样式只留专属修饰（padding/gap/cursor）。
选中态底色 = `--role-selected-bg`（不是 bg-surface——在 surface 宿主内会同值相消，cr-122 修过）；hover 只亮底不加边框。
基础设施/automatic 行加 `is-auto`（虚线标识）。

### R5 折叠内容区 → CollapseRow

工具卡/思考区/任何「label 行 + 左竖线 + 限高滚动正文」形态。自带可达性（button/aria-expanded/aria-live=off/吸底退出）。
例外（cr-125）：ToolMessage（label 行含域动作）、TurnDisplayItem（sticky 表头 + 无折叠变体）、AssistantMessage 思考区（流式吸底）不迁——形态不同构，强迁必改行为。

### R6 composer 上方浮层 → DockCard

ApprovalBar/InteractionBar 外壳已迁（cr-125）；GoalDockCard/TodoDockCard 待迁；QueueDock 例外（cr-125 裁决）——表头是折叠开关语义（多条收起/单条直渲染），DockCard 无 collapsible header，保留自建。busy 态正文区 role=status 由壳自带。

### R7 反馈形态归位

- 结果 2~5 秒可消 → `toastOk/toastError/toastBusy`（同 key 原位刷新）
- 状态持续在场（归档中/连接中）→ `FeedbackNotice`（tone=busy）
- 已发现反例：菜单内 FeedbackNotice 随点菜单即关消失——那是 toast 场景，见 ActivityBar 备份迁移注释

## 三、分批路线（每批一个 CR，独立可验）

| 批次 | 包 | hex 量 | 主要动作 |
|---|---|---|---|
| P1 | conversation | 120 | ✅ cr-125 完成：hex 143→9（余为分类色板/常量，均注释）；ApprovalBar/InteractionBar→DockCard；ContextInjectCard→CollapseRow；4 处 spinner→BusyRing；徽章/反馈归位；消息卡三件套与 QueueDock 按例外保留 |
| P2 | agents + singles | 61+66 | ✅ cr-126 完成：AgentList/SessionList→ui-row（active→is-selected）、状态点→StatusDot、ws-spin→BusyRing、徽章→ui-badge dim；hex 158→33（余为分类色板/遮罩常量/计数徽章） |
| P3 | workspace + runview | 55+52 | ✅ cr-127 完成：5 处 spinner→BusyRing；RunTrackingPanel 树行→ui-row；bespoke 深底退役；hex 146→44（余为沙箱调色板/文件类型分类色板/iframe 白底常量） |
| P4 | browser + usage + system | 41+34+25 | ✅ cr-128 完成：ToolResultBrowser 徽章→ui-badge（tag 色相经 --tag-hue）；usage 图表色板分层核对 + textColor 亮档化石修正；VersionDialog 第三态补迁；hex 38→18/14→10/26→1 |
| P5 | 其余小包 | <20/包 | ✅ cr-129 完成：fs/shell/group/subagent/run-code 忙指示→BusyRing、徽章→ui-badge；GoalBar/TodoPanel 外壳→DockCard；状态点改图形档；hex 158→29（余为分类色板/终端恒暗皮肤/计数徽章） |
| P6 | renderer + webui/assets | 47+93 | ✅ cr-130 完成：renderer R1 令牌化；main.css 零消费别名清 62 行；tokens.css 删 --color-primary-rgb/--color-warning-rgb 死条目（保活引用退役）；v2.html 重注入 `--check` 通过 |
| P7 | 全仓别名清收 | — | ✅ cr-131 完成（审查发现的补漏批）：12 文件 85 处 `var(--color-*)` 归本源令牌（含 kit StarAvatar 去自身别名依赖）；tokens.css 别名层 21 条零消费条目整族剪除（327→298 行）；main.css 51 处重复定义清除（209→149 行）；保留 `--color-code-*`（markdown.css 消费）与 `--radius-*/--space-*` 族 |

每批验收：`pnpm typecheck && pnpm webui:typecheck && npx vitest run src/webui/tests` + 定向 lint + 该包截图对照。

## 四、禁止事项（评审红线）

1. 新增任何 `#hex`（分类色板与一次性 SVG 数据色除外，须注释理由）。
2. 新增自建 spinner/徽章/胶囊样式——kit 有的必须用 kit。
3. 语义图形件取墨色档（对比度虚高浪费亮度）或文字取图形档（不达标）。
4. 跨主题同值假设——所有色两主题都要过目（aurora 档普遍更深）。
5. 深路径 import kit 组件；绕过 L0 令牌直写 rgba 数值。

## 五、已完成基准（勿重复迁移）

- webui-kit 全部组件已达标（cr-121~123）；v2.html 陈列页即目标态实物。
- 已迁移业务件：ExtToolsPane/PluginLibraryPane（ui-row+ui-badge+is-auto）、ConversationHeader（FeedbackNotice chip）、TokenGauge（三档+双档色+图形档）、usage 折线/云图、VersionDialog 横幅、5 处消息卡忙环色轴归一（保留自建，见 R2 例外）、ChatInput 发送键影。
- **cr-125~131 全量迁移完毕（27 个 ac-client-ui-* 包 + webui/assets + renderer）**：DockCard（ApprovalBar/InteractionBar/GoalBar/TodoPanel）、CollapseRow（ContextInjectCard）、BusyRing（12 处自建 spinner 退役）、ui-badge（约 30 处自建徽章退役）、ui-row（AgentList/SessionList/RunTrackingPanel）、StatusDot、反馈归位（toast/FeedbackNotice）；legacy `--color-*` 别名层整族清零（业务面 var() 零消费）。
- 存量残留（合规例外，均就地注释）：分类色板（动作类型/文件类型/工具身份/星板/云图/canvas legend）、遮罩与加深常量（`#000` 混色、`#fff` 画布底、QR 数据色、终端恒暗皮肤）、计数徽章 `#ef4444`（kit 无计数原语）、iframe srcdoc 沙箱文档自带调色板。
- 语义色现值（cr-123 终值）：墨色档 N `#9bd39a/#fcd34d/#f0879a` · A `#356f43/#8a5a06/#9f1239`；图形档 N `#9fd89f/#fde68a/#f7a8b8` · A `#669a6d/#bb831c/#d9536f`；星板马卡龙 8 色（薰衣草/蓝青/湖青/苔绿/橄榄/珊瑚/品红紫/暮蓝）。