# m17-recon · src/ui/webui 独有件盘点（插件打包入口 + 测试面 + m16 报告补遗）

> 基准：仓库根 `src/ui/webui/`（@agentchat/webui）。纯读分析，未修改任何 src 文件。
> 对照物：preview/webui 移植旧壳（已删除；其裁剪面 = 删去 `src/index.ts`、`src/plugin.ts`、`tsconfig.plugin.json`、`tests/` 全部测试、大部分 `core/api/endpoints/*`）与 m16-recon 三份报告（stores-spec / views-spec / extensions-spec）。
>
> **事实校正**（与任务书描述的差异，以实际为准）：
> - `tests/` 实际 **10 个**测试文件（任务书写 8）；任务书列出的名单本身就有 10 个。
> - 字节 size：`src/index.ts` = **2218 B**、`src/plugin.ts` = **2372 B**（任务书写的 2372/2218 顺序颠倒）。
> - 旧壳的 `package.json` / `vite.config.ts` 仍留在现 preview/webui（已被新原生实现继承演化），可作差异对照。

---

## §1 插件打包入口（移植壳没有的独有件）

### 1.1 `src/index.ts`（2218 B）——插件库出口（DSH 风格三段式的"库段"）

完整导出面（5 项）：

| 导出 | 形态 | 用途 |
|---|---|---|
| `webuiDistDir(): string` | 函数 | 解析插件自带前端构建产物目录：`path.resolve(dirname(fileURLToPath(import.meta.url)), '../dist')` —— 即包内 `dist/`（注释里写的 "preview/packages/ui/webui/dist" 是**过期注释**，代码实际指向自身 dist） |
| `WebServerHostLike` | interface | boot 注入宿主服务的最小面：`{ serviceRegistry, dataDir, port, pluginEvents?: PluginEventBus }`（pluginEvents 供广播 `plugin.*` 域事件） |
| `startWebUIServer(ctx, host, port?): Promise<WebUIServer>` | async 函数 | 核心：`new WebUIServer({ serviceRegistry, dataDir, port, ctx, staticDir: webuiDistDir(), pluginEvents, routeRegistry: ctx.http })` → `server.start()` → `new ServerService(ctx, server)` 把 ctx.server 包装为 cordis Service → 返回 server |
| `WebServerHostService` | type re-export | 透传 @agentchat/server 的宿主服务类型 |
| `webuiPlugin` | `export * as webuiPlugin from './plugin'` | 命名空间再导出插件行，供 boot 直接调用路径使用（Loader 路径则从 cordis.yml 加载） |

### 1.2 `src/plugin.ts`（2372 B）——cordis 插件行

完整导出面（3 项）+ 行为：

| 导出 | 值/签名 | 说明 |
|---|---|---|
| `name` | `'agentchat-webui'` | cordis 插件名 |
| `inject` | `['webServerHost', 'http']` | 等 boot 备好 ServiceRegistry/工作区/端口与 HTTP 路由注册表后再启动 |
| `Config` | `{ webuiPort?: number }` | 覆盖 webServerHost 端口（默认 3830） |
| `apply(ctx, config)` | async，返回 disposer | 见下 |

`apply` 流程：① `host.enabled` 为假直接返回；② **L3 路由先注册**：`ctx.http.register('/api/ui', createUiRouter(ctx))` + `ctx.http.registerStatic('/ui-plugin', createUiPluginStaticHandler(ctx))`（挂/摘本行 = 挂/摘 UI 路由）；③ 从 `ctx.get('bootstrap')` 取可选 `pluginEvents`；④ `startWebUIServer(...)`；⑤ **EADDRINUSE → logger error + `process.exit(1)`**（防重复定时调度/重复写状态，双实例自我了断）；⑥ 成功 log 启动 URL；⑦ 返回 disposer：dispose 两条 UI 路由 + `server.stop()`。

### 1.3 `package.json` —— TS 源直出的插件包

