# 移动端 UI 范式重设计（mobile-ui-paradigm-plan）

> 立项 cr-34（2026-09-28）。背景：M3.x 安卓远端链路已收口（配对/传输/回环桥/分发），
> 手机端使用反馈「不方便」——本文档裁决 webui 移动端范式重设计方案与分期。
> 事实基线：安卓端 = Capacitor 6 壳 + WebView（minSdk 28 / targetSdk 34）加载回环桥上的
> 同一套 webui dist，**一份前端服务桌面与手机两端**。

## 一、诊断：范式不匹配，不是样式缺陷

现有布局是 VSCode 工作台范式（AppFrame 五席：activity-bar / primary-sidebar / main /
aux-sidebar / overlay），为桌面大屏「多面板并行观察」打造。手机端痛点（均有代码依据）：

| # | 痛点 | 依据 |
|---|---|---|
| 1 | 48px 活动栏常驻吃掉 ~1/8 屏宽，窄屏价值低 | ActivityBar.vue 固定宽列 |
| 2 | 抽屉是覆盖不是导航：选完会话抽屉还糊在屏上 | drawerVisible overlay 模式 |
| 3 | 无「进入会话」心智：桌面是三栏并存，手机预期是「列表 → 会话 → 返回」栈式导航 | 无页面栈概念 |
| 4 | Android 返回键 = 退出 App：SPA 无路由，按返回直接 finish → onStop 断链路回配对面板 | MainActivity 无 onBackPressed 处理 |
| 5 | 辅助侧栏窄屏只有零星 Modal 兜底，入口分散 | uiStore 各 open* 手写 isNarrow 分支 |
| 6 | 断点双源：CSS @media 768 与 JS isNarrow()（即时读 innerWidth）跨界瞬间不同步 | uiStore.ts isNarrow |

**根因**：多面板并行范式与单窗口栈式导航的手机范式冲突——修补 CSS 治不了根。

## 二、目标范式：消息 App 栈式导航

架构有利条件：壳件席位驱动，行包（agents/singles/conversation/runview…）只插席位、
不关心排布。**移动化 = 壳层换一种排布，席位契约零改动**（插槽-插头原则的直接收益）。

目标形态（≤768px）：

- **root 页**：整页列表（主侧边栏三面板之一）+ 底部标签栏（会话 / Agent / 运行 / 更多）；
- **push 页**：点会话/群/Agent → 全屏会话页滑入（≤200ms），标题栏汉堡变返回；
- **更多 sheet**：头像配置 / 主题切换 / 全局设置 / 数据备份 / 检查更新 / 插件动作收编；
- **返回键**：关最顶层覆盖（sheet → 会话页 → root 页 → 才允许默认退出）。

### 关键裁决

1. **活动栏 → 底部标签栏**：拇指区；未读徽章复用 ActivityBar 的两套聚合 computed
   （抽到 layout 共享模块，ActivityBar 与 MobileTabBar 同源消费，不复制实现）。
2. **抽屉退役**：主侧边栏三面板在手机 = root 页整页切换（tab 驱动 primaryPanel）；
   点列表行 = push 会话页。keepAlive 语义不变（chat 视角文档流保活，push/pop 只是
   壳层显示切换，草稿/滚动天然保留）。
3. **返回键接入**：mobile 壳 onBackPressed → 经 JS 桥查询导航栈（会话页开则关之，
   否则默认退出）。WebView 内按返回不再直接杀链路。（@capacitor/app 插件或等价
   原生桥；壳侧改动，webui 经 window 事件消费——具体通道实施时定，裁决点是
   「返回键必须先过导航栈」而非通道选型。）
4. **aux 窄屏整体隐藏**：各 open* 的窄屏分支统一走全屏 Sheet（现有「窄屏 Modal」分支
   的收编升级）——Phase ② 实施。
5. **断点单源**：matchMedia('(max-width: 768px)') 一处定义（uiStore 响应式 narrow），
   CSS 断点对齐同值；isNarrow() 消费单源。
