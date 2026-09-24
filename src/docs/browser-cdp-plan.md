# browser 工具原生 CDP 化方案（browser-cdp-plan）

> 状态：设计稿（待评审）。目标版本：M1–M3 分期落地。
> 关联档案：src/README.md §3.4（web-tools）、ac-security access-tier、tag-registry 抉择组。

## 0. 一句话

把 browser 工具的执行层从「Python + playwright 守护进程」换成「Node 原生 CDP 直连」，
同时在工具面上长出两类能力：内容浏览（热搜/贴吧类站点的可读抽取 + 元素级导航）与
开发验证（localhost 页面操作 + 网络请求/控制台日志监测）。三层分期：执行层替换 → 感知层 → 诊断层。

## 1. 背景与动机

现状（src/ac-web-tools/src/browser.ts + data/files/shared/scripts/browser_daemon.py）：
- Node 侧 ctx.browser 是进程管理器：spawn Python daemon、stdin/stdout JSON 行协议、
  ready 握手、FIFO 队列、世代计数、C4 超时兜底。
- Python daemon 用 playwright.sync_api 驱动 headless Chromium，单标签页、单命令应答制，
  动作集：open/click/type/press/content/screenshot/eval/html/close。
- 已知痛点：要求用户装 Python + playwright（首装卡死已有事故记录，C4 教训）；
  innerText 式 content 抽取对 JS 重渲染站点（热搜榜/贴吧）质量差；
  click 靠 CSS selector——LLM 写 selector 是主要失败模式；无网络/控制台观测能力。

动机排序：
1. 甩运行时依赖：Windows 宿主必装 Edge（Chromium，CDP 兼容）——桌面分发零额外依赖。
2. 能力上限：CDP 事件流（Network/Runtime/Log/Target）是 daemon 协议拿不到的——
   网络监测、控制台日志、弹窗处理、新 target 感知都以它为前提。
3. 全 TS 栈：协议实现可单测、可 typecheck，与框架技术栈一致。

## 2. 目标 / 非目标

目标：
- G1 浏览：打开真实站点（热搜/贴吧/新闻），抽取结构化可读内容 + 可交互元素索引，
  LLM 按 ref 编号点击导航（不写 selector）。
- G2 操作与验证：对 localhost 开发服务器做真实点击/输入/滚动，
  持续采集网络请求（状态码/耗时/失败）与控制台输出（log/warn/error/异常/CORS），
  工具面一键取回——「vibe 完自查」闭环。
- G3 兼容：LLM 可见的工具面（单 browser 工具 + action 分发 + steps 批量）形态不变，
  新能力以新 action 出现；tier 门禁语义延续。

非目标（显式缩水，勿顺手恢复）：
- 不做多标签页编排（M2 只做最小 tabs 动作）。
- 不做登录态持久 profile（贴吧登录浏览等场景 M4 再议；M1 每次启动全新 ephemeral profile）。
- 不做反爬军备（stealth 修补仅基础项：真实 UA、禁 AutomationControlled 特征）。
- 不做跨浏览器（Firefox/Safari 不支持 CDP；跨浏览器需求出现时评估 BiDi）。
- 不引入 browser-use/Playwright 等运行时依赖。

## 3. 架构分层

```
ac-cdp-core（新，纯库，零 cordis 依赖，对标 ac-openai-completions 形态）
  client.ts     CDP 客户端：ws 连接、命令 id 配对（可并发）、事件多路分发、
               flat session 路由（sessionId 维度）、单命令超时、世代计数
  launch.ts     浏览器发现与拉起：Chrome→Edge→PATH chromium 探测链；
               remote-debugging-port 随机端口；user-data-dir 指向
               workspace 数据根 browser-profile/；/json/version 探活握手
  perceive.ts   感知层：DOMSnapshot.captureSnapshot(computedStyles+DOMRects)
               → 交互性过滤（tag/role/样式启发）→ 可见性（z 序/面积）→
               稳定 ref 编号 → 序列化（[n]<tag role name> 截断形式）
               + 正文抽取（正文密度启发，输出 markdown 化文本）
  diagnose.ts   诊断采集：Network.* / Runtime.consoleAPICalled /
               Runtime.exceptionThrown / Log.entryAdded → 环形缓冲（按类分桶、
               容量上限、marker 游标）；getResponseBody 按需取

ac-web-tools（owning 不变：ctx.browser 服务 + browser 工具 + tier 门禁）
  browser.ts v2 生命周期骨架保留（惰性启动/boot 超时/世代计数/dispose 杀进程），
               「杀 Python」换成「杀 Chrome + 关 ws」；FIFO 单命令队列退役——CDP 命令天然
               id 配对可并发，仅保留互斥语义的动作级锁（导航期间禁并发 evaluate）
  actions.ts    action 目录与实现（见 §5）；结果归一 {ok, output}，LLM 侧截断纪律
  index.ts      工具注册/tier/before-execute 门禁/steps 批量——形态不变，扩 action 表

前端行（ac-client-ui-web / ac-client-ui-browser）：BROWSER_FAMILY 结果卡兼容新 action，
  M3 增日志卡（console/network 分栏）——纯展示扩展。
```