- `"exports": { ".": "./src/index.ts", "./src/*": "./src/* }` —— **插件行以 TypeScript 源被宿主消费**（无预编译产物），dist 只承载体。
- scripts：`typecheck` = `vue-tsc -p tsconfig.json`（前端）**+ `tsc -p tsconfig.plugin.json`**（插件行双轨检查）；`build` = `vue-tsc --noEmit` + `vite build`；`test` = **`cd ../../.. && pnpm vitest run src/ui/webui/tests/`**（从仓库根跑，vitest 配置在根）。
- dependencies 含三个 workspace 包：`@agentchat/cordis` / `@agentchat/protocol` / `@agentchat/server`（插件行与服务类型的来源）；另有 `uuid`（useMarkdown 占位符用）、`unplugin-icons` + `@iconify-json/lucide`（**列在 dependencies 而非 devDependencies**——构建期插件的非常规摆放，移植壳里它们在 devDependencies）。

### 1.4 `vite.config.ts` —— 不是 build.lib

**没有 `build.lib`**。是标准 SPA 多入口构建：

- `rollupOptions.input` 双入口：`main`（index.html，主 SPA）+ `ui-plugin-iframe`（ui-plugin-iframe.html，P5.5 iframe isolated 档运行时）。
- `manualChunks` 三 vendor 块：`vue`(vue+pinia) / `markdown`(markdown-it+texmath+katex+highlight.js) / `chart`(chart.js+d3-chord)。
- dev：port 3831，proxy `/api` → 3830、`/ws` → ws://3830（**不代理 `/ui-plugin`**——src 形态下该路由由插件自身注册在 3830）。
- alias：`@` → ./src，**`@shared` → 仓库根 `src/shared`**（跨目录源引用，移植壳没有）。

### 1.5 tsconfig 双轨（tsconfig.json / tsconfig.plugin.json）

- `tsconfig.json`（前端）：`exclude: ["src/index.ts", "src/plugin.ts"]` —— 插件行不进 DOM 环境检查。
- `tsconfig.plugin.json`（插件行）：ES2022/ESNext、`types: ["node"]`、`verbatimModuleSyntax`、noEmit；`include` **恰好只有** `src/index.ts` + `src/plugin.ts` + `../../svc/timer/src/chinese-lunar.d.ts`（跨到 svc/timer 的类型依赖，独有件）。

### 1.6 宿主消费形态（仓库内实证）

- `src/boot/boot/src/bundle-rows.gen.ts`：`import * as r_webui from '@agentchat/webui/src/plugin'`，注册为 cordis 行 `{ id: "webui", config: {"webuiPort": 3830} }`。
- `src/boot/boot/src/composition.web-app.yml`：声明行 `name: '@agentchat/webui/src/plugin'`。
- 即"插件打包流程" = **pnpm build 产出 dist/（SPA+iframe+vendor 块）→ 插件行 TS 源经包 exports 被 boot 打包/加载 → 运行时 WebUIServer 以 `staticDir=webuiDistDir()` 托管 dist 并注册 /api/ui 与 /ui-plugin**。

### 1.7 与移植壳的差异对照

| 维度 | src/ui/webui（@agentchat/webui） | 移植壳（preview/webui，ac-webui-app） |
|---|---|---|
| 包定位 | cordis 插件（前端源码 + 内置 dist + 服务端挂载） | 纯前端 Vite 应用，dist 由 preview 的 ac-webui 托管 |
| exports | `.` → src/index.ts，`./src/*` | 无 exports |
| 服务端入口 | src/index.ts + src/plugin.ts（inject webServerHost/http、注册 L3 路由、EADDRINUSE exit(1)） | 无（移植时删除） |
| workspace 依赖 | @agentchat/cordis/protocol/server | 无 |
| typecheck | vue-tsc + tsc 双轨（tsconfig.plugin.json） | 仅 vue-tsc |
| test 脚本 | 仓库根 vitest 跑 10 个测试 | 无 test 脚本（测试全删；新原生实现另建 tests/wire、conversationReducer） |
| vite | 双入口 + manualChunks，proxy /api+/ws，alias @ + @shared | 同形双入口 + manualChunks；proxy /api+**/ui-plugin**+/ws；alias 仅 @ |
| tsconfig.plugin.json | 有 | 无（删除） |

---

## §2 测试面清单（10 个文件）+ 对原生面的价值评估

