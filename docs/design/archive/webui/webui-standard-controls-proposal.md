# AgentChat 标准控件库整理提案

> 基于 `webui/design/gallery.html`（时居 src/docs）全量陈列（16 组件 + 2 纯函数模块 + 6 组业务面未提取形态）与全仓消费面数据，
> 对现有控件做删减 / 合并 / 组合整理，形成一套专用于 AgentChat 的标准控件库目标态。
> 数据截至 2026-10-02（CR cr-116）；消费面数字均来自全仓 import 与类名扫描。

## 一、现状盘点

### 1.1 webui-kit 现有出口与消费强度

| 控件 | 消费面 | 消费强度 | 判定 |
|---|---|---|---|
| Icon | 46 文件 | ★★★ 核心 | 保留（底座） |
| Modal | 21 文件 | ★★★ 核心 | 保留 |
| Button | 17 文件 | ★★★ 核心 | 保留（soft 变体降级，见 2.1） |
| Avatar | 10 文件 | ★★☆ | 保留（square 形态零消费，见 2.2） |
| StarAvatar | 4 文件 | ★★☆ | 保留（星群身份核心） |
| starColor | 4 文件 | ★★☆ | 保留 |
| Sheet | 2 文件 | ★☆☆ | 保留（full 形态零消费，见 2.3） |
| PullToRefresh | 3 文件 | ★☆☆ | 保留（threshold 零覆写） |
| ThinkingIcon | 2 文件 | ★☆☆ | 保留 |
| formatDurationMs | 2 文件 | ★☆☆ | 保留 |
| formatFileSize | 2 文件 | ★☆☆ | 保留 |
| formatRelativeTime | 3 文件 | ★☆☆ | 保留 |
| StatusDot | 3 文件 | ★☆☆ | 保留（idle 态零消费，见 2.4） |
| Tooltip | 3 文件 | ★☆☆ | 保留 |
| FeedbackNotice | 1 文件 | ★☆☆ | 保留（toast 已覆盖主反馈位） |
| ToastHost + toast() | 39 文件（具名 39 处） | ★★★ 核心 | 保留（info 具名零消费，见 2.5） |
| RingProgress | 1 文件 | ★☆☆ | 保留（TokenGauge 专用） |
| StarCard | **0** | ✕ | **删除**（tree.md 标注预留原语，无消费） |
| PulseTrace | **0** | ✕ | **删除**（同上） |

### 1.2 业务面未提取形态（复用面排序）

| 形态 | 现居 | 复用面 | 下沉判定 |
|---|---|---|---|
| dock 卡外壳 | ApprovalBar / InteractionBar / QueueDock / GoalDockCard / TodoDockCard | **5 处同 recipe** | **下沉**——最高优先级 |
| 琥珀忙指示 spin-ring | ToolMessage / AssistantMessage / TurnDisplayItem / ToolResultRunCode + main.css 全局 | **4 组件 + 全局** | **下沉**——统一为 BusyRing 原语 |
| 折叠内容行（label + 左竖线体 + 限高视口） | ToolMessage / AssistantMessage think 区 | 2 处高度同构 | **合并下沉**——CollapseRow 原语 |
| 消息气泡对 | AssistantMessage / UserMessage | 2 处对偶 | 形态保留在业务（语义耦合），不强制下沉 |
| InputMention 弹层 | ChatInput 专属 | 1 处 | 不下沉（键盘/数据逻辑业务耦合深） |
| TokenGauge chip | ConversationHeader 专属 | 1 处 | 不下沉（席位逻辑耦合） |

## 二、删减清单（零消费面裁除）

### 2.1 Button：soft 变体收编进 ghost

- 数据：`variant="soft"` 仅 2 处 vs `variant="ghost"` 26 处。两变体视觉差异仅「常态底色 bg-hover vs 透明」，hover 态完全一致。
- 动作：删 soft 变体，2 处消费改 ghost；API 面 `variant` 收窄为 `primary | ghost | danger`。

### 2.2 Avatar：裁除 square 形态

- 数据：`shape="square"` 全仓零消费（全部 circle）。
- 动作：删 square 分支与 `--r-sm` 圆角变体，Avatar 恒为圆形。

### 2.3 Sheet：裁除 full 形态与 keepAlive 形态

- 数据：`:full` 零消费；keepAlive（v-show 保活）仅 AuxSidebarHost 探索性使用。
- 动作：删 full 分支；keepAlive 待 AuxSidebarHost 迁移后移除。

