# Changelog

All notable changes to AgentChat are documented in this file.

---

## [Unreleased]

### Added（桌面壳数据根可配置——指针链 + 设置面板「存储管理」）
- **指针读取链**（desktop/main.mjs，P1）：`env AGENTCHAT_DATA_ROOT`（调试/CI 覆盖）> 注册表 `HKCU\Software\AgentChat\DataRoot`（预留：安装向导/企业部署写入面，win packaged 形态）> `<appData>/AgentChat/data-root.txt`（设置面板写入面）> 缺省 `<appData>/AgentChat`。指针文件放缺省目录（稳定锚点——logs 恒在此，数据根可换而引导配置不丢）；指针失效 = 回落缺省 + 日志留痕，不 fatal。日志目录恒定缺省目录（迁移后重建）。
- **壳层存储桥**（P2 壳半边）：独立回环 http server（pickedPort+1）——`GET /desktop-bridge/storage`（当前根 + 占用统计）、`POST …/storage/pick`（Electron 原生目录选择——dialog 仅主进程可用，此即桥存在的理由）、`POST …/storage/set`（目标目录必须为空〔防吞并已有社区〕→ 可选迁移〔关后端 → rename 同盘原子 / 跨盘 cp+校验+删源，失败保源〕→ 写指针 → 壳层 relaunch）。仅桌面形态存在；非桌面/桥端口被占 = 前端 fetch 失败 → 设置节自动隐藏。
- **前端行 `ac-client-ui-desktop-storage`**（P2 前端半边）：settings:section 选举席贡献「存储管理」节（StorageHost.vue：位置 + 徽章 + 占用明细 + 迁移选项 + 确认弹层；bridge.ts 同源族端口推导 port+1 + 探活超时）。组合根两表 + ac-app 依赖同步。桥 pickedPort+1 与 vite 3831 理论撞号——仅 Electron 壳内存在（无 vite），无实际冲突。
- **验证**：行单测 2 例 + 全仓 tsc + check-deps + webui:build 全绿。

## [0.8.8] - 2026-09-16

### Added（群聊未读数字徽章——名册群行 + 活动栏聚合同源）
- **动机**：群聊离线时收到的消息无任何可见提示——Agent 私信有数字徽章（名册行 + 活动栏聚合），群聊却完全没有对等机制；正在别的会话/别的群里时，Agent 在群里发了什么全靠碰运气发现。
- **状态机**（feed-core，与 direct 同字段同语义——分区 `unread`）：`group/message-posted` 增量时非 viewer 发言且该群非当前活跃群 → `unread += 1`（正在看的群不计未读，与 direct 入站同口径）；清除收口在 `setActiveGroup`（进入即 `clearUnread(group:gid)`）——ui-group `selectGroup` 三路径（列表点击/创建后自动选中/上次上下文恢复）全经此，零改动自然生效。
- **名册群行**（AgentList.vue）：群头像外包 `group-avatar-wrap`（`position:relative` 容器，与 Agent 行 `item-avatar-wrap` 同构），挂 `.unread-badge` 数字徽章（复用既有样式：>99 封顶「99+」）；`unreadCountOf/unreadLabel` 泛化为 direct 对桶 + group 分区双源读取。
- **活动栏聚合**（ActivityBar.vue）：`agentsUnreadTotal` 从「viewer 直答对桶求和」改为**全分区求和**（direct + single + group）——名册只列 Agent/群（single 无行入口），原口径漏加 single 会话少报总数；群聊并入后徽章仍是全局唯一未读提示位。`unreadAgents` 旧接口保持原语义（名册行徽章消费），不动。
- **验证**：新增 `webui/tests/feed-group-unread.test.ts` 4 例（增量累加/viewer 自发不计/活跃群不计且清零稳定/direct-group 分区独立）+ `activity-bar-unread.test.ts` 扩 1 例（聚合含 group/single 分区、setActiveGroup 回落）；feed/群组/会话相关 13 文件 55 例 + 根 tsc 全绿。

### Changed（ac-sap-adt 引擎升级 @nefevcore/abap-adt-core 0.8.1 → 0.10.0：整合批次收敛工具面 40 → 32）
- **依赖**：`ac-sap-adt` 的 `@nefevcore/abap-adt-core` `^0.8.1` → `^0.10.0`（0.x 下 `^` 不跨 minor，需显式改 specifier；lock 同步为 registry 条目；`pnpm-workspace.yaml` minimumReleaseAgeExclude 白名单补 0.10.0 三件套）。
- **工具面变化（40 → 32）**：引擎 0.9.0 起整合批次（C/D/E 组）——调试器五件套（adt_debug_session/breakpoint/step/inspect/set_variable）合并为单工具 `adt_debug`（九 action 路由：listen/status/detach/setBreakpoint/deleteBreakpoint/step/variables/stack/setVariable）；ATC（adt_list_atc_runs + adt_get_atc_result）、dumps（adt_list_dumps + adt_get_dump）、transports（adt_list_transports + adt_get_transport）各并为一（adt_atc_runs / adt_dumps / adt_transports）；adt_read_textelements 并入 `adt_object_read {part:'textelements'}`。实现全部退位为内部引擎，策略/OCC/锁链不绕过。宿主适配层零改动——结构化缝（fs/credentials/host）与 assembleAdtTools 签名跨两代兼容（使用规约注入本就只认 `adt_` 前缀，代际无关设计按预期成立）。
- **连带同步**：ac-plugin-core `reserved.ts` 占名名单精确对账新注册面（32 adt_*，删 12 退位名 + 4 合并名）；ac-sap-adt 测试 2 处更新（adt_debug_session → adt_debug 策略拒绝断言；目录规模断言 40 → 32）；README/package.json/扩展自述/行头注释/preset 注释文案同步；engine.ts/index.ts 代际注释措辞更正（0.8 → 0.9+ 两代均成立）。
- **验证**：ac-sap-adt 20 例 + reserved-consistency 2 例全绿（boot 全 TREE 对账注册面 === BUILTIN_TOOL_NAMES）。

### Changed（会话列表工作区分批展开：时间分桶 + 桶内分页 + 折叠重置——空间效率优先）
- **动机**：工作区内会话增多后，「展开其余记录」一次展开全部——长列表折叠麻烦、定位困难；且工作区节点折叠再展开后仍记住「展开全部」状态，回到长列表。分桶本身不够省空间：深史桶（如「更早」）可能聚几十上百条，桶一开仍是一面墙。
- **新件 `sessionTimeBuckets.ts`**（ac-client-ui-singles client）：① 分桶纯函数 `bucketByTime`——最近活动按自然日分桶（今天/昨天/三天/一周/两周/一个月/更早；「三天」=2~3 天前、「一周」=4~7 天前……「更早」聚拢一个月外全部深史；桶边界锚本地时区 00:00，降序输入单趟游标 O(n)，空桶不出现）。② 桶内分页状态机（`RevealMap` = group key → bucket key → **显示条数上限**）——桶展开 ≠ 全量铺出：桶头点击 = 展开 `BUCKET_PAGE_SIZE`(5) 条/收起归 0（再展开回一页，不记住「展开很多」）；桶内「展开更多」= 每次追加一页（夹到桶大小，满额闸门消失）。无记录走缺省规则（首桶 + 激活会话所在桶各一页）；一旦有记录显式值是唯一事实源；首次交互以当前缺省上限播种——未被点击的桶视觉不跳变。
- **`SessionList.vue`**：桶住 `treeGroups` computed（随 sessions 变化重算）；桶头行（时间标签 + 条数胶囊，chevron 开合）+ 桶内会话行（前 limit 条）+ 尾部「··· 展开更多（N）」闸门。激活会话所在桶缺省开一页（选中态不被折叠藏掉；无今天会话时首桶顺延）。工作区节点折叠即 `resetGroupReveal` 弃置该组桶展开记录——重开恢复缺省分批态。工作区分组整体折叠态（collapsed）持久化语义不变。
- **验证**：新增 `session-time-buckets.test.ts` 12 例（分桶边界全轴/空桶/首桶顺延/未来时间戳兜底；状态机：缺省回落/桶头开合回一页/播种不跳变/分页追加与满额夹持/小桶夹持/组间隔离/折叠重置幂等）+ `session-list-buckets.test.ts` 6 例（组件级：分桶分页呈现/桶头开合/分页渐进与回退/首桶顺延/折叠重置/未分组同规则——jsdom 孤立挂载，桩 ctx 经 provide(CLIENT_CONTEXT_KEY) 注入）；ac-client-ui-singles 22 例 + 根 tsc 通过。

### Fixed（运行跟踪面板 single 会话显示具体标题——不再拿路由预设的「模式名」冒充会话名）
- **动机**：辅助侧边栏运行跟踪的「运行中」清单里，single 独立会话一行显示的是预设名（如「标准模式」）——`sessionTitle()` 先查 `snapshot.singles`，但客户端域投影 `toRunsSnapshot` 里 `singles: []` 恒为空，逐级回落到 `memberName(r.agentId)`，而 single 会话的运行 Agent 恰是路由目标预设（`__standard__` 等），预设名经 `getAgentName` 的预设目录解析即成「标准模式」。用户在会话列表看到的会话明明有具体标题，运行跟踪却只给模式名，无法分辨是哪个会话在跑。
- **改法**（ac-client-ui-runview `RunTrackingPanel.vue`）：single 分支改查 singles 域投影 `ctx.singleBoard.singles`（含自动生成标题；`singles/updated` 帧驱动刷新，标题生成后即时上屏——矩阵域 `RunsSnapshot.singles` 客户端投影恒空，不参与）；无标题会话与会话列表 `titleOf` 同款回落（`Agent 名 · 创建时间`；空 Agent →「新会话」）。`onMounted` 补拉 `singlesBoard.refresh()`（未开过会话列表时面板直接打开的数据源兜底，对齐 SessionList/ChatInput 既有模式）；域件未装载 → `?.` 静默跳过，可摘除性（D19）不变。
- **验证**：webui 全量 416 例全绿；根 tsc 干净。

### Added（前端 HTTP 面瞬时断网重试——后端 ac-llm 重试语义的前端镜像）
- **动机**：后端 LLM 调用自 2026-09-05 nana 事故后有瞬时网络错误退避重试（`ac-llm` dispatch——首块 chunk 产出前 fetch failed/ECONNRESET 等按 500/1500ms 重试 2 次），WS 面也有断线自动重连（退避 2s→30s + requestId 幂等重发），唯独前端 HTTP 面完全裸奔——网络一抖，`/api/ui/extensions`、`/api/ui/boot-graph` 等拉取直接失败；boot graph 拉取失败还静默返回空图，热通道 diff 会把全部 domain 行的 fiber 真回收（一次抖动拆光行集，代价远高于多等 2s）。
- **改法**（webui `core/api/client.ts`——全项目唯一 fetch 入口）：`request()` 增加瞬时故障退避重试，与后端 ac-llm 同款语义——仅幂等请求（GET/HEAD 且无 body）且仅在响应到达【之前】失败（fetch reject）才重试（缺省 2 次：500ms/1500ms）；非 2xx 应答（含 502/503——服务器已应答，后端重启窗口由 WS 通道重连恢复链兜底）、POST 等非幂等方法（重放可能重复执行）一律不重试；退避等待可被 `init.signal` 中止（中止优先于重试）；每次重试 `console.warn` 留痕。瞬时判定 `isTransientNetworkError` 镜像 `ac-error-core`（cause 链 AbortError 优先短路 / "fetch failed" 外壳 / 瞬时 code 清单——浏览器裸 TypeError 与 undici cause 链双形态），前端零依赖不复刻于本文件。新增 `setApiFetcher` 测试注入口。
- **收编**：两处绕过统一入口的裸 fetch 改走 `request()`——`api/extensions.ts`（扩展清单）、`runtime/bootGraph.ts`（boot graph 拉取；catch 兜底语义不变：重试耗尽仍不可达才空图）。
- **验证**：新增 `webui/tests/api-client-retry.test.ts` 10 例（重试成功/耗尽抛最后一次/退避节奏真实计时下界/POST 与带 body GET 不重试/503 不重试/AbortError 不重试/退避中 signal 中止/warn 留痕计数 + 与后端 `ac-error-core` 同输入对拍锁定双端口径一致防漂移）；webui 全量 416 例全绿；根 tsc 干净（webui vue-tsc 对本改动文件干净——InteractionBar.vue 的 13 个错误为另一在途多选题改动的存量，与本轮无关）。

### Changed（dev 启动去 tsx——Node 原生 TS strip-only 直跑，冷启动 3.2s → 1.2s）
- **动机**：`pnpm dev` 经 `--import tsx` 启动，tsx 的 esbuild 转换无持久缓存——每个新进程重新编译 80+ 行包，是冷启动静默期大头（boot 横幅打印后 ~2.7s 无任何行日志）。实测（同数据根）：tsx 路径 API 可用 @ 3.24s，Node 24 原生 strip-types @ 1.24s，dist bundle @ 0.99s。
- **改法**：仓库本就遵守原生 strip 红线（显式 `.ts` 扩展 / `verbatimModuleSyntax` / 无 enum 参数属性），Node ≥22.18（23.6 的 LTS 回移）type stripping 默认启用，直接去掉 tsx 层——`package.json` dev/dev:supervised/dev:demo/smoke/chat/bench 六脚本、`supervisor.mjs` worker spawn 参数、`bin/agentchat.js` 仓库回退路径（低版本 Node 兜底 tsx 不变）。vitest 不动（测试文件仍走 tsx transform，与运行时加载解耦）。
- **门槛**：engines `>=20` → `>=22.18`（原生 strip 的最低版本；Node 20/21 无此能力，dev 需升级 Node）。
- **附带验证**：NODE_COMPILE_CACHE 实测对该负载无收益（strip 产物小文件 V8 编译本就快，缓存目录读写反增 ~0.15s）——不引入。
- **验证**：`pnpm dev` 三端点全 200 @ 1.50s（隔离数据根探针）；`dev:demo` 完整跑通（e2e 链路 + HMR 热重载 v1→v2，exit 0）；supervisor 原生加载 + 锁协议正常（用户实例持锁时按协议退 78）；全仓 vitest 1936 例全绿 + 根 tsc 干净。

### Fixed（runs/snapshot 轮询整读会话文件堵事件循环——刷新页面 API 秒级排队）
- **动机**：`runs/snapshot` RPC（ac-web-api）每 3s 对全部会话调 `session.tail()` 取名册末条摘要，`tail()` 原实现每轮 `readFileSync` 整读 messages.jsonl 且零缓存——百 MB 级数据根（153 会话/182MB）实测稳态单轮 ~1.2s、进程冷后首轮 ~8s，同步 IO 全程阻塞事件循环：并发到达的 HTTP 请求（`/api/ui/extensions`、`/api/workspaces` 等）全部排队，用户侧表现为「启动完成后再刷新页面也要 5 秒+」。
- **改法**（ac-session）：`tail()` 两级加速——① `tailCache`（mtime/size 门，同 stats/records 缓存模式）：文件未变直接返回缓存投影零读；② 尾窗读取：变化时只读文件尾 8 MiB 窗口找末条完整记录（窗起点在行中时跳过被撕裂的半行），窗内找不到（病态大记录）才全读兜底（`tailFullRead`）。主动失效点对齐既有缓存：setShelf 迁移 / rewriteMessages 重写 / clear 各处同步 `tailCache.delete`。
- **验证**：新增 `ac-session/tests/tail-cache.test.ts` 8 例（命中全等/写后失效/外部直改失效/重写失效/clear 回 undefined/partial 行跳过/大文件尾窗命中/双桶隔离）；ac-session 全部 + ac-web-api 回归 118 例全绿；根 tsc 干净。实测同一数据根副本：稳态轮询 1230ms → 75ms，刷新时并发 HTTP 1048~2462ms → 6~12ms。