6. **桌面零变动**：同一 AppFrame 两形态，v-if 级隔离；≥769px 行为与现状逐像素一致。

### 明确不做

- 不引入 vue-router（席位选举已是导航层；栈式导航用壳层状态承载，避免双导航源）。
- 不做手势返回（Android 返回键先行；侧滑手势 WebView 92 兼容性不确定，价值/成本比低）。
- 不改行包席位契约（AgentList/SessionList 等只删自家抽屉 CSS，选中语义不变）。

## 三、分期

| 期 | 内容 | 主要落点 | 量级 |
|---|---|---|---|
| ① 导航范式 | 底部 tab 栏 + root/push 页导航 + 返回键 + 汉堡变返回 + 断点单源 | AppFrame 窄屏分支、新 MobileTabBar/MobileMoreSheet、uiStore（narrow/mobileMainOpen）、ConversationHeader、MainActivity | 2~3 天 |
| ② 覆盖层全屏化 | aux 选区/设置面板窄屏统一全屏 Sheet；webui-kit 出 Sheet.vue 原语（Teleport + 底部滑入，≤200ms） | uiStore 各 open* 窄屏分支、AuxSidebarHost 窄屏隐藏、webui-kit base/ | 1~2 天 |
| ③ 品质收口 | adjustResize 键盘钉死；color-mix 133 处构建期回退 + check-webview-baseline 补 CSS 判据；触摸三件套（tap-highlight/touch-action/overscroll）；safe-area 令牌（--safe-top/--safe-bottom，viewport-fit=cover）；四处复制抽屉 CSS 随 ① 删除 | manifest / tokens.css / postcss / base.css | 1~2 天 |

### 风险与实施注意

- **选中动作窄屏分派点**：列表选行入口分散在 agents/singles/runview/group 四行包——
  统一收敛为「选中 → narrow 则 push 会话页」单点（uiStore 提供 pushMainIfNarrow()，
  各行包选中处调用），避免散弹特判。
- **返回键桥接通道**：MainActivity onBackPressed → WebView JS；无 @capacitor/app 时
  用 evaluateJavascript 直发 window 事件（壳内自持，零新依赖优先）。
- **transition 与流式帧**：push 页滑入用 transform（不触发重排）；chat keepAlive 的
  流式帧在隐藏 pane 中继续上屏（v-show 语义，回来即最新帧）。
- **tracking 视角**：运行矩阵大画布窄屏不舒适——Phase ② 视使用反馈决定是否给
  窄屏专属形态（当前以 pushed page 兜底，exitOverlays 协议原样适用）。

## 四、验证

- 桌面回归：pnpm typecheck && pnpm test:unit && pnpm check:deps + 定向 eslint
  + pnpm webui:typecheck；≥769px 行为零变动（重点：活动栏/抽屉/三栏 resize）。
- 窄屏验证：devtools 手机模拟（768 以下）+ 真机（chrome://inspect，cr-15 基建）：
  tab 切换 / 会话 push/返回 / 返回键逐层退出 / 键盘弹出输入框可见。
- 壳侧：gradlew assembleDebug + 真机装包验证返回键。

## 五、实施实况

### Phase①（cr-35，2026-09-28 落地）