### 2.4 StatusDot：裁除 idle 态

- 数据：idle 与 ok 同色同逻辑（源码 case 穿透），且 idle 零消费。
- 动作：status 联合类型收窄为 `thinking | running | ok | err | offline`。

### 2.5 toast：裁除 toastInfo 具名出口

- 数据：toastOk 12 / toastError 23 / toastBusy 4 / **toastInfo 0**。
- 动作：删 toastInfo（info 形态经 `toast(text, {tone:'info'})` 仍可达，只裁高频具名面）。

### 2.6 删除组件：StarCard、PulseTrace

- 零消费预留原语（tree.md L414 明确标注），已从陈列页移除；源码删除后 index.ts 出口同步清理。
- 防返祖：删除后 `pnpm typecheck` 保证无隐式引用。

## 三、合并清单（同构收敛）

### 3.1 CollapseRow：工具卡行 × 思考卡行 → 单一原语

- 现状：ToolMessage 的 `.tool-label`/`.tool-body` 与 AssistantMessage 的 `.think-content-label`/`.think-content-body` 结构同构
  （图标位 ⇄ spin-ring 切换 + 单行截断标题 + 左竖线 `margin-left:7 + border-left:1 + padding-left:14` + 限高 `--card-viewport-max` 视口 + 吸底跟随）。
- 目标：kit 新增 `CollapseRow`（props：icon/title/meta/streaming/failed/defaultOpen，slot：body），两处迁移消费。
- 收益：折叠交互、hover 图标切换、流式吸底三套逻辑单源化（当前两份实现已出现细节漂移）。

### 3.2 BusyRing：琥珀忙指示单源化

- 现状：`.tool-spin-ring` / `.think-spin-ring` / `.chain-spin-ring` / run_code 卡各自复制同一 recipe
  （13px 环 + 琥珀 border-top + 0.8s 旋转），2026-09-13 统一选型的色值散布 4 处。
- 目标：kit 新增 `BusyRing`（size prop），全部替换；`.x-spin-ring`/`spin-ring` 类名从 main.css 移除。

### 3.3 DockCard：dock 卡外壳原语

- 现状：5 处消费同一外壳 recipe（`margin:0 10px 6px` + border + `--r-lg` + `--shadow-dock` + 13px 正文密度），
  交互（eyebrow + 标题 + 收起/关闭）也趋同。
- 目标：kit 新增 `DockCard`（props：eyebrow/title/collapsible/closable；slot：default + actions），五处迁移。
- 注：这是唯一「新增而不是收敛」的原语——但它消灭的是五份漂移中的外壳副本，属合并性质。

## 四、组合清单（业务形态归位，不进 kit）

这些形态保留在业务行包（语义耦合深，强行下沉违反「最少抽象」），但组合方式标准化：

| 业务形态 | 标准组合 | 归属 |
|---|---|---|
| 消息气泡 | Avatar + CollapseRow + BusyRing + markdown 体 | conversation 行 |
| 输入卡 | Button(ghost/primary) + Tooltip + Icon + InputMention（业务私有） | conversation 行 |
| 会话头 | RingProgress + 状态色映射 + 下挂面板 | conversation/consumer 行 |
| 审批/提问/排队 dock 卡 | DockCard + Button + FeedbackNotice | 各业务行 |
| 工具结果卡 | CollapseRow + BusyRing + 徽章族 + mono 视口 | 各 ToolResult 行 |

## 五、目标态标准库总表

```
webui-kit（标准控件库 · 整理后）
├─ 底座   Icon · Button(primary|ghost|danger) · Avatar(圆形) · BusyRing★
├─ 反馈   toast(ok|error|busy) · FeedbackNotice · StatusDot(5态) · Tooltip
├─ 浮层   Modal · Sheet(底部滑入) · PullToRefresh
├─ 结构   CollapseRow★ · DockCard★ · RingProgress
├─ 星群   StarAvatar（光环） · starColor
├─ 图标   ThinkingIcon · ThoughtIcon（经 icons.ts thought 名间接消费）
└─ 纯函数 formatFileSize · formatDurationMs · formatRelativeTime · hexTriplet(内部)
```

★ = 本提案新增（三个，全部来自业务面既有形态收敛）。