### Added（辅助活动栏「运行跟踪」rail 按钮：主题色数字徽章——一眼可见当前运行中会话数）
- **动机**：运行是否在进行要展开面板才能看到——运行中会话数是最常盯的监视量，常驻 rail 按钮上直接给数字（有 run 进行中即可见，无需展开）。
- **契约**（ac-client-ui-layout `auxSidebarViews.ts`）：`AuxSidebarPanelDef.rail` 新增可选 `badge?: () => number | string | null`——徽章数据源随 owning 行声明（壳零域知识）；0 / null / undefined / 空串 = 不渲染，数字 >99 壳封顶「99+」，文本（如「√」）原样透传。
- **壳渲染**（`AuxActivityBar.vue`）：rail 按钮右上角主题色胶囊徽章（`--color-primary` 底白字、`--color-bg-page` 描边 1.5px——同 more-dot/unread-badge 定位语言）；每渲染帧安全求值（badge() 抛错 = 该按钮无徽章 + console.warn，同 available 谓词姿势，不击穿栏）。
- **域行供数**（ac-client-ui-runview）：tracking 选区 `rail.badge` = `ctx.runs.snapshot.running.length`（经根 runtime 解析——本 fiber 未 inject runs，直访会抛被安全求值吞掉）；**行装载即启动 runs 快照轮询**（`ensurePolling` 在 apply 首调用，幂等；此前轮询只随面板挂载启动，收起面板徽章会失活）。fiber 卸载随 RunsClientService 定时器一并回收。
- **连带**：`boot-graph.test.ts` 装载断言更新——装载即拉取后 rpc stub（返回 `{}`）合成空视图（running: []），原「snapshot = null 空态」断言过时。
- **验证**：新增 `webui/tests/aux-badge.test.ts` 2 例（数字渲染/0·null 隐藏/99+ 封顶/文本透传 + 抛错不击穿）+ `clients-runview.test.ts` 补徽章数据源用例（随 snapshot running 数更新、行卸载同灭）；根 tsc + webui vue-tsc 干净；webui 全量测试回归。

### Changed（统一下 Toast 行为——全 UI 唯一瞬时反馈通道，收编 9 处自制实现）
- **动机**：项目没有全局 Toast 原语，各面板自制了 9 处「ref + setTimeout 短暂反馈」——时长 1500/2000/3000/3500/5000ms 五种口径、连续触发互踩（旧定时器清掉新消息或多条刷屏）、两处错误反馈埋在 title 属性里基本不可见、一处（活动栏备份结果）挂在「点击即关」的菜单里随菜单消失。webui-slot-tree ⑥ global 层早已预留 `global:toast` 候选席（宿主先建原语再开口），本轮落原语半件。
- **新件 `toast.ts`**（webui-kit，命令式写口 + 模块级单例栈，零 DOM 依赖）：tone 语义态与 FeedbackNotice 同轴（ok/error/info/busy → 图标/配色派生）；时长按 tone 分级（ok 2s / info 3s / busy 4s / error 5s——错误文本长阅读时间最长；`duration: 0` 永驻手动关）；**同 key 原位刷新**（缺省 key = 文本）：连续触发不叠加不互踩，busy → ok/error 同 key 演进（计时重置）；栈上限 4 条（超出丢最旧）；hover 暂停/恢复（剩余时长快照，resume 续走）。便捷别名 toastOk/toastError/toastInfo/toastBusy；dismissToast/clearToasts 手动管理。
- **新件 `ToastHost.vue`**（webui-kit，渲染半件）：Teleport body 右下角栈，z-index 9500（低于更多菜单 9999 / FilePreview 10000，盖过设置域弹窗 1200），TransitionGroup 进出动效，`role="status" aria-live="polite"`，逐条关闭钮。AppFrame 挂载一次（overlay 席之后），全局唯一渲染点。
- **收编 9 处**（行为统一为 toast；错误展示从 title 兜底升级为直接可见）：① PluginLibraryPane `flash()`（3500ms → toastOk）② SettingsPanel 保存 successMsg（footer 占位互斥 dirty 提示 → toastOk）③ PoolManager ④ SearchPoolManager `saved`（2000ms → toastOk）⑤ FilePreviewTabPane ⑥ FilePreviewModal 本地打开错误（title 3s → toastError）⑦ WorkspaceTree ⑧ SessionList 工作区资源管理器错误（同上）⑨ FileEditsPanel 本地打开错误。**连带修真 bug**：ActivityBar 备份反馈原挂「更多」菜单内的 FeedbackNotice——`onItemClick` 点菜单项即关菜单，备份结果随菜单消失不可见；改 toastBusy → toastOk/toastError 同 key 'backup' 演进，全程可见。
- **不收编面（原地翻转语义，保留各组件自实现）**：复制按钮的图标/文案翻转（AssistantMessage/UserMessage/ToolResultCode/Edit/Write/StagingReviewModal/SystemPrompt 族——反馈点即按钮本身，无脱离上下文需求）；表单内联错误（ExtensionSettingsModal/GroupDrawer/AgentList——错误锚定字段位置）；FeedbackNotice 嵌入式反馈条（ConversationView 投递反馈——就地呈现语义）。
- **验证**：新增 `webui/tests/toast.test.ts` 14 例（时长分级/去重刷新/上限/手动管理/hover 暂停快照续走/ToastHost Teleport 渲染与 aria）；根 tsc + webui vue-tsc 干净；全仓 vitest 1915 例（244 文件）全绿。

### Changed（[路径规则] 行按 access-tier 档位分措辞——单句全局口径在权限轴下失真）
- **动机**：access-tier（`full-access`/`sandbox-access`/缺省 base × `ToolCall.elevation`）落地后，[路径规则] 单句"工作目录与白名单内绝对/相对路径均可；沙箱越界一律拦截"三处失真：① 读不设防（§9.1，read/glob/grep 脱离沙箱只过双黑名单——旧句诱导 Agent 误以为读工作目录外会被拦）；② full 档不受沙箱限制（旧句对 full Agent 是假的）；③ base 有人桶越界写不是"一律拦截"而是审批询问、人批即放行。
- **改法**：ac-system-prompt `buildEnvBlock` 新增 `pathRuleLine(accessTier)`——按本 run 有效档位注入三套措辞（base：均可读写 + 读不设防 + 越界写触发审批/拦截，保留 2026-09-02 反泛化锚"拦截原因是越界而非绝对路径形态"；sandbox：白名单内自由读写含 bash 软边界；full：不受沙箱限制、黑名单仍生效）。档位判定走 `effectiveTierOf(agent, request.elevation)` 单源（ac-agents，与安全行/工具行同源）；agents 能力缺位 = base 措辞（fail 方向一致）。`AssembleInput` 新增 `accessTier`，纯函数与 apply 两级装配。
- **验证**：ac-system-prompt 33 例（新增分档措辞纯函数例 + apply 侧 tags/elevation 装配例）+ ac-agents/ac-security 回归 76 例全绿；根 tsc 干净。旧全局句不再出现于任何档位。

### Added（工作区树展开态跨刷新持久化——刷新后不再全部回到收起态）
- **新件 `workspaceTreePrefs.ts`**（ac-client-ui-workspace client）：各树基准（`c:<sid>` / `a:<agentId>` / `''` 全局——`contextKey` 同源）的展开目录路径集合记入 localStorage 单键 `agentchat.workspaceTreePrefs`（`{ contexts: { [key]: string[] } }`）。写侧去抖 200ms 合帧 + `pagehide` 冲刷兜底；读取逐项 string 校验、损坏/无 localStorage 静默降级空态（与 composePrefs 同款手法——存储面在 import 时捕获，jsdom/node 缺省 undefined）。
- **store 接线（`workspaceTreeStore`）**：基准建册（`setContext` 首触 / `loadDir` 防御兜底）改走 `registeredState(key)` 读回持久化展开集合；`expandDir`/`collapseDir` 变更即时 `saveExpanded` 写回（满集合全量替换）；新增 `restoreExpanded` 恢复链——根层加载后按**深度序**逐层懒加载重铺（父先子后 `findNode` 才可寻；复用 per-path in-flight 守卫，恢复期并发展开归一；幽灵路径（目录已更名/删除）静默忽略）。树数据/滚动位置/activePath 仍是会话内瞬态（懒加载重取 + 滚动随高度变化）。
- **护栏**：单基准 200 条展开路径、全基准 50 条目（超限裁最旧留最新——补丁键重排到尾）。
- **验证**：新增 `tests/workspace-tree-prefs.test.ts` 8 例（prefs 读写/损坏降级/条目护栏 + store 写回/刷新重铺/深度序/孤儿与幽灵路径/per-context 隔离；fetchWorkspaceTree 经 vi.mock 换克隆 fixture——store 会把返回节点挂树，共享引用曾致跨测试污染）+ 行内既有 3 例；根 tsc + webui vue-tsc 干净 + webui 全量 386 例 + webui:build 通过。

### Fixed（主侧边栏会话列表工作区分组折叠态从未持久化——注释承诺的「记住折叠」是句空话）
- **动机**：`SessionList.vue`（single 页主侧边栏）的工作区分组展开/收起态住组件内 `ref(new Set())`——注释写着「记住用户折叠状态」，但无任何持久化：切换活动栏视图（面板卸载 ref 清零）或刷新即全部回到展开。此前一轮「工作区树展开态持久化」改的是辅助侧边栏文件树（`WorkspaceTree`），两处常被混称「工作区树」，用户反馈「没生效」实际指本处。
- **改法**：新件 `sessionTreePrefs.ts`（ac-client-ui-singles client）——折叠分组 key 集合（workspace id + `__ungrouped__`）记入 localStorage 单键 `agentchat.sessionTreePrefs`（string[] 全量替换）；`SessionList` 初值 `loadCollapsed()` 读回、`toggleGroup` 即时 `saveCollapsed` 写回。与 composePrefs/workspaceTreePrefs 同款手法：storage 面 import 时捕获（jsdom/node 缺省 undefined → 静默无持久化）、损坏 JSON 降级空态、200 条护栏；幽灵 key（工作区已删）读取无害，随下次交互自然淘汰。
- **验证**：新增 `tests/session-tree-prefs.test.ts` 7 例（空态/写读往返/全量替换/损坏降级×2/护栏/幽灵 key；node 环境内存桩先于模块 import 注入——与 workspace-tree-prefs.test 同款）；根 tsc + webui vue-tsc 干净；Playwright 端到端：折叠 → 落键 → 刷新回放保持折叠，无页面错误。

---

## [0.8.7] - 2026-09-14

### Changed（ac-sap-adt 引擎升级 @nefevcore/abap-adt-core 0.7.2 → 0.8.1：CRUD 时代 A 组工具退位，fs 风格 adt_object_* 顶替）
- **依赖**：`ac-sap-adt` 的 `@nefevcore/abap-adt-core` `^0.7.2` → `^0.8.1`（0.x 下 `^` 不跨 minor，需显式改 specifier；lock 同步为 registry 条目；`pnpm-workspace.yaml` minimumReleaseAgeExclude 白名单补 0.8.1）。
- **工具面变化（46 → 40）**：引擎 0.8 起 CRUD 时代 A 组 9 名（adt_crud / adt_create_object / adt_read_object / adt_read_structure / adt_write_object / adt_edit_object / adt_write_structure / adt_delete_object / adt_package_content）与 adt_push_object 不再注册（实现退位为内部路由引擎），新增 4 个 fs 风格门面 adt_object_write / read / edit / delete（无 name 调用返回 fs 能力矩阵卡；非法 type 给可读违规）。宿主适配层零改动——结构化缝（fs/credentials/host）与 assembleAdtTools 签名兼容。
- **连带同步**：ac-plugin-core `reserved.ts` 占名名单精确对账新注册面（40 adt_* + 新 4 名，删 10 旧名）；ac-sap-adt 测试 4 处旧名调用换新（含矩阵卡/参数校验断言）+ 目录规模断言 46→40；README/package.json/扩展自述/行头注释等文案同步。
- **验证**：ac-sap-adt 15 例 + reserved-consistency 2 例 + root tsc 干净 + 全量 vitest 1876 例（241 文件）全绿。

## [0.8.6] - 2026-09-13