不新增能力域、不动 cordis.yml 行集（ac-cdp-core 是纯库不挂行）。
M1–M3 不新增 browser/* 领域事件（诊断数据经工具结果回流；UI 实时观察 M4 再议事件目录）。

## 4. CDP 域映射（动作 → 协议）

| 能力 | CDP 域/方法 | 备注 |
|---|---|---|
| 打开页面 | Target.createTarget + Page.navigate；Page.loadEventFired | domcontentloaded 后即返回，networkidle 不等待（8s 软上限探测沿现状） |
| 正文抽取 | DOMSnapshot.captureSnapshot | 文档树 + 布局，绕过 innerText 对 shadow DOM/虚拟列表的短板 |
| 元素索引 | DOMSnapshot.captureSnapshot(includeDOMRects) + Accessibility.getFullAXTree 融合 | ref 编号稳定策略：文档序 + backendNodeId 缓存复用 |
| 点击 | 坐标来自 DOMRects → Input.dispatchMouseEvent（合成 trusted 事件） | JS click 为降级路径（覆盖不到的 shadow 节点） |
| 输入 | Input.insertText + dispatchKeyEvent | 比现状 fill 更接近真实输入（触发完整事件链） |
| 网络观测 | Network.enable + requestWillBeSent/responseReceived/loadingFailed | 环形缓冲默认只记 method/url/status/type/耗时——不记 header（防 cookie/token 入 LLM 上下文） |
| 响应体 | Network.getResponseBody | 按需、显式 action 取，observe 层 |
| 控制台 | Runtime.consoleAPICalled + exceptionThrown；Log.entryAdded | Log.entryAdded 是 CORS/网络层错误的来源，必须订阅 |
| 弹窗/新页 | Target.setAutoAttach(waitForDebuggerOnStart) + Page.javascriptDialogOpening | M1 只自动 dismiss dialog；新 target M2 处理 |
| 截图 | Page.captureScreenshot(fullPage) | 沿现状落 screenshots/ 目录 |

## 5. 工具面 action 目录（LLM 可见）

observe 层（tier 1）：

| action | 入参 | 出参要点 | 服务于 |
|---|---|---|---|
| open | url, waitMs? | url/title + 摘要（正文前 N 字）+ error 概览（console error 数 + 失败请求数） | G1/G2 |
| read | maxLen? | 正文 markdown 化抽取（正文密度启发，去导航/广告壳） | G1 |
| elements | include?（interactive/all） | 可交互元素索引：[n] tag name（ref 编号，截断约 100 条/4KB） | G1 |
| click | ref（或 selector 降级） | 点击后 url/title 变化摘要 | G1/G2 |
| scroll | direction, amount? | 新视口摘要（elements 增量可选） | G1（懒加载榜单） |
| wait | ms / text? | 等待条件满足 | G1/G2 |
| screenshot | name? | 文件路径 | 沿现状 |
| logs | since?, kind?(console/network/error) | 环形缓冲按 marker 取，容量截断 | G2 核心 |
| response_body | requestId | 指定请求响应体（截断） | G2（查 XHR 返回） |
| close | — | 关浏览器回收 | 沿现状 |

manipulate 层（tier 2，含 observe 全部）：

| action | 入参 | 备注 | 服务于 |
|---|---|---|---|
| type | ref/selector, text | 真实输入事件链 | G2（表单验证） |
| press | key | 沿现状 | G2 |
| hover | ref | 新增 | G2（菜单展开类） |

inject 层（tier 3，含全部）：

| action | 入参 | 备注 |
|---|---|---|
| eval | js | 沿现状，超时与结果截断收紧 |

退役：content（被 read 替代，保留一个版本期做别名）、html（并入 read 的 debug 参数）。

## 6. 门禁与安全

- tier 映射延续 observe ⊂ manipulate ⊂ inject；新动作归层：
  read/elements/scroll/wait/logs/response_body → observe（被动读取，不改站点状态）；
  click/type/press/hover → manipulate。诊断不提层——它是观测不是注入。
- 网络日志红线：默认不采集请求头/cookie/authorization；response_body 显式按需——
  经 ac-security 脱敏管线后再入 LLM 上下文（与 web_search 同通道纪律）。
- Chrome 启动参数：remote-debugging-port 绑 127.0.0.1 随机端口（永不 0.0.0.0）、
  no-sandbox 沿现状、disable-blink-features=AutomationControlled、真实 UA。
  profile 目录 = workspace 数据根下 browser-profile/（ephemeral：boot 时清空，close/dispose 后删除）。
- eval 沿 inject 层 + fail-closed；ws 断线/浏览器崩溃 → 世代计数 + 拒绝式收束（C4 教训全保留）。

## 7. 生命周期

- 惰性启动：首次工具调用拉起 Chrome（headless；headful 为行配置项，调试用）。
- 空闲回收：拉起时才设 idle TTL 定时器（懒拉起纪律，参照 ac-timer 心跳），
  超时自动 close——空闲零常驻进程，pnpm dev 可自退。
- dispose：行卸载 → 杀 Chrome + 删 profile + 关 ws（fiber.effect 归属不变）。
- 并发：多会话共享一个浏览器实例（M1，与现状同）；会话间状态串扰由 ephemeral
  语义 + 文档声明兜底；per-conversation 隔离 M4 评估。

## 8. 测试策略

- 单测：fake CDP server（本地 ws + 最小协议实现——/json/version、命令回显、
  可注入事件流）覆盖 client 配对/超时/世代/会话路由；perceive 用快照夹具（
  captureSnapshot JSON 样本）锁序列化输出；diagnose 环形缓冲/marker 语义。
- 集成（*.integration.test.ts，有真实浏览器才跑）：open/click/logs 对本地
  fixture 页（自建 mini 站点：按钮/表单/失败 XHR/console 输出全覆盖 G2 场景）。
- 回归：web-tools 现有测试改注入 fake CDP endpoint（替换假 daemon 注入，同构手法）。

## 9. 里程碑

| 期 | 内容 | 规模估算 | 出口判据 |
|---|---|---|---|
| M1 执行层 | ac-cdp-core client+launch；browser.ts v2；现有 action 全集平移（click 暂保持 selector）；fake CDP 测试 | 约 1–1.5 周 | 全部现役动作在真实站点通过；Python daemon 不再被默认调用 |
| M2 感知层 | perceive（elements 索引 + read 抽取）+ click-by-ref + scroll/wait；tabs 最小集（list/select/new/close） | 约 1–1.5 周 | 热搜榜单类站点：open→elements→click(ref) 链路 10 步内无 selector |
| M3 诊断层 | diagnose 环形缓冲 + logs/response_body + open 摘要带 error 概览 + UI 日志卡 | 约 1 周 | 本地 fixture 站：console error/失败 XHR/CORS 全被捕获且可按 marker 取回 |
| M4（选） | 弹窗 watchdog 自动策略、下载管理、登录态持久 profile、per-conversation 隔离、stealth 强化 | 另立档案 | — |

旧 daemon：M1 合入后默认后端切 CDP；browser_daemon.py 与 RowOptions.command 逃生门
保留至 M2 末删除（测试注入用途由 fake CDP 接棒）。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| CDP 协议漂移（experimental 命令随版本消失） | 只用 stable 域（DOMSnapshot 已转正多年）；boot 时 /json/protocol 特性探测，缺能力降级 + 日志 |
| 热搜/贴吧反爬拦 headless | Input 合成 trusted 事件 + 真实 UA + AutomationControlled 禁用；仍被拦的站点列入已知限制，M4 stealth |
| 元素 ref 失稳（SPA 重渲染后编号漂移） | backendNodeId 缓存 + 世代失效标记；click 时校验目标仍存在，失稳返回新索引让 LLM 重选 |
| 网络日志刷爆上下文 | 环形缓冲 + 默认摘要（计数/首尾条目）+ 显式 logs 才给明细 + 条目截断 |
| ws 断线/Chrome 崩溃竞态 | 世代计数（沿用）+ 拒绝式收束 + 自动重启语义（下次调用重新 boot） |
| 多会话并发互相踩页面 | M1 互斥锁（导航原子性）；M4 per-conversation session |

## 11. 框架 checklist 对照

- [x] 不新增能力域/服务名（browser owning 不变）；不新增行（纯库不挂行）
- [x] 契约归属：工具 schema 变化住 ac-web-tools；ac-cdp-core 零 cordis、无 plugin:true
- [x] M1–M3 不新增 domain/* 事件 → 无事件目录工作；M4 若做 UI 实时观察再立 browser/* 目录（@mode/@scope 全标注）
- [x] 持久化红线：截图与 profile 都在 workspace 数据根，无跨域写
- [x] 验证命令：pnpm typecheck && pnpm lint && pnpm test:unit && pnpm check:deps；动 webui 跑 pnpm webui:typecheck
- [ ] 落地时更新 src/README.md §3.4 与布局图（M1 收尾项）