运行方式注记：全部经仓库根 vitest 运行；feed 系测试的统一手法 = `vi.mock('../src/stores/websocket')` + mock logger + `setActivePinia(createPinia())` 后直调 `feed.ingest(type, payload)` 断言分区数据（不挂组件，纯 store 契约）；ws 测试用 FakeWebSocket 类 + `vi.stubGlobal` + fake timers。

### A. 前端行为契约——值得在原生面补测（8 个）

| 文件 | 测什么（一句话） | 关键断言面 | 原生面价值 |
|---|---|---|---|
| `feed-parallel-tools.test.ts` | 并行工具调用结果按 `tool_call_id` 精确归属（修复"最后一条流式占位"按位置匹配的错乱 bug） | X 先 end 不吞 Y 占位（Y `isStreaming` 保持 true、内容不串）；assistant.toolCalls 的 running/result 同按 id 归属 | **搬**。store reducer 核心不变量，与 UI 框架无关；mock 面极小 |
| `feed-rapid-switch.test.ts` | 快速切换 Agent 的分区完整性 + 过期历史响应丢弃 | A→B→A 连切各分区零污染、activeDialogId 跟随；连点同 Agent 时旧 requestId 迟到响应被丢弃且不负责回落 status；无 requestId 的旧后端响应放行（兼容降级） | **搬**。0.5s 连点场景的三条不变量，纯数据层 |
| `feed-resume-merge.test.ts` | `chat.session.resume` 快照合并去重（"结果堆叠"回归） | steps 含/不含进行中步骤都只产出唯一流式载体且内容连续累积；快照落后直播不回卷；空分区先挂起、历史首屏后合并出唯一载体（isStreaming+thinking 保留） | **搬**。双端错位兼容的合并语义，最易回归 |
| `ws-backlog-flush.test.ts` | WebSocketClient 积压队列 flush（"1 条积压消息无限复读"bug） | 握手期入队 flush 一次清空、重连不重发且日志仅 1 次；毒消息（循环引用/BigInt）不炸 onopen、单条丢弃不阻断同批；CLOSING 窗口消息在新连接补发；旧 socket 迟到 close 被身份守卫忽略 | **搬**（若原生保留 backlog 客户端——建议保留：四条不变量全是用户实报 bug 钉住的）。FakeWebSocket 手法完全可移植 |
| `search-pool-default.test.ts` | `applySearchPoolDefault`：搜索池"设为默认"同步到全局 `tool.web_search` 的 $ref 语义 | 遮蔽字段（provider/apiKey 类）剥离、中性字段保留、`{$ref}` 指向默认条目；悬空 $ref 删 ns；已一致/无默认/空池各不动 | **搬**（settings/schema.ts 纯函数，零依赖；移植设置层则必搬） |
| `llm-pool-default.test.ts` | `applyLlmPoolDefault` + `sanitizeGlobalConfig`(llm 分支)：模型池默认同步 + GET 展开对象折叠 | GET 展开回写形态还原为纯 `{$ref}`；旧条目自带同值字段视为残留丢弃、用户覆盖保留；默认条目被删悬空清理；sanitize 折叠 $ref/掩码 api_key 剥离/显式内嵌对象保留 | **搬**。与上条同构，是"设为默认不生效"双 bug 的契约 |
| `p5.5-policy.test.ts` | `rewriteGlobalStyle` CSS 消毒 + isolated request/event 白名单 | 选择器强制 `.ui-plugin-<scope>` 前缀且不重复加；禁 url()/@import/at-rule/javascript:/`</style>`/反斜杠转义；`:root` 只许 `--*`；8 条 GET 白名单路径 + 路径穿越拒绝；4 个事件白名单 | **搬**。extensions-spec A7 已判"完全自包含，可独立单测"，纯函数直迁即测 |
| `csp-audit.test.ts` | 构建产物 CSP 审计（需先 `pnpm build`，读 dist/ 下两个 html） | 主 SPA：`script-src 'self'` + `style-src 'unsafe-inline'` + `connect-src ws: wss:` + `object-src 'none'` 且无外站 script；iframe 容器页：`default-src 'none'` + `frame-ancestors 'self'` 且自身无内联脚本 | **搬**（若原生保留 P5.5 CSP 与 iframe 双入口）。"审计 dist 产物"模式零运行时依赖，防 CSP 漂移 |