### Fixed（CI Linux 门禁四连修：v0.8.6 发布测试失败——平台差异与精度撞值）
- **bfcl 样例数据丢失（ENOENT）**：`.gitignore` 无锚定 `data/` 规则（本意忽略仓库根运行时数据根）误伤 `src/ac-bench/data/`——bfcl-sample.json 未入库，CI 上 ac-bench 2 例 ENOENT。修：规则锚定 `/data/`，数据文件入库。
- **Unix 彩色输出命令被沙箱整体误拦**：`bashCommandViolation` 反斜杠归一（`\` → `/`）把 printf 八进制转义 `\033[31m` 变作 `/033[31m`——恰好构成「空白后 / 开头」假 Unix 路径 token（首字符数字不落 Windows 开关豁免），`printf "…\033[31m…"` / `echo -e` 类彩色命令在 Unix 上整体被拦。修：归一前剥 shell 八进制转义（数据非路径）；真路径拦截不受影响（回归用例钉）。
- **单 step 双 ask_questions 排序退化**：`createdAt = Date.now()` 毫秒精度，同一 step 两个提问同毫秒 open 撞值——前端「最新优先」降序路由失效，断言翻车。修：store 单调时钟（同毫秒 +1）保证 createdAt 严格递增（排序语义 = 发生顺序）。
- **close 悬挂测试 Linux 分支越界**：`(cd /tmp && node …&)` 的 `/tmp` 绝对路径被命令级沙箱拦截（该测试目标是 close 兜底非沙箱）。修：Linux 分支孙进程直接以 workdir 为 cwd（Unix rm 不受进程占用目录影响，无 EPERM 面）。
- **验证**：sandbox-core 29 例（+八进制转义回归 1 例）+ durable-interaction 26 例（+单调时钟 1 例）+ ac-bench 16 例 + shell-tools 22 例全绿。
- **教训**：本轮三个失败全是「开发环境 Windows、CI Linux」的平台盲区——Linux 分支的命令字符串从未在本机跑过。后续涉平台分支的测试用例，本地需显式过一遍非常规分支。

### Changed（工作区树文件不再显示大小：UI 列除役 + 服务端 statSync 同除）
- **UI**：`WorkspaceTreeNode` 文件行的 `(xx.xKB)` 尾注与 `.wtn-size` 样式移除——文件大小对浏览决策意义不大，且挤占窄面板里本就紧张的文件名宽度（前端反馈 #4）。
- **服务端全链清理**（`ac-workspace` `tree()`）：`WorkspaceNode.size` 字段移除——同除每个文件一次的 `statSync`（大目录树加载 I/O 减半）；预览头部需要尺寸时由读面（`readFile`）自带，不受影响。前端 `TreeNode`/`WorkspaceNode` 契约面同步收窄。
- **验证**：ac-workspace + ac-web-api 116 例全绿；双 typecheck 干净；webui:build 通过。

### Changed（前端反馈三项：文件编辑/system prompt 按钮对齐预览页 icon 钮形态 + 工作区树 dotfile 口径分流）
- **文件编辑面板「本地打开」**：文字小按钮（"本地打开/打开中…/失败"）改为与预览页 `fpt-icon-btn` 同形态的 icon 按钮（24×22 透明图标钮 + hover 底色 + Tooltip）——`external-link` 常态 / `loader-circle` 旋转中 / `alert-circle` 错误态（title 兜底报错）；不再与文件名/徽章争宽度，卡片头部更紧凑。
- **System Prompt 面板「刷新/复制」**：同款对齐——原带边框文字按钮（图标 + "复制/已复制"）改为 icon 按钮 + Tooltip（`refresh-cw` / 刷新中 spinner / `copy`→`check` 已复制变绿）；与预览页头部动作视觉一致。
- **工作区树 dotfile 口径分流**（`ac-workspace` `tree()`）：dotfile 过滤（`.` 开头不入树）**仅作用于数据根基准**（滤 `.initialized` 等控制面噪音——原设计目的）；树基准为外挂工作区（会话挂载）或 Agent 专用空间（`files/<id>`）时 dotfile **如实入树**——`.dsh`/`.git`/`.gitignore` 等项目内容是用户真实文件，此前被误滤（前端反馈 #3：AgentChat 工作区看不到 `.dsh`）。
- **验证**：ac-workspace 47 例全绿（新增：会话工作区 `.dsh` 目录/`.gitignore` 入树 + `.dsh` 下钻、Agent 专用空间 dotfile 入树、数据根口径不变锚 ×2）；会话行 38 例 + 双 typecheck + webui:build + 视觉基线全绿。

### Fixed（圆角 token 双轨漂移：--radius-* 6/10/14 被 --r-* 4/8/12 无层别名覆盖，改动从未生效——单源统一）
- **根因**：本轮 main.css 已把 `--radius-*` 升至三档语义 6/10/14（`@layer design-tokens` 内），但 `webui-kit/tokens.css` 的业务兼容别名层（**无 @layer、后加载——层样式优先级恒低于无层样式**）仍以 `--radius-*: var(--r-sm/md/lg)` 把值压回 `--r-*` 的 4/8/12——main.css 的圆角升档实际从未生效，两套词表并存且值漂移。
- **修复（单源化）**：`webui-kit/tokens.css` `--r-*` 对齐 6/10/14（全站唯一值源，档位注释入册：6 控件 / 10 中层容器 / 14 大容器气泡；pill `--r-full` 与正圆 50% 另计）；main.css `--radius-*` 改为 `var(--r-*, 6/10/14px)` 别名消费（与既有别名层方向一致，消除反向覆盖）。
- **散落硬编码归位（本轮触及组件）**：FileEditsPanel/SystemPromptPanel/TimersPanel/GoalBar/GroupDrawer/TokenGauge/TokenUsage/ChatInput(.tok)/InputMention/AssistantMessage/UserMessage/ToolResultWrite/ToolResultCode/ToolResultEdit/SessionList/AgentList/WorkspaceTreeNode/ConversationJobsChip/RunTrackingPanel/预览三件套（FilePreviewModal/Panel/TabPane）——3/4/5px 控件级→`var(--radius-sm)`、8/10px 容器级→`var(--radius-md)`；GroupDrawer 成员角标 8px→pill（`--r-full`）；2px 超小指示件（SettingsPanel sp-accent 竖条）与 3px 滚动条 thumb 等非控件元素保留原值；TokenUsage 色点 3px 收敛为 2px（9px 方点内切圆角观感）。kit 词表组件（TokenUsage）用 `--r-*` 直引。
- **视觉基线**：有意重建（全站圆角随 token 升档——按钮 4→6、卡片 8→10 的感观差异 + 04 景 tracking 面板随入口迁移变 aux 侧栏形态）；白名单登记（token 单源统一 + tracking 入口适配两条目）。
- **验证**：根 tsc + webui vue-tsc 干净；webui 全量 388 例（386 过 2 skip）+ 客户端 UI 包 62 例全绿；webui:build 通过，dist 确认 `--r-sm:6px` 单源 + `--radius-sm:var(--r-sm,6px)` 别名链编入；视觉快照回归模式全绿。

### Fixed（视觉快照测试交互路径过时：主活动栏「Agent 运行跟踪」按钮已移除，04 景恒超时）
- **根因**：2026-12 入口冗余清理移除了主活动栏 tracking 按钮后，`visual-snapshot.test.ts` 04 景仍点 `[title="Agent 运行跟踪"]`——选择器恒等不到（超时失败，且 UPDATE 重建模式下同样中断）。
- **修复**：拍摄路径改点 `.aux-activity-bar [title="运行跟踪"]`（辅助活动栏 rail，tracking 唯一桌面入口）；面板形态由主侧边栏内嵌变 aux 侧栏右侧展开，04 各主题基线随真实形态重建。白名单登记。
- **验证**：AGENTCHAT_VISUAL=1 回归模式全绿（重建后连续两轮通过）。

### Fixed（助手回复文件引用双重渲染：行内代码路径升级为文件链接，不再灰底芯片内嵌链接芯片）
- **根因**：系统提示要求 Agent 以 markdown 行内代码引用产出路径（`` `src/a/b.ts` `` → 灰底 `<code>` 芯片），而 `useMarkdown.linkifyFilePaths` 的 HTML 标签保护列表缺 `code`，Step 2 路径检测穿透进行内代码再包一层主色 `file-path-link` span——同一路径叠两种视觉效果（外层代码芯片 + 内层链接芯片）。
- **修复**（`ac-client-ui-renderer/client/useMarkdown.ts`）：① 保护列表补 `code`——行内代码是字面语义，内容不再参与路径检测（纯文本路径检测能力不变）；② 新增 Step 4 升级——整段 `<code>` 恰为已知扩展名路径时把 code 本身升级为 `<code class="file-path-link" data-file-path>`（复用既有点击处理与样式，仅保留可点击链接一种效果；`escapeAttr` 属性转义防注入，g 正则 lastIndex 手动复位）。code 内混杂其他文字（`` `见 src/a.ts 文件` ``）保持字面语义不升级。
- **验证**：renderer-client 新增整段升级/混排不升级/无嵌套 span 回归用例，包内 4 例全绿；根 tsc + webui vue-tsc 干净；dist 重建。

### Added（方案 C：会话文件首见快照——存量文件的初版 diff 补全）
- **新行 `ac-file-snapshots`**（ctx.fileSnapshots）：每会话每文件**首次写入前**的磁盘内容快照，存储 `<dataRoot>/file-snapshots/<conversationId 编码>/<absPath 编码>`。核心不变量：`ensure` 幂等——同键首见后绝不二写（文件后续变更在消息流，快照保持首见事实）；首见时不存在 = `existed:false` 标记（会话内新建语义）。纯库 `SnapshotStore` + owning 行（Service），快照失败只 warn 不阻断写路径。
- **写点接入（软依赖可选探测）**：`ac-fs-tools`（write/edit）与 `ac-str-replace-editor`（create/str_replace/insert）五个写路径在 `withFileMutationQueue` 前调 `snapshotBefore`（`ctx.get('fileSnapshots', false)`——本行缺席静默跳过，两工具行零硬依赖）。快照键 = `call.conversationId`（工具执行身份，loop 装配）。
- **RPC `fileSnapshots/list`**（ac-web-api）：按 conversationId 返回快照清单（absPath/content/capturedAt）；行缺席 = 空清单（前端回落方案 A 纯重放）。
- **前端消费**：`fileEdits.ts` 新增 `applySnapshots`/`fileEditsWithSnapshots`——partial 断链文件（存量打头）匹配快照后以「快照底 + 会话内编辑链重放」重建完整初版/终版（快照 content=null 场景 base='' 全量 diff；路径按后缀段匹配对齐相对/绝对路径）。面板拉快照（会话切换 + `loop/after-run` 收束刷新），`partial` 徽章与断链提示在有快照时自然消除。
- **磁盘终版兜底（`applyDiskFinals`/`fileEditsFull` + RPC `fileSnapshots/read-current`）**：无快照匹配的 partial 文件（快照机制上线前已被编辑的存量会话——首编辑早于行装载，快照无从补起）二段兜底——终版 = 磁盘现内容、初版 = 自终版**逆序回退**编辑事件（edit 逆 = new→old、insert 逆 = 删行校验；write 前版不可知 = 停点，`diskBackfill` 软标记提示「自会话内首次可回推点起算」）。批量读上限 200 文件护栏。相对路径（沙箱内）无法寻址不兜底。
- **换行形态对齐（CRLF/LF）**：edit 工具执行面「归一 LF 匹配 + 写回还原行尾」——消息流参数是 LF、磁盘可能是 CRLF，严格 indexOf 匹配必失配（曾致「有 1 条编辑无法在重放中定位」警告与 diff 空）。`applyReplace`/`applyInsert`/`uninsert` 统一经 `alignNewlines`（参数串跟随基底行尾风格对齐后匹配/替换，产物换行随基底）。真实会话验证：22/23 文件出完整 diff（余 1 = 临时文件已删）。
- **boot 装配**：`src/cordis.yml` + `ac-app TREE` 两处加行（fs-tools 与 str-replace-editor 之间）；根 package.json devDependencies 声明。
- **验证**：`ac-file-snapshots` 纯库 7 例 + 工具行集成 5 例（真实 write/edit/str_replace_editor 执行落快照、跨会话独立、无 conversationId 不触发、行缺席不阻断）；fileEdits 快照补全 5 例；装配测试（config-boot/chat 16 例）+ 相关回归 44 例全绿；双 typecheck + webui:build 通过。

### Fixed（文件预览路径推导：Agent 回复的相对/工作区路径按会话与 Agent 基准定位，不再恒「文件不存在或不可读」）
- **根因**：预览链路（消息文件链接 / write 工具卡展开 / 预览 tab）把 Agent 回复中的路径一律按数据根相对解析——Agent 在工作区（`src/app.ts`、`notes/a.md` 等）内作业时回复的相对引用在数据根下不存在，点开恒 404；single 会话挂载工作区同样不可见。
- **服务端读面推导**（`ac-workspace` readFile/resolveFile 新 `context` 参数 + `locateReadable` 单源）：数据根快路径未命中时按基准定位——会话挂载工作区（singles workspaceId → conversationWorkspaceRoot）> Agent 沙箱基准（显式 settings workdir > 专用空间 `files/<id>`，与 sandboxWorkdir 同源优先序）。包含判定复用 ac-sandbox-core 的词法+身份双通道（../ 逃逸照拒、win32 别名词形放行）；敏感遮蔽（.env/凭据/控制面）在基准推导内 fail-closed 同拦；无 context 保持原行为（越界/不存在照抛原错误）。
- **HTTP 面**（`ac-web-api`）：`/api/workspace/file` 与 `/api/workspace/raw` 新增可选 `agentId`/`conversationId` query 透传（readContext 窄化）。基准命中的回显 `path` = 绝对路径（raw 直链/底部路径栏可追溯）。
- **前端载体链**：`ReadContext {agentId, conversationId}` 自 `workspaceFile.ts` 单源——filePreviewContent 候选序前置「原路径 + context」请求（服务端推导）→ 本地 `files/<agentId>/` 前缀回落保留；previewTabs/openTab 携带 context 快照进 tab；uiStore openPreview 三参 + `previewConversationId`/`previewIntentConversationId` 状态；FilePreviewHost/Modal/TabPane/Panel 全链接线。
- **会话链透传**：ConversationView（single = 会话 id；direct = 激活 Agent 对桶键）→ TranscriptList → TurnDisplayItem（previewFile payload 增 conversationId）→ AssistantMessage/UserMessage 文件链接与 ToolMessage 工具卡（agent-id = 工具消息 agent_id、conversation-id = 所在会话）；`ToolResultWrite` 展开读取同 context（Agent 工作区内产出文件可直接预览）。
- **验证**：ac-workspace 新增 3 例（Agent 基准/会话基准+数据根优先/越界与敏感遮蔽）共 33 绿；web-api 新增 query 透传端到端 1 例共 69 绿；webui 379 绿 + client UI 包 50 绿；tsc + vue-tsc 干净；dist 重建。

### Added（桌面版新增 macOS 支持：dmg/zip 双架构打包，壳层两处 darwin 行为适配）
- **打包配置**（`desktop/package.json`）：`build.mac` 块——dmg + zip target、`arm64 + x64` 双架构（非 universal，体积友好）、`identity: null` 显式跳过签名（无 Apple Developer 账号，避免构建机上找不到证书即失败）；图标复用 512×512 `icon.png` 由 electron-builder 自动转 icns。
- **CI**（`.github/workflows/desktop.yml`）：matrix 增加 `macos-latest` + `--mac`；与 win/linux 并行构建，产物随同一 Release 发布。
- **壳层适配**（`desktop/main.mjs`，仅两处 darwin 分支，win/linux 零行为变化）：① `app.on('activate')` 恢复主窗口——macOS 关窗=收托盘后点 dock 图标默认无恢复路径；② `autoUpdater.autoDownload` 在 darwin 关闭——未签名包 Squirrel.Mac 装不上，只做更新提醒，避免下载后安装失败的体验（win/linux 照旧自动下载静默安装）。
- **README**：桌面版段落补 macOS dmg 下载说明（arm64/x64 按芯片选择）、数据根路径 `~/Library/Application Support/AgentChat`、未签名首启引导（右键→打开）与更新策略说明。
- **Retina 托盘图标**：新增 `build/icon@2x.png`（32×32，logo.svg 按目标密度直渲，细线不发糊）——`nativeImage.createFromPath` 按同名后缀约定自动加载为 2x 表示，`resize(16pt)` 后 1x/2x 双表示保留，macOS Retina 与 Windows HiDPI 托盘均取原生密度渲染；`files` 打包清单同步带入（此前只带 icon.png）。
- 既有跨平台基础无需改动：杀进程树 win32/else 分支、数据根 `app.getPath('appData')`、托盘均为平台原生支持；后端纯 Node bundle 无 native addon。

### Added（文件编辑辅助侧边栏面板：会话文件编辑纵览 + 初版↔终版 diff）
- **新选区**（conversation 行）：`webui-base-conversation.file-edits`——辅助活动栏新增「文件编辑」按钮（icon `file-diff`，order 20，rail 恒可见；comfyWidth `'half'` diff 对照半屏；keepAlive 展开态跨让位保留）。点击展开侧边栏 / 二次点击收起（活动栏同款交互）。
- **纯函数层** `client/fileEdits.ts`（零 vue/cordis 依赖，可独立单测）：`extractFileEdits`（消息流 → 编辑事件——直播/历史双形态参数与结果解析、ToolResult `{ok,output}` 解包）→ `replayFiles`（时间序单遍正向重放：write/create 全量置内容、edit/replace 精确替换、insert 按行插入；失败事件跳过、失配计 mismatches 不中断链）→ `diffOfSummary`（初版 vs 终版 unified diff——复用 `ac-edit-core/src/diff.ts` 的 `generateDiffString`，从子路径直接导入避开包入口的 node:fs 依赖浏览器构建问题）。
- **初版/终版语义**：会话内出现过成功全量写入 → 链完整（base = 首次全量写入版，final = 重放终版——覆盖 write 内容全知不构成断链）；唯一断链场景 = 存量文件打头（首事件是编辑，首版磁盘内容不在消息流）→ partial 标记 + partialBase（后续全量写入版）降级提示。diff 生成行格式与 `ToolResultEdit` 工具卡同款（`- 行号 内容` / `+ 行号 内容`）。
- **面板** `FileEditsPanel.vue`：逐文件折叠卡（路径 + 新建/部分徽章 + `+N/-M` 统计 + 编辑次数）→ 展开 = 初版↔终版 diff 视图（增删行着色）+ 编辑事件时间线（时间/动作/Agent 署名/失败划线）；头部统计条（N 文件 · M 次编辑 · 合计 ±）；bash 等间接写不可追踪——底部如实提示；空态引导。
- **全量历史（P2）**：面板挂载时若 `hasMoreHistory` 自动循环 `loadMoreHistory` 拉全（feed 内置 loading 门串行安全）——编辑记录覆盖整个会话（含分页外的早期历史）；group 分区一次性拉全不触发。
- **覆盖工具面**：`write` / `edit`（ac-fs-tools）+ `str_replace_editor` 的 create/str_replace/insert（ac-str-replace-editor）；view 等只读命令、非编辑工具、失败调用（保留列表呈现但不参与重放）。
- **验证**：`tests/fileEdits.test.ts` 11 例（提取双形态/命令归一/新建迭代/存量断链/覆盖链完整/失败跳过/失配计数/多文件/diff 形态）；`webui/tests/clients-file-edits-sidebar.test.ts` 2 例（选区注册 + 意图通道）；相关回归 44 例全绿；tsc + vue-tsc 干净；webui:build 通过。

### Fixed（rail 直点串宽：preview 半屏被 tasks 沿用——宽度形态单源化到选区 def）
- **根因**：`auxWidth` 全局共享，rail 直点（togglePanel → openAux）不重整宽度——用户点过 preview（铺半屏 596/916）后再点「任务·目标」，tasks 直接沿用了 preview 的铺开值。「用户已调宽」与「意图铺开值」在同一变量里无法区分。
- **修复（宽度形态单源化）**：`AuxSidebarPanelDef` 新增 `comfyWidth` 字段（`number` 固定宽 / `'half'` 半屏 / 缺省 = 窄面板 280）——宽度形态是选区固有属性，声明住注册处（preview='half'、usage=840、其余缺省）；uiStore 新增 `applyAuxPanelWidth(panelId)` 按声明统一解析；**壳 togglePanel（rail 直点）与全部意图消费宿主（6 个 Host）统一切到此函数**。`sendAuxIntent` 不再携带宽度参数（意图只指选区）；`applyAuxIntentWidth`/`USAGE_COMFY_WIDTH` 常量/`auxIntentWidth` 字段一并清除。
- **语义**：切换选区 = 按目标选区形态铺开（窄面板 280 / 半屏 / 840）；同选区内收起再展开沿用用户手调宽；手动拖调只在切走时被重整。
- **验证**：aux-yield 更新意图宽度锚（无声明/未知选区回 280）；usage/preview 意图断言走 def 声明仍绿；webui 全量 379 例通过；tsc + vue-tsc 干净；dist 重建（applyAuxPanelWidth/comfyWidth 编入、旧 API 无残留）。

### Changed（无舒适宽选区改默认宽展开：平分策略退役 → 统一 280 缺省宽）
- **改动**：prompt/tasks/timers/tracking/workspace/群信息等无专属舒适宽的选区，展开宽度从「平分主区」改为**缺省宽 280**（与双击把手还原值同源）——窄面板形态更舒服、主区保留最大空间；rail 直点（openAux）也不再平分。
- **意图宽度语义简化**：`applyAuxIntentWidth(null)` = 直接回缺省 280（此前仅在从未调过时平分）；携舒适宽的 preview（半屏）/usage（840）不变。用户普通拖调后收起再展开仍沿用已调宽（普通展开不重置）；意图切选区时按该选区目标形态重整（窄面板选区回 280、图表/预览选区铺开）。
- **验证**：aux-yield 重写 2 例（默认宽展开/沿用 + 意图宽度策略）共 10 例全绿；webui 全量 379 例通过；tsc + vue-tsc 干净；dist 重建。

### Changed（System Prompt 双入口图标统一 + 辅助活动栏按钮重排序）
- **图标统一**：会话头按钮（原 `file-text` 泛文档象形）与 aux rail（原 `file-code` 错用代码文件象形）统一为 **`scroll-text` 卷轴文书**——System Prompt 本质是 Agent 的行为准则文书，卷轴是设定/指令的经典隐喻；与文件预览 tab 的 file-text 拉开区分。新图标注册（webui-kit iconMap）。
- **rail 重排序**（按使用频率 + 功能聚类，order 重排）：
  ```
  10 文件预览（最高频参考）→ 15 Token 用量（高频监视）→ 20 运行跟踪（中频监视）
  → 25 任务·目标 → 30 定时任务（低频）→ 35 System Prompt（低频参考）
  → 40 工作区（兜底，常驻组末位）→ 45 群聊信息（上下文触发组——available 有活跃群才露出，出现时不打乱常驻组）
  ```
  group 从原 order 10 移到 45：它是唯一条件露出的按钮，放最下不打扰常驻序列。
- **验证**：vue-tsc + tsc 干净；相关面 18 例全绿；dist 重建（scroll-text 双入口 + 新 order 编入）。

### Changed（prompt 面板头部标题整型：Agent 名并入标题行——粗体 + 间隔点分隔）
- **改动（两轮迭代）**：灰字区分度不足 → 试 pill 徽章（观感怪）→ 最终 = **同粗体一行以间隔点连接**——`System Prompt · 风栗`（两段均 600 字重、同字号，间隔点用三级灰弱化只做分隔；整行 baseline 对齐、超长截断）。未选中 Agent 时显示「System Prompt · 未选择」。
- **验证**：vue-tsc 干净；dist 重建（新标题样式编入、pill 无残留）。

### Fixed（prompt 双入口行为差异消除：Panel 目标解析实时自算——与会话头同源）
- **差异根因**：会话头按钮 `requestSystemPrompt(agentId)` 精准目标 + agentName 快照；aux Panel 兜底走无参请求（`activeAgent()` 群视角 null → 静默不发起）+ 标题依赖按钮快照（rail 直开时空/旧值）。
- **修复**：Panel 目标解析改为**实时自算**（与会话头 `headerAgentId` 同款：single 承载 Agent 优先〔元数据 agentId + defaultPresetId 兜底〕→ 活跃 1v1 Agent）——标题实时、请求带 agentId（single 视角 sessionId 装配同源）；目标切换（会话切换）自动清空重取（旧 Agent prompt 不残留）；群视角显示明确提示态（不再静默空态）；刷新按钮无目标时禁用。
- **双入口定位**（保留理由）：会话头按钮 = 上下文动作（当前会话直达）；rail = 通用面板（任意时刻查看/复制）。两入口现在行为同源（同目标解析），仅入口位置不同。
- **验证**：vue-tsc 干净；webui + conversation 393 例全绿；dist 重建（实时解析 + 群提示编入）。

### Changed（入口冗余清理：主活动栏 tracking 按钮移除 + settings sys.timer 节撤——单一入口原则）
- **tracking 按钮**：主活动栏（左）运行跟踪按钮移除——辅助活动栏（右）tracking rail 已是唯一入口（左右各一是冗余）；ActivityBar/Host 的 emit/prop 链清理；主侧边栏彻底回归纯导航（agents/sessions 两面板）。窄屏入口 = 辅助活动栏同按钮（aux 栏窄屏仍在场）。
- **settings sys.timer 节撤**：与 aux timers 选区同组件（GlobalTimerHost）纯冗余——定时任务唯一入口 = aux timers 选区。`/timer` 快捷命令改走 `ui.openTimers()`（新增动作：`sendAuxIntent('timers')` 直达选区），不再打开设置面板。
- **冗余排查结论（全景）**：主活动栏其余按钮（头像/agents/sessions/主题/插件动作/设置/更多）与右栏无重叠；settings 其余节（llm-pool/search-pool/plugin-registry/agents 设置）无 aux 对应——均不冗余，保留。
- **验证**：vue-tsc + tsc 干净；webui 全量 374 例全绿（clients-timer 重写为「sys.timer 节缺席」回归锚）；dist 重建（openTimers 编入、tracking 按钮与 sys.timer 注册无残留）。

### Added（aux 生态 A 类五连：A1-A5 全量落地——辅助侧边栏 8 选区生态 + 通用意图通道 + 持久化）
- **A4 持久化**：aux 选区（`agentchat.auxPanel`）与宽度（`agentchat.auxWidth`）写 localStorage——刷新恢复上次选区与分屏比例；展开状态不持久化（保守——避免刷新后突然被占半屏，一键重开）。宽度恢复带合法性钳制（无效值回落默认 280）。
- **A1 prompt 选区**（conversation 行）：会话头 System Prompt 按钮宽屏直达侧栏对照阅读（窄屏维持 Modal）；内容/加载/错误与 modal 同源 chatStore；rail 图标 `file-code`；当选兜底请求补 rail 直开场景。
- **A2 tasks 选区**（conversation 行）：TodoPanel + GoalBar 聚合一屏纵览——当前活跃会话（1v1/single）任务清单 + 长期目标；事件帧驱动刷新（todo write/goal 工具 + loop 收束）；群视角提示态（todo/goal 桶无群形态）。
- **A3 timers 选区**（timer 行）：Agent 定时器（TimerPane 复用 + timer/entries RPC 读写 + 防串台）+ 全局定时任务（GlobalTimerHost 复用）一屏纵览；「到点要发生什么」从设置第三层提到一键可达；rail 图标 `alarm-clock`（新注册）。
- **A5 tracking 选区**（runview 行）：运行跟踪自主侧边栏第三面板迁辅助侧边栏——主侧边栏回归纯导航（agents/sessions），监视类全归右栏；组件复用 RunTrackingPanel（数据/轮询/跳转不变）；活动栏 tracking 按钮改 `auxOpenTracking`（宽屏直达选区 + aux 当选高亮；窄屏回落抽屉面板页）；primary-sidebar:domain 贡献保留（窄屏 + 旧值兜底）；order 9（group 之前——最高频监视面）。
- **通用意图通道（C1 收敛）**：`previewIntent`/`usageIntent` 双轨合并为单一 `auxIntent`（seq + panel id + 可选舒适宽）——`sendAuxIntent(panel, comfyWidth?)` 一处定义；消费宿主（各选区常驻组件）watch 按 panel 分派。**宽度策略**：意图携带选区专属舒适宽——preview 半屏（代码对照需横向空间）、usage 840（图表看全）、prompt/tasks/timers/tracking 不携宽（沿用用户已调宽或初次平分主区）；`applyAuxIntentWidth` 统一钳制应用 + 持久化。
- **验证**：vue-tsc + tsc 干净；webui 全量 374 例（失败断言随意图通道收敛更新，关键面 29/29 全绿）；dist 重建（8 选区/通用意图/双持久化均编入）。

### Changed（durable-interaction jsonl 一周保留期清理：append-only 无限增长修正）
- **sweep（store 层）**：`JsonlDurableInteractionStore` 新增 `sweep()`——按保留期删除过期终态记录（answered/closed，`updatedAt <= now - retentionMs`）并把文件原子折叠为每 id 一行（tmp 写入 + fsync + rename，Windows 兼容先删旧名）。**pending 永不清理**（write-ahead 恢复源）；干净文件（无删除且无冗余行）构造时跳过重写——启动路径只读。构造时自动清一次积压（后端重启即收敛历史文件）。
- **懒触发（service 层）**：写口（open/reply/close）后挂一次性 60s 定时器触发 sweep，摊平密集 ask_questions 轮次（一次折叠 N 次写入）；空闲零定时器（`pnpm dev` 自退前提），dispose 收定时器。
- **配置**：`retentionMs` 缺省 7 天（604_800_000）；`null` = 显式关闭清理（纯 append-only 行为不变）；`sweepDelayMs` 缺省 60s。memory 后端无 sweep 面（返回 0）。
- **验证**：新增 13 例（过期删除/pending 保护/边界 cutoff/多代折叠/未配置只折叠/空投影清文件/干净文件不重写/服务面懒 sweep + 立即档/显式关闭/裸行缺省冒烟/memory 0/崩溃安全重载/dispose 收定时器），包内 25 例 + ac-security 23 例 + webui 重启恢复 e2e 全绿；root tsc 通过。

### Changed（usage panel 默认进「用量统计」+ 分界线单源化：面板自带边框退役，双线消除）
- **默认页签**：panel 形态初始 `activeTab = 'daily'`（用量统计双柱图填满侧栏高度——弦图是正方形 viewBox，侧栏窄高比下上下留白大）；modal 形态维持总览默认。panel 内页签选择常驻保留（切走再回不重置），modal 每次打开回总览不变。
- **双线消除**：主/辅侧边栏各面板自带的边缘边框退役——分界线**单源**于布局骨架 `ResizeHandle` 细线（分界属布局不属面板，VSCode 同款职责划分；面板边框与 handle 线并排曾呈两条线）。移除：AgentList/SessionList/RunTrackingPanel 的 `border-right`，WorkspaceTree/GroupDrawer/FilePreviewPanel 的 `border-left`（WorkspaceTree 窄屏覆盖态保留——独立覆盖层无 handle 在场，需自描边）。
- **验证**：vue-tsc 干净；usage/layout/workspace 10 例通过；dist 重建（三面板根样式无边框确认编入）。

### Fixed（动态 chunk 加载失败误判 entry 崩溃 → 永久退位：主栏「再也看不到」真根因修复）
- **事故链（用户捕获报错锚定）**：`webui:build` 重建 → chunk hash 全变 → 旧页面挂着的 `defineAsyncComponent` loader 请求旧 URL → 404（`TypeError: Failed to fetch dynamically imported module`）→ `EntryErrorBoundary` 捕获 → `reportEntryError` → **abdicate 永久退位** → 出厂条目（layout 注册的 PrimarySidebarHost）永不重注册 → 主栏永久空白（「让位后展开只有占位」事故的完整根因——此前只归因到 stale bundle，未追到退位层）。
- **修复（双层）**：① runtime `reportEntryError` 识别资源性 import 失败（Chrome/Firefox 标准措辞）——**不退位**（warn 放行，条目保留席位，下次渲染重试）；② `main.ts` 挂全局 error 监听：chunk 失败弹原生 confirm「页面资源已更新，点击确定刷新」（原生控件——不依赖可能同样加载失败的组件库；仅提示一次）。真实代码崩溃（非资源性错误）退位语义不变。
- **验证**：新增 `chunk-load-error.test.ts` 3 例（Chrome 措辞豁免/Firefox 措辞豁免/真实崩溃仍退位）；runtime 21 例全绿；tsc + vue-tsc 干净；dist 重建（runtime 豁免逻辑 + main chunk 兜底均编入）。

### Changed（aux 初次展开平分主区：缺省 280 → 主区可用宽一半）
- **平分展开**：`openAux`（含 `toggleAux` 展开路径）检测 auxWidth 仍为缺省值（280——从未拖过/未铺开过）时，取 `(视口 - 88 双活动栏 - 主栏若在场) / 2` 为初始宽（钳 `[MIN_AUX, maxAux()]`）——初次展开即是主区与辅助侧边栏均分的分屏形态，而非挤在边上的窄条。
- **尊重已调状态**：拖过或意图铺开过（宽度非缺省）的展开沿用当前宽，不再重复平分；双击把手仍还原 DEFAULT_AUX（还原后下次展开重新平分）。主栏让位收起后再展开平分时扣除主栏（份额更大）。
- **验证**：aux-yield 新增 2 例（平分/沿用语义 + 让位态扣主栏平分）共 10 例全绿；tsc + vue-tsc 干净；dist 重建。

### Changed（拖拽分界线细化：4px 实条 → 1px 细线，热区不变）
- **视觉降噪**：`ResizeHandle` 从 4px 实底色条改为**热区/视觉分离**——4px 热区保持（拖拽命中最优），视觉由 `::before` 渲染 1px 居中细线（`--color-border-secondary` 弱灰）；hover/拖动细线加亮为主题色并加宽到 2px。三区（主侧边栏/主区/辅助侧边栏）之间的分界不再抢注意力。
- **验证**：vue-tsc 干净；dist 重建（::before 细线样式编入）。

### Changed（aux 面板头部高度对齐会话头：三区顶部齐线，减少视觉割裂）
- **统一头部高度**：辅助侧边栏三个选区的头部统一为 `--layout-header-height`（48px，与主区会话头同源）+ `padding: 0 16px`（与 ConversationView chat-header 同款内距）——usage 面板头（原 padding 7px）、文件预览 tab 条（原 34px 定高）、群聊信息头（原 padding 10px）全部对齐；workspace 树此前已对齐。三区（主侧边栏列表头 / 会话头 / aux 面板头）顶部齐线，底部边框连成一条水平线。
- **验证**：vue-tsc 干净；usage/preview 11 例通过；dist 重建（三处 `--layout-header-height` 均编入）。

### Changed（usage panel「用量统计」页签双图化：总用量 + 按模型同屏上下排布）
- **双图布局**（panel 形态）：原单图 + 缓存/模型切换按钮改为**上下两图各占半高**——上图「总用量」（缓存→未缓存→输出堆叠），下图「按模型」（模型序列堆叠，top 7 + 其他归并）；各带标题小行（主标题 + 弱化副题），侧栏高度下两图一次看全，无需切换。
- **图表构造参数化**：`makeBarChart()` 单构造函数双图共用（canvas/数据/mode/tooltip 各持）；`buildChartDatasets` 加 mode 参数（panel 双图各持固定视角，modal 单图沿用 usageViewMode 切换不变）；tooltip 渲染抽 `renderChartTipAt(tipEl, args)`（双图各持独立 tip 元素，定位/翻转逻辑同源）。
- **modal 形态零变化**：单图 + 缓存/模型切换按钮原样（modelChartCanvas 不在 DOM 自然跳过）。
- **验证**：vue-tsc + tsc 干净；usage 相关 4 例通过；dist 重建（modelChartCanvas/tup-chart-block/makeBarChart 均编入）。

### Changed（区域分界线常显 + usage 面板顶部布局侧栏化重排）
- **分界线**：`ResizeHandle`（主区 ⇄ 侧边栏把手）从 3px 透明改为 4px 常显弱边界线（`--color-border`，VSCode 同款弱分隔）——主区与主侧边栏/辅助侧边栏有稳定视觉分界；hover/拖动仍主题色高亮。
- **usage 面板重排**（panel 形态，适应侧栏窄宽）：
  - 页签条吸顶一行、**两格均分**（总览/用量统计，下划线激活态——替代旧 pill 按钮组）；
  - 工具行：日期筛选下拉占满剩余宽 + 覆盖区间尾随（`2026-09-01~12-01` 紧凑格式）；
  - 摘要改为**统计卡条**（命中/输出/请求/步数四项，标签弱化 + 数值加重，圆角卡片容器，超宽自动换行）；
  - 头部：标题 + 更新时间（右对齐收缩）+ 刷新按钮。
- **验证**：vue-tsc + tsc 干净；usage/aux-yield/preview 19 例全绿；dist 重建（tup-toolbar/统计卡/均分页签 CSS 与 4px 常显把手均编入）。

### Fixed（usage 选区三连修：面板空白（加载永不触发）+ 入口迁辅助活动栏 + 点击铺开舒适宽）
- **空白根因**：panel 形态 `visible` 恒 true（挂载即激活），`watch(visible)` 无 `immediate` → 回调永不触发 → `loadData` 不跑 → `data=null` 且 `loading=false` → 模板三分支（loading/error/data）全不命中 = 白屏。修：watch 加 `{ immediate: true }`（modal 形态初始 false 走 else 分支无副作用）。
- **入口迁移**：活动栏（左栏底部）「Token 用量」按钮移除——统一入口 = 辅助活动栏（右栏）`chart-pie` rail 按钮（选区自带，P2 已注册）；窄屏 Modal 入口经同按钮的宽窄分派维持。ActivityBar/ActivityBarHost 的 openTokenUsage emit 链一并清理。
- **点击铺开舒适宽**：意图消费时 `auxWidth = max(480, min(840, 视口-88-320))`——图表一次看全（840 经验值，小屏自动回落主区保底）；用户随后可拖调（双击把手还原默认 280）。

### Added（P2 辅助侧边栏「Token 用量」选区：监视常驻——活动栏入口宽屏直达侧栏面板）
- **新选区 `usage`**（usage 行注册，aux 第四选区）：宽屏活动栏「Token 用量」点击不再弹 Modal，而是切到辅助侧边栏的常驻用量面板（`variant='panel'` 上下布局：筛选/摘要/页签横排 + 图表填满剩余）；窄屏（≤768）维持 Modal 弹窗。rail 按钮 `chart-pie`（新注册图标）恒可见，二次点击收起区域。
- **状态保留**：`keepAlive: true`——图表/筛选/页签跨选区让位不丢（v-show 常驻）；panel 形态不重置 activeTab（切走再回保持上次视图）。
- **意图通道**：`openTokenUsage` 宽屏写 `usageIntent`（seq 计数）→ `TokenUsageHost`（overlay 常驻组件）watch 消费 → 显式选区 `'usage'` + 展开 aux。**踩坑锚**：意图 watch 不能住行插件（插件级 `watch` 绑死建立时的 active pinia 实例——测试换 pinia 后意图失效），须住常驻组件 setup（app pinia 同实例；同 FilePreviewHost 模式）。
- **组件复用**：`TokenUsage.vue` 加 `variant` prop 双形态（modal 原样 / panel 新增），数据逻辑/图表/chart.js 配置单一源；chart.js `responsive:true` + 弦图 viewBox 等比缩放天然适配侧栏宽度变化。
- **验证**：tsc + vue-tsc 干净；新增 `clients-usage-sidebar.test.ts` 3 例（选区注册/keepAlive/意图消费挂载路径/窄屏 Modal 分派）+ 相关面 23 例全绿；dist 重建（usageIntent/选区条目/panel 形态/chart-pie 均编入）。

### Fixed（代码视图重构为行式布局：wrap 态行号恒与代码对齐 + 展开主栏的 aux 护距）
- **行号跟随（wrap 态）**：原双列布局（行号列/代码列各自 flex）在自动换行开启后，长行折成多视觉行而行号列只按逻辑行排——行号整体漂移。重构为**行式布局**：每行 = `[行号][代码]` 同格（`fpt-code-row`），折行行高自然增长、行号钉行首恒对齐；nowrap 态行号 `position: sticky` 跟随横滚视口左缘（长行滚动行号可见，带底色遮盖穿行代码）。
- **按行高亮切分**（`splitHighlightedHtml`）：hljs 输出整体 v-html 改为按行独立渲染——跨行 `<span>`（块注释/模板串）行尾闭合、行首重开，颜色跨行无损延续且每行是平衡 HTML；纯文本快路径直切。
- **展开主栏的 aux 护距**（`shrinkAuxForPrimary`）：让位期 aux 常停在 70% 上限，用户展开主栏时 primary + aux 总宽可溢出视口（aux 被推出屏幕/主区压没）——`togglePrimary`/`openPrimaryPanel` 展开路径先收缩 aux 至 `视口-88-320-primary`（保 `MIN_AUX` 下限）。
- **排查注记**：用户报「让位后展开主栏占位空白（260px 空条无列表）」后复现不了——定位为 stale bundle（webui:build 重建后未刷新页面：旧 chunk 的异步组件 loader 指向已失效文件名 → 加载失败恒注释占位）。刷新即恢复；护距修复为排查中锚定的真实缺陷一并落地。
- **验证**：vue-tsc + tsc 干净；preview-tabs 8 例（新增 splitHighlightedHtml 跨行标签平衡锚）+ aux-yield 8 例（新增护距收缩锚）全绿；dist 重建（sticky/pre-wrap/fpt-code-row CSS + split 逻辑均编入）。

### Added（goal dock 卡直编面：目标编辑 / 暂停恢复 / 删除——hover 操作区 + 二段式确认）
- **hover 操作区**：GoalBar 条带悬停露出三钮（暂停/恢复 · 编辑 · 删除；触屏 `@media (hover:none)` 恒可见），常驻占位透明待命防条带宽度跳变；写面 props（agentId/conversationId/rpc）缺任一退化为只读形态（无操作钮，历史只读位姿不变）。
- **暂停/恢复**：active/blocked → paused 停轮；paused → active 恢复（服务端清 autoPausedReason 自动暂停标记）。单钮图标随状态切换（pause/play）。
- **编辑弹窗**（ui/Modal 统一外壳）：目标文本 / 备注（空串=清除，域语义）/ 轮次预算（1-200，行内提示已跑轮次与上限自动暂停语义）三字段，打开即取当前值、聚焦目标框；Enter 直提。
- **删除**：危险操作二段式确认（展示目标原文 + 「不入历史、自动推进停止、不可恢复」警示）→ `goal/delete`（桶回无目标态，goal-round 驱动停止）。
- **写面链路**：写经 `goalApi.updateGoal/deleteGoal` → RPC `goal/update`·`goal/delete`（与 Agent goal 工具同一 GoalsService 写口，最终一致）；落定 emit changed → GoalDockCard → `useGoalTracking.refresh` 对账（直编不经 Agent 工具，tool/after-execute 帧不触发——写后主动拉）。rpc error 不静默：条带级失败行内 danger 呈现，弹窗内失败留窗可改可重试。
- **验证**：新增 `webui/tests/goal-bar-edit.test.ts` 5 例（操作区三态/暂停恢复写链/编辑 patch 提交/删除确认与失败呈现/条带级行内错误）；goal 域测试 39 例全绿（goal-bar-edit 5 + goal-tracking 10 + clients-goal 2 + ac-goal 17 + goal-row 5）；root tsc + vue-tsc 干净；dist 重建（操作区/双弹窗/错误反馈均编入）。

### Added（文件预览 pane 头新增：自动换行开关 + markdown 渲染/源码切换）
- **自动换行**：pane 头「换行」按钮（代码类视图显示）——开启后 `pre-wrap` 折行（关闭横滚与行号列，长行内折），per-tab 记忆（`PreviewTab.wrap`）。
- **markdown 渲染 ⇄ 源码**：`.md` 文件 pane 头新增「渲染/源码」切换——默认渲染视图，一键看原始文本（源码态走高亮代码视图 + 行号，与普通代码文件同款）；per-tab 记忆（`viewMode: 'auto' | 'source'`）。
- **状态机**：`previewTabs` store 增 `toggleWrap`/`setViewMode`（写回 tab 对象，tab 间互不牵连）；pane props 透传 + 回调写回（pane 无 tab 写权）。
- **验证**：vue-tsc 干净；preview-tabs 7 例（新增 per-tab 偏好隔离断言）通过；dist 重建（toggleWrap/viewMode/pre-wrap CSS 均编入）。

### Fixed（文件预览行号与代码行错位：空行塌陷 + 两列字号不一 + 尾部换行多一行）
- **根因（三因叠加）**：① 行号列 flex 布局中空行 `<span>` 无内容高度塌 0——每遇空行后续行号上移累积错位（主因）；② 行号列与代码列字号不一（pane 11 vs 12 / Modal 12 vs 13），每行行高差 1.6px 逐步漂移；③ 源码以 `\n` 结尾时 `split` 产生尾部空串——行号列比代码多渲染一行。
- **修复**：空行行号以 `\u00A0`（nbsp）占位（pane/Modal 双形态）；行号列改与代码列同字号同字族（pane 12px / Modal 13px，`line-height: 1.6` 一致）；`codeLines` 滤除尾部空行（`filePreviewContent.ts` composable 单一源，双形态同享）。行号列加 `aria-hidden`。
- **验证**：vue-tsc 干净；preview-tabs 测试 6 例（新增 split 语义回归锚）通过；dist 重建（两形态 nbsp 占位均编入）。

### Changed（辅助侧边栏宽度上限提至视口 70% + 超宽自动让位收起主侧边栏）
- **上限 40% → 70%**：`maxAux()` 动态上限 = `min(视口×70%, 视口-88-320)`——70% 为主额（2560 屏 1792px），第二项保主区 ≥ 320px 软下限（1360px 以下视口自动回落，如 1280 屏实际 872px/68%）；窄屏维持静态 480。
- **超宽让位**：aux 拖过视口 30%（`AUX_YIELD_RATIO`）→ 主侧边栏自动收起（半屏预览/监视时主栏是空间冗余）。**只收不展**：拖回窄宽不自动展开主栏——恢复走用户显式动作（活动栏图标点击展开，`togglePrimary`/`openPrimaryPanel` 均复位 `primaryYielded` 让位标志）。窄屏（≤768 抽屉形态）不适用。
- **验证**：新增 `aux-yield.test.ts` 7 例（阈值收起/只收不展/显式展开复位/阈内不动/窄屏豁免/70% 钳制/大屏 70% 全额）；tsc + vue-tsc 干净；layout/preview/workspace 相关测试全绿；dist 重建（`innerWidth*.7` + 主区保底钳制 + `.3` 阈 + `primaryYielded` 均编入）。

### Added（P1 辅助侧边栏「文件预览」选区：多 tab 并行预览——树/消息点文件不再全屏弹窗）
- **多 tab 面板**（新选区 `preview`，workspace 行注册）：辅助侧边栏第三选区——tab 条（文件名 + × 单关 + 全部关闭）+ 多 pane 并存（v-show 保活，切 tab 不丢滚动）；同路径去重复用、超 8 个 LRU 淘汰最旧非激活 tab；关闭激活 tab 相邻让位、全关自动收起区域；收起面板不清 tab（辅助活动栏按钮重开恢复）。
- **意图通道**（layout 壳零域依赖）：`ui.openPreview` 宽屏（>768）写 `previewIntent`（seq 计数）——workspace 行 `FilePreviewHost` watch 意图 → 开 tab + 显式选区 `'preview'` + 展开 aux；窄屏维持原 Modal 全屏形态（行为零变化）。树点击与消息内文件链路均经此通道，自动获得新形态。
- **内容逻辑单一源**：`filePreviewContent.ts` composable 抽出（类型分派/高亮/Markdown/图片/SVG data URL/fallback 候选路径），Modal 与 pane 双消费；pane 按需取数（首次激活才请求），`previewTabs` 状态住 pinia（选区卸载不丢）。
- **空 tab 按钮隐藏**：`available()` = 有 tab 才露出辅助活动栏按钮（域态驱动，壳零域知识）。
- **验证**：vue-tsc + 根 tsc 干净；新增 `clients-preview-tabs.test.ts` 5 例（选区注册/意图通道宽窄分派/LRU 淘汰/激活让位/收起恢复）+ 既有 workspace/layout/conversation 测试 24 例全绿；dist 重建（previewTabs/previewIntent/选区条目/面板组件均编入）。

### Changed（侧边栏拖动条交互增强：双击还原默认宽度 + 辅助侧边栏拖动上限提至视口 40%）
- **双击还原**：`ResizeHandle` 新增 `@dblclick` → `ui.resetWidth(kind)`——双击任一拖动把手即还原默认宽度（主侧边栏 260 / 辅助侧边栏 280，与初始缺省同源常量 `DEFAULT_PRIMARY`/`DEFAULT_AUX`）；把手加 title 提示「拖动调整宽度，双击还原默认」。双击路径带 `Math.min(default, maxWidth)` 钳制，窄屏下不会把主区挤没。
- **辅助侧边栏更宽**：拖动上限从静态 `MAX_AUX=480` 改为动态 `maxAux()` = 宽屏（>768）`max(480, 视口×40%)`（2560 屏可拉到 1024px，原 480 只占 19%）；窄屏维持 480。
- **主区限制排查结论**：主区（`.main-area`/`.main-view-pane`）为 `flex:1 + min-width:0`——只被压缩、不产生布局挤压，**不限制辅助侧边栏拖动**；唯一约束即上述 JS 上限。推算验证：40% 上限时主区剩余宽度 1280 屏 420px / 1920 屏 804px（均 ≥ MIN_CHAT=320），主区可读性保底仍成立。
- **验证**：根 tsc + vue-tsc 干净；layout/sidebar/workspace/group 包测试 10 例通过；dist 重建并 build:bundle（产物确认 `innerWidth*.4` 动态上限、`onDblclick→resetWidth`、title 文案均编入）。

### Fixed（bash 前台 close 悬挂卡死：命令派生持有管道的后代进程 → 工具永挂、run 卡死、前端"得刷新才恢复"）
- **现象（用户偶然触发）**：工具调用超时后前端无法继续流式输出、须刷新页面恢复。链路排查排除传输层（WS 心跳/重连、RPC 超时只 reject promise、web-server RPC 异常只回错误帧均不断连接）——真因是 run 卡死导致流式帧停止，非 WS 中断。
- **根因（本机复现锚定）**：`ac-shell-tools` 前台 bash 收束依赖 `child.on('close')`，而 close = 进程退出 **且 stdio 管道全关**。命令派生的后代进程（`Start-Process`/dev server/watch 等继承 stdout 管道写端）在直接子进程退出后仍持有管道 → close 永不触发；超时/中断触发的 `killProcessTree`（Windows `taskkill /F /T` 按父子链杀树）对脱离父链的孙进程漏杀 → 管道仍被持有，树杀后 close 依旧不来（复现脚本两阶段实证：exit 已到、close 不来；树杀后仍不来）。工具 Promise 永挂 → `mapLimit` 挂起 → run 永不收束 → 会话串行化门不释放、前端 streaming 永真（watchdog 把未闭合工具行算在途不回落）。触发条件苛刻（须命令派生继承管道且活过命令本身的后代）——"偶然"的由来。
- **修复（ac-shell-tools 前台路径）**：收束逻辑重写为统一 `settle`（幂等）+ `finish` 分离——新增 `child.on('exit')` 起跳 `CLOSE_FALLBACK_MS`（2500ms）宽限计时，close 正常到达则即时收束（原语义零变化）；宽限期内 close 不来 = 管道被活后代持有 → 销毁本端 stdout/stderr 读端强制收束（输出已随 exit 收齐；孙进程后续写已关管道得 EPIPE 自灭）。`error` 路径同经 settle 兜底。
- **测试**：`shell-tools.test.ts` 新增回归锚——孙进程（`Start-Process node -NoNewWindow`，8s 自杀）持有管道场景下工具 3.6s 内正常返回（300ms 命令 + 2500ms 宽限的签名耗时），exit_code 0、输出完整；既有超时/signal/后台 job 13 例不变全绿（shell-tools 14/14、agent-loop 43/43、根 tsc 干净）。

### Changed（工具卡旋转环改琥珀：全前端"忙"指示同色同款——工具卡/思考卡/链栏三环统一）
- **动机（2026-12 选型迭代）**：链栏统一后用户决定取消"思考琥珀/执行靛蓝"的颜色分治，全部统一为琥珀。
- **改动**：`ToolMessage.vue` 的 `tool-spin-ring` 边色 `--color-primary` → `--color-warning`（StatusDot 的 thinking/running 双色分治属工坊组件语义，不受影响）；三组件注释同步改为"同色同款统一"表述。
- **验证**：vue-tsc + clients-conversation/clients-tool-cards 11 例通过；dist 重建（产物三环同为 warning 琥珀）。

### Changed（链栏 chain-header 活动指示统一为行首旋转环：尾部琥珀三点 dots 退役）
- **动机（2026-12 选型延续）**：用户确认工具卡/思考卡旋转环落地后，要求链栏（chain-header）的执行中指示（label 尾部琥珀三点 dots）同步换为行首运动环，全局统一。
- **改动（TurnDisplayItem.vue 两处 header）**：
  - 可折叠 header（思维链展开形态）：链活动中且非 hover → 行首脑电波图标让位琥珀旋转环（`chain-spin-ring`，与 `think-spin-ring` 同款构造同色——链级语义"Agent 正在忙"，思考是链活动主要形态）；hover 仍显示折叠箭头；尾部 dots 移除；
  - 静态 header（思维链隐藏模式，唯一活动指示）：图标位直接换环（无折叠语义、无 hover 箭头）；
  - `chain-spin-ring` 同步加入 `prefers-reduced-motion` 豁免清单（main.css）——避免重蹈上一条"reduce 下环静止"的坑；旧 `streaming-dots`/`dot-pulse` 样式删除。
- **验证**：vue-tsc + clients-conversation 6 例通过；dist 重建（chain-spin-ring 样式与 keyframes 编入、旧 dots 无残留、豁免清单含新环）。

### Fixed（旋转环在「减少动画」偏好下静止：prefers-reduced-motion 豁免清单未含新环——运动即语义的功能指示被压成 0.01ms）
- **现象（2026-12 反馈）**：工具运行时黄色小圈不转动（用户机器开系统级减少动画——浏览器报 `prefers-reduced-motion: reduce`）。
- **根因**：`main.css` 的 reduce 规则把全部动画压至 0.01ms，豁免清单（`.run-spin`/`.ring-spin`/`.dot`/`.loading-dot`——功能性状态指示"运动即语义"）未包含本轮新增的 `tool-spin-ring`/`think-spin-ring`——环静止后与"卡死"不可区分，恰是该豁免机制的存在理由（2026-09-04 反馈同病：chain-header dots 静止）。
- **修复**：两个环类名加入豁免 `:not()` 链。另澄清：用户看到的"黄色"环是思考环（琥珀 `--color-warning`）；工具执行环为靛蓝（`--color-primary`）——颜色分治即设计（思考/执行两种"忙"经颜色区分）。
- **验证**：dist 重建（main.css 产物豁免链含两个环类名）。

### Fixed（思维链内每条消息前冒出机器人图标：AssistantMessage 头像恒渲染 + bot 兜底——链内调用方从不传头像）
- **现象（2026-12 反馈）**：思维链中的思考卡片、链内口述正文、最终回复前面都多出一个 32px 机器人图标。
- **根因（404 探测修复的连带回归，未提交工作区改动）**：此前修"预设 Agent 每条消息打一发注定 404 的头像探测请求"时，把 `AssistantMessage.vue` 头像块从 `v-if="senderAvatar"`（有 URL 才渲染）改成**无条件渲染 + `fallback-icon="bot"`**。但思维链内部的调用方（TurnDisplayItem 的思考卡/链内口述/final 回复）**从不传** `senderAvatar`/`senderName`——旧版正好靠"不传就不渲染"工作；恒渲染后 Avatar 兜底链生效（无图无字 → bot 图标），每条链内消息前都多一个图标。轮级头部（turn-avatar）不受影响（那是设计内的恒渲染）。
- **修复**：`v-if="senderAvatar || senderName"`——显式传了才渲染：链内不传 → 无头像位（旧版行为）；纯文本轮传名 → bot 占位保留；头像真挂（URL 失效）仍由 Avatar 内部回退 bot（404 修复的两层语义都不倒退）。
- **验证**：vue-tsc + clients-conversation/tool-label 11 例通过；dist 重建（产物 `key:0` 条件分支形态确认编入）。

### Changed（工具卡/思考卡运行中指示换旋转环：行首图标位 spinner——颜色分治思考琥珀/工具靛蓝）
- **动机（2026-12 选型）**：上一条修复让 running 态可见后，用户对 7 种候选样式预览选型「样式 2：旋转环替换行首工具图标」，并要求思考卡片同步同款。
- **改动**：
  - `ToolMessage.vue`：运行中（isRunning）且非 hover → 行首工具图标位换靛蓝旋转环（`--color-primary`，StatusDot running 同色系）；尾部黄灰三点波浪移除（单一指示不重复）。hover 仍显示折叠箭头（交互优先不丢）；
  - `AssistantMessage.vue`：思考相位（isThinkingLive = 流式中且思考文本在场）且非 hover → 行首涟漪图标换琥珀旋转环（`--color-warning`，StatusDot thinking 同色系）；
  - 颜色语义分治：思考=琥珀 / 工具执行=靛蓝——两种「忙」经颜色即可区分（此前 dots 思考/工具同为琥珀系混色）；
  - 链栏（TurnDisplayItem）的 streaming-dots 是整链级活动指示（非项级），保持不动；
  - 环尺寸 13px + 0.5px 边距对齐 14px 图标位，无布局跳动。
- **验证**：vue-tsc + webui 全量 336 例通过；dist 重建（ConversationView CSS 产物含 `spin-ring`/`thinkSpin`，JS 产物含类名绑定）。
- **关联**：样式预览页留档 `workspace/tool-running-styles-preview.html`。

### Fixed（工具 running 态不可见：参数生成阶段纯静默 + 快工具终态同帧吞掉转圈——「只有工具执行完才出现」）
- **现象（2026-12 前端反馈）**：前端似乎不存在工具消息的 running 等待状态，观感上只有工具执行完才会出现，怀疑是 step 执行太快。
- **根因（可见窗口双重收窄，机制本身存在）**：链路核对（ws-bridge → feed-core → buildTurns → ToolMessage.vue）确认 running 态机制完整，但两处把可见窗口压没了：
  - ① **参数生成阶段不建卡**：`llm/delta` 工具分片（模型流式生成参数，通常数秒——一个 step 的大头）此前只累积进 `StreamState.tools`，等 `delta-end` 才建占位（2026-09 修同名并行错位时的收紧行为）。思考已闭合、正文常空 → 界面纯静默；
  - ② **快工具终态同帧提交**：本地工具（read/glob/math 等）执行毫秒级，`delta-end` → `tool/after-execute` 几乎同批到达，Vue 同一渲染批次提交「建占位 + 写终态」——首帧 paint 出来就是已完成，running dots 在 paint 层面从未存在（用户"太快"的直觉对这部分成立）。
- **修复（两件）**：
  - **参数阶段占位**：首个工具分片（id+name 完整，幻影冲洗片除外）到达即建 preparing 占位卡（`prepareToolCall`，按 index 去重防重放叠卡），label「正在调用工具: X」；`delta-end` 按 preparing 标记 + name 精确配对升级为真 `tool_call_id`（占位行按 prep- 原始 id 精确查找吸收——顺带修掉了升级路径 `lastStreaming` 位置匹配在并行占位下漏升级的隐患）；`onToolStart`/`onToolEnd`/`onToolUpdate` 全链路不变，仍按 tool_call_id 精确归属；
  - **最短转圈（TOOL_MIN_SPIN_MS=300ms）**：`onToolEnd` 数据立即落（content/running/result 即写），仅视觉关停（isStreaming）延迟至占位建立后满 300ms——快工具的 dots 至少可见一瞬。边界事件（after-step 步终值全量替换 / after-run 收束重拉 / 中断 / chat-error / WS 重连）强制 `flushSpinHolds` 收口，不破坏既有「步终即关」「收束即重拉」时序；deadline 一致性核对防重放误关。
- **验证**：新增 `tool-running-visibility.test.ts` 6 例（参数阶段占位可见 + index 去重 + delta-end 升级、并行同名双占位不串位、快工具数据即落 dots 延迟 300ms 关停、慢工具无延迟、边界事件强制 flush、幻影分片不建卡）；`feed-parallel-tools` 适配新语义（X 终值数据即归属、视觉 300ms 后关停——fake timers 驱动）；webui 全量 336 例 + root tsc + vue-tsc + ac-app e2e/chat 7 例全绿。
- **关联**：旧 `onToolcallStart`（无调用方的 preview 词表死代码）一并删除。

### Fixed（Agent 主动发消息（send_agent 等）后点进会话只见该条、历史要刷新才回来：direct 历史 watch 缺 immediate——视角重挂载丢"已就位"选中态）
- **现象（2026-09-12 前端反馈）**：Agent 经 send_agent 等主动向用户发消息，用户点开该会话只能看到这条主动消息，之前的历史全部不可见，刷新页面才恢复。
- **根因（视角重挂载丢变化）**：入站私信本身是健康的——`router/message-received` 帧经 `showInbound` 实时推入 `pair:user|agent` 分区并点亮未读，这正是用户看到的那一条。断点在历史装载：M28 会话区重构后主区是 keyed 选举席（single/group ↔ talk 互切 = ConversationView **整体重挂载**），而用户通常先停在独立会话/群视角再点 Agent——`roster.activeAgentId` 在点击时刻赋值，早于 talk 视角的 ConversationView 挂载；direct 形态的历史装载 watch（`watch(() => roster.activeAgentId.value, …)`）**缺 `immediate: true`**，挂载时选中值已就位、不再是"变化"，watch 不触发 → `loadHistory` 从未发出，分区停留在实时推入的单条入站消息。同文件的 single watch（`props.single?.id`）重构时就带了 immediate，唯独 direct 漏掉。刷新恢复走 `onAgentListResponse → tryRestoreLastAgent → loadHistory` 另一条链，所以刷新能救回——与反馈完全吻合。group watch 缺 immediate 同病（挂载时 group_id 已就位则群历史不加载），一并修复。
- **修复**：`ConversationView.vue` direct watch 补 `{ immediate: true }`；group watch 同步补上（挂载即按当前 group_id 加载）。重复 `loadHistory` 无害——feed 的 requestId 时序守卫（`_historyReq`）丢弃在途旧请求的迟到响应，不产生错误合并。
- **验证**：webui vue-tsc 通过；`singles-reopen` / `clients-conversation` / `portb-e2e` 回归 3 文件 13 例全绿；dist 重建（`ConversationView` 产物验证 `activeAgentId` watch 带 `immediate:!0` 已编入）。

### Added（会话提权水位：机制唤醒统一继承权限——"发起会话时就记录当前 run 的权限"）
- **动机（2026-09-12 用户设计反馈）**：重启后 late-reply 唤醒的 run 丢权限逐工具审批只是个案——**所有机制唤醒（job 完成回投 / 定时器触发 / late-reply / 插件回执回触 / 归档整理）全部丢**：用户快捷提权是 run 级、随消息不持久。单点修 late-reply 是打补丁，应上升到会话级权限记忆。
- **设计（水位 = conv-settings 新键 `elevation`）**：**用户 run 开跑时（deliver 边界）记录当前提权档位**到会话设置（`<root>/conv-settings/<conversationId>.json`，持久化重启不丢）；**机制唤醒（`source='event'` 信封）未显式带档位时自动继承水位**。deliver 边界单点实现——全部唤醒源一处生效，无需逐行改。
- **语义细则**：
  - 水位跟随用户最新选择：用户武装 → 记档；收起快捷提权 → 清水位（下次唤醒不再继承）；
  - 继承降档：水位 full-access 按 sandbox 继承（机制唤醒不放行 full——防伪造不变量；恢复的是"沙箱内自由+白名单写免审批"，越沙箱敏感操作仍走审批=正确行为）。实现要点：直接传 full 会被 `sanitizeElevation` 剥成空（event 上限是【剥除非降级】），必须先降档再进 sanitize；
  - 显式档位优先：唤醒源自带 elevation 时不吃水位；agent 信封（send_agent）恒不继承——Agent 面够不到提权；
  - Agent 自有 tags 档位底座不变：继承的水位不高于 Agent 自有档位时剥除（不降级执行）；单次审批（ac-security approval）不写水位——它是"本次调用"授权非会话级武装；
  - conv-settings 行未装/写失败 → 尽力而为静默（组合可选惯例，不影响投递）。
- **修复中的回归**：effOptions 构造重构时一度把"剥除=显式覆盖 undefined"变成"保留原值"（agent 信封剥除/低档剥除 3 例老用例红了）——已修正并注释钉死语义。
- **验证**：`ac-conversation` 新增「会话提权水位」describe 3 例（写水位→事件唤醒继承（full 降档 sandbox）→用户收起清水位→不再继承；显式优先+agent 不继承；底座剥除不变）+ conv-settings 文件持久化断言；`ac-conv-settings` elevation 键读写/清除；全机制行回归（conversation/durable-interaction/security/job-wakeup/timer/goal）118 例 + root tsc + check-deps R1-R7 通过。
- **关联**：上一轮的 payload.elevation 留痕保留（诊断价值），late-reply 回投不再单独透传（走水位——防双路径漂移）。

### Fixed（late-reply 唤醒 run 未继承原会话提权：重启后逐工具手工审批疲劳）
- **现象（2026-09-12 反馈）**：重启后经 late-reply 唤醒的会话（如 `__standard__` 空会话预设 = base 档）不继承原 run 的提权档位——每个 `needPermission` 工具（bash/write 等）都触发询问提权审批，用户被迫逐个手工批准。
- **根因**：ask_questions 的交互记录不存原 run 的 `call.elevation`（用户输入框快捷提权是 run 级、随消息不持久）；late-reply 回投的 `deliver` 也没传 elevation——`sanitizeElevation(event, undefined)` = 剥除 → 新 run 以 base 档执行。
- **修复（留痕 + 透传）**：① 工具 open 时把 `call.elevation` 存进 `payload.elevation`（落盘随记录持久，重启不丢）；② late-reply 回投时读取留痕并透传 `elevation`。**安全边界不变**：`deliver` 边界 `sanitizeElevation` 对 `source='event'` 信封上限 `sandbox-access`——机制唤醒不放行 full（防伪造不变量），原 full 提权降级为 sandbox 恢复：沙箱内自由 + 白名单路径写免审批（消解绝大部分审批疲劳），越沙箱的敏感操作仍走审批（正确行为）。
- **验证**：`durable-interaction.test.ts` 新增「提权档位留痕与恢复」（open 留痕 full-access / 无提权不留 / 回投透传 sandbox——event 上限裁剪后档位）12 例全绿；root tsc + ac-security 23 例 + e2e 回归通过。

### Fixed（InteractionBar 挂载崩溃：恢复路径下 watch 缺 immediate → drafts 恒空 → 渲染崩溃 → slot 永久退位——"弹窗不出现"的最终根因）
- **现象（2026-09-12 反馈第三轮，控制台实锤）**：`[slots] entry 崩溃退位：conversation:dock-widget#interaction TypeError: Cannot read properties of undefined (reading 'custom') at InteractionBar`——弹窗崩溃后被 slot 错误边界**永久退位**，此后所有提问都不再显示，只能重启后端。
- **根因（时序竞态）**：dock 卡是 `defineAsyncComponent` 异步挂载；【刷新恢复路径】下挂载完成时 `chatStore.interaction` 已非空（`interaction/list` 恢复先到），而初始化 `drafts` 的 `watch(interaction)` **缺 `immediate: true`**——watch 不触发、drafts 恒空数组，模板 `v-model="drafts[index]!.custom"`（非空断言直读）读 `undefined.custom` 崩溃。live 路径（挂载早于提问）不触发，因此该 bug 只在「刷新后/恢复后」的第一次渲染爆发——与用户反馈"一刷新就无法继续回答"完全吻合；退位后新提问也全被吞（slot 注册仍在但渲染崩溃）。
- **修复（双保险）**：① watch 加 `immediate: true`（挂载即同步 drafts——主修复）；② 模板去非空断言改受控写回（`:value="drafts[index]?.custom ?? ''"` + `onCustomInput(e)` 事件写回——即使未来再出现空草稿竞态也只是输入框静默，不再崩溃退位）。
- **验证**：新增 `interaction-mount-crash.test.ts`（SSR 渲染挂载时 interaction 已就位——**反向验证抓到旧代码精确复现用户控制台的 TypeError**；修复后绿）；真浏览器 Playwright e2e（新 dist：live 弹窗 → 作答 → run 收束）绿；webui 全量 64 文件 330 例 + root tsc 通过；dist 重建（`InteractionBar` 产物验证 `immediate:!0` 已编入、崩溃形态清零）。
- **关联**（同日四层修复链，本条为最终根因）：① durable-interaction jsonl 持久化；② late-reply 唤醒；③ 作答可靠投递；④ **本条挂载崩溃**——①②③修的是数据链，④修的是渲染链；四层叠加才是用户看到的全貌。

### Fixed（ask_questions 作答静默丢失：断连窗口 fire-and-forget——"答了没反应/刷新后无法继续/连弹窗都不出现"的共同根因）
- **现象（2026-09-12 反馈两轮）**：Single 会话 Agent 提问后刷新无法继续作答；后续 even live 弹窗也不出现，只能重启后端续会话。数据根取证：`interactions.jsonl` 残留 4 条 pending（含已被用户口头回答的）——**用户的作答从未到达后端**。
- **根因（`respondInteraction` 的 fire-and-forget 投递）**：`rpc.call('interaction/reply').catch(() => undefined)` + **提交即出列**——ws 断连/后端重启的窗口期（dev 下改代码重启、vite 代理闪断、system/restarting）内作答 RPC reject 被吞、弹窗已关、后端 pending 永久残留。三现象同源：作答丢失 → Agent 永久等待 → 「答了没反应」；刷新恢复的正是这条死 pending → 「无法继续回答」；重连窗口期 opened 帧丢失 + 恢复链 timing → 「弹窗不出现」。
- **修复（可靠投递）**：成功才出列——`interaction/reply` 失败时按 1.5s 间隔重试（后端 reply 幂等，duplicate 语义，重试无副作用），约 30s（20 次）仍不通则提示「回答未送达（连接不可用），请稍后重新提交」且**弹窗保留**（作答入口不失联）。`replied` 帧到达（别处已答）仍即时出列，无双弹窗。
- **验证**：`interaction-restore.test.ts` 新增「断连窗口作答不丢」（前两投失败 → 弹窗保留 → 第三投成功出列，三次投递同 id 同答案的幂等重试钉）；`interaction-live-popup.test.ts` 新增 Playwright 真浏览器 e2e（真 dist + live 弹窗出现 → 作答 → run 收束——锁定渲染链无恙，问题只在投递）。webui 63 文件 328 例 + e2e 40 例 + root tsc 通过；dist 已重建（`chat-core` 产物验证含重试逻辑）。
- **关联**（同日早前修复，本条为第三层）：① durable-interaction 缺省 jsonl 落盘（重启丢 pending）；② late-reply 唤醒（run 已死时作答回投重开 run）；③ 本条（作答投递自身的断连可靠性）。

### Fixed（Single 会话 ask_questions 后端重启后无法继续回复：durable-interaction 持久化缺失 + late-reply 唤醒缺位）
- **现象（2026-09-12 反馈）**：Single 会话中 Agent 调 `ask_questions` 发起提问，刷新页面后无法继续回复。用户环境为 0.8.5+ 且**后端重启过**（重开桌面端）。
- **排查**：前端恢复链（`interaction/list` → `pendingInteractions` 列表 → 会话键路由 → InteractionBar 重挂）经全链路 e2e 验证完好；真正的断点在后端——生产装配（`src/cordis.yml` / ac-app TREE）的 `durable-interaction` 行是裸行（无 config），而 `DurableInteractionService.createStore` 的旧缺省是 `memory` 后端：**号称 durable 的挂起交互实际根本不持久化**，后端重启 → 内存清空 → `interaction/list` 返回空 → 前端刷新后弹窗无从恢复（`timeout_ms=0` 永久等待的 Agent run 也已死于重启，双杀）。
- **修复 ①（缺省翻转）**：`createStore` 缺省改走 **jsonl** 落盘（`<root ?? AGENTCHAT_DATA_ROOT ?? './data'>/interactions.jsonl`，与 ac-session 等持久化行惯例对齐——生产裸行即持久化；torn tail 忽略 + last-write-wins 折叠的崩溃恢复本就在 store 实现）；显式 `backend:'memory'` 才走内存（嵌入式/单测隔离）。config 注释同步。
- **修复 ②（late-reply 唤醒）**：注释里声称的"工具超时后收到的回答由宿主以 sender:'event' 信封重新唤醒 Agent"在新架构里从未落地——run 死于重启/中断后，步级部分行残留在会话流、工具永不回填，用户即使作答也无人消费。补齐：`ac-durable-interaction` 行订阅 `durable-interaction/replied`，ask_questions 记录 answered 且该会话**无活跃 run**（`conversation.listRunning` 探测；run 活着则工具自身的事件驱动半边会拿到答案，不回投防双消费）时，经 `conversation.deliver` 以 `sender:'event'` 信封回投答案通知（问题清单 + 用户答案逐条列出），新 run 醒来基于历史 partial 行 + 通知文本继续任务。conversation 行未装 = 无唤醒（组合可选惯例，作答仍落记录）。
- **验证**：`ac-durable-interaction` 新增 4 例（裸行缺省落盘 / 同根重构恢复 / run 已死回投 sender:event 形态 / run 活跃不回投防双消费）；`webui/tests/singles-ask-questions-refresh.test.ts` 新增全链路 e2e 4 例（绑定 Agent 挂起→前端刷新→作答→run 续跑收束；空会话 `__standard__` 同场景；**后端重启（dispose 全 fiber + 同 dataRoot 重 boot）→ pending 持久恢复 → 作答 → late-reply 唤醒新 run 收束文本落盘**；**多条提问并发（同 run 两个 ask_questions）+ 纯前端刷新 → 逐条恢复逐条作答接棒**——列表降序最新先显，答一条 replied 按 id 出列下一条接棒）。root tsc + check-deps R1-R7 + webui 63 文件 326 例通过。
- **产物同步（2026-09-12 追记）**：首轮修复只改了源码未重建发布 bundle——`dist/agentchat.mjs` 仍是旧逻辑（`backend === "jsonl"` 才落盘，缺省 memory），运行打包版的用户命中"刷新即丢"。已 `build:bundle` 重建，产物内 `createStore` 验证为新缺省（memory 显式声明才走内存）。

### Added（输入栏组合偏好持久化：新开会话保持上次选择）
- **动机**（用户反馈）：新开会话时输入栏四项选择（Agent/预设〔模式〕· 模型 · 思考强度〔推理等级〕· 快捷提权〔权限〕）全部回落缺省值——用户每次都要重选一遍。
- **composePrefs 小件**（`ac-client-ui-conversation/client/composePrefs.ts`）：localStorage 单键 `agentchat.composePrefs` 记录四项最后选定值（与 lastContext 同款裁决：唯一读写方 ChatInput + 新建消费方 SessionList，均已有依赖面；结构化类型访问不引 DOM lib；损坏/无 localStorage 面 → 静默无偏好）。合法关闭态 `''`（思考关/未武装）与「未记录」区分——回放时保持而非回落缺省。
- **ChatInput.vue**：思考强度/快捷提权初值回放记录值（无记录保持原缺省 high/`''`；原「视角切换重挂载回到默认」改为回到上次选择——与提权「持续生效直到手动改回」的既有语义对齐）；四项选择函数各写回对应键。
- **SessionList.vue 新建透传**：新建会话时把上次 Agent/模型作为 `singles/create` 参数（服务端已有校验：Agent 不存在/虚拟、provider 未注册即抛错）；校验失败回退空会话创建（过期偏好不阻断新建）。无 Agent/模型偏好时保持原路径（顶部 reuse 复用空白会话语义不动）。effort/elevation 不属会话元数据，由 ChatInput 挂载回放。
- **测试**：`ac-client-ui-conversation/tests/compose-prefs.test.ts` 5 例（无记录 null / 键级合并写 / 关闭态可记录 / wire 宽容〔非法档位与未知键忽略、损坏 JSON → null、空串不记录〕/ 半记录形态）；root tsc + webui vue-tsc + conversation/singles 两行测试 + webui 侧 conversation/singles/port-b 测试面全通过。

### Fixed（在途 run 的空白新会话被 purgeEmpty 误删：别处新建会话后运行中会话消失且事后无记录）
- **现象（2026-12 反馈）**：Single 新会话（未选 Agent 的空白形态）发出首条消息正在运行时，在其他工作区「+」新建会话 → 运行中的会话从列表消失，运行结束后也看不到任何记录（元数据与消息流双双丢失）。
- **根因（两级误判叠加）**：① `SinglesService.hasMessages` 以 ac-session `stats()` 的**文件口径**判"有无消息"——首条用户消息 `router/message-received` 入账后只进内存写队列（设计上 message-received 不触发落盘，首次 flush 在 tool/before-execute checkpoint 或收束行），纯文本首 run 全程文件口径恒 0；② `isEmpty` 又不看会话是否在跑。空白新会话（agentId ''，运行时路由默认预设）因此在首 run 进行中被判"空白"，而前端工作区节点「+」走 `singles/create`（带 workspaceId、无 reuse）→ 后端 `create()` 先 `purgeEmpty()` 清理"遗留空白" → 把在跑会话**连元数据带消息流硬删**（`remove()` = rmSync 元数据目录 + `session.clear()` 连在途队列一起作废）。run 照常跑完，但记录已无家可归——列表不再显示、事后也找不回。顶部「新增」（reuse 路径）同判据缺陷：会复用（劫持）在跑会话而非新建。
- **修复**：ac-session 新增只读在途判读口 `hasPending(conversationId)`（写队列非空即真——不 flush 不建队，与 stats/tail 同口径）；ac-singles `hasMessages` 计入在途（顺带使"已有消息锁 Agent"在首 run 进行中即生效——在途首条消息与路由身份绑定，本就该锁）；`isEmpty` 增加在跑守卫——conversation 串行化门在册（`listRunning()` 含该 conversationId）即非空白，覆盖 event 触发（无用户消息）的 run；行未装 fail-open 放行（可选能力惯例）。
- **验证**：ac-singles 新增全链路复现例（挂起 provider 制造"正在运行"窗口：窗口期内其他工作区 create / 顶部 reuse 双路径断言在跑会话存活，放行收束后消息落盘在账）；root `tsc --noEmit` + 全量 vitest 218 文件 1659 例通过。conversation 探测按可选能力姿势防御式调用（`listRunning?.()`——脚本桩无 run 簿记面时 fail-open 放行，行未装同语义）。

### Changed（工作区「选择文件夹」改用系统原生对话框：自研下钻弹窗降级为兜底）
- **动机**（用户反馈）：新增工作区的「选择」弹出的是自研 `EntryPickerModal` 小弹窗（快捷根 → 逐层下钻，480px 列表），不如系统文件浏览器好用——不能搜索、不能贴地址栏路径、无收藏夹。
- **方案裁决（为什么不是浏览器原生）**：`<input webkitdirectory>` / File System Access `showDirectoryPicker()` 都不暴露所选目录的本机绝对路径（浏览器安全模型），而工作区登记需要真实绝对路径（沙箱白名单根）——不可行。宿主 Node 与浏览器同机（本地桌面形态），由服务端唤起系统对话框是唯一拿到绝对路径的路径。仓库早期的 `POST /api/browse/folder`（XP 树形观感修复时代）已在重构中退役，本轮以 workspace 域 RPC 重新落地。
- **后端（纯模块 `ac-workspace/src/native-dialog.ts`）**：win32 = `powershell.exe -EncodedCommand`（UTF-16LE base64 单 argv，免引号/转义/stdin 语义差异）内嵌 C# interop：`IFileDialog` + `FOS_PICKFOLDERS|FOS_FORCEFILESYSTEM`（Vista+ 现代选择器——地址栏/搜索/收藏夹与资源管理器同款）；Add-Type 编译失败或 Pick 抛异常时 catch 回退 `FolderBrowserDialog` 保功能；**用户取消（Show 非 0 → null，非异常）不触发回退——杜绝"取消后又弹一个框"**。标题经环境变量传入（Windows env 天然 Unicode），C# 源恒 ASCII（Add-Type 落临时 .cs 不吃编码差异），stdout 强制 UTF-8（中文路径回传不乱码）。darwin = `osascript choose folder`；linux = zenity → kdialog 候选链（前者 ENOENT 才试后者）。结果三态 `path/cancelled/error`；10 分钟超时兜底杀进程。
- **vtable 槽位序按 SDK 头文件实测校准**：首版凭记忆声明（`SetClientSite` 在前、`GetOptions` 在 `SetOptions` 前）整段错位——GetOptions 实际落到 Unadvise 槽返回 E_INVALIDARG（本机探针实测 OPTS=0 / HRG=0x80070057）。对照 `ShObjIdl_core.h` 真实序重排（SetFileTypes → SetFileTypeIndex → **GetFileTypeIndex → Advise → Unadvise** → SetOptions → GetOptions → … → SetFileName → GetFileName → SetTitle；IFileDialog 无 SetClientSite——文档词条易误导），重排后本机无弹窗探针全绿：GetOptions=0x1808（标准默认组合）、SetOptions 往返 0x1828（文件夹标志生效）、SetFileName/GetFileName 回读一致。
- **服务/RPC**：`WorkspaceService.pickFolder(title)`（薄委托）+ `workspace/pick-folder` RPC（长阻塞——等用户在系统对话框完成操作，服务端 10 分钟兜底）。
- **前端**：`fileApi.pickFolder`（长超时 10min+5s 与服务端兜底对齐——RPC 缺省 60s 会中途掐断）；`SessionList` 「选择」按钮改调原生对话框（进行中按钮防重入 + 「已打开系统文件夹选择对话框，请在系统弹窗中完成选择…」等待提示）；error（平台无选择器/启动失败/超时）自动降级回 `EntryPickerModal` 应用内浏览并点名原因；用户取消静默收场。`EntryPickerModal` 保留：file 模式消费方 `ExtensionSettingsModal` 不受影响 + dir 模式作降级兜底。
- **前台激活（DSH 同款 Alt 点击）+ 取消等待**：首版真机 UI 流仍不可见——Windows 拒绝后台宿主进程 spawn 的对话框抢前台（压在浏览器后面/只闪任务栏），用户等不到弹窗即判"没生效"。参照 DSH `dsh-host-directory-picker-native` 的成熟细节（其注释明言 "synthesizes an Alt press before Show, which matters when a background host spawned the child"）：Show 前合成一次 Alt 按下/释放（`keybd_event` VK_MENU）解除前台锁，对话框可靠置前（本机无弹窗探针验证：编译/槽位往返/注入路径全绿）。前端补「取消等待」恢复口（找不到弹窗时不必干等服务端超时——序号令牌丢弃晚到结果，系统弹窗挂到服务端 10 分钟超时自动关闭），等待提示补"查看任务栏/其他窗口后面"指引。
- **Fixed：`useClientContext()` 在事件处理器内调用恒 undefined——「选择」点击必落兜底自研弹窗（真机三轮"还是不行"的真正根因）**：`useClientContext` = Vue `inject()`，只能在 setup 期调用；首版把调用写进 `chooseWsFolder()` 点击处理器 → `rpc` 永远 undefined → 误判"无 RPC（孤立挂载）"直接打开自研弹窗。修复：setup 顶部一次性取 `rpcFace` 供处理器使用（组件内注释钉住该约束）。**验证升级**（前两轮只验了 RPC 链路、没验点击路径的教训）：Playwright(msedge) 驱动真实页面完整点击路径——「会话列表」→「新增工作区」→「选择」→ 断言等待提示出现 + `.entry-picker` 不弹出 + 「取消等待」恢复，PASS；此后面向 UI 的行为改动默认补该层验证。
- **Fixed：选定文件夹后路径不回写——GetFileName 在文件夹模式不带完整路径**：取结果原用 `GetFileName`（只读"文件名"编辑框文本，`FOS_PICKFOLDERS` 模式下它不是完整绝对路径，空值还会被归一成"用户取消"静默收场）。改走 DSH worker 同款标准路径：`GetResult()`（vtable 槽 20，接口声明延至 SetOkButtonLabel/SetFileNameLabel/GetResult）→ `IShellItem.GetDisplayName(SIGDN_FILESYSPATH=0x80058000)`（IShellItem IID `43826d1e-…`，GetDisplayName 槽 5——槽位/IID/常量均对照 `ShObjIdl_core.h` 核实，与 DSH 槽位表一致）。**双探针验证**：①无弹窗（`SHCreateItemFromParsingName` 直构 IShellItem → GetDisplayName）中文路径全字往返 `C:\…\Temp\探针目录-中文路径测试`（S_OK + UTF-8 无乱码）；②真弹窗实测选定文件夹返回完整绝对路径。测试加"路径回写回归钉"（Pick 体必须走 GetResult→GetDisplayName、禁用 `dlg.GetFileName(`）。
- **线程 DPI 感知（真机 150% 缩放屏弹窗字体发虚）**：powershell.exe 不声明 DPI 感知——高缩放屏上对话框按 96 DPI 渲染再位图拉伸，文字模糊。DSH 同款解法：`SetThreadDpiAwarenessContext` 级联（-4 per-monitor-v2 → -3 per-monitor → -2 system-aware，逐级回退；pre-1607 catch 容忍），`Pick()` 首位调用（先于线程上任何窗口创建，`FolderBrowserDialog` 回退路径同线程受益）。本机探针实测首选 `-4` 即被接受；与 DSH worker 的槽位表交叉验证（SetOptions=9/SetTitle=17）与本仓 SDK 头文件校准序一致。测试加 DPI 级联回归钉；C# 段 ASCII 不变量钉子当场抓住两处误入的 em-dash（防 Add-Type 临时 .cs 编码歧义的设计即此用）。
- **测试**：`src/ac-workspace/tests/native-dialog.test.ts` 16 例——脚本要素（COM GUID/FOS 常量/owner/`-STA`/UTF-8 输出/取消协议）、**vtable 槽位序回归钉**（错序即红）、**前台激活回归钉**（Alt 点击恰在 Show 前）、**DPI 级联回归钉**、取消不双弹门控（`$failed` 而非判空）、here-string 闭标记行首、C# 段 ASCII 不变量、平台命令矩阵（osascript 标题转义/zenity→kdialog 链/不支持平台）、输出分类（四族 path/cancelled/error）、真进程注入编排（选定/取消/ENOENT 候选链/超时杀进程）。ac-workspace 29 例 + ac-web-api 61 例 + root tsc + webui vue-tsc + webui build + 全量 vitest 通过。

### Changed（插件边界评估修复：解唯一运行时环 + 凭据行去 LLM 化 + 环检测进 CI）
- **依据**：admin《AgentChat 插件边界质量与独立性评估报告》（2026-09-05，总评 A-）六项改进建议全量落地。
- **🔴 解环 ac-session⇄ac-group（全仓唯一运行时环）**：`isGroupHint`/`GROUP_HINT_META`（原 ac-group）与 `maxSeqOf`（原 ac-session）下沉新纯库 **ac-core-utils**——收录判据：只收随 owning 行导出会成【运行时环/反向依赖】的最小词汇，域词汇仍归 owning 包（防 grab-bag 化）。五方消费（session/group/conversation/ws-bridge/archive）改经公共层；session 与 group 自此互相零 import（协作只经 ctx.get 服务面 + D11 跨域读写口），停 ac-group 不再连锁炸 ac-session 编译。顺带修复 ac-archive 运行时 import maxSeqOf 原只挂 devDependencies（workspace hoisting 隐式生效，违显式声明红线）。ac-core-utils 补 6 例（含 0 地板语义锁定）。
- **CI 环检测（构建期硬失败）**：`scripts/check-deps.mjs` 新增 **R5 包级运行时循环依赖**规则——TypeScript AST 精确分类运行时值导入（`import type`/全 type 具名导入不计；re-export/动态 import/副作用裸 import 计入），Tarjan SCC 检环（src/ 全工作区包，src/vendor 上游除外；type-only 互引是弱依赖不构成环）。publish.yml 原有 `check:deps` 门槛自动生效，desktop.yml 补同款步骤。故障注入验证：临时环包对 → R5 拦截 exit 1 → 清理 → 通过。
- **ac-credentials 摆脱 ac-llm（凭据行去能力域感知）**：LLM 凭据注入（`resolveLlmApiKey` + `llm/before-chat` 订阅）自 ac-credentials 迁 **ac-llm-pool**（新 `src/credentials.ts`）——凭据降为纯横切存储（src 零内部运行时依赖、不感知任何能力域），方向修正为 LLM 连接域感知凭据服务（`ctx.get` 可选能力，凭据行未装载 = 不注入，provider 构造层 env 兜底）。测试随迁并新增行卸载回收订阅例；注入语义不变（拦截链在路由之前，只补 api_key 传输头）。
- **ac-openai-completions 定位明示**：包头/描述明示「共享协议纯库，**非 provider/插件行**——provider 注册唯一入口 = ac-llm-pool 配置驱动（llmProviders 池），openai/deepseek/glm 适配薄行与池共用本库」（防被当 provider 误用；README 纯库清单同步）。
- **补测（两个被多包依赖零测试纯库 + 九个零测试薄壳）**：ac-text-budget 17 例（token 估算 CJK 0.6/其他 0.3·代理对边界三档·lone surrogate 替换·预算截取 markerMargin 退化）；ac-web-search-core 26 例（tavily/deepseek 请求形状与归一化·parseSourceSummaries/extractAnswer/mapAnthropicResponse 纯函数·serpapi/brave/duckduckgo 工厂；fetch 全 `vi.stubGlobal` 打桩零网络）；九薄壳 apply→注册面→执行→dispose→回收 生命周期冒烟（extension-core 2 / hello 3 / restart 4 / fs-search 5 / str-replace-editor 5 / plugin-gates 4 / webui-extensions 3 例）——78 包独立测试覆盖 88% → 100%。
- 事实源同步：src/README.md 纯库清单 + 布局图（ac-core-utils 新条目、ac-credentials/ac-llm-pool/ac-openai-completions 定位修正）。

### Changed（主输入卡浅影：双主题令牌化，深色底层次感回归）
- **动机**：会话主输入卡 `.chat-input` 的阴影硬编码 `0 1px 3px rgba(0,0,0,.05)`——白底（#fff 卡压 #fff 页）尚可辨，深色底（#1a1a1a 卡压 #1a1a1a 页）上等效不可见，输入区与消息流之间没有分离面。
- **webui-kit（tokens.css）**：新增 `--shadow-input` 令牌进阴影层，双层结构（贴边 contact + 环境光 soft）——aurora（亮）`0 1px 2px rgba(15,23,42,.06), 0 4px 12px rgba(15,23,42,.08)`；nebula（暗）`0 1px 2px rgba(0,0,0,.5), 0 4px 12px rgba(0,0,0,.55)`（深底上纯黑影必须提浓度才等效可见：#1a1a1a 约压到 #0d0d0d，观感对齐亮色 6-8% 灰调）。首版极浅贴边（1px/2px 单层）实测偏浅，按反馈扩为 4px/12px 柔光层。阴影自此单源，不再散落硬编码。
- **webui（ChatInput.vue）**：`.chat-input` 的 `box-shadow` 改引 `var(--shadow-input, 0 1px 2px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.08))`（带亮色双层 fallback，与 SettingField 同款惯例）；边框 / 圆角 / 内距不动，仅阴影一层——浮起可感不抢眼。
- **验证**：`pnpm webui:build` 通过（令牌与引用经构建解析）。
- 生效范围：dev（`pnpm webui`）热更即见；打包版随 `pnpm webui:build` 重建 dist（dist 为 gitignore 产物）。

## [0.8.5] - 2026-09-05

### Fixed（后端流式 OOM：llm/delta 帧全量载荷放大——2026-09-05 桌面端五连崩）
- **事故**：打包版会话历史 ~258k token 时连续五次 `→ loop` 后 40-75 秒内 OOM 崩溃（4GB old space 两次 Mark-Compact 零回收，exit 134；崩溃 run 已完成步的持久化又推大历史，形成连环）。开发环境从未触发——引爆需要 MB 级历史 × 失控长流（180s 无进展超时被持续 chunk 重置、永不刹车）× 慢消费端（Electron 渲染进程逐帧 parse 滞后 → TCP 背压）三条件同时成立。
- **根因**：ac-ws-bridge「事件目录即协议」镜像直转——`llm/delta-*` 帧以 chunk 频率携带完整 `input`（messages/tools 全量上下文，实测 ~1MB/帧 × 50-100 chunk/s），慢消费端把 ws 发送队列滞留成 4GB 活对象。`input.messages`/`tools` 自上线起前端零消费（feed 仅读 meta 兜位）。
- **修复（ac-ws-bridge）**：delta 帧载荷投影 `wireLlmInput`——只保留 `model` + `meta`，messages/tools 绝不进逐 chunk 帧（~1MB → ~200B，约 5000×）；进程内事件契约不变（ac-session/CLI 等仍见全量 input）；`llm/chat-error` 维持直转（频率有界，前端经 input.meta 路由）；后台会话过滤仍读原始 input，语义不变。
- **验证**：ws-bridge 新增 1 例（delta-start/delta/delta-end 三帧载荷瘦身 + messages/tools 不在帧——2026-09-05 OOM 回归锚）；ws-bridge 12/12 + webui-e2e 真链路 + root tsc 通过。

### Added（fatal 自动诊断报告：下次 OOM/abort 进程内自动留档）
- boot.ts 与 bootstrap.ts（dist 打包入口，桌面/npm 同一 bundle）内联启用 `process.report.reportOnFatalError` + `directory=<数据根>/reports`——等价 `NODE_OPTIONS=--report-on-fatalerror --diagnostic-dir`，无需桌面壳注入环境，packaged 与 dev 同权生效；报告由原生侧写出（JS/原生栈 + heap 统计），不占 JS 堆，常态零开销。下次 fatal 直接在数据根 `reports/` 留下可分析现场。

### Fixed（沙箱包含判定误伤同文件别名词形——绝对路径访问自己工作区被拦「连读都拦」）
- **现象（2026-11 反馈）**：Agent 汇报「相对路径可读写，绝对路径访问已被沙箱拦截（连读都拦）」——绝对路径指向的就是允许根内（自己工作区/挂载工作区）的文件，read/write/edit/bash 全被拒，相对路径却恒过。
- **根因**：包含判定是**大小写敏感的词法前缀匹配**（`t === r || t.startsWith(r + sep)`，paths.ts 与 bash-scan.ts 各写一份）。win32 文件系统大小写不敏感：同一文件的大小写变体（`C:\USERS\…` 与 `C:\Users\…`）、8.3 短名（`DOCUME~1`）、junction/符号链接词形全部词法失配——相对路径不含根前缀恒过、绝对路径因「拼写」被拦。且 Node 纯 JS `realpathSync` 不展开 8.3 短名，字符串身份比对同样失配。
- **修复（ac-sandbox-core）**：包含判定收敛为单一事实源——`isPathUnder`（词法快路径，大小写按平台惯例：win32 折叠，posix 保留；对齐 DSH dsh-fs-sandbox containment）+ `createRootsContainment`（词法失配时身份回退：目标最近存在祖先的 `realpathSync.native` 规范词形与各根 realpath 精确前缀比对，大小写/8.3/junction 一并收敛；write 新文件的缺失尾段保留拼接）。`createSandboxResolver` 与 `bashCommandViolation` 改用同源判定，fs-tools/fs-search/str-replace-editor/shell 行与 ac-security 复检经既有单一来源自动生效。强度不降：词法命中走 O(1) 快路径不触 fs；身份回退只可能**追加**放行（文件系统身份证明目标确在根内），根外目标（含大小写混淆、指向根外的别名）照拦。
- **拦截消息点名越界路径（2026-11 复盘）**：用户实录一条命令混根内 + 根外两个绝对路径——整条被拦正确（fail-closed），但消息只报盘符「（C:）」不报哪个路径越界，Agent 无从分辨、再次泛化「绝对路径都被拦」。三条拦截文案（盘符 / Unix 绝对路径 / `..` 引用）统一为「点名越界路径 + 仅这一个被拦 + 工作目录与白名单内绝对/相对路径均可正常使用」，与系统提示词 [路径规则] 行同口径；去掉「不要写盘符」这类强化误解的措辞。
- **全仓同款词法守卫清查（其余 fs 面）**：两处**硬闸门 + 模型/用户可控绝对路径输入**的同款问题改用同源 `createRootsContainment` 修复——①`ac-sap-adt` SapAdtFs.guard（快照/导出/abaplint 的子树守卫，模型可给绝对路径，大小写变体曾误报 escapes）；②`ac-workspace` resolveIn（tree/readFile/resolveFile 的 files 根守卫，raw 直链面收绝对路径）。清查确认无恙：ac-skill assertInside（白名单名拼在服务端规范根上，大小写不可能分叉）、ac-plugin-core readStagingFile（realpath 双侧归一，结构上安全）、ac-plugin-registry outOfRootWarning（仅建议性警告非闸门）、ac-webui addEntry（入口为插件自述相对路径，逃逸方向判定不受大小写影响）。ac-sap-adt / ac-workspace 补 `ac-sandbox-core` workspace 依赖（纯库零依赖）。
- **验证**：sandbox-core 新增 5 例（isPathUnder 旗标语义 / junction·symlink 别名放行·根外别名照拦·词法真越界不变 / win32 大小写变体放行·兄弟目录大小写混淆仍拦 / bash 扫描同源 / 混合命令消息点名越界路径且根内段单独放行）；sap-adt +1（别名词形放行·子树外与 ../ 照拒）、workspace +1（win32 大小写/junction 别名放行·../ 逃逸照拒）；本机复现 8.3（DOCUME~1）与全大写绝对路径由 DENY 转 OK、`C:/Windows/win.ini` 照拦、混合命令消息精确指向越界的 workspace/default；root tsc + 全量 vitest 139 文件 1305 例通过。

### Changed（QueueDock 排队卡风格对齐 dock 卡族 + dock 列统一纵向节奏）
- **动机**：QueueDock 与同族 dock 卡（TodoPanel/GoalBar/InteractionBar，均在 composer 上方）风格漂移：radius-md vs 族内 radius-lg、bg-subtle vs bg-secondary、10px vs 12px 横向内距、12px 行文 + border-top 分割线 vs 族内 13px 行文 + gap 分隔、表头单段 12px 文案 vs 族内「14px lead + 13px/500 标题 + 12px 摘要 + chevron」结构；且 dock 卡之间（TaskDock ↔ QueueDock ↔ InteractionBar ↔ 输入卡）无纵向间隔，多卡同现时边框贴边框。
- **webui（QueueDock）**：外壳/密度/表头/列表全面对齐 TodoPanel 同构形态——radius-lg 扁平卡 · bg-secondary · `queue-body`（gap 6px · padding 6px 12px）· 表头 = clock lead（14px）+「排队消息」标题（13px/500）+「n 条」计数摘要（12px tertiary，flex 吸收中段）+ chevron（14px，0.2s 旋转）；列表 gap 8px 无分割线、行文 13px、180px 上限滚动；行级动作钮对齐 InteractionBar（22px · radius-sm · dur-fast 过渡），插话警示色保留。单条直渲染行、多条默认收起等交互不变。
- **webui（dock 列纵向节奏）**：TaskDock / QueueDock / InteractionBar 根部统一 `margin-bottom: 6px`（与 `.task-dock` 内部 6px gap 同拍）——任意 dock 卡组合同现时卡间及与输入卡之间恒 6px 间隔，不再贴边。
- **验证**：webui vue-tsc + webui 测试 31 文件 214 例通过；前端 dist 重建。

### Fixed（Agent 运行中发送：排队消息同时出现在会话流导致渲染顺序错乱）
- **现象（2026-09-06 反馈）**：Agent 运行中发送消息，消息成功进入 next-run 队列（QueueDock 展示"n 条排队消息"），但用户气泡同时也立即出现在会话消息流里——插在在途回复中间，"既在队列又在会话流"双现，渲染顺序错乱。
- **根因**：webui chat store `sendMessage` 的忙态分流只改投递形态（busy → `lane:'next-turn'`），本地一律乐观 `feed.append` 用户气泡——排队消息没有"延迟上屏"语义。
- **webui（chat store）**：排队路径（`busyMode==='queue'`）本地不再上屏——消息唯一可见位是 QueueDock；改为在 feed 登记回显待补（键 = 剥离 `[附件]` 行的正文，计数制——同文多条排队各补各的）。插话路径（steer）保持本地立即上屏。
- **webui（feed store）**：新增 `showOwnEcho`——viewer 自己的 `router/message-received` 回显不再无条件跳过：后端消费队列（当前 run 结束后作为独立 run 经 router.send 投递）时按登记补气泡，位置恰在新 run 流式之前（消息从 dock "移入"会话流）；未登记但同文气泡在场（普通发送/重新推理/编辑本地已上屏）→ 跳过；无登记无在场（刷新后消费 / 别处 tab 同账号发送）→ 上屏兜底。正文与历史同规格（尾部 `[附件]` 行剥回 chips）。`appendOwnSteered`（QueueDock ⚡ 插话）同步回退登记并把 preview 剥附件行后上屏；排队投递失败 / dock 行删除同样回退登记（回显不再到来，防同文后续回显误补重复气泡）。
- **验证**：新增 `feed-queued-echo.test.ts` 7 例（排队不上屏+回显补气泡/同文计数/普通发送回显跳过/无登记兜底/附件剥离/插话回退/投递失败回退）；全量 vitest 139 文件 1298 例 + webui vue-tsc + root tsc 通过。

### Fixed（ask_questions 多 Agent 并发提问刷新后失去作答入口——全局单槽列表化）
- **现象（2026-09-06 反馈）**：多个 Agent 同时发起 ask_questions 后刷新页面，前端无法继续作答——除"全局最新"一条外全部 pending 提问永不可见；答完这一条后其余条目也永远弹不出来（后端 `timeout_ms=0` 永久等待 → Agent 卡死）。
- **根因**：webui chat store 的 ask_questions 交互是**全局单槽** `interactionState`——①刷新恢复 `interaction/list {state:'pending'}` 只取 `pending[0]`（全局最新一条）；②live 路径后到的 `durable-interaction/opened` 帧直接覆盖前一条（多 Agent 并发提问即丢）；③作答/别处已答只清空单槽，无机制拉取剩余 pending；④恢复到的"全局最新"若不是当前会话的，InteractionBar 按 agent 门控后当前会话永远弹不出来。
- **webui（chat-ops）**：`AskQuestionsUiState` 增加 `key`（record.key = 会话归属键）与 `created_at`（排序用），`pickAskQuestions` 提取（live 帧与恢复记录两形同源）。
- **webui（chat store）**：单槽 → `pendingInteractions` 列表（按 created_at 降序、按 interaction_id upsert）；`interaction` computed 按当前上下文会话键路由（pair = viewer 对桶 / single = sid 精确匹配，旧载荷无 key 回落 agent 匹配）——切到哪个会话答哪个会话的题，别家更新的提问不再占槽遮挡；`respondInteraction`/`dismissInteraction`/`replied`/`closed` 帧按 id 出列，同会话剩余 pending 自然接棒；重连恢复以快照为真源对账（发出时已在本地、快照没有的 = 离线期间已被答，剔除；恢复在途新到的 live 帧保留）。
- **验证**：新增 `interaction-restore.test.ts` 7 例（全量恢复+按会话路由/作答出列别家不受影响/live 多条共存/replied·closed 接棒/single 串台/旧载荷回落/重连对账）；webui 30 文件 207 例 + 全量 vitest 138 文件 1289 例 + webui vue-tsc + root tsc 通过。


---

# 历史版本归档

完整变更历史按 minor 线归档（主文件只保留最近两个版本——控制随包分发的体积与弹窗渲染量）：

- [CHANGELOG-0.8.md](./CHANGELOG/CHANGELOG-0.8.md)——0.8.0 ~ 0.8.4（M2x 系列）
- [CHANGELOG-0.7-and-older.md](./CHANGELOG/CHANGELOG-0.7-and-older.md)——0.1.0 ~ 0.7.1（早期）

