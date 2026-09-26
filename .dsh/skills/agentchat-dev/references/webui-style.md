# 前端轨道：WebUI Kit 风格规范（@agentchat/webui-kit）

> 读条件：写 AgentChat 前端（`src/webui`、`src/ac-client-ui-*`、任何 Vue 前端行）的样式与组件时。
> 事实源是 `src/webui-kit/` 源码——本规范与源码冲突时，以源码为准。

## 设计语言：扁平 × 语义色 × 双主题

当前视觉基线（M30 重建后）：**扁平化、中性底、语义色点缀**。

- 旧「星群炫光」语言（渐变发光、光晕 = 活跃度）已退役：`--grad-star` 已改主色实底、glow 令牌全部置 none、StarAvatar 无光晕呼吸。
- 仅存的运动语义是「运行光环」（StarAvatar running：SVG 双流光弧旋转，功能语义不可静止降级）。

### 六条铁律

1. **令牌驱动**——组件样式只引 `tokens.css` 变量，禁止硬编码色值 / 圆角 / 阴影。
2. **双主题同构**——暗色 Nebula / 亮色 Aurora 同一套令牌两套值；新样式两主题都要过目。
3. **语义色**——ok 绿 / warn 琥珀 / err 红 / info 主色；状态表达必须文字 + 颜色双通道。
4. **tone 反馈同轴**——瞬时反馈一律 FeedbackNotice（原地）或 toast（全局），tone ∈ ok|error|info|busy；禁止文案内嵌 emoji 前缀，禁止自建 ref + setTimeout 反馈。
5. **运动即语义**——动画只出现在功能位（运行光环 / 呼吸状态灯 / toast 进出），信息内容零动画；时长 ≤ 200ms。
6. **行/徽章单源**——清单行用 `.ui-row`、徽章用 `.ui-badge` 族；组件不再自建盒装卡片与徽章样式。

## 目录分层（src/webui-kit/src/）

| 目录 | 内容 |
|---|---|
| `base/` | L0 令牌 tokens/row/badge 三 css + L1 原语 Icon/Button/Avatar/Modal + 工具组件 StatusDot/Tooltip/RingProgress |
| `feedback/` | FeedbackNotice（原地反馈条）+ toast.ts（全局 Toast 单例）+ ToastHost（渲染半件） |
| `star/` | L2 星群组合件 StarAvatar/StarCard/PulseTrace |
| `icons/` | 思维链图标族 ThinkingIcon/ThoughtIcon + icons.ts 注册表（不进包入口） |
| 根级 | index.ts 出口 + 纯函数 format.ts / starColor.ts |

消费规则：