### B. 性能基准——诊断用，非行为断言（2 个）

| 文件 | 测什么 | 形态 | 原生面价值 |
|---|---|---|---|
| `history-render-perf.test.ts` | 历史数据前端管线各阶段耗时（merge 首屏 / turns 首派生 / turns 流式增量 / merge 续拉前插 / 时间分隔），典型页 5 轮→极端 500 轮 | `process.hrtime.bigint()` 测量 + console.log，仅弱断言（条数/轮数>0） | **可弃/按需重建**。定位"卡在正在加载历史"时再复刻；测量对象（mergeHistoryPage/buildTurnsIncremental/insertTimeSeparators）若换实现则数字不可比 |
| `markdown-render-perf.test.ts` | 历史页 markdown 同步渲染成本（1:1 复刻 useMarkdown 管线：markdown-it+hljs+texmath/KaTeX），单项成本（hljs 30/100KB、纯文本 50KB、200 公式）+ 整页四档场景 | performance.now 测量 + `expect(true)`（零行为断言） | **可弃/按需重建**。结论性知识（历史页同步全量渲染是主瓶颈 → 已由 useChunkedMarkdown/分块提交解决）比数字更有价值，写入设计文档即可 |

---

## §3 m16-recon 三报告覆盖缺口补遗（功能点 → 所在 src 文件）

先说结论：三报告对 **stores / 主视图组件 / extensions+registry** 覆盖扎实；最大空洞是 **settings/ 整层**与 **core/api/endpoints 细节**；其次是若干 utils/css/契约载荷的散点。

### A. 完全未覆盖