| 落点 | 内容 |
|---|---|
| uiStore | narrow 单源（matchMedia 768 响应式；togglePrimary 窄屏 no-op）；mobileMainOpen push 态 + pushMainIfNarrow/closeMobileMain；openTrackingView/openPairView/openSubagentView 内嵌 push；抽屉态全链退役（drawerVisible/toggleDrawer/closeDrawer/overlay/CSS 五处复制块全删） |
| AppFrame | 窄屏 root/push 双层：root = 列表页整页 + MobileTabBar；push = 会话页 transform 滑入覆盖；活动栏/aux 窄屏隐藏；返回键消费链（registerBackConsumer provide 通道 + historyFlag 桥） |
| MobileTabBar（新） | 会话/Agent/运行/更多四 tab；未读徽章消费 useUnreadBadges 单源 |
| MobileMoreSheet（新） | 头像行（viewer 配置）/主题切换/全局设置/数据备份/检查更新/插件动作 |
| historyFlag（新） | window.__agentchatBack() 壳查询面 + agentchat:back 事件通道 |
| useUnreadBadges（新·conversation） | 徽章聚合归位 conversation（feed 的家）——初版落 layout 触发 R5 运行时环（layout→conversation .ts 边 vs conversation→layout 反向），归位消环，未入白名单 |
| ConversationHeader | 汉堡钮变返回钮（closeMobileMain）；inject 键换新 |
| ActivityBar | 未读聚合迁 useUnreadBadges 共享（口径注释随迁） |
| 四列表 | 删 mobile-close-btn 与 @media 抽屉块；选中处理器改 pushMainIfNarrow()（closeDrawer inject 残留一并清理） |
| webui-kit | Sheet.vue 原语（Phase② 前置）；tokens.css 补 --safe-top/--safe-bottom；index.html viewport-fit=cover |
| MainActivity | onBackPressed → evaluateJavascript 查询 __agentchatBack()；未消费 moveTaskToBack（不 finish，链路不断） |

测试对齐：三处窄屏模拟自 Object.defineProperty(innerWidth) 改 ui.narrow 直写（单源化的测试面收益——jsdom matchMedia 垫片恒宽的旧缺口消除）。验证：typecheck/webui:typecheck/test:unit(2191)/check:deps/eslint 定向全绿。

### Phase②（cr-36，2026-09-28 落地）

| 落点 | 内容 |
|---|---|
| AuxSidebarHost | 窄屏改**全屏 Sheet** 形态（宽屏原形态零改动）——选区注册面零改动，只换壳的排布；辅助活动栏窄屏不渲染。上轮 Phase① 把本区域整体隐藏后，九个选区在手机端无入口（遗留缺口），本轮补齐。 |
| uiStore | `auxPaneStyle` 宽度单源（窄屏 100% / 宽屏拖调宽）——九个选区宿主自绑 `ui.auxWidth` 改消费单源（固定舒适宽会在全屏里撑破）；`openAuxPanel(def)` 开面板语义单点（域侧激活 → 显式置位 → 宽度重整 → 展开）；`closeAux()`。 |
| MobileMoreSheet | 「面板」区新增（列 `auxSidebarRailDefs` 全量 + available 过滤 + badge）——手机端九个选区的唯一入口；整体迁 webui-kit Sheet 原语（自建覆盖层退役）。 |
| webui-kit Sheet | 加 `full`（全屏形态：满高/无圆角/让安全区）与 `keepAlive`（v-show——选区 keepAlive 语义在开关间保持，编辑中状态不丢）两档。 |
| 窄屏 Modal 收编 | usage/prompt/preview 三处「窄屏 Modal 兜底」退役——统一走 aux 意图通道（二者本就同源：`FilePreviewModal`/`FilePreviewPanel` 共用 `filePreviewContent.ts`；`TokenUsage` 自带 `variant: 'modal'|'panel'`；`SystemPromptModal`/`Panel` 共用 chatStore）。删两组件（FilePreviewModal、SystemPromptModal）+ 一个 overlay 贡献 + 三标志（tokenUsageVisible/systemPromptOpen/previewVisible）与配对 close。`TokenUsageHost`/`FilePreviewHost` 退化为零渲染意图宿主（watch 必须住 overlay 常驻组件——选区宿主 volatile 卸载即收不到意图帧，这是既有裁决，非本轮引入）。 |
| 返回键消费链 | AppFrame 的 `registerBackConsumer` 通道上线为**栈**（Set + 倒序询问，后注册者在上层）；AuxSidebarHost 注册（关全屏 Sheet）、MobileMoreSheet 注册（关面板）。逐层：覆盖层 → push 会话页 → root。 |