- 一律 `import { ... } from '@agentchat/webui-kit'`；css 走 `@agentchat/webui-kit/tokens.css` 等子路径。
- 禁止深路径引组件文件（`@agentchat/webui-kit/src/*` 不可用）。
- icons.ts 不进包入口（~icons/* 虚拟模块仅 webui 工具链有类型源，M29 P0-2）。

## L0 令牌速查（base/tokens.css）

主题切换：`html[data-theme='nebula|aurora']`（兼容 `html.dark/.light`）。

| 族 | 令牌 | 暗色值 | 亮色值 | 用途 |
|---|---|---|---|---|
| 底面 | `--bg-deep/--bg-base` | #1a1a1a | #ffffff | 页面底 |
| 底面 | `--bg-surface/--bg-raised` | #2d2d2d | #fafafa/#ffffff | 卡片/浮层 |
| 底面 | `--bg-hover` | #252525 | #f0f0f0 | hover |
| 主色 | `--primary` | #818cf8 | #6366f1 | 主操作/选中 |
| 主色 | `--primary-strong` | #a5b4fc | #4f46e5 | 链接/hover |
| 主色 | `--accent` | #f472b6 | #ec4899 | 次强调 |
| 文本 | `--text-1/2/3` | #ecf0f1/#bdc3c7/#7f8c8d | #2c3e50/#7f8c8d/#a8abb2 | 主/次/弱 |
| 线 | `--line/--line-strong` | #333/#404040 | #e0e0e0/#bdc3c7 | 分隔/强调 |
| 语义 | `--ok/--warn/--err` | #10b981/#f59e0b/#e74c3c | 同左 | 成功/警告/错误 |
| 圆角 | `--r-sm/--r-md/--r-lg/--r-full` | 6/10/14/999px（全站单源） | 同左 | 控件/卡片/容器/胶囊 |
| 间距 | `--space-1..6` | 4/8/12/16/20/24px | 同左 | 4px 网格 |
| 阴影 | `--shadow-panel/pop` | 深 0.45 浓度 | 浅 6-8% 灰调 | 面板/弹出 |
| 阴影 | `--shadow-input/dock` | 双层影 | 双层影轻一档 | 输入卡/dock 卡 |
| 动效 | `--dur-fast/--dur-base` | 0.12s/0.2s + `--ease-out` | 同左 | 过渡 |
| 角色 | `--role-hover/selected/active/info-{bg,text}` | 见源码 | 见源码 | 状态角色色 |

约定与兼容：

- 限高：`--card-viewport-max: clamp(200px, 40vh, 340px)`——会话卡内长内容滚动区统一限高。
- 业务兼容层：`--color-*` / `--radius-*` / `--space-*` 别名已映射到上述令牌（历史 main.css 体系）；新代码用本源令牌。

## row.css / badge.css 速查

- `.ui-row`：透明底扁平行（hover 浮起 + is-selected 主色描边 + is-auto 虚线）；`.ui-switch` 红绿开关（绿开红关）。
- `.ui-badge` 族：状态徽章（ok/err/warn/info/dim）、标签徽章 `.tag` + `--tag-hue`（tt-* 色相类）、`.cfg` 可配置、`.kind` 类型徽记。

## 组件对照表

### base/（L1 原语 + 工具组件）

| 组件 | Props | 要点 |
|---|---|---|
| Icon | name: string; size?: number=16 | 统一图标；名字见 icons.ts 注册表；未注册兜底 info；继承 currentColor |
| Button | variant?: primary/soft/ghost/danger=soft; size?: sm/md=md; icon?: string; disabled; loading | loading 显示 spinner 并禁用 |
| Avatar | src?: string\|null; name?: string; size?: number=32; shape?: circle/square=circle; fallbackIcon?: string; plainFallback?: boolean | 图挂自动回退（图标→首字），不出破图 |
| Modal | visible: boolean; title?: string; width?: number=440; height?; closeOnOverlay?=true; zIndex?: number=600 | Teleport+遮罩+ESC；height 固定高度防跳变 |
| StatusDot | status: thinking/running/idle/offline/ok/err; pulse?: boolean; size?: number=8 | 状态灯；thinking 琥珀/running 靛蓝自动呼吸；仅视觉点，语义须配文字 |
| Tooltip | text?: string; placement?: top/bottom=top | CSS hover 轻提示 |
| RingProgress | value: number(0-100 钳制); size?: number=28; stroke?: number=3; tone?: ''/low/moderate/high/critical | SVG 圆环；中心内容经默认插槽 |

### feedback/（语义反馈）

| 组件/模块 | API | 要点 |
|---|---|---|
| FeedbackNotice | text?: string（空=不渲染）; tone?: ok/error/info/busy; variant?: chip/inline | 原地反馈条；文案只承载文本，语义由 tone 派生图标配色 |
| toast(text, opts?) | opts: { tone?, duration?(0=永驻), key?(去重键) } | 全局 Toast 写口；同 key 原位刷新；栈上限 4 |
| toastOk/toastError/toastInfo/toastBusy | (text, opts?) | 语义态直呼别名 |
| dismissToast(id)/clearToasts() | | 手动关闭 |
| pauseToast(id)/resumeToast(id) | | hover 暂停（ToastHost 内部消费） |
| ToastHost | 无 props | AppFrame 挂载一次的渲染半件；z-index 9500 |

时长分级：ok=2000 / info=3000 / busy=4000 / error=5000（ms）。

### star/（L2 组合件）

| 组件 | Props | 要点 |
|---|---|---|
| StarAvatar | src/name/color/size=32/fallbackIcon/plainFallback/running=false | 扁平头像 + 身份色首字底色；running=true 外圈双流光弧旋转（仅 direct/single 会话——群聊无可靠运行信号） |
| StarCard | selected?: boolean; color?: string | 星卡容器；选中 = 星色描边微光 |
| PulseTrace | title?='思考过程'; meta?; color?; streaming?=false; open?=false | 思维链折叠容器；streaming 流光动画 |

### icons/（思维链图标族）

| 组件 | Props | 寓意 |
|---|---|---|
| ThinkingIcon | size?: number=14 | 脑电波折线 + 节点链（思维过程整体） |
| ThoughtIcon | size?: number=14 | 涟漪（单步思考展开） |

### 纯函数（根级）

| 函数 | 签名 | 说明 |
|---|---|---|
| formatFileSize | (bytes: number) => string | B/KB/MB/GB |
| formatDurationMs | (ms: number) => string | m:ss / h:mm:ss（负值归零） |
| formatRelativeTime | (ts: number) => string | 今天 HH:mm / 昨天 / N天前 / 日期 |
| starColor | (agentId: string, theme: ThemeMode) => string | 8 色星板稳定哈希；user 固定白金 |

## 新增组件的归位判断

- 通用原语（无业务语义）→ webui-kit 对应层；星群 / 工坊语言 → star/。
- 业务组件 → 所属 ac-client-ui-* 前端行（kit 只放设计原语）。
- 新图标：icons.ts 的 iconMap 加一行（lucide），消费用 `<Icon name="..." />`。
- 新令牌：先查语义族是否已有（role-* / shadow-* 族），避免同义异名。
