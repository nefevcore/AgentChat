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
已迁移标杆：ToolMessage/AssistantMessage/TurnDisplayItem/ToolResultRunCode/ToolResultSubagent 五处琥珀环（cr-122）。

### R3 自建徽章 → .ui-badge 族

状态徽章 `ui-badge ok|err|warn|info|dim`；身份标签 `ui-badge tag` + tt-* 色相类；类型徽记 `ui-badge kind`。
`cfg` 已并入 `info`（cr-122）；色相类必须双档同加（暗亮档，测试⑤锁）。

### R4 盒装卡片清单 → .ui-row

常驻边框 + bg-surface 填充的清单项改 `class="<语义类> ui-row"`；scoped 样式只留专属修饰（padding/gap/cursor）。
选中态底色 = `--role-selected-bg`（不是 bg-surface——在 surface 宿主内会同值相消，cr-122 修过）；hover 只亮底不加边框。
基础设施/automatic 行加 `is-auto`（虚线标识）。

### R5 折叠内容区 → CollapseRow

工具卡/思考区/任何「label 行 + 左竖线 + 限高滚动正文」形态。自带可达性（button/aria-expanded/aria-live=off/吸底退出）。

### R6 composer 上方浮层 → DockCard

ApprovalBar/InteractionBar/QueueDock/GoalDockCard/TodoDockCard 五处同 recipe 副本归一；busy 态正文区 role=status 由壳自带。

### R7 反馈形态归位

- 结果 2~5 秒可消 → `toastOk/toastError/toastBusy`（同 key 原位刷新）
- 状态持续在场（归档中/连接中）→ `FeedbackNotice`（tone=busy）
- 已发现反例：菜单内 FeedbackNotice 随点菜单即关消失——那是 toast 场景，见 ActivityBar 备份迁移注释

## 三、分批路线（每批一个 CR，独立可验）

| 批次 | 包 | hex 量 | 主要动作 |
|---|---|---|---|
| P1 | conversation | 120 | 消息卡三件套迁 CollapseRow；ChatInput 反馈归 toast；TokenGauge 剩余散件 |
| P2 | agents + singles | 61+66 | AgentList/SessionList 清单行 ui-row 化（list-item 双源收编）；状态点 StatusDot |
| P3 | workspace + runview | 55+52 | FilePreview/WorkspaceTree spinner 归 BusyRing；RunTracking 树行 ui-row |
| P4 | browser + usage + system | 41+34+25 | 浏览器结果卡徽章归 ui-badge；usage 图表色板分层核对；VersionDialog 类横幅令牌化（已迁） |
| P5 | 其余小包 | <20/包 | fs/goal/jobs/layout/shell/subagent/run-code/timer/todo/group/web 逐包清零 |

每批验收：`pnpm typecheck && pnpm webui:typecheck && npx vitest run src/webui/tests` + 定向 lint + 该包截图对照。

## 四、禁止事项（评审红线）

1. 新增任何 `#hex`（分类色板与一次性 SVG 数据色除外，须注释理由）。
2. 新增自建 spinner/徽章/胶囊样式——kit 有的必须用 kit。
3. 语义图形件取墨色档（对比度虚高浪费亮度）或文字取图形档（不达标）。
4. 跨主题同值假设——所有色两主题都要过目（aurora 档普遍更深）。
5. 深路径 import kit 组件；绕过 L0 令牌直写 rgba 数值。

## 五、已完成基准（勿重复迁移）

- webui-kit 全部组件已达标（cr-121~123）；v2.html 陈列页即目标态实物。
- 已迁移业务件：ExtToolsPane/PluginLibraryPane（ui-row+ui-badge+is-auto）、ConversationHeader（FeedbackNotice chip）、TokenGauge（三档+双档色+图形档）、usage 折线/云图、VersionDialog 横幅、5 处琥珀忙环、ChatInput 发送键影。
- 语义色现值（cr-123 终值）：墨色档 N `#9bd39a/#fcd34d/#f0879a` · A `#356f43/#8a5a06/#9f1239`；图形档 N `#9fd89f/#fde68a/#f7a8b8` · A `#669a6d/#bb831c/#d9536f`；星板马卡龙 8 色（薰衣草/蓝青/湖青/苔绿/橄榄/珊瑚/品红紫/暮蓝）。