删除合计：2 组件 + 4 死形态（soft/square/full+keepAlive/idle）+ 1 死出口（toastInfo）+ PulseTrace 附带的 ui-flow 动画。

## 六、迁移路线（三批，每批独立可验）

| 批次 | 内容 | 验证 |
|---|---|---|
| P1 删减 | 删 StarCard/PulseTrace + 4 死形态 + toastInfo；index.ts 同步 | typecheck + lint + 全量单测 |
| P2 合并 | 新增 BusyRing → CollapseRow（含工具卡/思考卡迁移） | 定向 vitest conversation 包 + 视觉对照截图 |
| P3 组合 | DockCard + 五处 dock 迁移 + main.css spin-ring 清理 | smoke + webui:typecheck + 截图 |

每批一个 CR；P2/P3 迁移期间 gallery 同步更新陈列（保持对照页与库同步是它的存在目的）。

## 七、红线对齐自查

- 摘掉任一新原语（BusyRing/CollapseRow/DockCard），消费方回退到自有副本即可——插槽-插头成立。
- 无跨行 import 实现：三个新原语纯展示组件，零 cordis 依赖。
- 令牌驱动：全部样式只引 tokens.css 变量（陈列页已验证双主题联动）。
- 判死证据：所有「零消费」结论均有全仓 grep 佐证，与 tree.md 裁决交叉验证。

## 八、cr-121 落地记录（v2 预览页评审修正 + 契约增量）

评审以 `src/docs/webui/v2.html`（cr-119）为对象，实测双主题 CSS 变量并逐条对照全仓源码。
结论：提案的分层与删减方向成立；**主要缺口不在删减，而在「契约层」**——对比度、焦点、
动效归一、可达性四类在 kit 内整体缺失，预览页因此长期展示了一个比源码更理想的库。
以下全部已落地。

### 8.1 对比度定档（旧 → 新；括号 = on bg-base / on bg-surface）

| 令牌 | 暗色 Nebula | 亮色 Aurora |
|---|---|---|
| `--text-2` | #bdc3c7（9.8 / 7.7 ✓ 不动） | #7f8c8d → **#5f6b78**（3.5 → 5.4） |
| `--text-3` | #7f8c8d → **#949ea0**（5.0 → 6.35；surface 上原 3.96） | #a8abb2 → **#666b71**（2.3 → 5.3） |
| `--primary` | #818cf8（不动：暗底作为文字用色合格） | #6366f1 → **#4f46e5**（4.5 → 6.3） |
| `--accent` | #f472b6（不动） | #ec4899 → **#be185d**（3.5 → 6.1） |
| `--ok` | #10b981 → **#34d399** | #10b981 → **#065f46** |
| `--warn` | #f59e0b（不动） | #f59e0b → **#92400e** |
| `--err` | #e74c3c → **#f28b82** | #e74c3c → **#b91c1c** |
| `--warn-strong`（新·用量四档中间档） | **#fb923c** | **#c2410c** |
| `--on-primary`（新·主色实底前景） | **#16161a**（白字 on #818cf8 仅 2.99） | **#ffffff** |

三条判据（不是「看着顺眼」）：

1. **徽章 tint 底是最坏底**——淡染底色会把背景亮度拉向本色，故状态徽章 / `.tt-*` 标签 /
   星色（首字 + 图标）都必须按「本色 × 自身 tint 底」校验，而不是按裸底。
2. **能力标签色相必须双档**：暗底取 300/400 档、亮底取 700/800 档。单值色相不可能同时
   过两种底（旧值在暗底 8% tint 上只有 2.7~4.0）。
3. **星色是文字色**（首字/图标）+ 自身 14% tint 底，所以 starColor.ts 的两个主题各自取档：
   暗底更亮（300 档）、亮底更深（800/900 档）；用户白金色不参与哈希但同样校验。

### 8.2 四类契约（kit 内此前整体缺失）