| # | 功能点 | 所在 src 文件 |
|---|---|---|
| 1 | 设置域类型化 API 全面（约 30 函数）：全局 config 读写、pools、llm/search/ns schemas、装配视图 get/save、插件目录、插件库 stage/approve/reject/uninstall、市场 search/cached/stage/install、会话级插件 register/reload/unload、权限词汇表、暂存树/文件人审、Agent config/timers、browseFile | `settings/api.ts`（views-spec §21 仅一句"保存统一走 settings/api.ts"） |
| 2 | Schema 归一化 + 池默认同步：`toFields`（数组/对象双格式→FieldMeta[]）、`isVisible/filterFields`（showWhen+搜索）、`isNonDefault/parseNum/formatRatio`、`sanitizeGlobalConfig`（$ref 折叠/掩码 api_key 剥离）、`applySearchPoolDefault/applyLlmPoolDefault`（遮蔽剥离/覆盖保留/悬空清理三规则） | `settings/schema.ts`（有 2 个专属测试文件，报告零提及） |
| 3 | 设置共享类型：FieldMeta（text/password/number/ratio/checkbox/select/file 七型 + showWhen/sensitive/accept）、PoolEntry/PoolData、AgentConfigViews（raw 编辑/effective 展示双视图）、TimerEntry（time/delay/random/workday/holiday 五 mode + repeatCount）、PluginMeta（configNs/fields/security 特殊标记） | `settings/types.ts` |
| 4 | 11 个设置子组件全未读 + 3 个只读了开头：AgentListPane（Agent 池列表）、ExtToolsPane（40K，最大件：插件分组 + 7 种 hook kind + tools include/exclude，全局/Agent 双模式）、PluginLibraryPane（已安装/待审暂存/开发目录三页签）、PoolManager（模型/搜索池，provider 下拉由 schema 动态生成）、TimerPane、StagingReviewModal（人审：文件树+内容预览+requiredGrants 强制勾选）、PluginCard/PluginDevCard、NsFieldList（schema 表单 + JSON 兜底）、SettingField（7 种控件原子）、ConfirmDialog（`ref.ask()` 命令式确认） | `settings/components/*.vue`（views-spec §21 只覆盖 SettingsPanel 前 300 行、AgentPane 前 200 行、useSettings 前 150 行） |
| 5 | useSettings 未读部分：restartBackend（重启后端流程）、nsValue/setNsValue（命名空间字段读写）、agentAssemblyKey/snapshot/agentStateKey（dirty 判定键策略）、normalizeLegacyTags、syncRawFromAssembly | `settings/useSettings.ts`（22.7K，报告仅前 150 行） |
| 6 | REST endpoints 层 8/9 个文件：agents（CRUD/models/pools/avatar 上下传/**会话 Token 用量** fetchSessionTokens+色阶 status）、agentPresets、groups（CRUD+群历史分页）、runs（**RunsSnapshot DTO 簇 9 个接口**：members/pairs/groups/groupArchives/singles/running/subagents/coverage + interruptRun 软中断 + fetchPairHistory）、singles（CRUD + `?reuse=1` 复用空会话 + `?purge=1` 硬删/软删语义 + agentId 已有消息 409 禁改）、system（version/changelog/update/backup/usage-tokens/upload，上传按 agentId 归档 `files/<agentId>/_tmp/`）、workspace（tree/file/browseReadFile/browseFolder）、workspaces（CRUD，删除后会话归未分组） | `core/api/endpoints/*.ts`（仅 ui.ts 在 extensions-spec D3 提及；client.ts 在 D2 一行带过） |
| 7 | P5.5 双 CSP 形态本体：主 SPA 的 CSP meta（default-src self / script-src self / style-src unsafe-inline / img data: blob: / connect ws: wss: / worker self blob: / frame self / object none / base-uri / form-action self）与 iframe 容器页 CSP（default-src none / frame-ancestors self / base-uri none） | `index.html`、`ui-plugin-iframe.html`（报告只提 iframe sandbox 属性，未提 CSP 内容与审计面） |
| 8 | ABAP 语法高亮注册（模块加载即 `registerAbapLanguage()`；ToolResultCode/FilePreviewModal 的语言映射表含 abap/vue/svelte 等） | `utils/abap-hljs.ts` |
| 9 | 流式 markdown 安全切点算法本体：`findSafeSplitIndex`（围栏状态机、空行优先切点、末行无换行不产切点）、`splitStreamingContent`（maxPending=4000 强切、围栏内 lastIndexOf('\n')、词边界切分） | `utils/streamingMarkdown.ts`（views-spec §12 把分块机制一句话归到 useChunkedMarkdown，算法本体未展开；useChunkedMarkdown 只是它的 rAF 合并壳） |
| 10 | **src 原版** WebSocketClient 语义：MAX_PENDING=100 丢最旧、90s 入站静默看门狗（15s 检查）、flushPending "先整体取走再逐条 send + 单条 try/catch 丢毒消息"、socket 身份守卫（`this.ws !== ws` 忽略过期事件）、CLOSING 窗口直接重建、`disconnect()` 先摘事件再 close（防自动复活全聋）、`offMessage` | `services/websocket.ts`（stores-spec §2.5 描述的是旧壳改写的 preview 协议适配器——含 rpc() 出站翻译/入站合成；src 原版无 rpc，参数面与报告描述错位，ws-backlog-flush 钉的 4 条不变量报告无对应） |

### B. 覆盖不足（有点到、缺细节）

| # | 功能点 | 所在 src 文件 | 报告现状 |
|---|---|---|---|
| 11 | WS 契约**载荷类型**：ChatSendPayload（`requestId` 客户端幂等语义：重连 flush 重发同 id 去重、手动重发换新 id）、StreamDeltaPayload、MessageEndPayload、GroupMessageEvent、StreamEventBase（agentId/agent/sender/dialogId 多名并存） | `core/events/contract.ts` | extensions-spec E.4 已收**事件名**全集（并指出 WS_EVENT 缺 `ui.extensions.changed` 的双源缺口），但 5 个载荷接口未录 |
| 12 | useMarkdown 机制细节：动态 hljs 主题（内联 light/dark 两套主题字符串注入 `#hljs-theme` style 元素，响应 window `theme-changed`）、`md-table-wrapper` 表格包裹 rule、fence 复制按钮 + uuid 占位符方案、`parseFileTags/restoreTags`（file-tag 先抽出再还原防误渲染）与 `linkifyFilePaths` | `composables/useMarkdown.ts`（341 行） | views-spec §12 只从 AssistantMessage 消费侧点到 .md-code-block-btn/.file-path-link 两个类名 |
| 13 | css 三层特性：main.css `@layer design-tokens` + light/dark 双令牌组（--color-*/--layout-*/--space-*/--radius-*/--transition-*，color-scheme 声明）；markdown.css 342 行 .markdown-body 渲染样式（防代码块撑破容器的 min-width:0 等）；**双令牌体系并存**（main.css 的 `--color-primary` 系 vs ui/tokens.css 的 `--primary` 系）这一事实本身；tokens.css 的 `html[data-theme='nebula'|'aurora']` 选择器**当前无 JS 驱动方**（theme store 只写 html.dark/.light，data-theme 是潜伏兼容层） | `assets/main.css`、`assets/markdown.css`、`assets/base.css`、`ui/tokens.css` | 报告仅在 main.ts 引样式处列过文件名；零特性记录 |
| 14 | ui/ 基础组件库 13 件：Button/Modal/Tooltip/Icon/Avatar/StarAvatar/StarCard/StatusDot/ThinkingIcon/ThoughtIcon/PulseTrace/icons.ts/index.ts/tokens.css 的 props/emits 面（如 Modal 的尺寸约定、ConfirmDialog 基于 Modal 的命令式 ask() 协议） | `ui/*.vue`、`ui/icons.ts`、`ui/index.ts` | 仅在使用处散点提及，无 kit 级清单 |
| 15 | TokenUsage 弦图/柱状图实现细节（chart.js + d3-chord 的联动、includeUserSelf 过滤、群聊流量排除） | `components/TokenUsage.vue`（53.6K，全仓最大组件） | views-spec §9 有骨架级覆盖（tab/交互），渲染实现细节未展开——属"够用"级别，列此备查 |