验证：typecheck / webui:typecheck / test:unit（2190） / check:deps（R1-R7 白名单仍 20 条，未新增） / 全域定向 eslint 全绿。测试同步：三处窄屏用例改「同路径」断言（Modal 直开断言删除）、system-prompt 测试删 modal 用例面。

### Phase③（cr-37，部分落地）

| 项 | 状态 |
|---|---|
| 软键盘 | ✅ AndroidManifest 补 `windowSoftInputMode="adjustResize"`（键盘压缩 WebView 视口而非整页上移，100vh 高度链随之收缩） |
| 触摸基线 | ✅ base.css 全局：`-webkit-tap-highlight-color: transparent`（消 WebView 点击灰闪）+ `touch-action: manipulation`（消双击缩放延迟与误触）+ `body { overscroll-behavior: none }`（遏制滚动链外溢） |
| safe-area | ✅ cr-35 已前置（tokens.css `--safe-top/--safe-bottom` + viewport-fit=cover），tab 栏/Sheet/输入区已消费 |
| color-mix 回退 | ✅ cr-38 完成（123 处转 `rgba(var(--x-rgb), α)`；12 处带回退的渐进增强；构建期棘轮守门 + 令牌契约测试） |
| 真机验证轮 | ⏸ 待设备（chrome://inspect + m3-realdevice-checklist） |

**color-mix 收口（cr-38 已落地）**：133 处。核心洞察——`color-mix(in srgb, C N%, transparent)` 在**预乘 alpha 插值**下语义恰等于「C 以 N% 不透明度着色」，故等价物是 `rgba(var(--x-rgb), N/100)`，只差一个 RGB 三元组令牌。落地：

- **令牌层**：tokens.css 双主题补 `--primary/-text-1/-2/-3/-ok/-warn/-err-rgb`（改色须与 hex 同改，有测试锁）；badge.css 九个 `tt-*` 色相类补 `--tag-hue-rgb`。
- **动态色例外**：星色 `--sc`/`--tc` 是运行时内联值，CSS 无从派生三元组 → 组件同时注入伴随变量（`starColor.hexTriplet`）。
- **机械转换**：确定性 codemod 转 123 处（含嵌套 `var()` 回退的括号平衡解析）。
- **残量 12 处**：无法用三元组表达者（与非透明色混色 6 / currentColor 1 / 需加深的 hover 1 等）保留 `color-mix`，但**同属性前置静态回退声明**——基线运行时取回退值，现代浏览器由 color-mix 覆盖（渐进增强）。
- **防回归**：构建期棘轮（产物 color-mix 数 ≤ 12，只减不增）+ 令牌三元组三锁测试（同步 / 存在 / 反向死条目）。
- **验证手段（无设备替代）**：本地探针页加载构建产物 CSS，读回**解析后的计算样式**——比肉眼截图可靠，实测 tint/CSS 变量链/色相回落/回退链全部正确；并实锤一处级联缺陷（组件规则内写 `--tag-hue-rgb` 缺省值压掉色相类，详见 cr-38）。
- 副产品（测试反哺零冗余）：清掉 4 个未被消费的三元组条目。
- 副产品（测试反哺零冗余）：清掉 4 个未被消费的三元组条目。

**流程发现（值得登记）**：Phase① 删抽屉按钮时，RunTrackingPanel 模板残留一个多余 `</div>`——`pnpm typecheck` 与 `pnpm webui:typecheck`（vue-tsc）**双双放过**，只有 `pnpm webui:build`（模板编译器）报 `Invalid end tag` 并失败。教训：模板结构性破损是 vue-tsc 的检测盲区，**动了前端模板的改动应把 `pnpm webui:build` 纳入验证阶梯**（该命令同时跑 webview 基线守门，成本 ~1 分钟）。已同步给技能文档维护者决策。

### 待办

- Phase③ 余项：color-mix 133 处逐处定静态色；真机验证轮（键盘/tab/Sheet/返回键逐层退出）。
- Phase② 遗留：设置面板（SettingsPanel）窄屏仍为既有形态，未纳入 Sheet 化——按真机反馈决定是否跟进。