| 契约 | 内容 |
|---|---|
| 焦点 | `--focus-ring / -width / -offset` + tokens.css 全局 `:focus-visible`；开关等「input 透明覆盖」形态由 row.css 把环画到可见元素（此前 kit 内 0 条 focus 规则，规则只散落在业务面） |
| 动效 | `--motion-scale`：一切时长写 `calc(Xs * var(--motion-scale))`，`prefers-reduced-motion` 里归零（此前 kit 内 14 处动画无一响应系统设置）；StarAvatar 运行光环按既有裁决豁免（功能语义不可静止降级） |
| 命中区 | `--hit-min`(24px)：开关（旧 34×18）、toast 关闭键（18）、Sheet 抓手（36×4）、导航点阵（9）一律以透明覆盖层/伪元素撑到下限，视觉尺寸不变 |
| 语义 | 状态色（ok/warn/err/info）只用于「结果与状态陈述」；控件开合用中性 + 主色（开关关闭 = 中性灰、开启 = 主色），红只留给「阻断/错误」——旧「红绿开关」把危险色与关闭态混成一色 |

### 8.3 三原语落地（§四的 ★ 三项）

| 原语 | 归一对象 | 关键契约 |
|---|---|---|
| `BusyRing` | ToolMessage / AssistantMessage / TurnDisplayItem / ToolResultRunCode 四处 spin-ring + toast / FeedbackNotice 的 loader 旋转 | `tone: busy(琥珀)\|running(靛蓝)`、`size`（行内 13 / 独立 18）；默认 `aria-hidden`（装饰），独立语义位传 `label` 才以 `role=status` 播报 |
| `CollapseRow` | ToolMessage 工具卡 + AssistantMessage 思考区两份漂移实现 | label 行是真正的 button（`aria-expanded` / `aria-controls`）；正文视口 `aria-live=off`（流式输出不逐句打断读屏）；吸底跟随可退出（出现「回到底部」） |
| `DockCard` | ApprovalBar / InteractionBar / QueueDock / GoalDockCard / TodoDockCard 五处外壳 | `tone: idle\|busy\|warn\|error`；busy 时正文区挂 `role=status`（颜色/转圈读屏读不到）；底缘吃 `--safe-bottom` |

### 8.4 验收：两道新增 CI 断言（替代「人眼评审」）

1. `src/webui/tests/contrast-tokens.test.ts` —— 解析 tokens.css / badge.css / row.css /
   StarAvatar.vue / starColor.ts **本体**后断言：文本令牌 × 四底色 ≥4.5；徽章、标签、星色在
   自身 tint 底上 ≥4.5；开关两态 vs 页面 ≥3 / ≥1.5，两态之间 ≥3。改色漏改、加色相类漏加档、
   加星色漏校验，全部红灯。
2. `scripts/build-webui-preview.mjs --check`（+ `src/webui/tests/preview-kit-sync.test.ts`，
   已接进 `pnpm webui:build`）—— 预览页的 kit 片段由**注入**产生（tokens / row / badge /
   BusyRing / CollapseRow / DockCard 的 scoped 样式 + starColor 星板），注入区以外字节不动。
   此前「预览页有焦点环、进源码没有」这类结论正是因为页面在**手抄**组件样式；注入后不可能漂移。

### 8.5 本轮**未做**（批次纪律，勿顺手恢复）

- P1 的删除项（StarCard / PulseTrace / toastInfo / 4 死形态）未删。原因：`Button.soft` 是
  **当前默认变体**（17 个文件走默认），改渲染必须与全仓视觉对照同批；本轮只登记
  `@deprecated` 并写明执行顺序（先全仓 codemod → 再删变体）。`PullToRefresh.threshold`
  已固化为常量 `THRESHOLD`（零覆写）。
- P2/P3 的业务面迁移（工具卡/思考卡/dock ×5/main.css spin-ring 清理）属提案既定批次，未动。
- 预览页剩余手抄面：L1 单组件镜像（Button/Avatar/Modal/Sheet/Tooltip/PullToRefresh/Toast/
  FeedbackNotice）与业务形态镜像仍在页内手写。注入机制已就位，扩充注入清单即可收敛。

### 8.6 每批验证口径（把 8.4 固化为流程）

| 批次 | 验证 |
|---|---|
| P1 删减 | `pnpm typecheck && pnpm test:unit && pnpm check:deps` + `npx vitest run src/webui/tests/contrast-tokens.test.ts` + 全仓 codemod 后 `webui:typecheck` + 双主题截图对照（soft→ghost 的 17 个默认用法逐个过） |
| P2 合并 | 定向 `npx vitest run src/ac-client-ui-conversation` + 工具卡/思考卡截图对照 + focus 走查（Tab 走一遍两卡的一级操作） |
| P3 组合 | `pnpm smoke` + `webui:typecheck` + 五处 dock 截图对照 + `webui:preview:check` |