### C. 反向注意（报告有、src 没有的内容——原生面勿照搬）

| # | 内容 | 说明 |
|---|---|---|
| 16 | stores-spec §2.5 的"preview 线协议适配器"全节（出站翻译 chat.send→conversation/deliver 等、入站合成 loop/*→chat.*、`getPreviewClient()` 双实例双连接） | 这是旧壳为 preview 传输层做的改写，src 的 services/websocket.ts 无此层；原生面按新事件目录直连即可，§2.5 末尾"合并双连接"提示对新前端不适用 |
| 17 | stores-spec §1.3/§2.2 中标注的"preview 差异"注释（如 resume 快照 steps 含进行中步骤的镜像特征） | feed-resume-merge 测试两种形态都钉住了（含/不含进行中步骤），原生面以此为准即可 |

### D. 打包/工程面（本报告 §1 已补，三报告原本缺）

exports TS 源直出、tsconfig 双轨 + chinese-lunar.d.ts 跨树引用、vite 双入口 + manualChunks + @shared alias、boot bundle-rows/composition.yml 消费形态、EADDRINUSE 自杀策略、test 脚本的仓库根运行方式。

---

## 附：本次核实过的关键路径

- 入口/打包：`src/ui/webui/{src/index.ts, src/plugin.ts, package.json, vite.config.ts, tsconfig.json, tsconfig.plugin.json, index.html, ui-plugin-iframe.html}`
- 测试：`src/ui/webui/tests/`（10 文件，全读）
- 补遗证据：`core/events/contract.ts`、`core/api/client.ts` + `core/api/endpoints/*`（9 文件）、`settings/{api,schema,types,useSettings}.ts` + `settings/components/*` 头部、`services/websocket.ts`、`utils/{streamingMarkdown,abap-hljs}.ts`、`composables/{useMarkdown,useChunkedMarkdown}.ts`、`assets/{base,main,markdown}.css`、`ui/tokens.css`
- 宿主消费：`src/boot/boot/src/{bundle-rows.gen.ts, composition.web-app.yml, bootstrap.ts}`
- 对照：`preview/docs/m16-recon/{stores,views,extensions}-spec.md`、`preview/webui/{package.json, vite.config.ts}`
