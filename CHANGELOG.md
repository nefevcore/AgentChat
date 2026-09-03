# Changelog

All notable changes to AgentChat are documented in this file.

---

## [Unreleased]

## [0.8.1] - 2026-09-03

### Fixed（发布包内置插件目录空白：生产 bundle 的插件目录/行偏好生产源落地）
- **现象**：`agentchat`（npm 包）启动后，WebUI 插件库「内置目录」为空（注记"仅开发形态可用"），扩展面板行无描述——内置插件的配置/停用开关全部不可用。根因：`plugin/catalog` 内置组靠**运行时扫描 `src/ac-*` 包源**、`plugin/rows` 行元数据靠 **node 解析包 package.json**——发布 bundle 无 src/无 node_modules，两条扫描面双空（M24 §四.7 预留的"生产源后裁"缩水点，随 0.8.0 首个生产 bundle 部署触发）。
- **生产源 = 构建期固化清单**：`build-bundle` 生成 `dist/plugin-catalog.json`（声明 `agentchat.plugin: true` 的行包 {name, version, description} + cordis.yml 全量行 id↔name 映射，含 disabled 行）；运行时三级回退（src 扫描 → 清单 → 空态注记）。新增纯库 `ac-plugin-core/catalog-manifest.ts`（解析 fail-soft / `AGENTCHAT_PLUGIN_MANIFEST` 显式指路 / 清单→目录条目纯映射），ac-web-api 与 ac-plugin-registry 共用。
- **接线三处**：①`plugin/catalog` 内置组 + entryId 映射（loader 缺席时从清单补——停用行 toggle 锚点回归）；②`plugin/rows` 行元数据（node 解析失败回退清单——origin=package + 描述/版本，不再整批 internal 出局）；③`enumerateDisablableEntryIds`（无 loader 时按清单行集枚举——`patch-reset(minimal)` 在发布形态可用）。装配状态/fibers 恒为运行时事实（registry 交叉），清单只答"有什么可装"。
- **setPatch/resetPatches 的 dist 语义**：发布形态（bootstrap 标记 `AGENTCHAT_BOOT_FORM=dist`）无 include 热通道，但 patch 由下次启动的 bootstrap 消费——如实返回 `written + restartRequired`（此前误报 `no-include-row`"偏好无消费者"）；未标记的程序化组合（测试直调 bootTree）维持原语义。
- **附带**：`scripts/diag-rpc.mjs` 输出上限可调（`DIAG_RPC_MAX`，默认 3000——全量目录诊断管道化）。
- **验证**：catalog-manifest 纯库 7 用例（解析 fail-soft/双 Map 去重/env 指路/纯映射交叉）+ dist-form 4 用例（清单枚举兜底/setPatch 双态/minimal 还原）+ plugin-catalog 清单兜底端到端 1 例 + bootstrap 形态标记断言；本地 `npm pack` + 临时目录安装冒烟全链路（plugin/catalog 56 行带元数据与 entryId → patch-set hello → 重启后 assembled=false 且锚点在，UI 可还原）；全量 1052/1052 + tsc 通过。

## [0.8.0] - 2026-09-03

### Changed（发布链复活：新轨生产 bundle 里程碑——npm 包 0.8.0 起新轨形态）
- **dist 直调入口 `src/ac-app/src/bootstrap.ts`**：发布包无 node_modules，Loader/yml 装配（boot.ts 仓库形态）在 dist 不可用——行表改走 ac-app **TREE 静态 import**（与 cordis.yml 由 tree.test「双表一致」守护锁定，esbuild 单文件 ~3.0MB 自包含）。与 boot.ts 语义逐条对齐：数据根锚定（INIT_CWD 回落 cwd → `AGENTCHAT_DATA_ROOT`）、行偏好层 `<dataRoot>/cordis.patch.yml` fail-soft 停用、单实例锁（**锚点从 trackDir 改为数据根**——dist 包目录可能只读，且双写者冲突的本源就是同数据根）、进程级兜底（unhandledRejection/uncaughtException 记日志不退出）、装载失败 exit 78（EXIT_CONFIG）、boot 末事件治理清扫。web-server 生产 config 由入口注入（yml 的 `./webui/dist` 是 src/ cwd 相对路径；dist 静态产物与 bundle 同目录）；`--port=N`/`--port N` 覆盖缺省 3830。
- **`bootTree` 增 `skip` 参数**：停用行不装配（与 loader 路径 include patches 的 disabled 语义等价）；hmr 行不在 TREE（loader 专属，bundle 无热重载——dev 请用仓库检出）。
- **脚本面整备**：`build:bundle` 重写（入口 bootstrap.ts；前端产物 `src/webui/dist` 即发布 dist 根；退役 cli.mjs/headless.mjs——旧轨 plugin/headless 表面无新轨对应物）；`build:frontend` filter 修正 `@agentchat/webui`→`ac-webui-app`（轨道切换漏改，CI 原会挂在第一步）；退役 `gen:bundle-rows` 生成器（行表单一事实源 = 手写 TREE + 双表一致测试）；`bin/agentchat.js` 简化（dist 单文件优先 / 仓库回退 tsx 跑 boot.ts = `pnpm dev` 同参）；package.json `files` 剔除已删除的 docs/tool-dev-guide.md。
- **验证**：bootstrap 新增 7 用例（--port 解析三态 / 全树装配 + web-server 监听 + 数据根锚定 / patch 停用行 / 未知行 fail-soft / 同根双开拒绝、异根不冲突）；本地 `npm pack` + 临时目录安装冒烟（`agentchat --port=3987`：WebUI 200 / API 404 JSON / 数据落启动目录 / 双实例 exit 78）；全量 1040/1040 + tsc + check:deps 通过。

### Changed（运行中发消息改 DSH 语义：排队优先 + 立即插话 + 纯停止按钮 + 排队 UI）
- **设计对齐 DSH**（busy 发送四件套，`session.prompt(mode: queue|steer)` / InputBar primaryStops / QueueDock 同款姿势）：
  - **运行中发送 → next-run 排队**：前端 sendMessage 在目标会话流式时不再**隐式打断**在途 run，改投 `lane:'next-turn'`（落盘排队，本轮结束后独立 run 投递）。
  - **着急可立即发送 → next-step 注入**：立即发送的点击位在 QueueDock 排队行的行级操作（输入框不设插话按钮——DSH 同款：steer 是队列行的 strict-steer 动作）；键盘手势对 = 忙态 Cmd/Ctrl+Enter（有草稿 = 插话发送草稿；空草稿 + 有排队 = FIFO 整队列插话，DSH placeholder.steerQueue 同款提示）。
  - **输入框主按钮退化为纯"停止"**：忙态 send 按钮变红色方停止键（危险操作视觉预告——点击即中止在途 run），不再有"打断并发送"复合语义——停止是它唯一的职责。
  - **排队 UI（QueueDock，DSH 样式）**：composer 上方 dock——队空隐藏、单条直渲染、多条折叠为「n 条排队消息」表头（可展开，180px 滚动上限，清空后恢复收起）；行 = 单行预览 + 插话（仅运行中可用）+ 删除。
- **后端（ac-conversation）**：QueuedTurn 增稳定 `id`/`queuedAt`（持久化兼容旧文件——回放补生成）；新增队列数据面 `queue()`（快照）/ `removeQueued()`（删除）/ `steerQueued()`（**严格 steering**：原子出队→注入活跃 run；窗口已关放回原位返回 `requeued`，DSH 收敛竞态不报失败不丢消息）；入队/消费/删除/插话/预算放回每次变更广播 **`conversation/queue-changed`**（emit，run 域；载荷 = 权威全量快照，排队 UI 唯一事实源）。
- **RPC（ac-web-api）**：`conversation/queue`·`queue-remove`·`queue-steer`（会话键与 deliver 同口径）；deliver busy ack 补 `agentId`（前端提示文案取名）。**ws-bridge**：转发 queue-changed 帧。
- **前端（webui）**：`useQueuedMessages` composable（会话切换拉取 + queue-changed 权威快照按桶套用，TaskDock 同款姿势；DialogView 持单一事实源，QueueDock 纯展示组件、ChatInput 只收计数/整队列插话回调）；ChatInput 忙态 = 红色停止键 + Cmd/Ctrl+Enter 手势对 + 忙态 placeholder 分流提示；插话成功本地上屏 user 气泡（steered 帧对 viewer 自身发送跳过）；busy ack 文案分流（queued=已排队 / steered=已插入当前运行）。
- 群聊输入（自定义 onSend）与 collab send_agent 的 busy=steer 缺省语义不变；后端 deliver 缺省 placement 仍 'steer'（程序化调用方不受影响，DSH 语义由前端显式选择）。
- 验证：ac-conversation 新增 4 用例（快照+事件 / 删除 / 忙时插话注入 / 空闲留队 requeued）；ac-web-api queue 三 RPC 转发；webui `queued-messages.test.ts`（按桶过滤/三态/空态）；event-catalog run 域清单 + 设置面板 scope 推断同步；全量 990/990 + tsc + vue-tsc 通过。

### Changed（UI 文案 emoji 全量清理 → 语义控件）
- **新增 `ui/FeedbackNotice` 语义反馈控件**：文案只承载文本，成功/失败/提示由 `tone`（ok/error/info）表达——图标（check-circle/alert-circle/info）与配色（success/error/中性）从 tone 派生；`variant: chip|inline` 两形态（浅底描边胶囊 / 裸图标文字）。
- **反馈状态语义化**：chat store 的 `busyFeedback`/`compressFeedback` 与 Sidebar 的 `backupMsg` 各配 `tone` 副状态（统一 setter 成对写）——DialogView 的 busy/compress 反馈、Sidebar 备份反馈改用 FeedbackNotice；**退役 `startsWith('✅')` 文案耦合判定**（compress-feedback--ok → tone 绑定）。
- **行内 emoji 标记换图标**：GoalBar 受阻/暂停标记（alert-circle/pause，新增 pause 图标）；RunTracking 覆盖面三段说明（check-circle/alert-circle 着色行）；ToolMessage blocked（ban，新增图标）；ToolResultSubagent 耗时/错误（clock/alert-circle）；ToolResultBrowser 徽章与行（image/link/zap/globe，新增 link 图标）；ToolResultWeb AI 摘要标签（file-text）；feed 空内容占位 `(生成失败)` 去前缀（错误语义由 role='error' 红色分隔符承载）。设置面板 UI 文案中的 ⚙ 指称改为文字（"齿轮徽章"/"可配置"——徽章本身已是 Icon 渲染）。
- 口径：**UI 可见字符串零 emoji**；注释中的排版符号（→/★/⚙）保留。验证：vue-tsc + webui 100/100 + vite build 通过。

### Changed（系统环境块补路径规则一句话）
- 分析结论（2026-09-02 询问）：fs 工具**允许完整路径**——绝对/相对一视同仁，判定只看解析后落点是否在沙箱允许根（workdir + allowedPaths）内；Agent 倾向相对路径是 system prompt 注入工作目录锚点的自然行为 + bash 绝对路径越界拦截文案的行为泛化（拦截原因是越界而非绝对形态，`../` 上跳出根同样拦）。系统环境块补一句 `[路径规则] 工作目录与白名单内绝对/相对路径均可；越界（含 ../ 上跳出根）一律拦截`，消除歧义。

### Changed（连排 hint 时间戳归并 + hint 视点过滤）
- **连排 hint 时间戳归并（UI）**：回执/回触/通知链连续出现时每条都带时间戳，视觉噪音大——`insertTimeSeparators` 归并：3 分钟窗口内的连续 event/error 分隔只在**首条**显示时间（正常消息重置连排；time-separator 充当时间锚时不重复）。DialogView / PairDialogView 模板按 `showTime` 渲染。
- **hint 视点过滤（LLM 上下文）**：`role:'agent'` 行按 viewer 换位投影（自己的话 assistant / 对方 user），但 `role:'event'`（hint）行此前读者无关——共享对桶 a⇋b 里发给 b 的"你请求的…"类第二人称 hint 会原样进对端 a 的回放上下文（误导）。补齐同口径视点判断：`session.history()` 与 ac-conversation 视图投影通道都只把 event 行喂给**目标读者**（`agent_id === viewer`）；steered 机制通知在视图通道同样按 event 行投影（此前按 sender 投成 agent 行——目标 Agent 视角里"你请求的…"变成了自己的话）。UI（records 共享时间线）不受影响。
- 验证：ac-session 新增对端视点用例（hint 不进 peer 回放 / agent 行照常投影）；全量 921/921 + vue-tsc + vite build 通过。

### Fixed（机制唤醒的 run 不流式广播：回执可见但 Agent 运行隐形）
- **现象**：`[plugin] 你请求的…` / `[plugin] 你卸载的…` 等回执出现在会话里，后端也确实起了 run（落盘连续），但前端不刷新看不到任何流式推理——表现为"回执只是记录消息，没触发 Agent 运行"。
- **根因**：ws-bridge 的后台会话过滤对 `source='event'` 的 run **一刀切隐藏流式帧**（step/delta/tool）。该过滤本意是藏定时自唤醒与归档整理（维护 run 不扰民），但 job 完成通知、插件回执回触、reload 续跑、ask_questions 晚到回答这些机制唤醒如今都发生在**用户可见会话**（a⇋b / 群 / singles）——它们的续跑流式被误吞。
- **修复（ac-ws-bridge）**：过滤精化为 **run 级判定**（run-started 按信封登记一次，after-run 清除；tool 级事件查表，delta/step 逐帧可退化判定）：`source='event'` 的 run 只在【自会话桶 a~a】与【归档整理（meta[archive-review]）】隐藏；用户可见会话里的机制唤醒照常流式广播。user/agent 来源恒可见（原语义不变）。
- 验证：ws-bridge 新增三态用例（自会话桶隐藏 / 用户会话 event 可见 / 归档整理隐藏）；全量 921/921 通过。

### Fixed（register_plugin 装载失败后会话中断：回执与回触分家）
- **现象**：用户会话（a⇋b）里 register_plugin 被拒（"已作为全局插件安装，会话级加载被拒绝"）后，原会话只剩失败回执即沉默——Agent 其实被回触唤醒到了 **owner 自会话**（b⇋b）里继续"确认无需修复"，用户看不见，表现为会话中断（与后台任务通知回错会话同类错位）。
- **修复（ac-plugin-registry）**：`retriggerOwner`（固定回 `pairKey(owner, owner)`）改为 `retrigger`——回投**发起会话**（`request.conversationId`，回执与下一轮驱动同会话、完整闭环用户可见；宿主直调无会话上下文回退自会话），register/install 成败路径统一；金闭环 e2e 断言同步（回触行在发起会话、自会话零行）。
- **附带**：会话级加载拒绝文案补充可执行指引（已装插件工具可直接调用测试；重新试跑先 `unregister_plugin(removeFromLibrary=true)` 移出插件库，或 bump version 后 `install_plugin`）。
- 验证：ac-plugin-registry 42/42、全量 919/919 通过。

### Fixed（deliver 超时误报 + Agent 自测三问题：browser 启动 / subagent 默认池 / bash 斜杠参数）
- **反馈 #1（"发送失败：rpc conversation/deliver 超时"）**：`conversation/deliver` RPC 等**整轮 run 收束**才返回（web-api 语义），工具密集的长 run 轻松超过 wire 缺省 60s——超时被误报成"发送失败"。修复：wire `call` 支持按调用覆盖超时；chat 的 deliver RPC 用 10 分钟专属超时 + **超时降级**——会话流式态仍活着（分区 streaming / turnInProgress）说明 run 正常进行，只记日志不弹失败警告；真失败（WS 断开/未知方法）照常提示。
- **反馈 #2a（browser 无法启动：daemon 启动后即退出 code=2）**：缺省守护命令的脚本路径是相对路径（`files/shared/scripts/browser_daemon.py`），spawn 按进程 cwd 解析——后端 cwd 是仓库根，脚本实际分发在 workspace 数据根，python 找不到文件以 code=2 退出。修复：boot 时按 `ctx.workspace.root` 解析相对脚本路径（`resolveDaemonScriptArg` 纯函数，显式 command 注入原样）。
- **反馈 #2b（subagent："父 Agent 无可用模型"）**：spawn 只读 `AgentConfig.model`，没有 router 信封的默认池回落——admin 未声明 model 但用默认池连接跑得好好的，却派不了子 Agent。修复：模型解析与 router 同口径（`defaultPoolConnection` 回落；无池无 model 维持 fail-closed）。
- **反馈 #2c（bash 斜杠参数被沙箱误判：`dir /b`、`date /t` 报"Unix 绝对路径（/b）"）**：扫描器规则 2 把单段 `/token` 一律当 Unix 路径。修复：**Windows 开关豁免**——单段、≤6 字符、字母/数字/?（可带 `:值`）、非已知 Unix 顶层目录（/etc /tmp /usr…）的 `/token` 视为开关；多段路径（/etc/passwd）与已知 Unix 目录照常拦截。
- **附带（同一批工具自测暴露）**：Unix→PS 翻译器把 `2>&1` 当路径参数包成 `'2>&1'` 字面量（`ls path 2>&1` → `Get-ChildItem 'path' '2>&1'`）——ls/rm/cp/mv 的目标集剔除重定向 token、原样追加译文尾部（`2>/dev/null` 归一 `2>$null`）。
- 验证：sandbox-core 开关豁免用例（4 放行 + 3 拦截）；`unix-translate.test.ts`（重定向 4 例 + 行为不变）；subagent 默认池回落双态用例；web-tools `resolveDaemonScriptArg` 用例；全量 919/919 + vue-tsc + vite build 通过。

### Fixed（reload 语义化中断后断流 + 前端渲染序与落盘序不一致）
- **反馈 #1（reload / reload_modules 中断后会话没有继续）**：工具体只发语义化中断（"run 收束后由宿主执行"），但**宿主半边从未实现**——中断后既没人执行热重载也没人唤醒会话（对比 ac-restart / ac-plugin-registry 均有 after-run 消费者）。补齐：`ac-dev-tools` 新增 `loop/after-run` 消费——`reload` → include 子树 `refresh()`（cordis.yml 重读，行增删事务性应用）；`reload-modules` → `ctx.hmr.reloadFiles(paths ?? 水位线发现)`（vendor hmr 新增 `changedSinceWatermark()` 发现面：loadCache 内 mtime ≥ 水位线的文件 URL；HMR 缺席如实报告）；完成后向**原会话**回投 `[系统通知]`（source:'event'，job-wakeup 同款）——会话不因语义化中断断流，Agent 醒来即知重载结果并可继续任务。
- **反馈 #2（渲染序 ≠ 落盘序：send_agent 投递与事件通知排到整个 run 块之前）**：收束行把整轮 run 折叠为单行 `steps[]`——run 中途的插行（投递消息/机制通知）在磁盘上按事件序与步交错，但整块展开后全部排到插行之后。修复（步级时序三件套）：① `LoopStepRecord`/`SessionStepRecord` 增 `ts`（loop 步收束盖章，transform 后补）；② 前端 `toHistoryMessages` 按 `steps[].ts` 逐步展开 + 全列表**稳定时间排序**（无步级 ts 旧行整块按行时刻，行为不变）；③ `buildTurns` 平文中段拆轮（同 sender 后续还有消息 → 独立成轮 + `afterSolo` 使后续步另起一轮）——插行在真实位置独立气泡渲染，不再被"思考过程"折叠链吞掉；组尾平文仍作 final 不拆。
- 验证：ac-dev-tools 新增宿主半边三态用例（显式 paths / 水位线发现 / HMR 缺席 / 非 reload 意图不触发）；loop 步 ts 断言；ac-session 步级 ts 落盘断言；webui 新增 `history-order.test.ts`（展开排序 + 旧行兼容 + 拆轮保位 + 组尾不拆）；全量 912/912 + vue-tsc + vite build 通过。

### Changed（发送失败提示驻留 12s）
- `busyFeedback` 的 `⚠️ 发送失败：…`（会话头部右上角橙色警告片）驻留 6s→12s——热重载窗口等场景一闪而过来不及看清/截图（2026-09-02 反馈：reload/reload_modules 工具中断 run 后宿主热重载，期间发送的 deliver RPC 被拒）；完整错误恒在控制台（`[ChatStore] 投递失败`）。

### Fixed（会话忙时后台任务通知静默丢失：steer 入账丢事件语义 + 前端不处理 steered 帧）
- **现象**：`[系统通知] 后台任务 bash-1 完成` 落盘为无 `source` 的普通 agent 行（`role:"agent"`），前端直播与刷新后都不显示。
- **根因（两条路径叠加）**：任务启动会话（a⇋b）正忙（admin 的 run 还在跑）→ job-wakeup 的通知经 steer 通道注入活跃 run（不发 `router/message-received`）——① ac-session 的 `conversation/steered` 入账忽略 `source`，机制通知（source='event'）落成普通 agent 行而非事件行（空闲时同款通知走 message-received 落 `role:'event'`——同一通知忙/闲两条入账路径不同形）；② 前端 feed 只处理 `router/message-received` 帧，`conversation/steered` 完全无人处理——直播静默丢失；普通 agent 行形态下刷新后也不会渲染成系统分隔。
- **修复**：① steer 入账对 `source='event'` 落 `role:'event' + source:'event'` 事件行（与 message-received 路径同形；LLM 回放按 user 语义位不变）；② feed 新增 `conversation/steered` 帧处理——viewer 自身 busy 发送跳过（本地已上屏）、`source='event'` 上屏系统事件行（含未读计数）、其余 agent 注入与 message-received 同款上屏。
- **复评收口（source→role 契约全链一致）**：`source`（入站信封触发来源）为唯一类别判据，忙/闲两条入账路径同形推导 `role`（user/agent→agent 行；event→事件行；meta 门控不入账）——契约写入 ac-session 头注释；feed 的 `router/message-received` 分支同步按 `source='event'` 分流（此前空闲路径直播把机制通知渲染成 sender 普通消息、刷新却是分隔符——最后一处忙/闲/直播/刷新不一致），事件行渲染抽 `showEventNotice` 两帧共用；`kind` 维持交互域属性（durable-interaction），不进会话行。
- 验证：ac-session 新增 steer 双态用例（event → 事件行 / 普通注入 → 说话人行 + 回放语义位）；webui 新增 `feed-steered-inbound.test.ts`（忙/闲两帧事件行、viewer 自身跳过、agent 注入、普通入站不受影响）；全量 905/905 + vue-tsc + vite build 通过。

### Fixed（工具可见面能力过滤 + ask_questions 弹窗全题作答/自定义回答）
- **反馈 #1（未分配 tag:fs_minimal 的 Agent 仍看到 str_replace_editor）**：`requiredTags` 此前只在**执行时** veto（ac-security），工具对 LLM 仍可见——Agent 会调用后收到拒绝、把门禁当"工具异常"上报。修正：**工具可见面 = 注册面 ∩ 能力面**——ac-agents 新增 `capabilitySetOf`/`toolAllowedFor`（能力集合成与 ac-security 执行门禁同款单源：`{'base','agent:<id>'} ∪ tags ∪ security.capabilities 覆盖层`），三个装配点接线：router 信封（未配置 include/exclude 时也**显式**传可见面全量——loop 的 tools 缺省语义是"全部已注册"，省略即绕过）、collab `list_tools`、web-api `agents/tool-defs`（UI 生效工具集）。执行门禁保留（纵深防御，语义不变）。
- **反馈 #2（ask_questions 弹窗只显示第一题、只能源于选项作答）**：`pickAskQuestions` 此前只取 `questions[0]`，Agent 问多题（最多 5 题）时其余问题用户无从作答。InteractionBar 重做：**单题**保持即选即发 + 自定义输入（Enter/回复按钮）；**多题**逐题分块——每题选项可选中/改选（✓ 高亮）+ 每题"或输入其他回答…"输入框（与选项互斥），底部"提交回答（已答 x/n）"一次提交——`answers` 与 `questions` 对齐（`respondInteraction` 改收数组），未答的题传 `null`（工具结果如实呈现"用户跳过"，Agent 自行决断）。
- 验证：router 新增可见面三态断言（无标签不可见 / tags 命中 / 覆盖层命中）；port-b `pickAskQuestions` 多题保留 + 新形状断言；全量 899/899 + vue-tsc + vite build 通过。

### Fixed（工具 interrupt 收束丢整轮思维链 + 后台任务完成通知回错会话）
- **反馈 #1（a⇋b 中 b.send_agent(a) 后整轮思维链消失，只剩投递消息）**：run 因工具 interrupt（system_restart/reload 等）或 max-steps 收束且末步为工具调用时 `text=''`，ac-session 的 `!text → 不入账` 把**整轮**已完成的步（思维链/工具结果对）一起丢弃——会话流里只剩 send_agent 投递时经 message-received 落的那条消息。修正：`onReplyCompleted` 改为**有步即入账**（content 空 + steps 携带全部内容；UI 按步重建无空泡），完全空 run（首步前中断）仍不入账；`history()` LLM 回放跳过空 content 的 agent 行（回放层面与原"不入账"语义一致）。该收束行带 run 键照常吸收步级部分行。
- **反馈 #2（a⇋b 中 b 起的后台任务，完成通知落到 b⇋b——结果对原会话丢失）**：`ac-job-wakeup` 硬编码回投 owner 自会话桶 `pairKey(owner, owner)`（M19/D2 旧规）。修正：`JobStartSpec`/`JobSnapshot` 增 `conversationId`（发起会话键 = 工具执行身份），bash 后台与 subagent 登记 job 时透传 `call.conversationId`；唤醒行改为**回投发起会话**（`job.conversationId ?? owner~owner`——宿主任务/旧 producer 回退自会话桶）。结果：用户在 a⇋b 里让 b 起的任务，完成通知与后续解读都回到 a⇋b。
- 验证：ac-session（中断有步入账+吸收/空 run 不入账/回放跳空行）、ac-jobs（conversationId 透传 snapshot/settled）、ac-shell-tools（后台 job 携带/缺省两态）、ac-job-wakeup（回投发起会话/回退自会话桶）新增断言；全量 898/898 通过。

### Fixed（刷新丢思维链 + ask_questions 弹窗不恢复：src step-persist 平移）
- **现象**：前端刷新后，运行中 Agent 已流式输出的思维链消失；ask_questions 待答弹窗也不再现（`durable-interaction/opened` 只在工具调用时刻广播一次，刷新后无人重推；且 assistant 回复整轮只在 `router/reply-completed` 落账——工具阻塞等待用户回答时 run 未收束，历史里什么都没有）。
- **ac-session 步级部分行（src step-persist 平移）**：订阅 `loop/run-started`（run 簿记：runId + 机制 run 标记）与 `loop/after-step`——每完成一个**带工具调用**的步即先落一条 `partial` 行（正文/思维链/工具调用对，结果未回）；既有 `tool/before-execute` fail-closed checkpoint 随后 flush，保证部分行在工具副作用/阻塞等待前 durable。收束行（reply-completed）携带同 `run` 键，`records()` 读侧**吸收**同 run 全部部分行——完成后的落盘形态与步级落盘前逐字节一致；中断/错误收束不吸收（已产出的思维链是会话事实，保留）。`history()` LLM 回放恒不消费部分行（工具结果未回，展开即悬空 tool_calls 破坏 provider 消息序）；`stats()`/`tail()`/热力窗口计数排除部分行（口径一致）。无工具调用的 run 零变化（纯文本步不落部分行）；归档整理 run（meta[archive-review]）门控跳过。
- **webui 刷新恢复 ask_questions**：chat store 挂 `wireRpc.onWireOpen` → `interaction/list {state:'pending'}` 重挂弹窗（write-ahead store 是唯一恢复源；断线重连/后端重启后同样恢复）；`pickAskQuestions` 两形归一（live 帧 questions 上提 / 恢复记录 payload.questions）；无 deadline → `timeout_ms=0` 永不自动关（后端工具在永久等待，前端先关会让用户失去作答入口——旧 live 路径缺省 300s 自动关同为缺陷，一并修正）；新增 `durable-interaction/replied|closed` 订阅——别处作答/后端超时后同 id 弹窗收起。
- **InteractionBar 弹窗方向**（上轮修复随记）：触发器位于输入框上方（屏幕底部），菜单改向上弹出（对齐 ChatInput 底部下拉惯例）+ `max-height/overflow` 兜底。
- 验证：ac-session 新增 4 用例（pending 可见/收束吸收/中断保留/纯文本与机制 run 零漂移）+ webui port-b 新增两形归一用例；全量 895/895、vue-tsc + vite build 通过。

### Changed（工具面收敛：memory 专用工具移除 + str_replace_editor 移出默认面）
- **移除 memory_append / memory_rewrite 工具**（与 fs 工具能力重叠——用户裁决）：记忆维护改走 fs 工具直写。
  - **存储迁移**：记忆文件 `<root>/memory/<会话键>.md` → **Agent 专用空间 `files/<agentId>/memory/<会话键>.md`**（记忆归 Agent 本人：对桶两侧各一份、互不覆盖；预设 Agent 专用空间 = 数据根，singles 键路径不变）。存量常规 Agent 的旧 `<root>/memory/` 文件不自动迁移（手动搬移即可）。
  - **注入直读文件**（无读缓存）：Agent 经 write/edit 的外写即时可见（此前缓存优先，fs 外写会读到陈旧值）。
  - `ctx.memory` 服务 API 加 agent 维度：`set/append/get/remove/ids(agentId, key…)` + `fileOf`（口径与 workspace.agentWorkdir 一致）；ac-singles 前缀快照（M21 D5 记忆哈希）同步新签名（带执行 Agent 维度读取）；归档整理提示词改「write 整文件重写 `memory/<会话键>.md`」（write 在生效集且 settings['memory'].enabled 才给指令——记忆停用的 Agent 不再被要求维护不会注入的文件）。
  - 保留字表 `BUILTIN_TOOL_NAMES` 同步移除两名（保留字一致性测试仍锁全 TREE 注册面）。
- **str_replace_editor 移出默认工具面**：注册面挂 `requiredTags: ['fs_minimal']`（与 read/write/edit 重叠、DSH 兼容定位——缺标签调用被 ac-security 能力门禁 veto，include 不可绕过）；`__dsh_minimal__` 预设 tags 补 `fs_minimal` 并修正 tools include（此前误列 view/create/str_replace/insert 四个不存在的工具名——实际注册名为 str_replace_editor 四命令合一，等于极简预设实际只剩 bash 可用）；UI 标签字典补 fs_minimal（极简文件面）。
- 验证：typecheck + 全量测试 + security 门禁新断言（fs_minimal 缺标签 veto / 显式标签放行）+ memory 新断言（fs 外写即时可见、对桶两侧分文件、归档提示词相对路径同口径）。

### Changed（轨道切换：preview 部署为 src 正式轨）
- **preview/ → src/**：82 个跟踪项（74 个 ac-* 包 + webui/docs/scripts/templates + cordis.yml/supervisor.mjs）git mv 整体迁入，历史原地保留。
- **旧轨删除**：`@agentchat/*` 旧轨包族（src/{core,agents,toolkit,...} 30 目录）删除，git tag `legacy-src-final` 留档；`src/vendor/`（cordis 框架行，本轨运行时基座）保留。
- **接线收口**：pnpm-workspace（`src/*` + `src/vendor/*`）；根 package.json 脚本转正（`pnpm dev`/`typecheck`/`test`/`smoke`/`webui*`，`preview:*` 保留为别名）+ devDependencies 清除 41 个旧轨 `@agentchat/*` 条目（cordis vendor 6 项保留）；根 tsconfig 吸收原 preview 配置；vitest include/alias 改指 `src/`；.gitignore 路径同步。
- **代码内路径正名**：ac-web-api 目录内置组 dev 扫描（`trackDir`）、migrate 脚本与 supervisor/boot 变量与用法注释改 `src/` 语义（解析全部相对自身，行为不变）。
- **测试适配**：ac-event-policy bail 单链静态断言扫描范围排除 `vendor/`（cordis 框架本体是 internal/listener 定义方，非行违规）。
- **发布链休眠**：build:frontend/build:bundle/gen:bundle-rows/bin/agentchat.js 回退路径/publish CI 仍锚定旧轨入口，随切换暂停，待新轨生产 bundle 里程碑另立任务。
- **文档面**：根 README 加切换公告 + 源码运行/项目结构改新轨事实；src/README.md 标题与命令块转正；.dsh 两个开发技能路径与命令同步（加术语注记）。
- 验证：typecheck + webui vue-tsc + 832/832 测试 + smoke 全绿。

### Fixed（聊天历史长消息被静默截断）
- grep_history / read_history 的消息预览固定截取 200 字符且无提示，长消息（如交付说明）看不到结尾。现在截断处会标注「已截断，全文 N 字符」，read_history 新增 `full=true` 参数直接输出完整内容，不必再翻原始会话文件。

### Removed（诊断探针整体清除：用户换思路，调查暂停）
- **清除物**：`src/ui/webui/src/utils/strayDomProbe.ts`（v1-v5 探针）、`src/ui/webui/tests/stray-dom-repro.test.ts`（jsdom 复现钉子）、`main.ts` 挂载点、devDependency `jsdom`。用户侧 `localStorage.LOG_LEVEL` 遗留键不影响应用（仅控制 logger 冗余级别）。
- **调查暂停时的结论存档（备未来重启）**：游离 = turn-item 包装层被拆、子元素（turn-bubble/turn-chain-row）按对话顺序平铺至 `<html>` 直属层；触发于页面加载后 ~13-30s 静置窗口（与快速切换无关）；普通窗口必现（3/3），InPrivate/headless 均阴性；实例级+原型级插入 API 全谱拦截零触发、零 JS 异常——嫌疑集中于未挂钩原生入口或浏览器扩展改写页面（REBORN 假设未及验证）。诊断工具脚本存于 `%TEMP%\agentchat-stray\`（cdp-repro/cdp-quiet/cdp-smoke.mjs），可复用。

### Fixed（探针 v5 黑屏事故：ShadowRoot.prototype.innerHTML 是 accessor——包装器读取即触发 getter，this=原型对象非法）
- **现象**：v5 上线即黑屏，`Uncaught TypeError: Illegal invocation at cs(=wrapMethod)`，异常发生在模块顶层初始化 → app 整个未挂载。
- **根因**：全原生入口挂钩列表误收 `ShadowRoot.prototype.innerHTML`——它是 **accessor 属性（getter/setter）而非函数值属性**，包装器 `i[o]` 一读取就触发 getter，而 getter 的 `this` 是原型对象（非真实元素）→ 浏览器抛 Illegal invocation。普通方法（insertBefore 等）是函数值属性、读取无副作用，accessor 必须走 `getOwnPropertyDescriptor` 分支（该分支 v5 本就正确）。
- **修复**：移除该条目（accessor 集合注释封边）；`startProbe` 外层 try/catch 兜底——探针任何失败只降级退出（console.warn），绝不外泄拖垮宿主。
- **验证**：headless Edge + `LOG_LEVEL=debug` 自动武装路径冒烟——app 正常挂载、真实 DOM 插入/删除操作通过（appendChild/insertBefore 挂钩未破坏原生行为）、运行 16s 零游离。39/39 webui 测试通过，dist 已重建。

### Investigated（游离 DOM 结构定性：turn-item 包装层被拆、子元素平铺至 html；v5 探针上身份判别）
- **第二次用户捕获（普通窗口，页面加载后 ~27s，无任何交互）**：119 条游离 + html 层完整名册。名册决定性：html 直属 17 元素 = `turn-bubble`（用户气泡）/`turn-chain-row`（Agent 思维链行）**交替序列**——正好是一段对话的展开顺序，而 **turn-item 包装层完全消失**（其子元素被平铺，非整节点搬移）。插入 API 全谱拦截（实例+原型 insertBefore/appendChild/append/prepend/replaceChildren）**零触发**、零 JS 异常。
- **嫌疑收窄为两路径**：① 未挂钩的原生入口（`insertAdjacentElement/HTML`、`before/after/replaceWith`、`Range.insertNode`、`document.write`、`innerHTML/outerHTML` setter——平台内部实现绕过 JS 覆盖）；② 解析器重造（有代码读取页面 HTML 再写回——浏览器扩展改写页面的典型行为；三次复现全部在普通窗口，InPrivate/headless 均阴性，与扩展假设一致）。
- **探针 v5（判别器一步定罪）**：① 身份注册表（MutationObserver 记录所有曾在 #app 内出现的消息元素）——游离命中时比对：同一节点对象 = **MOVED**（未挂钩 API 搬移）vs 从未在 #app 内 = **REBORN**（解析器重造副本，指向扩展/innerHTML 往返）；② 全原生入口原型级包装 + 每次调用后 diff html 名册（新增即记录调用者栈）；③ document.write/writeln/open、innerHTML/outerHTML setter 挂钩。
- 待办：用户普通窗口纯刷新复现后 `copy(window.__strayDomLog)`——MOVED/REBORN + 调用来源栈即为终局证据；若 REBORN，下一步核对浏览器扩展清单。

### Investigated（游离 DOM 定位推进：触发时点锁定「页面加载后 ~13s」+ 插入未走 insertBefore/appendChild）
- **用户 17502 行捕获日志分析**（页面 09:42:15 加载，首条游离 09:42:28）：① **游离发生在加载后 ~13 秒内**（历史+token+resume 落定时点），不在快速切换中——解释用户"切换时复现不了"；② 首条游离 prev=`button.compress-btn`（DialogView 页头元素）与消息元素**成片**出现在 html 层且保持模板相对顺序 = 整段 DOM 被搬移而非零散错位；③ v3 实例级 `documentElement.insertBefore/appendChild` 拦截**零触发**（1942 条全为观察记录）→ 插入走了未挂钩的 API（append/prepend/replaceChildren/原型层）或非插入型机制。
- **headless 静置复现仍阴**（36s 静置 + 全谱挂钩 + 每秒 html 名册，CDP）：与真实浏览器差异收窄为 localStorage 状态（lastContext 恢复上次会话等）+ 真实运行中会话。
- **探针 v4**：① 挂钩全谱化——实例级 insertBefore/appendChild/**append/prepend/replaceChildren** + **原型层** insertBefore/appendChild（拦 Reflect.apply/proto.call 形态）；② 捕获首次命中时记录 **html 层完整名册**（含非消息类元素，还原成片搬移范围）；③ window.onerror/unhandledrejection 时间线关联（游离若由渲染中途异常导致可对照）。
- 待办：用户真实浏览器纯刷新（无需切换）复现 + `copy(window.__strayDomLog)`；用户提供 `copy(localStorage)` 以便 headless 重放差异变量。

### Investigated（「会话消息渲染到 body/html 同级」：三层静态排查 + 双轨复现实验均未复现，探针升级为插入拦截抓现行）
- **证据确证**（用户实捕 50 条）：游离散布为**成棵 TurnDisplayItem 子树**（turn-item > chain-body > message-item，带真实消息内容与 data-v 作用域属性），其 `parentElement` 精确等于 **`<html>`**（class 链第 6 层直判，非深度截断伪影）；`#app` 本体完好；后续使用中被清掉（Vue remove 按 el.parentNode 工作，任何父级都能正确移除——解释"过段时间自己好了"）。
- **静态排查三层清零**：① 应用源码 12 处 DOM 挂载全在 head/一次性 textarea（同步移除）；② Vue 3.5.41 runtime-dom 源码 **0 处** documentElement 插入路径；③ 构建产物全 chunk 扫描 9 处 documentElement 全部无害（主题 classList/图表配色/探针自身）。结论：**不存在任何静态可寻的插入者**。
- **复现实验双轨皆阴**：① jsdom + h() 结构复刻（v-show 包裹/component :is/v-if 根/混合 key v-for + 真实 feed store + 三场景风暴）干净；② 真实 UI + Edge headless CDP 自动化（16 Agent × 3 种节奏 × 38 次点击风暴）`htmlChildren = [HEAD, BODY]` 零游离。缺失变量：事故时有 Agent **正在流式输出**（需消耗配额触发，未擅自执行）+ 用户日常浏览器环境（扩展/配置档）vs 干净 headless。
- **探针 v3**：挂钩 `documentElement.insertBefore/appendChild`——下次插入发生时直接打印**插入者自身的调用栈**（此前 MutationObserver 只能给出观察者栈），一步定罪。armed 后照旧 `copy(window.__strayDomLog)`。
- 测试资产：`stray-dom-repro.test.ts`（jsdom 3 场景回归钉子）+ 新增 devDependency `jsdom`。

### Fixed（诊断取证复盘：npx 缓存路径实为仓库 junction——收回"双实例新旧前端交替"误判）
- **上一轮误判（已收回）**：曾据进程列表判定"npx 缓存里的发布快照与仓库实例抢 3830、浏览器交替加载新旧前端"。实测否定：`_npx\...\@nefevcore\agentchat` 是指向仓库根的 **Junction**（`npm link` 遗留），package.json 的 File ID 与仓库完全相同——全程只有一棵代码树，不存在新旧前端交替。
- **"探针输出消失又出现"的真实解释**（用户日志时间线复原）：08:50:24 服务停止 → 用户此刻刷新页面 → 对着已停服务加载（浏览器错误页 = 控制台零输出）→ 08:50:26-32 服务重启 + 刷新 → 探针输出回归。另一叠加因素：`localStorage.setItem('LOG_LEVEL','debug')` 本身不产生任何输出——探针在**页面加载时**武装、logger 逐条输出；set 完不刷新永远看不到新输出（v2 探针已加 `window.__strayDomProbe()` 免刷新入口，绕开该限制）。
- **探针 v2**（`utils/strayDomProbe.ts`）：① 控制台随时 `window.__strayDomProbe()` 免刷新武装；② 捕获记录同步写入 `window.__strayDomLog` 内存缓冲（上限 50 条，控制台清空/漏复制不丢证据），`copy(window.__strayDomLog)` 整份拷贝。首版探针已在 WS 重连窗口捕获到一次 body 直属异常子节点（warn 正文在用户控制台丢失，待 v2 复取）。
- **启动方式备忘**：`pnpm dev`（tsx 源码直跑）/ `pnpm start web`（= `node ./bin/agentchat.js web`，同样 tsx 跑源码）；`npx agentchat web` 经 junction 等效但多两层 npx 包装进程，无谓开销。

### Added（游离 DOM 诊断探针：捕捉「会话消息渲染到 body 同级」偶发错位的现场证据）
- **背景**：快速切换 Agent 会话时偶发消息渲染到 body 同级位置（DevTools 已确认），一段时间后自行恢复（视觉上像页面自动刷新——已排查 `location.reload` 仅版本更新流程手动触发，"恢复"实为后续渲染清掉了游离节点）。静态排查已穷尽：消息渲染链路（DialogView → TurnDisplayItem → AssistantMessage/UserMessage/ToolMessage）无 Teleport、无 fixed 定位、无手动 DOM 挂载；全库挂 body 的只有 Modal/tooltip/插件 iframe/复制兜底 textarea。
- **探针**（`utils/strayDomProbe.ts`，main.ts 挂载，`localStorage.LOG_LEVEL=debug` 启用，生产构建可用、默认零开销）：① MutationObserver 监控 body 直属子节点，非 #app/非白名单（.ui-modal/.mx-tip/.agentchat-more-menu/iframe/textarea 等）新增即报警——class 链 + HTML 片段 + 兄弟节点 + `#app` 连接态 + console.trace 调用栈；② 3s 周期扫描全文档消息类元素（turn-item/message-item/messages-content/markdown-body/chat-view/chat-input）中游离于 #app 之外者（覆盖非 body 直属的错位形态），WeakSet 去重。输出统一 `[stray-dom]` 前缀。

### Fixed（快速切换 Agent 偶发「新会话未加载、旧会话驻留主窗口」：列表交互期重排顶替光标行 + 历史响应无请求关联）
- **现象**：0.5s 级快速切换 Agent 时偶发点击后主区仍显示旧 Agent 的会话、新 Agent 会话未加载；无法稳定复现。
- **根因（两层叠加，均依赖流式/轮询时序故难复现）**：
  - **列表重排顶替光标行（主因，点击层）**：`bumpAgentById`（每条消息结束/虚拟消息）、`setAgents`（每次 agentList 响应）都按 lastActivity **重排整个列表**。快速连点间隙一旦发生重排，光标下的行已被顶替——click 落到被流式活动顶到顶部的**旧 Agent** 上（主区回到旧会话），或 mousedown/mouseup 目标分离导致 click 根本不触发（点击无反应）。任何 Agent 在运行（流式 bump 持续）+ 用户快速切换 = 最易触发。
  - **历史响应到达序错乱（次因，数据层）**：`history.response` 无请求关联标识。快速连点同一 Agent 产生多个在途 `history.request`，大历史量查询慢时响应到达序 ≠ 发送序——旧分页响应在新首屏请求之后到达，被当作首屏/旧页合并进刚重置的分区（错误分页闪现；`loadMore` 的 offset 是发送时即加，迟到响应按 `_historyOffset` 判定首屏还会误判）。
- **修复**：
  - **AgentList 指针交互期冻结行序**：列表容器 `pointerdown` 冻结排序（行序快照），`pointerup/leave/cancel` 后 600ms 解冻（覆盖 0.5s 级连点窗口）；解冻后按最新活动自然重排，浮顶语义不变；冻结期间新出现的条目排尾。视图层实现（`freeOrder`/`frozenKeys`/`unifiedList`），store 排序逻辑零改动。
  - **history.request/response 加 requestId 回显**：后端 `handleHistoryRequest` 回显 `data.requestId`（两分支：direct + single）；前端 `loadHistory`/`loadMoreHistory` 每请求生成并按目标（session ?? agentId）记住最新 requestId，`onHistory` 比对不一致即丢弃（被更新请求取代的迟到响应不参与合并/状态回落）；旧后端无回显时放行（兼容降级）。
- **测试**：新增 `src/ui/webui/tests/feed-rapid-switch.test.ts`（3 例：A→B→A 连切分区完整性/activeDialog 跟随、连点同 Agent 旧响应丢弃-新响应首屏合并、旧后端无 requestId 兼容放行）；连同 resume-merge 共 7 例全绿。全量 871/872（唯一失败为并行在途编辑的 bundle-rows 漂移，与本修复无关）；server typecheck 干净；webui dist 已重建。

### Fixed（点击 Agent 会话「没有变化」：运行矩阵/pair 视角让位失效——toggle 反选与同值重选绕过选中 watch）
- **现象**：经运行矩阵（cell 进入会话/pair 只读视角）之后，在列表点击某个 Agent/会话出现主区毫无变化（要点第二次才生效）。
- **根因**：覆盖层（矩阵 `trackingViewVisible` / pair 只读视角 `pairView`）的收起此前**只**由 App.vue 的选中 watch 驱动，其判定 `cur.some((v,i) => v && v !== prev[i])` 要求「非空且变化」。两类真实导航不满足：
  - **toggle 反选**：`agentStore.selectAgent` 是 toggle（点"当前已选中"的 Agent = 反选成空）。矩阵 cell 进 pair 视角时选中态不变 → 用户随后在列表点这个仍高亮的 Agent → 反选成 `''` → watch 不触发 → PairDialogView/矩阵不退，主区纹丝不动；「运行中」面板 `jumpTo` 的 agent 分支同样无 toggle 守卫，点正在查看的 Agent 的运行条目 = 反选 + 无任何可见变化。
  - **同值重选**：点击「当前已激活」的群/独立会话时选中三元组完全不变 → watch 不触发 → 覆盖层不退。
- **修复（导航入口显式收起，不再依赖 watch）**：
  - `AgentList.selectAgent`：覆盖层打开时强制选中（导航语义，防 toggle 反选成空）；无论选中结果都显式 `ui.closeTrackingView()`（连带清 pairView，幂等）；常规列表态保留 toggle 语义（点已选中项取消选择）。
  - `AgentList.selectGroup` / `SessionList.selectSingle`：显式 `ui.closeTrackingView()`（覆盖同值重选）。
  - `RunTrackingPanel.jumpTo`：agent 分支对齐矩阵 cell 的完整导航仪式——toggle 守卫 + 清未读 + `loadHistory` + 活跃会话 `chat.subscribe`（此前只切选中不加载历史，跳到从未打开过的 Agent 是空白会话）；三分支末统一显式收起覆盖层。
  - App.vue watch 保留（新选中的快路径 + 被动清空不打断矩阵的设计意图），注释补契约说明。
- **验证**：webui dist 已重建；全量 868/869（唯一失败 `composition.test.ts` 为并行在途编辑的 bundle-rows 漂移（yml/gen.ts 均为 7:36:55 修改），与本修复无关，重跑 `pnpm gen:bundle-rows` 即对齐）；webui typecheck 仅剩 `svc/archive` 一条既有错误（来自并行在途的 `@agentchat/jobs` tsconfig 映射，同样与本修复无关）。

### Fixed（前端流式「结果堆叠」：切回运行中的 Agent / 流式中刷新出现 测/测试 双气泡）
- **现象**：流式输出期间（尤其切换到正在运行的 Agent 会话、或流式中刷新页面）消息区短暂出现两个堆叠的气泡——一个冻结在部分前缀（"测"），另一个继续累积（"测试"）；历史首屏返回替换分区后消失，但触发极其频繁（每次切回运行中的会话/每次刷新必现）。
- **根因（双端错位，d2a4d61 引入即时合并路径后显性化）**：
  - 后端 `handleChatSubscribe` 序列化 resume 快照时把 **currentStep（进行中的部分内容）并入 `steps` 尾部**（8ddaeb7 引入）——`steps` = 已归档 + 进行中；
  - 前端 `mergeResumeSnapshot` 的载体复用判定按「`steps` = 仅已归档」设计（`persistedAssistants > steps.length` 才原地续流）→ 恒差一位：分区里已有 k+1 个 assistant（含直播流式占位）时仍走"新建占位"分支 → 直播占位冻结在部分内容，新占位成为 `lastStreaming` 继续吃 delta → 同一段内容渲染两份。
- **修复（双端对齐 + 前端防御）**：
  - 后端：resume 快照 `steps` 恢复为仅已归档步骤——进行中部分由顶层 `content/thinking/phase/toolCallId` 承载（前端 ③ 以其重建流式载体）；
  - 前端 `mergeResumeSnapshot`：① 兼容旧载荷——按镜像特征（尾部 step 与顶层 content/thinking 同值）剔除被并入的进行中步骤（全空步骤不剔，防误伤 tools-only 完成步骤）；② 复用载体时**长度取胜**——subscribe 往返期间直播 delta 已渗出更长内容时不回卷（回卷后 delta 追加会造出重复尾巴）；③ 新建分支兜底复用当前轮已有的流式占位——任何载荷形态下都不产生第二个流式载体。
- **测试**：新增 `src/ui/webui/tests/feed-resume-merge.test.ts`（4 例：旧/新载荷形态切回运行中 Agent 唯一载体、快照落后不回卷、空分区刷新挂起-历史首屏合并唯一载体）；修复前 3 例复现失败（双载体），修复后全过。全量 **869 通过**（101 文件），server typecheck 干净；webui dist 已重建。

### Changed（第五轮：遗留项清零——参数统一/oneOf/hooks 定义/数值约束）
- **同语义参数统一**：job 的 `lines` → `limit`（与 read_logs/read_history/read 的条数参数同名；execute 层 `args.limit ?? args.lines` 兼容旧名）。
- **"二选一必填"用 oneOf 表达**：grep_history / read_history 的 parameters 补 `oneOf: [{required:['agent_id']}, {required:['group_id']}]`——体积小收益直接，LLM 生成阶段即可见约束；subagent/browser 的或关系定义 oneOf/anyOf 体积太大，维持运行时报错兜底（用户裁决）。
- **`fields.hooks` 补完整 properties**：update_agent_profile 的 hooks 从自由 object 补全为七类钩子定义（runStart/runEnd/stepStart/stepEnd/toolExecutionStart/toolExecutionEnd/fallback，均 `string[]`），与同工具 `tools` 字段的精细度对齐。
- **数值参数补 minimum/maximum（12 处）**：read `offset`(≥1)/`limit`(1-5000)、bash `timeout`(1000-120000)、job `limit`(1-500)、read_logs `limit`(1-500)、read_history `limit`(1-100)/`offset`(≥0)、timer `repeat_count`(≥0)、subagent `wait_time`(0-600)、ask_questions `timeout_ms`(≥0)、browser steps `repeat`(1-20)/`delay_ms`(≥0)。边界进入 schema，LLM 生成阶段可见。
- **明确不做（用户裁决）**：str_replace_editor UI 标注（可当成四合一工具）；browser eval 约束声明（页面上下文受限）；默认值硬编码维持现状。
- 文档：tool-schemas.md §5.2 改为处置表（遗留清零）、§2 演进表补第五轮、11 个明细块由源码 dump 重新生成；plugins/shell.md 同步。全量 **865 通过**，typecheck 干净。

### Changed（web_search 深度简化：仅 query + description）
- **依据**：部署主用 DeepSeek 搜索——其实现（`web-search/deepseek.ts`，Anthropic 兼容 Messages API + 服务端 web_search 工具）**只消费 query**（max_results 仅用于结果切片），其余 7 个参数（max_results/search_depth/topic/time_range/include_domains/exclude_domains/include_answer/include_raw_content）全部忽略，纯粹占用 schema token。
- **变更**：schema 收敛为 `web_search(query, description)`；provider 级调优（结果条数/深度/主题等）走 `tool.web_search` 命名空间配置（defaultResults/defaultDepth/defaultTopic/rawContentMaxLen），不再暴露给 LLM。
- **兼容**：execute 层 `args.X ?? wsCfg.defaultX` 兜底保持——其他 provider（tavily/brave/serpapi）部署时仍可经配置生效，旧参数传入不报错。
- 参数总量 116 → **107**；文档同步（tool-schemas §9 + 总表、plugins/web.md）。全量 865 通过，typecheck 干净。

### Changed（第四轮：全部工具描述按「口语化、有效指引、简单全面」重写）
- **原则**（用户定稿）：相信 Agent 的理解能力——描述只说"做什么 + 关键指引"，详细语义（超时上限、模糊匹配规则、返回结构、边界情况）移出描述留在行为层与报错信息里；效果由定期的使用统计与成功率分析驱动迭代。
- **重写范围**：29 个内置工具的主描述与参数描述全部精简。代表对比：
  - read：`读取文件内容或列出目录。文件输出「行号:内容」（行号全局连续…目录返回 JSON 列表…）`（~100 字）→ `读取文本文件并返回带有行号的内容。`
  - write：`写入/覆盖文本文件（自动创建父目录…⚠️ 会整体覆盖…修改请用 edit…）`（~80 字）→ `创建或覆盖文本文件。`
  - edit：`修改现有文件：把 old_string 精确替换为 new_string…必须在文件中唯一…多处修改并行发多个 edit…`（~150 字）→ `通过替换文本内容来编辑文本文件。`
  - bash（~200 字）→ `执行 shell 命令并返回输出。`；browser（~380 字）→ 动作列举一句；str_replace_editor（~500 字）→ 四命令一句。
  - read/write/edit 保留行为指引的最小集：reload/reload_modules/system_restart 互相指向正确阶梯；timer/subagent 保留模式与 action 枚举说明。
- **测试**：str_replace_editor 描述钉子测试同步（insert_line 参数描述保留"与 view 显示的行号一致"防回归锚点）。全量 **865 通过**，typecheck 干净。
- **文档**：tool-schemas.md §4 由源码 dump 重新生成（29 个明细块逐字一致），头部与演进表补第四轮记录。

### Changed（工具面第二轮调整：十个工具 schema 收敛 + query_history 拆分 + inspect_session 移除）
- **read**：`path` → `file_path`，新增 `offset`（1 基起始行，默认 1）/ `limit`（默认 2000，最大 5000）分段读取——行号保持全局连续（edit 的 old_string 不受分段影响），截断时返回 `truncated` + `next_offset`。
- **write**：`path` → `file_path`。
- **bash**：新增 `description`（一句话用途，extractLabel 优先展示，任务列表可读性）；`cwd` → `workdir`；`stdin` 移出 schema（execute 层兼容）。
- **web_search**：新增 `description`（同上，extractLabel 优先）。
- **query_history 拆分**：`grep_history(pattern, agent_id, group_id)`（关键词全量检索，命中上限 50）+ `read_history(agent_id, group_id, limit, offset)`（分页翻阅）——检索与翻阅语义分离，参数各自收敛；描述明确"自身与任何 Agent 的 1:1 对话或任意群聊"（agent_id="user" 查与用户对话）。旧 query_history 不再注册。
- **inspect_session 移除**：使用数据分析（近 7 天 46 次）显示主要用途是"看会话尾部消息"（limit=5/6/8/15），由 read_history 完全覆盖，且常见参数误用（agentA 塞 group id 致 error）；诊断场景（byRole/byAgent/dupCount 统计）由 bash+grep 承担。
- **send_agent**：移除 `no_wait`（schema；execute 层兼容），描述补"可发给自己形成自我提醒"。
- **timer**：移除 `replace` 与 `max_steps`（schema；execute 层兼容）。
- **subagent**：收敛为 7 参数——`action/task/name/tools/context/subagent_id/wait_time`；`wait_time`（秒）统一等待语义（spawn 传正值 = 阻塞至完成；await 默认 60）；移除 `wait/no_wait/wait_s/max_steps/timeout_s`（execute 层兼容旧名）。
- **连带文案**：memory/archive/group-service 的"可用 query_history 回忆"提示 → read_history；agent-prompt 术语约定与协作工具清单更新；boot BUILTIN 描述更新。
- **测试**：新增 `tool-adjust-20260820.test.ts`（12 例：read 分段/续读/越界/旧参数兼容、write 命名、grep_history 检索命中/无命中、read_history 分页、二选一报错、bash description label）；盘点测试快照更新（grep_history/read_history 取代 query_history/inspect_session）。全量 **865 通过**（100 文件），typecheck 干净。
- **文档**：tool-schemas.md 定稿为当前态参考（三轮演进表、处置状态对照、明细块与源码逐字核验一致）、plugins/session-tools 重写、fs/shell/web/agent-tools/timer/subagent/agent-prompt/tools、README、tutorial 03/04、assembly-catalog、architecture、tool-value-review 同步。send_agent 描述笔误修正（agent_id→to）。
- **参数总量**：29 个工具 schema 参数 133 → 116（-13%）。

### Changed（edit 极简化：收敛为 file_path/old_string/new_string 单一形态——DSL/行级定位/edits[] 全部移除）
- **依据（5035 次真实调用统计，2026-08-20）**：文本匹配 77.6%（成功率 92-97%）为绝对主流；Hashline DSL 仅 7.4% 且成功率最低（62%，失败全是 TAG 失配/语法摩擦）；行级 pos 2.6%；**11.6% 是 LLM 自创的顶层平铺 camelCase 形态（全失败）**——多形态并发散是最大失败源。条目数 83% 为单条；"同文本批量替换"需求实际为零；LLM 原生并行 tool_call 与 edits[] 数组等价。
- **edit 新形态**：`edit(file_path, old_string, new_string)` 三参数（均必填，`new_string` 空串 = 删除）。保留：三级模糊匹配（精确/NFKC+trimEnd/NFKC+trim）、唯一性校验（多次出现报错并给恢复建议）、重叠检测、增量 diff、混合行尾按行保留、`withFileMutationQueue` 同文件并发串行化。
- **移除（edit 包）**：`hashline-parser.ts` / `hashline-executor.ts` / `hashline.ts` / `hashline-snapshot.ts` / `edit-diff.ts`（barrel）五个文件；`apply.ts` 的 `applyLineEdits`/`resolveSnapshotHash`/行哈希验证；`executor.ts` 的 TAG 校验/定位解析/快照更新；返回值去 `updated_hashes`/`file_tag`；`types.ts` 去 `LineEdit`/`HashPos`/`HashUpdateInfo`。
- **移除（连带）**：read 的 `[PATH#TAG]` 头、`line_hash` 参数、`file_tag` 返回与快照记录（保留「行号:内容」）；write 的写后快照同步（P0-2 口径随快照机制整体失效）；str_replace_editor 的 4 处 `recordSnapshot` 调用（不再依赖 `@agentchat/edit`）。
- **兼容与引导**：顶层 camelCase 入参（`filePath`/`oldText`/`newText`）读取层兜底（历史 LLM 自创形态，占 11.6%）；DSL `input` / `edits[]` / `op`/`pos`/`end` 传入返回明确迁移引导错误（非神秘报错）；security 拦截器的路径提取本就覆盖顶层 `file_path`（测试改为新形态载荷）。
- **system prompt 同步**：文件操作指引改"old_string/new_string 文本匹配 + 多处修改并行发多个 edit"（原指引还在教 DSL 行级定位）。
- **测试**：删 `hashline-dsl.test.ts`（10 例）/ `edit-snapshot-line.test.ts`（9 例）/ `edit-write-snapshot.test.ts`（9 例）；新增 `edit-simple.test.ts`（13 例：正典三参数/多行块/空串删除/唯一性/未找到/模糊/camelCase 兜底/CRLF 保留/旧形态迁移引导 ×3/write→edit 衔接/read 无 TAG）；security 拦截器测试 2 例改新形态载荷；str-replace-editor 快照断言改直读文件。全量 **853 通过**（99 文件），typecheck 干净。
- **文档**：plugins/edit.md 重写、plugins/fs.md / architecture / assembly-catalog / plugins/README / plugins/tools / tool-dev-guide（补"单工具单职责"约定）/ tool-value-review 同步。
- **工具面变化**：edit 参数 5 → 3；read 参数 2 → 1。

### Removed（register_tool 运行时工具注册：动态能力收敛到 register_plugin 插件路径）
- **动机**：运行时经 LLM 传 JS 源码注册工具（vm 沙箱）与 `register_plugin` 的动态加载功能重叠，且后者有 manifest 声明 + grants 高危权限审批（process/shell 显式授予）的统一治理面；保留两条代码注入路径收益小、审计面大。移除后 admin 动态扩展只走插件路径。
- **删除**：`src/dev/dev/src/register-tool.ts`（工具实现 + compileExecute 沙箱编译）与 `src/dev/dev/tests/register-tool.test.ts`（7 例）。`agentchat-plugin-tools` 插件行保留，现提供 register_plugin / unregister_plugin 两个 admin 工具。
- **保留**：`ToolsService.register` 的 `always`/`replace` 选项（服务级 API，有独立测试 service.test.ts；不再被内置工具使用）。
- **同步**：盘点测试快照移除 register_tool（内置工具 30 → **29**）；boot 三处注释/描述（register-core / loader BUILTIN / composition.base.yml）；文档十处（tool-schemas 重编号、architecture、assembly-catalog、README、tutorial 04、plugins/dev、plugins/README、plugins/math、tool-dev-guide；tool-capabilities 加历史注记、tool-value-review 按删除先例标注）。
- 全量 **868 通过**（101 文件），typecheck 干净。

### Fixed（工具 schema 评审首轮落地：fs-search 补入默认 presets + edit schema/实现漂移 + 参数统一 snake_case + 盘点护栏补齐）
- **背景**：`docs/tool-schemas.md`（30 个内置工具 schema 全览 + 19 条疑点）评审流出四项高优先级问题，本轮全部落地。
- **glob/grep 不在默认 presets**（意图与装配矛盾：工具描述明令"不要用 shell find/grep"，但默认 Agent 无任何文件搜索工具）：`/api/agents` 新建基线与 workspace admin 种子的 presets 均补入 `agentchat-fs-search-tools`（standard 预设本就含）。默认可见工具 27 → **29**（30 − str_replace_editor）。存量 Agent 需手动在 config.presets 加该行。
- **edit schema/实现漂移**：①`extractLabel` 读 `args.oldString`/`edits[0].filePath`（camelCase），schema 却声明 `old_string`——按 schema 传参时 UI 标签计数恒错 → 改读 snake_case（带旧名兜底）；②`ns: 'tool.edit'` 无任何配置读取点（违反 namespaces.ts"仅保留有真实读取点的工具"规则，WebUI nsSchemas 也无对应项）→ 移除声明；③ask_questions execute 残留读取未声明的 `args.convKey` → 删除。
- **参数统一 snake_case**（schema 只声明 snake_case 正典；execute 层保留 camelCase 兼容别名，会话历史重放不破）：
  - read：`lineHash` → `line_hash`
  - edit：`filePath`/`oldText`/`newText`（edits[] 与顶层）→ `file_path`/`old_text`/`new_text`（描述同步改写；`normalizeEditArguments` 兼容全部旧名）
  - browser：`continueOnError` → `continue_on_error`、steps[] `delayMs` → `delay_ms`
  - inspect_session：`agentA`/`agentB`/`filterRole`/`filterAgent`/`dupCheck`/`includeArchive` → `agent_a`/`agent_b`/`filter_role`/`filter_agent`/`dup_check`/`include_archive`
  - timer：`repeatCount`/`maxSteps`/`delayMin`/`delayMax` → `repeat_count`/`max_steps`/`delay_min`/`delay_max`（TimerEntry 磁盘字段不变，参数层映射）
  - bash `timeout`（单词）与 subagent `timeout_s`/`wait_s`、ask_questions `timeout_ms` 维持不变
- **盘点护栏补齐**：`tool-requires-inventory.test.ts` 快照补 `makeFsSearchTools`（glob/grep）与 `makeStrReplaceEditorTool`（str_replace_editor），30 个内置工具 requires 全覆盖（此前 3 个无护栏）。
- **WebUI 同步**：`ToolResultEdit.vue` 路径提取链补 `file_path`；`ToolResultCard.vue` 标签映射补 `file_path`。
- **测试**：`edit-snapshot-line.test.ts` 端到端改 snake_case 正典参数并新增顶层 `old_string/new_string` 用例，保留一例 camelCase 作历史重放兼容回归。全量 **875 通过**（102 文件），typecheck 干净。
- **文档**：`docs/tool-schemas.md` 更新为修复后状态（§5.1 已修复四项 / §5.2 遗留九项）。

### Added（Agent 运行跟踪模块：标准布局模型 —— 侧边栏树形面板 + 主区矩阵视图）
- **布局模型**（对齐 IDE/VS Code 范式：活动栏只控制侧边栏，主区由侧边栏选择驱动）：活动栏第三项 = 侧边栏第三个面板；「运行矩阵」入口在面板树内；主区让位规则 —— 选中 Agent/群/会话（任何面板）或矩阵格子点击切换上下文 → 矩阵自动关闭回聊天。
- **侧边栏「运行跟踪」面板**（`RunTrackingPanel.vue`，对齐会话列表的工作区树形态）：标题栏（文本）→ **运行总览（节点本身即矩阵入口，点击打开/关闭主区运行矩阵，运行数徽标 + hover 统计提示）** → 运行中（树节点 → 运行会话叶：运行光环头像、实时时长、hover 中断、点击跳转）→ 活跃子Agent（树节点 → 清单叶）；节点 30px 行高/悬停交互与 SessionList 同款。
- **主区「运行矩阵」视图**（`RunTracking.vue`）：头部 = 标题（文本）+ **日期范围筛选（1h/1天/3天/1周/1月/全部）** + 快照时间。
  - **着色 = 活跃度浓度（对数刻度 + 固定上限）**：选中范围内每个会话的消息量（后端按 timestamp 分桶计数 `windows:{h1,d1,d3,d7,d30}`，mtime/size 缓存、文件变化才重算）封顶固定上限（`h1:30 / d1:100 / d3:300 / d7:600 / d30:1500 / all:3000`）后按 **log(1+v)/log(1+CAP)** 归一 5 档。固定上限三利：图例写死区间（`≤5 · 6–21 · 22–78 · 79–289 · 290+ 条`，不随数据重算）；上限不依赖快照 → 轮询时浓度分档稳定；极值热点（实测 max=2864，跨 3.5 个数量级的重尾分布）不再"吃掉"色阶 —— 对数刻度本身保留（线性会把中位数会话压进最浅档）。范围内 0 条无色；运行中格最深底 + 流转光环；群参与证据格浅绿证据色；精确数值看 tooltip。**版本容错**：旧后端无 `windows` 字段时回退总量着色（范围按钮禁用 + 提示重启后端）。
  - **性能（实测卡顿四源修复）**：① 3s 轮询若每次替换 snapshot 对象会触发 400+ 格子 computed 级联重算与全量 patch —— runs store 改为**内容签名比对（剔除 generatedAt 的 JSON 签名），未变化只更新时间戳、保留对象引用** → 稳态零渲染；② 十字置灰的 `filter:saturate()` 作用于 400+ 格子在 hover 切换时全矩阵样式重算 —— **改为纯 opacity**（GPU 合成）；③ tooltip 跟随的 mousemove 高频响应式更新 —— **rAF 合并**；④ 运行光环首版用 **`stroke-dashoffset` 动画沿圆角方框流转 —— 该属性不在浏览器合成器加速白名单（仅 transform/opacity 等），每帧主线程 style→paint，构成永不停歇的基底负载**（与轮询/filter 尖峰叠加放大卡顿）—— **改为 StarAvatar 同款 `transform: rotate()` 旋转 SVG 组方案**（合成器线程/GPU，主线程零开销；方形格子不能旋转 → 光环取内切圆形，视觉更贴近头像光环语言）；后端统计本身有 mtime/size 缓存（首屏一次性逐行分桶，此后仅文件变化才重算），非持续卡顿源。
  - **矩阵**：头像轴（群/system/未知用图标徽）、下三角 + 对角线为主、**上三角有会话数据时同样可 hover/点击**（cellKey 排序使镜像格共享会话数据；弱化浓度呈现，无数据镜像保持斜纹占位）；`chat~x~x` 与旧 `chat~x~self` 归一落对角线；格子纯颜色（无数值）。
  - **hover 十字聚焦（整行/整列底色带）**：grid 容器上两层绝对定位色带（横 = hover 行、纵 = hover 列，主色 10% 透明，按几何定位 `190px 表头 + i×(40+5)` 计算）铺在**格子图层之下** —— 色带只出现在 gap 与透明格上，有浓度色的格子覆盖其上；十字以"底色通道"呈现，**完全不触碰格子颜色**。hover 格仅细主色 inset 描边（不放大、无光晕、无颜色改动 —— 前两版外环/放大方案在圆角与 gap 上观感不佳，已废弃）；非十字区域照旧置灰衬托。
  - **美化 tooltip**（Teleport 悬浮卡，跟随鼠标并防溢出）：两端点头像与名称、关系（1v1/自会话/群本体/群参与）、范围内/总量消息数、最后活跃、参与证据、运行中 run（来源 + 时长 + 摘要）；有会话时才显示"点击进入会话"提示。
  - **点击格子进入会话**（上/下三角均可）：群格子 → 群聊；viewer 参与的 pair → 直接对话（**显式 `chatStore.loadHistory` + 清未读 + 活跃时订阅流式** —— 修复此前从矩阵进入 user 配对格落在空白会话的 bug：只切 activeAgentId 不加载历史）；其余（Agent↔Agent / 自会话 / ↔system）→ **pair 只读视角，返回时回到矩阵**（进入不关矩阵视图，`closePairView` 后矩阵回归，避免落到无选中的空白聊天区；`closeTrackingView` 连带清 pairView 防悬挂）。pair 视角**完全复用 DialogView 的消息区布局与样式**（同一套 `chat-header` / `messages-container/content` / 分隔符 / `TurnDisplayItem` 渲染管线 / 回到底部按钮 / `useChatShell` 滚动外壳）；对齐基准 = viewer → 两端点都不是 user 时**双方全部左气泡**；数据走 feed 新增 `pair:` 分区（`loadPairHistory`/`loadOlderPairHistory`，REST 分页前插保持滚动位置；`pairMessageToChatMessage` 保留 event/system/error 角色、透传思维链/工具调用）；头部最左返回按钮，只读无输入框。
  - **群参与过滤**：群本体只落群对角线；agent×群格子需参与证据（周归档 `sessions/group~<gid>/archive/<aid>/`（真实磁盘结构）/ 运行中 / 旧格式会话键）；按人消息比例归属留作后续。
  - **覆盖面分析**（页脚面板）：矩阵外 single~ 独立会话与残留端点明示。
- **共享数据源**（`stores/runs.ts`）：面板与主视图共用单一轮询（3s + 1s 时钟）。
- **会话列表新增按钮**：虚线幽灵样式 + **主文字色（默认黑）加粗** —— 可辨识但不过分抢眼（hover 才染主色）；此前版本先后为灰色幽灵（太融入）/实心主色 CTA（太抢眼），本轮取中。
- **后端**：`GET /api/runs` 快照 + `POST /api/runs/interrupt`；`AgentRouter.listRunning()`（running 条目补 startedAt/source）；`SubAgentManager.listAll()`。
- **测试**：`src/host/server/tests/runs.test.ts`（7 例）；`http-routes-e2e` 扩展 `/api/runs` 断言。全量 835 通过。

### Fixed（GLM 缓存 token 统计恒为空：未识别 usage.prompt_tokens_details.cached_tokens）
- **现象**：GLM（智谱）对话的「缓存命中/未命中/命中率」统计与用量 API `total_cache_hit/miss` 恒为 0，而智谱平台后台实际存在上下文缓存（隐式缓存）命中。
- **根因**：usage 归一化单点 `extractUsage`（`@agentchat/llm-openai`，GLM 继承基类）只识别 **DeepSeek 顶层字段** `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`；GLM 官方[对话补全 API](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E9%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8)返回的是 **OpenAI 风格嵌套字段** `usage.prompt_tokens_details.cached_tokens`（「命中的缓存 Token 数量」，见[上下文缓存](https://docs.bigmodel.cn/cn/guide/capabilities/cache)），字段名与层级均不同 → 永远解析不到。
- **修复**（`extractUsage` 单点收敛，GLM/OpenAI 同格式一并受益）：识别 `prompt_tokens_details.cached_tokens` 并归一化为内部统一字段——`prompt_cache_hit_tokens = cached_tokens`；未命中数协议不提供，按 `prompt_tokens − cached_tokens` 推导（下限 0）填入 `prompt_cache_miss_tokens`；DeepSeek 顶层字段并存时优先（显式语义 > 推导值）；`cached_tokens` 为 null/非数字时不产出缓存字段。下游全链路（agent-loop 跨 step 累加 → agent-session 落盘 jsonl → usage API 聚合 → WebUI 用量面板）消费的即这两个统一字段，零改动自动生效。
- **测试**：新增 `src/core/llm-openai/tests/usage.test.ts`（11 例）——GLM 官方响应示例回归（1200/800 → hit 800/miss 400）、cached_tokens=0 全未命中、全量命中 miss=0、超 prompt_tokens 防御收敛、null 容忍、流式末 chunk usage 同路径、DeepSeek 顶层透传回归、双源并存优先级、无缓存信息不产出字段、异常输入。
- 文档同步：`docs/plugins/core-llm.md`（GLM 节 + 测试清单）、`@agentchat/llm` 契约注释、GLM 适配器头注释（官方文档链接）。

### Fixed（bash 命令沙箱误判 here-string/heredoc 载荷里的正则字面量：/const\\s+/ 被当成 Unix 路径 /const/）
- **现象**：把一段 GLSL 检查脚本经 `@'…'@ | Set-Content -Encoding UTF8 test-glsl.mjs; node test-glsl.mjs` 写盘执行，整条被拦：「命令包含 Unix 绝对路径（/const/）访问」——命令里根本没有这个路径。
- **根因**：`bashCommandViolation` 分析前把**所有反斜杠归一化为斜杠**，脚本里 JS 正则字面量 `/const\s+([A-Z_0-9]+)…/` 变成 `/const/s+…`——空格 + `/const/` 恰好命中 Unix 绝对路径启发式（`(?:^|\s)\/[\w.-]+(?:\/|$)`）。写代码文件再执行本就是工具提示推荐的做法，扫描载荷代码必然误判。
- **修复**（`@agentchat/shell` `tools.ts`）：新增 `stripHeredocPayloads`——分析前剥离 here-string（`@'…'@`/`@"…"@`，开标记行尾、闭标记行首，惰性匹配到首个闭标记即止）与 bash heredoc（`<<'X'`/`<<"X"`/`<<X`，闭定界符独占一行；`<<X` 要求后随空白/重定向/EOL，避开位移运算 `a << b`）载荷，替换为占位符；载荷之后同一行的管道/命令（`| Set-Content …`）与写盘目标**照常受检**。剥离正则匹配失败时保留原文继续扫描——方向上只会多拦不会漏拦。已知残留误报（文档记录）：引号内直接执行的代码（`node -e "…正则…"`）不在剥离范围。
- **测试**：新增 6 例——用户实报命令回归、载荷含真实路径样式文本（`C:/Windows/…`、`/etc/passwd` 样例）放行、双引号 here-string、载荷后的违规命令/写盘目标（盘符+Unix）仍拦、bash heredoc 同剥离且闭定界符后受检、位移运算不误剥（其后的真实路径仍拦）。

### Fixed（工作区"选择文件夹"弹窗观感：换用系统现代文件夹选择器）
- **现象**：新增工作区时点"选择文件夹"弹出的是 XP 风格的树形小窗，与系统原生观感不符。
- **根因**：`/api/browse/folder`（`api/browse.ts`）经 PowerShell 调 WinForms `FolderBrowserDialog`——它包装的是上古 `SHBrowseForFolder` COM 树形对话框，WinForms 没有现代版；Windows Vista+ 的原生现代选择器是 `IFileDialog` + `FOS_PICKFOLDERS`（地址栏/搜索/收藏夹，与资源管理器同款），无托管包装、需 P/Invoke。
- **修复**：`browse.ts` 内嵌 C# interop 源（`IFileDialog` 完整 vtable 声明至所需槽位 + `SHCreateItemFromParsingName` 未用即未含），经 `Add-Type` 编译后 `Pick(title)`：`GetOptions`→OR `FOS_PICKFOLDERS|FOS_FORCEFILESYSTEM`（AND-NOT `FOS_FILEMUSTEXIST`）→`SetTitle`→`Show(GetForegroundWindow())`（前台窗口作 owner，避免弹窗落到主窗后面）→OK 后 `GetFileName` 即选中文件夹路径。**interop 槽位已在本机实测验证**：`GetOptions` 返回标准组合 `0x1808`（SetOptions/GetOptions 槽位正确）、`SetFileName/GetFileName` 回读一致（13/14 槽正确）、`Show` 模态真实跑通（owner 关闭→取消返回）；成品脚本端到端验证：后台运行→ESC 取消→输出 `__CANCELLED__` 退出码 0。降级路径：`Add-Type` 编译失败或 Pick 异常时 catch 回退旧 `FolderBrowserDialog`（保功能可用）；输出协议不变（路径一行 / `__CANCELLED__`），前端零改动。另两处顺手修复：①两个 browse 端点 PS 脚本前置 `[Console]::OutputEncoding = UTF8`——非 ASCII 选中路径经 stdout 回传不再乱码（此前中文路径会损坏）；②spawn 参数加 `-STA`（IFileDialog 需 STA 线程，powershell.exe 5.1 默认 STA、显式声明兜底）。
- **测试**：新增 `src/host/server/tests/browse.test.ts`（5 例）：C# 源内嵌要素（IFileDialog GUID/FOS 常量/入口）、here-string 边界（`'@` 必须行首——缩进即 PS 语法错误）、标题单引号转义（`'`→`''`）、现代/回退双路径与 `__CANCELLED__` 协议、UTF-8 输出行。

### Fixed（str_replace_editor insert 位置语义的提示缺口：主描述只讲端点，中间值靠猜）
- **现象**：模型用 insert 插中间位置后自我怀疑（实拍：`insert_line=310 是零基行边界，插到第 310 行之后？……让我查看文件尾部`），需要回读文件验证才敢继续——位置换算没有权威文本可依。
- **审计结论**：实现**无 off-by-one**（`lines.slice(0, N)` + 新行 + `lines.slice(N)`：边界 N = 第 N 行之后/第 N+1 行之前；0=开头、=行数=尾，测试已钉住）。**已对照 DSH 上游源码**（`@deepseek-ai/dsh-tool-str-replace-editor/lib/index.js`）逐点核验：insert 算法逐行等价（slice/splice、[0, 行数] 校验）、view_range 校验净行为一致、`presentCall` 的 `line = insert_line + 1` 印证落点语义；上游 insert 语义只写在参数描述——**"The `new_str` will be inserted AFTER the line `insert_line`"**（插到第 N 行之后，行号与 view 显示的 1 基一致），默认 description 甚至完全不提 insert。移植版缺陷在主 description 的 insert 子句只讲两个端点，且「零基」边界术语诱导 L−1 换算歧义。
- **修复**（`@agentchat/str-replace-editor` `tool.ts`，按上游「行后」框架收敛措辞）：①主 description insert 子句：「把 new_str 插到第 insert_line 行之后——行号 1 基、与 view 显示一致：要插在你看到的第 L 行之后，直接传 L 即可，无需换算；0=插到文件开头（第 1 行之前）；=总行数=插到文件尾（以换行结尾的文件行数含一空尾行，与 view 的 total_lines 一致）」——常见场景零换算，替代初版修复引入的「零基边界 + L-1」表述；②参数描述同步同一框架；③成功消息改双表述自校验：「insert_line=310 → 第 310 行之后 / 第 311 行之前；文件现 N 行」（0/尾部分支单独措辞「文件开头/文件尾」），模型无须回读即可核对落点。
- **测试**：insert 用例扩充消息断言（insert_line 回显 / 中间值双表述 / 0=文件开头 / 尾=文件尾 / 多行 new_str 后总行数）；新增「文件以换行结尾」行为钉子——`'a\nb\n'`（split 含空尾行共 3 行）边界 3 插在末尾换行之后（`'a\nb\n\ntail'`）、边界 2 插在结尾换行之前（`'a\nb\nmid\n\ntail'`），与 DSH/SWE-agent 语义一致并显式钉住；新增**描述文本回归钉子**（主 description 与 insert_line 参数描述必须含「插到第 insert_line 行之后」「直接传 L 即可，无需换算」等关键措辞——本次缺陷本质是提示缺陷，钉住措辞防回退）。

### Fixed（独立会话（single）隔离：同 Agent 多会话串台 / 流式不显示 / 跨会话误中断）
- **现象**：①同一 Agent 开多个 single 会话（或 single 与 1v1 并存）时，A 会话的流式内容出现在 B 会话里（刷新后也串）；②single 视角看不到流式输出——回复一次性弹出或完全不显示（刷新才有）；③在 B 会话发消息/点停止会误杀 A 会话正在跑的 run；④别的会话流式时，当前会话输入框误显「打断并发送」。
- **根因（后端按 agentId 匹配，缺会话维度）**：`WSHandler` 的快照/订阅/中断全部按 agentId 匹配——`updateSessionSnapshot` 把事件写进同 Agent 的**所有** activeSessions 快照（A 的流式污染 B 的快照）；`handleChatSubscribe` 跨连接 `findAgentSnapshot` 按 agentId 取第一个匹配（订阅 B 拿到 A 的快照，resume 只有 agentId，前端按激活上下文猜路由 → A 的内容并进 B）；`handleChatInterrupt` → `router.abortSession(agentId)` 全杀该 Agent 的会话。
- **根因（前端门控/全局态）**：feed 的 `isForActiveAgent` 用 **direct 列表选中项**做门控——用户先选过 Agent X 再进 single 会话（Agent Y）时 `chatStepStart` 被跳过 → 分区里没有流式占位 → 正文增量全部丢弃（chat.end 兜底才一次性弹出）；`turnInProgress` 是全局的，驱动 ChatInput 的「打断并发送」与发送前自动打断（`if (turnInProgress) interruptGeneration()`）→ 跨会话误杀。
- **修复（后端）**：`ActiveSession` 记录 `dialogKey`（convKey：single~<sid> / chat~<lo>~<hi>，send/continue 两处登记）；`updateSessionSnapshot` 事件带 dialogId 时按会话键**精确**匹配（无 dialogId 回退 agentId 兼容）；`chat.subscribe`/`chat.interrupt` 接受 `data.session`——订阅按 `conn:single:sid` + 跨连接 `findDialogSnapshot(single~sid)` 精确取快照并回显 `session`；中断走新增 `router.abortDialog(convKey)`（会话级精确中止，不影响同 Agent 其他会话），pair 路径行为不变。
- **修复（前端）**：feed 新增 `gatingAgentId`（single 视角 = 会话登记的目标 Agent，非 direct 选中项）驱动 `isForActiveAgent`；`onSessionResume` 快照带 `session` 时精确路由到对应 single 分区（历史未到先挂起，`onHistory` 首屏按 session 匹配补合；旧载荷回退 agentId 比对）；chat store 订阅/中断带 session；`sendMessage` 发送即置当前分区 `streaming`（stepStart 前无空窗）；新增 `contextBusy`（当前 dialog 的 per-partition 流式态）替代 ChatInput 中的全局 `turnInProgress`（按钮样式 + 发送前打断均不再跨会话联动）；`onMessageError` 回落分区流式态防卡死。
- **测试**：router 新增 `abortDialog` 用例（同 Agent 两个 single 会话并行，精确中断 s1、s2 不受影响跑完）。全局 `turnInProgress` 仍保留（活动指示器/中断恢复等全局信号）；TurnDisplayItem 的思考区自动展开仍用全局态（展示性小噪声，未动）。

### Fixed（bash 命令沙箱误拦截 URL：https:// 被当成 S: 盘）
- **现象**：`curl.exe -sI --max-time 10 https://unpkg.com/three@0.160.0/build/three.module.js | Select-Object -First 5` 整条被沙箱拦截，报「命令包含绝对路径（S:）访问…」——命令里根本没有 S: 盘。
- **根因**：`bashCommandViolation` 盘符正则 `[A-Za-z]:[\\/]` 无边界约束：`https://unpkg.com` 中 scheme 尾字母 `s` + `:` + `//` 恰好命中「字母+冒号+斜杠」，提取出 `s:/unpkg.com/...`，resolve 后不在白名单 → 拦截。同根因误杀一片：`http://`/`ftp://`/`wss://` → `P:`，即所有含 URL 的命令（curl / Invoke-WebRequest / git clone https://… / fetch wss://…）。
- **修复**（`@agentchat/shell` `tools.ts`）：盘符匹配加 lookbehind `(?<![A-Za-z0-9_])[A-Za-z]:[\\/]`——盘符前邻必须是行首或非「字母/数字/下划线」字符（空格/引号/等号等）；URL scheme 的冒号前是字母序列，不再命中。真实盘符路径行为不变：段首 `C:/x`、引号内 `"C:\Windows\win.ini"`、`-o C:/out.bin`、`robocopy src D:/out` 照常拦截；`file:///C:/…` 中 `C:/` 前邻是 `/`（非字母）仍会被拦——读本地文件的 file URL 本就属越界访问。`$env:VAR`/`%VAR%` 变量展开维持原有排除（冒号后无斜杠）。
- **测试**：新增 `src/shell/shell/tests/tools.test.ts`（8 例，该函数此前零测试）：用户实报命令回归、http/ftp/wss/userinfo:port/多级路径 URL 放行、URL 与真盘符混排只报真盘符、白名单外盘符（`\` 与 `/` 写法）/Unix 绝对路径/`cd ..`/`../` 引用仍拦、白名单内绝对路径与纯相对路径命令放行。

### Added（极简预设人设提示词）
- **预设定义改数据文件驱动**（DSH `config/agent-presets/<name>/` 同形态）：`presets/<name>/preset.json`（展示元信息 label/description/default/**order**，对应 DSH preset.yml）+ `config.json`（AgentConfig 主体，对应常规 Agent 的 agents/<dir>/config.json）+ 可选 `AGENT.md`（人设，与常规 Agent 同一约定）。`loader.ts` 启动时扫描装载（label/agent_id/name 必填校验、frontmatter 剥离、order 升序）；新增预设 = 加一个目录，零代码改动。原 `presets/standard.ts` / `minimal.ts` TS 硬编码删除。
- **`AgentConfig.persona` 内联人设**（`agent-prompt` 装配）：`buildSystemPrompt` 默认装配路径在无 `AGENT.md`（或无 agents/ 目录实体）时以 `## 角色\n<persona>…</persona>` 块注入 config.persona——预设 Agent（`__minimal__` 等）不在 agents/ 下，人设此前只能为空；loader 把预设目录的 AGENT.md 读入该字段。优先级：目录实体 `AGENT.md` > config.persona > 无角色块；空白 persona 视同无人设。
- **极简预设（`__minimal__`）带人设**（`presets/minimal/AGENT.md`）：惜字如金、直给结果——不解释过程、成功改完只回一行确认（含路径）、失败只报关键行、不闲聊不建议。与工具面（仅 str_replace_editor / bash）同一减法哲学。标准预设保持无人设（通用对话定位）。
- 测试：persona 注入 4 例（AGENT.md 优先 / 内联主路径 / standard 无角色块 / 空白容忍）+ presets 数据装载断言（order 排序 / allowlist / AGENT.md → persona）。

### Fixed（会话静默中断排查：SSE 损坏分片不再静默跳过）
- **现象**（8/19 21:57 agent_chat_dev 会话）：思考流 + 正文流完整落盘（正文以冒号收尾、思考里明确"先试第一个调用"），`tool_calls` 整体缺失；流以 [DONE] 干净终止 → 截断检测未命中 → `processStep` 判定"无工具调用，正常结束"→ run 正常闭合（同秒 usage 落盘、无 error 消息）。UI 表现为回复戛然而止、无任何报错。
- **复现验证（23/23 全部正常，排除工具格式问题）**：三层保真度直打 GLM coding 端点抓原始 SSE——①同 schema 单工具×10；②28 工具 + 交错历史 + reasoning_content 回传 + "继续"×10；③**真实会话 363 条消息全量回放**（经应用自身 `GLMChatLLM.toProviderMessages`/`buildRequestBody` 构建）×3。全部 `finish=tool_calls`、零损坏分片；且复现出的 content 尾巴与事发消息风格一致（"……基本流："以冒号收尾后紧接 tool_calls）——证实事发时 tool_calls 本应紧跟其后、属单次传输丢失而非格式不兼容。
- **根因结论**：单次瞬时事故（服务端 SSE tool_call 增量丢失但补发 [DONE]，或客户端损坏分片被 `catch {}` 静默跳过）。8/17 的流完整性检测只覆盖"FIN 无 [DONE]"变种，[DONE] 在场的增量丢失对其免疫；协议上无法区分"模型说完了"与"增量丢失"，不做启发式拦截。
- **修复**：损坏分片解析失败时 `log.warn` 留下截断预览（不再静默），同类事故可从日志定位。用户侧恢复：对会话发"继续"即可（continue_turn 兜底，上下文完整）。
- **复现验证（23/23 全部正常，排除工具格式问题）**：三层保真度直打 GLM coding 端点抓原始 SSE——①同 schema 单工具×10；②28 工具 + 交错历史 + reasoning_content 回传 + "继续"×10；③**真实会话 363 条消息全量回放**（经应用自身 `GLMChatLLM.toProviderMessages`/`buildRequestBody` 构建）×3。全部 `finish=tool_calls`、零损坏分片；且复现出的 content 尾巴与事发消息风格一致（"……基本流："以冒号收尾后紧接 tool_calls）——证实事发时 tool_calls 本应紧跟其后、属单次传输丢失而非格式不兼容。
- **根因结论**：单次瞬时事故（服务端 SSE tool_call 增量丢失但补发 [DONE]，或客户端损坏分片被 `catch {}` 静默跳过）。8/17 的流完整性检测只覆盖"FIN 无 [DONE]"变种，[DONE] 在场的增量丢失对其免疫；协议上无法区分"模型说完了"与"增量丢失"，不做启发式拦截。
- **修复**：损坏分片解析失败时 `log.warn` 留下截断预览（不再静默），同类事故可从日志定位。用户侧恢复：对会话发"继续"即可（continue_turn 兜底，上下文完整）。

### Fixed（预设 Agent 泄入 Agent 协作空间：list_agents 过滤 + send_agent 拒绝）
- **`list_agents` 过滤预设 Agent**：`registry.listIds()` 含物化的 `__standard__`/`__minimal__`，此前每个 Agent 的协作清单都把它们列为可投递对象（与 `/api/agents` Agent 列表的 `preset: true` 过滤口径不一致）。
- **`send_agent` 拒绝预设目标**：向 `__standard__` 投递会开出 `chat~<from>~<preset>` 幽灵 pair 会话（预设 Agent 本应只服务 single~ 会话），现在直接返回错误说明。
- 背景（排查记录）：agent_chat_dev 会话出现「我当前 standard 预设没启用它」——非路由侵入（消息 agent_id/工具集均正确），是该 dev Agent `code_search` 读到仓库内 agent-presets 预设定义注释（「str_replace_editor 不进 standard」）后的措辞借用；顺手封堵了上述真实的协作空间泄漏。

### Added（文件发现与单工具编辑器：glob / grep / str_replace_editor，DSH 语义移植）
- **`@agentchat/fs-search` 包（glob + grep 工具，插件行 `agentchat-fs-search-tools`）**：参考 DSH `dsh-tool-fs-search` 的纯 TS 移植（DSH 由打包 ripgrep 驱动，此处原生遍历，零新增依赖）。`glob`：模式不含 `/` 时匹配任意深度的文件名（`*.ts` 匹配整棵树）、含 `/` 时锚定相对路径（支持 `**` 跨层级、`{a,b}` 交替、`[...]` 字符类）；只返回文件、包含隐藏文件；跳过 `.git`/`node_modules`/`__pycache__` 与敏感黑名单（`isDeniedPath`，与 read/write 同口径）；按修改时间从新到旧排序，内联上限 100 条（超出保留最新部分并提示）。`grep`：正则内容搜索，按文件分组返回 `Line N: <预览>`；`include` 单个正向 glob 过滤（`*.{ts,tsx}` 花括号交替合法，逗号列表/否定值拒绝）；内联上限 250 条匹配、每行预览 2000 字符（截断带标记）；二进制（含 NUL）跳过；`path` 可为文件（直搜，include 不适用）或目录；无效正则/越界路径返回结构化错误。
- **`@agentchat/str-replace-editor` 包（str_replace_editor 工具，插件行 `agentchat-str-replace-editor-tools`）**：DSH `dsh-tool-str-replace-editor`（SWE-agent 经典单工具编辑器）语义移植。单工具四命令：`view`（文件 `cat -n` 风格行号 + `view_range=[起,止]`（1 基，-1 到文件尾）；目录下探两层列表，跳过隐藏/`node_modules`/`__pycache__`）、`create`（已存在拒绝，自动建父目录）、`str_replace`（`old_str` 字面量唯一匹配替换——零匹配/多匹配都失败且不落盘，多匹配报出全部行号；`new_str` 缺省为删除）、`insert`（零基行边界插入，多行按行 splice，不隐式补尾换行）。字面量操作保留编辑范围外内容（制表符/CRLF 原样）；查看输出 16000 字符截断（提示先用 grep 定位）；修改后 `recordSnapshot` 同步 hashline 快照（与 write 工具 P0-2 同口径，保证随后的 `edit` 行哈希校验可用）；路径走 `resolveSafePath` 沙箱。
- **预设接线**：standard 预设新增 `agentchat-fs-search-tools`（glob/grep 默认启用，与 DSH standard 的 tool-fs-search 对应；str_replace_editor 不进 standard，与 read/write/edit 重叠——DSH 同样只在 minimal 配编辑器）；minimal 预设改为仅 `str_replace_editor` + `bash` 两件工具（与 DSH 极简模式组合完全一致：文件查看/编辑全走 str_replace_editor 的 view/create/str_replace/insert，发现靠 bash；fs 域 read/write/edit 整行退出 presets，exclude 防御性再排除一遍）。security 钩子 `DANGEROUS_TOOLS` 加入 `str_replace_editor`（Agent 配置目录拦截，`args.path` 提取已有覆盖）。loader 内置插件目录同步两条新行；bundle-rows 重新生成。
- 测试：`src/fs/fs-search/tests/tools.test.ts`（15 例：glob 深度/锚定/交替/上限/跳过规则，grep 分组/过滤/截断/二进制/单文件）、`src/fs/str-replace-editor/tests/tool.test.ts`（12 例：四命令全语义 + CRLF 保留 + 快照同步 + 沙箱拒绝）、presets 测试加强新 owner 断言。

### Changed（空白会话全局唯一）
- **`SinglesService.create` 前置清理遗留空白会话**（`purgeEmptySessions`：未选 Agent 且无消息 → 硬删，无数据可失；不区分 workspaceId，空白会话不属于任何分组）：保证任一时刻最多存在一个空白会话。此前的 `?reuse=1` 复用路径依赖调用方自觉，绕过它的创建（如 `create({agentId})` 后遗留旧空会话）不再堆积；规则 1 落地后「选 Agent 又清空」路径也被删除，堆积来源全部封堵。有消息 / 已选 Agent 的会话不受影响。测试新增「create 清理遗留 × 2、保留有消息与已选 Agent 会话」用例。

### Fixed（刷新恢复会话选择：lastContext 统一持久化）
- **统一持久化键 `agentchat.lastContext`**（`{kind: agent|group|single, id}`，最后写入者胜）：替代旧散键 `agentchat.lastAgent` / `agentchat.lastGroup`（读取时自动迁移），消除三类上下文互斥漂移——此前「选独立会话后刷新会错误恢复旧群组」「选 Agent 后刷新群组记录未清导致双恢复」。
- **独立会话选择刷新恢复**（此前完全丢失）：App 挂载拉完 singles 列表后 `restoreLastSingle()` 恢复选中（历史由 DialogView single watch 加载；会话已删/已归档则清掉过期记录）。
- **群组恢复加守卫**：`groups.init` 仅当上次上下文是群组才恢复；恢复后群组已不存在 → 放弃并清记录。
- **列表页签持久化**：`agentchat.listPanel`（agents / sessions），刷新后保持上次所在的列表页。
- 恢复链路互斥保持：agent 恢复（chat.onAgentListResponse → tryRestoreLastAgent）读取统一键，kind 非 agent 不恢复；`clearLastContextIf(kind)` 只清匹配类型（选会话时触发的 deselectGroup 不会误清 single 记录）。

### Changed（独立会话三项交互修正：预设锁定 / 预设设置入口移除 / 会话列表工作区树）
- **已有消息的会话禁止修改预设**（规则 1）：`SinglesService.update` 在会话有消息（messages.jsonl 存在且非空）时拒绝 `agentId` 变更（同值 no-op 放行），错误经 PATCH 返回 409「已存在消息的会话不能更换预设/Agent」——历史消息归属身份与投递目标绑定在所选 Agent/预设上，中途更换会错乱。前端输入栏 Agent 下拉同步锁定（锁图标 + tooltip 说明；`lastActivity` 或 feed 分区非空即视为有消息，覆盖首轮流式期间文件未落盘的窗口）。
- **移除预设 Agent 的设置按钮**（规则 2）：预设 Agent（`__standard__` / `__minimal__` 等插件内置预设）无实体配置，会话头部不再显示「Agent 配置」设置入口（agents store 新增 `isPreset`；System Prompt / 工具定义预览仍可用——预设已物化进注册表）。
- **会话列表改为工作区树布局**（规则 3，自上而下）：①「新增」按钮（新建会话）→ ② 工具栏「工作区」文本 + 纯 ICON 新增工作区按钮 → ③ 树列表：用户工作区为根节点（按名称排列），各 session 为叶节点（未挂工作区的会话归入固定「未分组」根，排在末尾）。移除旧搜索框与平铺列表。

### Changed（会话列表与输入栏细化：单行会话 / 工作区节点收纳 / 输入栏工作区选择）
- **树/叶节点统一风格**：工作区根节点与会话叶节点同高度（30px 固定行高）、同垂直间距（`--space-xs`）、同圆角/hover 效果（hover 底色 + 边框 + 微影）与操作按钮尺寸（22px），层级仅以左缩进与图标区分。会话头像（StarAvatar 15px）与树节点文件夹图标尺寸一致。
- **无头像默认图标**（`bot`）：`Avatar`/`StarAvatar` 新增 `fallbackIcon` 属性——无图（或图片加载失败）时渲染图标而非首字；应用于小尺寸场景（会话列表 15px、输入栏 Agent 按钮/下拉 18px），首字在 6~8px 下不可读。保留身份色底（color-mix 14%），大尺寸（消息/侧栏/Agent 列表）仍用首字回退。
- **会话条目压缩为单行**：头像 - 标题 - 删除按钮（移除「Agent 名 · 时间」副行；完整信息移入条目 hover tooltip），行高与内边距同步收紧。
- **工作区根节点收纳**：移除折叠箭头（整行点击展开/收起，文件夹 open/closed 图标即状态）与 session 数量统计；hover 显示「更多」（重命名 / 删除，下拉菜单）+「新增会话」两个按钮；新增重命名弹窗。
- **输入栏新增工作区选择**（Agent 选择之前）：显示会话当前所属工作区（未挂载 = 「未分组」），下拉切换即时 PATCH `workspaceId`——随时可换，不受「已有消息锁定预设」限制（工作区只影响沙箱白名单与分组，不绑定消息身份）。

### Added（用户工作区：会话分组的文件夹白名单区域）
- **概念**：用户工作区 ≠ 数据目录（workspace/default）——是用户登记的一个本机文件夹（白名单区域）。挂在其下的独立会话运行时把该文件夹并入沙箱路径白名单：Agent 的 read/write/edit/bash 可访问该目录，系统提示词同步出现「路径穿透白名单」行。存储 `workspace/default/workspaces/<id>/workspace.json`。
- **后端**：`WorkspacesService`（CRUD：路径必须是存在的文件夹、同一路径只允许登记一次、删除只摘登记不动会话）+ `/api/workspaces`（GET/POST/PATCH/DELETE）；`SinglesService`/`/api/singles` 支持 `workspaceId`（创建/改挂/移入未分组，目录校验）；`POST /api/browse/folder` 原生文件夹选择对话框（FolderBrowserDialog）。
- **白名单链路**：WS `chat.send`/`chat.continue` 解析 session.workspaceId → RouterMessage `data.sessionAllowedPaths` / TriggerOptions.sessionAllowedPaths → `createAgentContext` 新增 `extraAllowedPaths` 合并进 effective config 的 `security.allowedPaths`（不落盘、不改 Agent 原配置；resolveTools/resolveHooks/systemPrompt 消费，reload 补丁重烘焙沿用）。
- **前端**：workspaces store + 会话列表树（工作区节点 hover 可「+ 在此新建会话」/「删除登记」；新增工作区弹窗 = 原生文件夹选择 + 名称确认）；空工作区也显示（可挂新会话）。
- 测试：`host/server/tests/workspaces.test.ts`（5 例：CRUD/校验/重名/损坏容忍）、singles 新增规则 1 锁定 + workspaceId 挂载用例、`agents/config.test.ts` 新增 extraAllowedPaths 合并/透传用例（原 isEmpty 用例改为落盘构造——中途清空 Agent 的旧路径已被规则 1 正确禁止）。

### Added（L1.5 主动模块重载：reload_modules 工具 + 水位线发现 + 中断-续跑-补丁）
- **`reload_modules` 工具（dev）**（`@agentchat/dev/src/module-reload.ts`，`docs/restart-design.md` §2 已拍板项）：dev 改完 `src/` 下后端源码后**宣告完成**（任意写法——edit/bash sed/heredoc/git checkout/格式化器/代码生成器均覆盖），机械发现变更集：水位线扫描（`mtime ≥ 上次成功重载时刻`，初始化 = 进程启动）→ file:// URL 与 ESM loadCache 求交（只关心已加载模块）→ externals 分类；`files` 参数可显式补充（取并集，不信任自报清单）。多文件关联修改（重命名导出 + 改用方）= 一个事务，改完宣告一次。
- **中断-续跑-补丁链路**：工具只发现与宣告（`ToolInterrupt({type:'reload-requested', scope:'modules', files})`），真正重载在装配层中断处理器（`agents/config.ts` handler 分支：**先 `ctx.hmr.reloadFiles` 后 `resolveTools` 重新烘焙**——顺序反了烘出的还是旧闭包）→ `continue + patch` → 本 run 下一 step 用新闭包，会话/WS 不断。`ReloadScope` 联合类型加 `'modules'`；`InterruptReason.reload-requested` 携带 `files`；`describeInterrupt` 渲染清单（避免静默重载）。
- **vendored hmr 主动 API**（`src/vendor/hmr`）：`ctx.hmr.reloadFiles(urls)`（stash → partialReload 机器：依赖图扩散、双缓存清除带备份、ESM+CJS、重导入失败自动回滚旧模块、fiber 行链接保留）；externals（框架/内核文件）命中**拒绝并导向 system_restart**（不再 `loader.exit()` 全量退出）；每次调用为独立事务；成功后推进 `watermark`。另公开 `isExternal/isLoaded/watermark` 供水位线扫描器。`lib/index.js`（esbuild）与 `lib/types` 同步重建。
- **hmr 组合行启用**（`composition.base.yml`）：`disabled: true` → 启用 + `root: []`（关被动 watcher 只保活重载机器——被动文件监视 HMR 明确不采用，半写文件触发重载/防抖中间态等问题见 §2.2）；`gen-bundle-rows.mjs` 增加 `LOADER_ONLY_IDS`（hmr 行不进 dist 直调路径生成物）。`reload`（配置）工具的源码变更警告从「请改用 system_restart」改为「请改用 reload_modules（框架文件除外）」，且水位线感知（成功重载后不再误报）。
- **失败语义**：新代码导入失败 → 双缓存回滚旧模块 → 旧树继续跑 → 错误经 next-step 续跑消息反馈 agent（可修复后重试）；对比 42：进程重启撞上坏代码 = 新进程起不来 = supervisor 退避循环 = 停机。
- 测试：`agent-loop` 中断/loop 续跑（清单渲染 + 失败续跑消息）、`agents` handler 分支（先模块后烘焙时序）、`dev` 扫描/计划/工具（externals 拒绝、显式并集、HMR 不可用降级）、`boot` 子进程 e2e `hmr-reloadfiles.e2e.test.ts`（`--expose-internals` 真树：v1→v2 模块换血生效 + 水位线推进 + externals 拒绝）。

### Fixed（L3 supervisor 协议加固：78 退出码 + 退避熔断 + worker 信号接线 + 幂等守卫，P0×2）
- **78 退出码（EX_CONFIG）**：启动期配置/组合失败（组合树 ready 之前：组合解析失败、workspace 门禁被他实例持有等）以 78 退出，supervisor **不重拉**——消灭「补丁层写错一个字段 → 每 1.5s 无限重拉」死循环（`loader-boot.ts` / `bootstrap.ts`）。ready 之后的失败仍为崩溃类（退避重拉）。
- **supervisor 退避 + 熔断**（`supervisor-policy.ts` 纯函数策略 + `supervisor.ts`）：崩溃退出从固定 1.5s 重拉改为指数退避（base 1.5s ×2 cap 60s，jitter ±20%）；存活 ≥30s（bootOk）退避归零；10min 窗口内 5 次崩溃 → 熔断退出（supervisor 自身非 0 退出，不再无限拉起）；42（主动重启）保持固定 1.5s 且不计退避；每次监护决策一行结构化日志。策略状态机独立成模块可单测（协议矩阵 0/42/78/崩溃退避/bootOk/窗口剪枝/熔断/jitter）。
- **统一 worker 信号接线**：dev/Loader 路径（`loader-boot.ts`）此前无 SIGINT/SIGTERM 处理（Ctrl+C 硬退出、会话可能不落盘），现与 dist 直启路径一致接线 `gracefulShutdown`（排空 → 落盘 → 退出）。
- **gracefulShutdown in-flight 幂等守卫**：共享控制台 Ctrl+C 父子双达、IPC+信号并发时关闭流程只跑一次（首次调用的退出码生效）。
- **`system_restart` 工具指引改写**：普通插件/工具/钩子源码改动优先 `reload_modules`（零中断、失败可回滚）；42 留给框架/内核文件、env/依赖、堆/状态异常。supervisor 信号转发注释修正 Windows 事实（`child.kill()` 是硬终止，定向优雅关闭需 IPC——Phase 3）。

### Fixed（LLM 流式调用网络健壮性：瞬时失败重试 + 连接池管控 + 流截断检测）
- **瞬时失败自动重试**（`@agentchat/llm-openai`，2026-08-17 网络专项）：`ECONNRESET`/`ECONNREFUSED`/`ETIMEDOUT`/`UND_ERR_SOCKET`/`UND_ERR_CONNECT_TIMEOUT`/`UND_ERR_BODY_TIMEOUT`/DNS 抖动及 HTTP 408/429（限流）/500/502/503/504/529、预检网络类失败、180s 响应头超时，在**零输出失败**（尚未流出任何 thinking/content/toolcall 事件）时指数退避（800ms·2^n + 抖动）自动重试至多 3 次，瞬时抖动对调用方不可见；已流出部分内容的失败不重试，partial 随错误落盘（与原行为一致，上层 continue_turn 兜底）。智谱/DeepSeek 余额类 429（code 1113）显式排除（重试无意义）；重试等待期间外部中止立即生效。终态错误消息追加「已自动重试 N 次」便于观测。背景：8/17 GLM 首晚 57 次调用 5 次瞬时失败（ECONNRESET×3 / UND_ERR_BODY_TIMEOUT / 429），全部为重试即愈型。
- **自定义 undici 连接池**：全局 fetch 替换为 undici `fetch` + 模块级共享 `Agent`（`keepAliveTimeout` 钉死 1s 压缩"复用已被服务端关闭连接"的竞态窗口；`bodyTimeout` 600s 适配深度思考模型 chunk 间静默——GLM-5.3 强制思考 max 档可达数分钟，默认 300s 会误杀为 `UND_ERR_BODY_TIMEOUT`；`headersTimeout` 300s > 外层 180s）。`@agentchat/llm-openai` 新增唯一外部依赖 `undici`（Node 内置 fetch 同源实现，头注释记录例外理由）。连通性预检同步走该连接池。
- **SSE 流完整性检测**：连接正常关闭（`read()` done）但未收到 `[DONE]` 终止符时判定为截断——部分网关/中间设备以 FIN 优雅关闭掐断长连接，undici 表现为 done 而非异常，半截内容此前会冒充完整回复静默落盘。现按错误落盘 partial（零输出时自动重试），与 `terminated` 路径同类别。
- **定时器密集 Agent 推理降档**：news / neko / math_pro / test / editor 五个 Agent 的 `llm` 配置为 `{"$ref":"glm-5.3","reasoning_effort":"high"}`（原走全局默认 max）——定时巡检/简报类任务无需 max 档思考，缩短流时长即缩小断连暴露窗口，也降低 token 消耗。

### Fixed（Token 用量统计多步低报 ~5x：改按整次 run 累计口径）
- **根因**：usage JSONL 每条记录是**整次 run** 的用量，其中 `prompt_tokens` / `total_tokens` 为**最后一次 LLM 调用**的值（agent-loop `accumulateUsage` 每步覆盖），多步累计在 `accumulated_prompt_tokens` / `accumulated_total_tokens`；而统计 API 聚合用的是前者——多步 ReAct run 只计了末步，实测 2026-08-16 当天低报 **5.09 倍**（614 步只计 166 条记录的末步，7.75M vs 实际 39.5M），与官网计费严重不符。`completion_tokens` / 缓存命中/未命中写入端即累计值，此前恰好正确。
- **修复**：聚合统一改按累计口径（`accumulated_*` 优先，旧记录缺省回退字段值即全量），覆盖 overall / by_agent / by_day / by_llm / by_pair（弦图）/ by_day_llm（模型视图）；快照新增 `version: 2` 口径版本，旧快照自动全量重建；前端侧栏「缓存命中 / 总输入」公式修正（新口径 `total_prompt_tokens` 已含缓存命中，不再重复叠加，命中率 = hit / prompt）。实测 API 与原始 JSONL 逐条加总**完全一致**（近 2 天 71,219,704；全量 4,585,804,083）。
- **新增 last step 口径统计（供归档/容量判断）**：计费口径之外新增末步（上下文规模）口径——`overall.last_step_prompt/total_tokens`（区间内各 run 末步合计）、`by_agent.last_prompt/total_tokens`（该 Agent 最近一次 run 的末步值 ≈ 当前上下文规模，线上实测 test 83.8K / chat_agent 65.8K / writer 61K）、`by_day.last_step_prompt/total_tokens`（每日上下文处理量趋势）。说明：现有归档触发（1:1 会话归档用消息估算、群聊轮转用逐条消息估算）**不读用量统计**，本轮为后续基于统计的容量判断提供正确数据；两口径比值（计费/末步 ≈ 5.3x）即多步放大系数。快照版本升至 3，旧快照自动重建补齐。测试 11 例（新增末步口径独立校验：计费 487 vs 末步 327 不混淆）。

### Changed（Token 用量统计：柱状图重做 + 页签收敛）
- **用量统计柱状图**（原「按日期」）：移除竖向网格线（仅保留横向刻度线）；**柱顶圆角**——只有堆叠实际顶段圆上两角、底部落轴保持直角（经典仪表盘柱形；scriptable 逐柱计算，顶段为 0 时圆角顺延到首个可见段）；移除图表下方图例（颜色含义经悬停 tooltip 呈现）。
- **堆叠顺序**：缓存视图自上而下 缓存 → 未缓存 → 输出；模型视图自上而下按模型 ID 升序（展示集仍按区间总量取 top 7 防模型爆炸，其余合并「其他」垫底）；tooltip 列表顺序与视觉堆叠一致（自上而下）。
- **柱状图 tooltip 与弦图同风格**：raised 底 + 1px line 边 + 8px 圆角、无箭头、标题 12px/600 + 正文 12px + 合计行 11px，颜色对齐 tokens（text-1/2/3），字体继承应用字体，零值段不出行；明暗主题切换时柱状图（含 tooltip）同步重渲染。
- **tooltip 可读性（external HTML tooltip）**：柱状图弃用 canvas 内建浮层，改为 external HTML 渲染——两列布局（色点+名称左对齐，**数值列右对齐**、tabular-nums），标题下边线 + 合计行上边线分区，卡片带阴影，与弦图 tooltip 风格完全一致；零值段不出行、明细自上而下与视觉堆叠一致；弦图 tooltip 行首色点（弧段=Agent 色，弦=两端双色）并放宽行距。
- **弦图弧段圆角**：外环弧段四角加 3px 圆角（Q 贝塞尔角圆角，按带宽/角跨度自动钳制，极小弧段自然退化为直角；已数值验证 2°~200° 全跨度路径点均落在弧带内）。
- **统计方式切换**：新增「缓存 / 模型」分段切换。「缓存」由两维度（输入/输出）改为 **缓存 / 未缓存 / 输出** 三维度（缓存+未缓存=输入，绿/靛/紫配色，数据源 `by_day.total_cache_hit/miss`）；「模型」按 LLM 模型拆分每日 Token（数据源 `by_day_llm`；跨版本写法归一化合并——`deepseek/deepseek-v4-flash` 与 `deepseek-v4-flash` 同模型合并；总量降序，超过 7 个合并「其他」）。旧数据仅写 `model` 字段（无 `llm`）也能正确归因。
- **页签收敛**：侧栏页签精简为 总览 → 用量统计（原「按日期」更名），移除「按 Agent」「按 LLM」表格页签及其排序逻辑/样式（Agent 明细仍可经总览弦图悬停查看）。
- **API 扩展**：`by_day` 新增 `total_cache_hit / total_cache_miss`；新增 `by_day_llm`（按日期 × 模型聚合，范围/快照两条路径均返回）；快照结构新增 `by_day_llm`，旧版快照自动一次性全量重建补齐。测试扩至 10 例（含旧格式 `model` 回退归因）。

### Added（Token 用量统计：日期筛选 + 弦图交互优化）
- **用量 API 日期范围过滤**：`GET /api/usage/tokens` 支持 `?days=N`（最近 N 天，含今日）与 `?from=YYYY-MM-DD&to=YYYY-MM-DD`（含两端，起止颠倒自动交换，非法值回退全量）；有范围时按日文件直接聚合该区间 JSONL（按日分文件天然支持裁剪），无范围保持全量快照路径；响应新增 `range: { from, to }`（数据实际覆盖区间）。新增测试 `host/server/tests/usage-api.test.ts`（6 例）。
- **WebUI Token 用量面板日期筛选项（默认近 30 天）**：左栏顶部新增「统计范围」选择（近 7/30/90 天、全部、自定义），自定义支持起止日期 + 应用按钮（未应用标记），并显示数据覆盖区间；筛选作用于全部页签；30s 自动刷新保持当前筛选；已有数据时刷新/切筛选不再整屏闪「加载中」。
- **弦图绘制优化**（`TokenUsage.vue`）：悬停联动高亮——悬停弧段点亮该 Agent 的全部协作弦并压暗其余，悬停弦只亮自身与两端弧段；原生 `<title>` 提示升级为跟随指针的自定义 tooltip（Agent/对端名 + tokens + 协作流量占比，长名完整显示）；弧段径向标签超长截断（12 字符 + …）；渲染改为标记字符串一次性 `innerHTML` 重建（替代逐节点 `createElementNS`）并加渐变 id 防撞与重绘淡入；明暗主题切换即时重算配色；无协作流量时显示引导文案（勾选包含 user/self 或调整范围）；过滤口径（self/群聊/user 排除）收敛到单一 `chordPairs` computed，修正说明文案（弧段为按占比而非等分）。

### Added（智谱 GLM LLM Provider）
- **新增 `@agentchat/llm-glm`**（`src/core/llm-glm`）：智谱开放平台（`https://open.bigmodel.cn/api/paas/v4`，OpenAI 兼容）适配器，注册 `provider: 'glm'`，默认模型 `glm-5.3`。继承 `@agentchat/llm-openai` 基类，注入 `thinking`/`reasoning_effort`（low/high/max，默认 max）。
- **GLM 协议差异收敛**：glm-5.3/glm-4.7/glm-4.5v 为强制思考模型（`thinking.type=disabled` 会报错，适配器恒传 `enabled`）；`tool_choice` 仅支持 auto（非 auto 不传）；`stop` 收敛为数组且最多 4 个；`temperature` 收敛到 [0,1]、`top_p` 到 [0.01,1]；`user_id` 仅在 6-128 字符时传递；`stream_options` 移除（GLM 的 usage 由最后一个 chunk 自动携带）。
- **契约扩展**：`LLMConfig.provider` 联合类型加入 `'glm'`；`reasoning_effort` 加入 `'low'` 档（GLM-5.3 专有；DeepSeek 侧降级映射为 `high`）。
- **端点指引**：GLM Coding Plan（编码套餐）额度仅在专属端点 `https://open.bigmodel.cn/api/coding/paas/v4` 生效，套餐 Key 打标准按量端点会报 1113「余额不足或无可用资源包」；新增 `GLM_CODING_BASE_URL` 常量，WebUI base_url 字段描述已注明。
- **装配同步**：`cordis.yml` 新增 `@agentchat/llm-glm/src/plugin` 适配器行；`registerCoreServices` 兜底同步；`llm-factory` 分发 glm；boot 暴露 `GLM_LLM_SCHEMA`（WebUI Provider 下拉与配置表单自动出现 glm）；新建 Agent 时 provider=glm 默认模型 `glm-5.3`。
- 文档同步：`docs/plugins/core-llm.md`、`docs/plugins/README.md`、`docs/configuration.md`、`docs/architecture.md`、`docs/README.md`；新增测试 `llm-glm/tests/glm-body.test.ts`（17 例）与 `llm-factory` glm 分发用例。

---

## [0.7.1] - 2026-08-17

### Fixed
- **step 级落盘并发重复消息**：`agent-session` 的 `persistDelta` 增加 per-run 互斥锁。当一步返回多个工具调用时，多个 `toolExecutionStart` 钩子会并行持久化同一个 `loopMessages` 数组；此前它们会在 `persisted` 下标更新前各自 `slice(0)`，导致同一 `event + assistant(tool_calls)` 被重复写入 `messages.jsonl`。现在同一数组的持久化串行执行，重复入队被消除，并新增并发回归测试。
- **WebUI event/error 分隔符显示时间**：`ChatView` / `DialogView` 的 event、error 分隔符内显示相对时间，且自带时间戳时不再额外插入上方 `time-separator`，避免同一时间点出现两行时间。
- **WebUI 全局钩子排序**：`ExtToolsPane` 的 global 钩子列表按推荐顺序展示，与 Agent 未启用区排序规则一致。
- **Release 管道迁移 pnpm**：GitHub Actions 安装依赖由 `npm ci` 改为 `pnpm install --frozen-lockfile`；新增 `build:release` 脚本；`scripts/build-release.ts` 改为 pnpm 构建，并将 `src` 工作区包复制进发布包后以 `pnpm install --prod --frozen-lockfile` 生成自包含的运行时 `node_modules`。

---

## [0.7.0] - 2026-08-16

### Added（automatic 钩子前端可视化）
- **automatic 钩子全程可见**：`HookInfo` 新增 `automatic` 字段并经 `/api/plugins/catalog` 透出；`BUILTIN_HOOK_CATALOG` 补齐 `recover-history / tool-persist / step-persist` 条目并支持 stepStart/stepEnd kind。
- **WebUI 钩子面板**：automatic 钩子固定显示为“恒启用区”（显式启用区之后），带 `automatic` 徽章、虚线行样式；toggle 禁用、不可拖动排序；详情弹窗状态显示 `automatic（自动启用，不可停用）`；配置项（configNs/security）仍可点击查看与编辑。

### Added（step 级持久化 + ask_questions 崩溃恢复）
- **`Tool.execute` 注入执行上下文**：新增可选第四参 `ToolExecutionContext { toolCallId, dialogId, agentId }`；`toolExecutionStartHook` 第三参携带同款信息 + 当前已产出消息（供持久化 checkpoint），旧工具/旧钩子签名完全兼容。
- **agent-session 增量写盘**：新增 `SessionLogWriter`（per-dialog 写队列 + flush barrier + fsync），注册 automatic 钩子 `agent-session.tool-persist / step-persist / save-session`——工具副作用前先落盘 assistant(tool_calls)（失败 fail-closed 阻止工具）、每 step 结束 checkpoint、runEnd 收尾 flush；归档整理 run 仍不落盘。`HooksService` 支持 `automatic` 基础设施钩子（不受 config.hooks 清单控制、同名去重、仍受 preset 过滤）。
- **ask_questions 崩溃恢复闭环**：问题以 `correlationId=tool_call_id` 落盘；`agent-session.load-history` 加载后调用宿主注入的 `recoverHistory` 对账——answered 完整则合成 tool 结果续跑、pending 保留悬空；WS `chat.send` 检测到 pending 交互时把新输入 `router.inject` 挂起而非新开 run；重启后晚到的回答经 `onLateReply` 唤醒原会话继续。非 ask 悬空调用补 unknown outcome 平衡转录。
- 文档同步：`docs/plugins/agent-session.md`（step checkpoint）、`docs/plugins/durable-interaction.md`（恢复决策）、`docs/architecture.md` 持久化交互说明。

### Added（通用持久化交互插件）
- **新增 `@agentchat/durable-interaction`**（`src/interaction/durable-interaction`）：领域无关的持久化暂停点/可恢复交互服务，提供 `ctx.durableInteraction`（open/reply/close/get/list/listOpen/clear + `durable-interaction/opened|replied|closed` 事件），内置 memory 与 append-only JSONL 后端（fsync + torn tail 恢复 + 回答幂等）。
- 装配同步：`cordis.yml` 新增 `@agentchat/durable-interaction/src/plugin` 行；`registerCoreServices` 兜底同步；`plugin-diagnostics` 必需服务加入 `durableInteraction`；根 workspace/tsconfig 路径同步。
- **ask_questions 适配持久化**：`InteractionBridge` 改为先落盘问题再弹窗、先落盘回答再 resolve；`timeout_ms=0` 永久等待；进程重启后 pending 恢复、WS 新连接重推弹窗；回答幂等。存储文件 `<ws>/.durable-interactions.jsonl`（初始化失败降级 memory 并告警）。
- 文档同步：新增 `docs/plugins/durable-interaction.md`，更新插件索引/架构/教程包数。

### Changed（插件拆分）
- **`@agentchat/app-tools` 拆分为两个独立工具域包**：`@agentchat/restart`（`src/restart/restart`，插件行 `agentchat-restart-tools`，提供 `system_restart`）与 `@agentchat/interaction`（`src/interaction/interaction`，插件行 `agentchat-interaction-tools`，提供 `ask_questions`）；旧包删除。
- 装配同步：根 `cordis.yml` 工具领域从 1 行拆为 2 行（`restart` + `interaction`，均为 inject: tools）；`register-core.ts` 兜底、内置插件目录、默认/新建 Agent 的 `presets` 基线同步改为两个新 owner，可独立启停。
- 文档同步：新增 `docs/plugins/{restart,interaction}.md`，删除 `docs/plugins/app-tools.md`；插件索引/架构/依赖图/教程/工具开发指南同步更新。

### Changed（工具能力分层）
- **`browser` 下沉基础能力层**：`@agentchat/web` 的 `browser` 工具 requires 从 `dev` 改为 `base`，启用 `agentchat-web-tools` 插件的真实 Agent 默认获得浏览器操作能力；能力盘点测试与 README/架构/插件/教程文档同步。

### Changed（Breaking：执行层术语 turn → step）

- **术语分层正名**：L1 执行层的“ReAct 轮次（turn）”统一改称 **step**（一次 LLM 请求 + 其工具执行）；`run` 保持为整次执行生命周期；`turn` 保留给交互层/前端（一次用户提示到完成回复）。
- 字段/事件/钩子重命名：`chat.turn.start/end/steered` → `chat.step.start/end/steered`；`turnStartHook/turnEndHook` → `stepStartHook/stepEndHook`；`TurnStartHook/TurnEndHook/TurnOutcome` → `StepStartHook/StepEndHook/StepOutcome`。
- 配置重命名：`maxTurns` → `maxSteps`；钩子 kind `turnStart/turnEnd` → `stepStart/stepEnd`（agent-config/hooks/boot/security/protocol/webui 同步）。
- 用量统计重命名：`react_turns` → `react_steps`、`total_react_turns` → `total_react_steps`（LLM 契约、usage JSONL/API、前端 Token 用量面板）。
- 中断类型重命名：`max-turns` → `max-steps`；相关文案改为“达到最大推理步数”。
- 子 Agent 工具参数重命名：`max_turns` → `max_steps`。
- 不保留旧名兼容；历史 usage JSONL 中的 `react_turns` 不自动迁移（属数据迁移范围）。
- 文档/教程同步：`docs/architecture.md` 第 5/8 节、`docs/tutorial/05` 移除未实现的 `followup/steer/inject` 描述，改为当前实现（同会话 pushSteer / 带 meta trigger 等待空闲新 run）。

### Changed（Breaking：Router 投递链路收敛）

- **`@agentchat/router` 公开入口收敛为 `send()` 与 `trigger()`**：`send(msg, { wait, placement, signal })`（wait 默认 true）、`sendAsync(msg)` 降为 wait=false 一行糖；`trigger()` 改为**永远 fire-and-forget**，受理即返回、不返回 run 最终内容，需等待 run 收尾的调用方改用新增 `whenSessionIdle(convKey, timeoutMs)`（WS `chat.continue` 已接入）。
- **内部路径收敛为单一路径**：`route()` 统一处理 shutdown 生命周期闸门、群组委托、入站事件与 target 解析；广播并入 `fanout()`（n=1 即 1v1）；`submit()` 成为唯一 busy 决策点（`steer` / `next-run` / aborted-clear），删除 `deliver/dispatch/broadcast/broadcastAsync` 多路径。
- **新增 `BusyPlacement`**：`'steer'`（默认，运行中注入下一步）与 `'next-run'`（等待会话空闲后独立 run）；receive 可显式指定，trigger 带 `meta/maxSteps/deepThink` 等 run 级选项时默认强制 `next-run`。
- **pending 序列化与恢复**：shutdown 分支统一 `pendingOf()` + `enqueuePending()` 落盘，`RouterMessage` 扩展 `input/wait/placement/triggerOptions`；`flushPendingMessages()` 分组键统一 `chatDialogKey/groupDialogKey`，trigger 用完整 `triggerOptions` 重建内部 plan（delivery=await 保留成败判定），1v1 receive 同会话同目标合并；旧 pending 文件按 `type==='trigger'` 一次性兼容。
- **调用方同步**：`timer`/`archive`/群组接线改为 `void trigger(...)`，不再 `await`/`.catch`；WS `chat.continue` 改为 `trigger` + `whenSessionIdle`；`agent-tools` 的 send_agent 改用 `send(msg, { wait: false })`。
- **文档同步**：`docs/architecture.md`（§8 路由模型）、`docs/archive-orchestration.md`、`docs/plugins/{router,archive,timer,server,boot,agent-tools,session-tools}.md`、`docs/tutorial/{02,05,06,09}` 与 `docs/README.md` 同步 Router 新契约（send 选项 / trigger fire-and-forget / placement / whenSessionIdle / pending 恢复）。

### Fixed
- **Token 用量统计按 LLM 显示 unknown**：用量记录同时写入 `llm` 字段；API 聚合兼容 `llm / model / react_turns` 旧数据，今天的记录不再归入 `unknown`。
- **Token 云图左侧标签**：左侧弧段标签翻转后起始半径外移，文字不再上下颠倒，也不会侵入弧带。

---

## [0.6.2] - 2026-08-15

### Changed
- **“一切皆插件” L4 完成：preview 整体切换 src（块 E）**：
  - `preview/packages/<domain>/<pkg>` → `src/<domain>/<pkg>`、`preview/vendor/*` → `src/vendor/*`；仓库根切换为 pnpm monorepo（45 workspace projects）
  - 根 `cordis.yml` / `pnpm-workspace.yaml` / `tsconfig.json` / `vitest.config.ts` 全部切换新 src 包布局；旧 src 实现、旧根 tests 与 `preview/` 临时轨道按计划删除（源码基线备份于 `backups/`）
  - 路径修正：WebUI `@shared` alias、webui-server 仓库根推导、boot supervisor 入口改 cordis Loader、webui 包 test script
  - 迁移前冻结基线；迁移后根目录全量验证通过：`pnpm typecheck` 0 错误、`pnpm test` 406/406、`pnpm build`（WebUI vue-tsc + vite build）通过、desktop Tauri NSIS + MSI 打包通过、`pnpm dev` Loader Ready（WebUI 3830）
- **消息上下文注入重构（DSH 式 role + source + inbox 双队列）**：
  - 内存/LLM 传输层移除 `trigger` 角色：所有入站消息统一 `role='user'`，来源语义由新增 `source.kind/form/summary` 表达（user/agent/timer/group/subagent/continue/restart/archive × prompt/hint/notice/resume/relay）
  - 持久化层引入中性 `event` 角色取代 `trigger`；旧 `role='trigger'` 数据在 `loadHistory`/历史 API 读取时自动归一化为 `user + source`，`trigger+tool_call_id` 历史损坏运行时兜底为 `tool`
  - `ctx.steer` 单队列升级为 `inbox` 双队列：`next-turn`（独立后续 run，router 消费）与 `next-step`（当前 run 下一 ReAct 轮，loop 消费）；新增 `followup/steer/inject` 投递原语（前两者唤醒、inject 只入队不唤醒），系统来源自动连跑受 `MAX_AUTO_WAKES=3` 约束
  - 修复末轮竞态：run 自然结束时若 `next-step` 非空则继续一轮消费，不再丢弃工具执行中注入的 steering
  - trigger 识别从正文嗅探改为事件显式下发：`chat.start` 携带 `mode/isTrigger/hint/source/correlation_id`，WS 层据此过滤 trigger 会话流式事件，前端据此渲染 event 分隔符
  - 触发方补齐来源分类：定时器（timer）、群聊（group）、归档（archive）、`continue_turn`/`chat.continue`（continue）、重启恢复（restart/resume）
- **文档对齐**：`docs/architecture.md` 更新 inbox 双队列与 role/source 分离设计

### Fixed
- 同会话运行中 `trigger` 降级为 steer 时 `maxTurns` 不再丢失（取更小值继续生效）
- pending trigger 重投保留 `kind/form`，旧重启 pending 文件按 `restart-` correlation 推断为恢复语义

---

## [0.6.1] - 2026-08-14

### Changed
- **edit 工具主路径重构（文本匹配优先，编辑成功率导向）**：基于真实使用统计（2888 次调用，65% 失败为 Hashline 协议摩擦——TAG/lineHash 失配等保护性拒绝），将首选模式从 Hashline DSL 改为 `edits[].oldText/newText` 文本匹配（支持模糊归一化，实测"未找到"类失败在模糊匹配后归零）：
  - 工具描述改为文本匹配首选、Hashline DSL 降为行级大操作选项；schema 暴露 `edits[].oldText`（此前被 `additionalProperties:false` 屏蔽，LLM 无法使用最高成功路径）+ 顶层 `filePath/old_string/new_string` 便捷入口
  - 失败报错增加恢复建议（未找到→提示 read 复制原文/缩短 oldText；重复→提示加上下文或行级定位），降低 Agent 重试成本
  - system prompt 文件操作指引同步改为"edit 首选 oldText/newText 文本匹配"
  - 新增 4 用例：edits[].oldText 文本匹配 + 模糊（smart quote）/ 未找到恢复建议 / 重复唯一性建议
- **工具集生命周期合并（agent 使用角度）**：
  - `subagent` 四件套合并为单一 `subagent` 工具（action: spawn/list/await/kill）——子 Agent 生命周期是同一工作流，4 个相似名字 + 4 份参数浪费 tool 定义 token 且增加 LLM 心智负担；合并后参数按 action 复用（subagent_id 等）
  - `timer` 三件套合并为单一 `timer` 工具（action: set/list/disable）——定时任务管理（创建/查询/禁用）是同一对象的生命周期操作
  - 前端 toolResultViews 注册表与 ToolResultSubagent 组件同步（按 data 结构自动区分 action）
- **system prompt 大幅精简**：工具描述已自足（每个工具说清"做什么/参数/返回"），`buildGuidelinesBlock` 删除逐工具用法指引（web_search/math/query_history/ask_questions/档案/子 Agent 等），只保留跨工具编排（read→edit 工作流、list→send 协作流）与行为准则（主动安排定时任务、不可逆操作前询问、dev 重启语义）；`math` 描述补充"比 bash 更安全"引导
- **README/docs 对齐**：自动注入工具清单改 `timer`（替代 set/list/disable_timer）、`subagent`（替代 spawn/await/list/kill_subagent）；定时任务示例改 `timer(action="set", ...)`；tool-dev-guide 目录结构/requires 表/生命周期合并约定

### Fixed
- **mergeHistoryPage 测试修复**：过期导入路径 `stores/chat` → `utils/feed`（0.6.0 WebUI 重构后函数迁移，测试 5 例全挂；现 485 测试全过）
- **query_history 关键词检索 bug**：keyword 过滤原在分页之后执行（只搜最新一页）；改为先过滤再分页，关键词检索全量历史（1:1 与群聊分支统一）

### Changed
- **工具描述与参数打磨（LLM 使用体验）**：
  - `send_agent`：新增规范参数 `wait`（默认 false=异步投递立即返回；true=阻塞等待回复），旧名 `no_wait` 降为兼容别名（`no_wait=false` 仍等价等待）；描述澄清"对方回复会作为新消息送达"
  - `write`：描述增加整体覆盖警告（修改现有文件应优先 edit）；`read`：描述补充目录返回 JSON 列表
  - `list_tools`：输出附带每个工具的 label + 一句话描述（供 Agent 自省能力，判断任务用哪个工具）
  - `web_search`/`ask_questions`/`send_group`/`list_agents`/`update_agent_profile`/`edit`：描述与参数 Schema 打磨（何时用、返回什么、选项数上限、plugins 装配单元结构）
  - system prompt 指引块重构：工具描述已自足后，删除逐工具用法指引（web_search/math/query_history/ask_questions/档案/子 Agent 等），只保留跨工具编排（read→edit 工作流、list→send 协作流）与行为准则（主动安排定时任务、不可逆操作前询问、dev 重启语义）；修正术语约定中 update_agent_profile 的 admin 可更新他人表述
- **依赖瘦身（root）**：移除死依赖 `mathjs`/`openai`/`punycode`/`tiktoken`/`zod`（零引用；math 工具已改用 node:vm 沙箱、token 估算为自研实现）与 `ts-node`（全部脚本已用 tsx）；`nodemon@2 → 3`（修复其传递依赖 semver 的 ReDoS 高危告警），`npm audit` 归零
- **依赖瘦身（webui）**：移除冗余类型包 `@types/uuid`/`@types/katex`（uuid@14 / katex 自带类型）；`npm audit` 6 → 2（剩余 vite≤6 esbuild 告警需破坏性升级 vite@8，暂缓）
- **WebUI 构建分包**：`vite.config.ts` manualChunks 拆出 vue / markdown(katex+hljs+markdown-it) / chart(chart.js+d3-chord)，主包 1.82MB → 280KB，长缓存 + 并行加载
- **仓库卫生**：删除已跟踪的一次性调试脚本 `scripts/runtime/_tmp-replace-ext.ts`、`scripts/runtime/_tmp-ws-trigger.ts`、根 `analyze-blank.ps1`（硬编码绝对路径的临时工具）；`.vscode/tasks.json` 改为引用真实 npm 脚本（原任务指向已不存在的 `start:agentchat`/`webui/client`）
- **文档对齐**：README 修正过期工具名（`get_agent_profile`→`read_agent_info`、`reload_self_tools`/`reload_extensions`→`reload`）、失效的最小配置示例（旧 `tools`/`pre_hooks`/`post_hooks` → 新 `plugins[].tools` 形态）、`no_wait` 文档改为 `wait`；tool-dev-guide.md 的 read 示例对齐真实 Hashline v2 定义
- **desktop/README.md**：替换 Tauri 模板占位内容为 AgentChat 桌面端实际说明（托盘常驻 / 通知监听 / 断线重连 / 开发与构建）

---

## [0.6.0] - 2026-08-13

### Added
- **WebUI 架构重构上线（双轨迁移完成）**：`webui-preview` 平行版本验收通过并替换正式版（原版归档 `webui_v1_archive`，可回滚）。新架构分层：`core/` 领域层 / `services/` API 层 / `composables/` 组合层 / `stores/` 状态层 / 扩展注册表（toolResultViews / messageViews / perspectives / eventHandlers）；ChatView + GroupChat 合并为统一 `DialogView`（useChatShell + useDialogFeed，消除双渲染管线）；App 上帝组件拆分（AppShell + ui/groups store）；删除 8 个死代码组件
- **Token 用量弦图（总览页签）**：基于 d3-chord 的标准弦图——弧段长度 ∝ Token 占比、占比过小的 Agent 合并为「其他」、弦宽 ∝ 1v1 用量且两端等宽、弦端顺序占满弧段（与矩阵行和同口径，消除弧段空白）、标准弧线收束圆心、悬停 tooltip
- **Token 流量筛选**：勾选「包含 user/self 流量」（默认不勾选，聚焦 Agent 间协作）；群聊流量始终排除（后端 `by_pair` 保留 `group~`/`group:`/`room:` 数据，为后续群聊图谱准备）
- **弦图标签**：径向横躺排列，长名称完整显示不省略
- **usage 快照自愈**：修复历史快照 `by_pair` 严重缺失（7.6M vs 真实 694.5M），删除快照自动全量重建

### Fixed
- **Token 弹窗 30s 自动刷新闪烁**：renderCloud 数据指纹（含勾选状态）+ SVG 引用比对，数据未变不重绘
- **Token 弹窗图表消失**：SVG 元素重建（弹窗重开/组件重渲染）时强制重新渲染
- **token 记录群聊保留**：`group~` 前缀不再被 `by_pair` 过滤，前端可统一识别群聊流量

### Changed
- **WebUI 正式版替换**：`src/ui/webui-preview` → `src/ui/webui`（端口 3831）；根 tsconfig exclude 增加归档目录；删除根 `dev:frontend:preview` 脚本
- **Token 弹窗**：默认进入「总览」页签；宽度 920 → 1120px
- **usage 口径**：弦图弧段改按矩阵行和（协作连接流量）分配，tooltip 占比同步

---

## [0.5.2] - 2026-08-10

### Added
- **WebUI 工作区右侧分屏**：工作区从"活动栏第二视图"改为会话区右侧可折叠分屏（宽度可拖拽 180–480px），Agent 列表不再被替换，实现"边看文件边对话"
- **WebUI 统一信息流 feed store**：`stores/feed.ts` 统一 chat/history/group/virtual 事件入口，per-dialog 分区 + turns 派生 memo；新增 `utils/feed.ts`（buildTurns/mergeHistoryPage 纯函数层）
- **WebUI UI 库（`src/ui/`）**：Icon / Button / Avatar / Modal / ScrollView / StatusDot / Tooltip / StarAvatar / StarCard / PulseTrace + `tokens.css` 双主题令牌（深空/晨曦），全部弹窗/工具栏/头像接入
- **星色系统**：`utils/starColor.ts`，Agent 从 id 稳定哈希派生专属星色（8 色双主题板），会话列表头像接入
- **群聊历史注入（后端）**：`hooks/session.ts` 新增 `loadGroupHistory`——群聊本体 `<msg>` 标签封装（名称/群名映射）+ 相邻发言合并 + `groupLoadLimitTokens`（默认 30k）截断；`makeLoadHistoryHook` 群聊分支完整注入
- **L3→L4 服务自动发现**：`ServiceRegistry.registerPluginServices()` 批量注册插件声明服务；`WebUIServer` 改经注册表唯一装配（history/agent/group/plugin 服务），去除直接传参；AgentService 定时器/System Prompt 预览改经注册表取用
- **群聊本体落盘归位**：`GroupService` 监听 `group.message.received` 统一落盘（send_group 工具 + 用户 WebUI 群消息的唯一入口），只记真实投递消息（无思考/工具）
- **首次运行引导直写会话**：bootstrap 直接把艾吉自我介绍写入 `chat~agent_chat_dev~user` 会话文件（此前 router.trigger 因首次运行无全局 LLM 静默空跑）

### Fixed
- **流式串台**：前端 feed 按后端会话键（dialogId）反解归属——过滤 Agent 自言自语（`chat~X~X`）、Agent 间对话（`chat~A~B`）、群聊过程流式（`group~gid~aid`），定时器/群聊 trigger 的思考不再串进当前 1v1 会话
- **会话出字慢**：AssistantMessage markdown 渲染 rAF 合并 + 结果缓存，消除每 token 全量 markdown-it/highlight.js 重渲染（含思考计时引发的无谓重渲染）
- **活动栏头像底色**：用户头像按钮去掉 primary-light 底色，圆形头像外不再露出色块
- **归档阈值误判**：`archive-service` 改用当次 `total_tokens`（非跨轮累计值）判断上下文超长，长 run 不再频繁误触发归档；`scanPendingArchives` 未超时 pending 跳过（不误清理进行中的整理轮），真残留由超时兜底；done/pending 残留清理边界补齐
- **list_timers 模式展示**：定时任务列表支持 delay / random / workday / holiday 模式显示

### Changed
- **WebUI 设计基调（Soft UI 色板）**：主色切换 indigo 系（亮 `#6366f1` / 暗 `#818cf8`），辅助强调粉 `#ec4899` / 绿 `#10b981` / 琥珀 `#f59e0b`，品牌渐变改 indigo→pink；背景中性化；选中态降密度（中性灰底 + 主色轻强调）
- **WebUI 按钮语言统一**：工具栏/发送按钮同高 28px、同圆角、同字重，发送按钮加彩色阴影（替代 scale 缩放）
- **WebUI 布局**：Agent 列表与工作区解耦（v-if 互斥解除）
- **前端文档**：新增 `docs/webui-design-system.md` / `feed-architecture.md` / `ui-library.md` / `ui-solidity-analysis.md` / `webui-component-analysis.md` / `group-message-density-analysis.md` / `design-preview*.html`

---

### Added
- **配置迁移到 plugins 装配形态**：Agent config.json 移除 `tools`/`pre_hooks`/`post_hooks` 字段与兼容层，统一由 `plugins[].runStart/runEnd` 声明（build-system-prompt / load-memory / load-history / save-session / update-memory 等）；hooks 挂载点在 plugins 形态下全链路验证无损
- **list_tools 返回全量工具**：按 tags→requires 装配后含平台内置工具全量展示（艾吉 29 个），不再只列 plugins 自定义工具
- **list_groups 按归属过滤**：只返回调用方所在群组（不在任何群组时返回空）
- **router pending 落盘**：关机模式下 pending 消息立即落盘 `<ws>/.router_pending.jsonl`，进程级重启后 flush 恢复，不丢消息
- **read/edit/bash 工具增强恢复**：read lineHash 输出 + recordSnapshot；edit Hashline v2 DSL（三级模糊匹配/冲突重叠检测/快照校验，edit-diff/hashline-executor 等 7 文件回归）；bash background 后台执行（detached+PID+log_file）+ killProcessTree 杀进程树（超时+abort 双链路）
- **ArchiveService 迁移（L4 门面）**：归档编排收敛 services 层——archive-service.ts（handleRunEnd 统一入口 / requestArchive / archiveAndRebuild / scanPendingArchives / idleArchive / archiveAllActiveSessions / dispose），app 装配层通过 services 门面注入 runEnd 统一出口与 __archive_all__ 批量归档；scanPendingArchives 残留清理逻辑回归

### Fixed
- **PluginRegistry.setServices 引用语义**：此前浅拷贝导致 registry 与 loader 各持一份 services，spawn_subagent 永远读不到父 Agent LLM（报"父 Agent 无 LLM"）；改为首次直接引用 + 后续原地合并后，子 Agent 创建/执行/回收全链路打通
- **重启后继续消息 trigger 语义**：system_restart 后系统注入的"请继续"以 `role=trigger` 落盘（此前误记为 `agent_id=user` 的用户消息），前端/统计可区分系统注入与用户真实发言
- **工具开发指引可达性**：tool-dev-guide.md 移入工作区 `files/shared/`，read 工具沙箱内直达（此前指向仓库根 docs/，read 越界需绕道 bash）
- **16 个旧测试迁移**：import 路径对齐新结构（14 迁 2 删——pendingArchiveCleanup/truncateTail 新架构无等价符号）；全量 47 套件过 / 381 tests 通过
- **归档整理轮 meta 通道修复（繁忙丢标志）**：归档整理轮触发在会话繁忙时降级为 steer 导致 `archiveReview` 标志丢失、整理轮消息落盘污染会话；改为通用 meta 通道（META_ARCHIVE_REVIEW 常量）+ router 不降级 steer 直接等待空闲后独立 run 重试（190s 上限 + 10 分钟 pending 超时兜底）
- **记忆审查标记机制移除**：.memory_update_needed/.memory_review_needed 全链路删除，记忆整理由归档整理轮统一完成（失忆可由 query_history 重新回忆）
- **消息 ID 稳定化**：stableMessageIdOf 对无 ID 旧数据补稳定 ID（dialogId+ts+role+content hash），供去重/归档二次去重/前端 persistedMsgId/删除使用

### Changed
- **system prompt 持久化存储段落精简**：记忆相关合并为一条 `[记忆文件]`（内联命名规则与归档触发说明），移除会话存储说明
- **前端调整**：删除 PluginSettings.vue（并入 AgentSettings），WorkspaceTree / AgentSettings 等组件同步配置迁移
- **docs/tool-dev-guide.md 重构**：按 v0.5.0 五层架构重写（defineTool 工厂 / requires 门控 / per-Agent 烘焙 / reload(scope=global)）
- **prompt 框架层精简**：术语约定 3→1、标签约定 3→1、删除被工具描述覆盖的 3 条冗余指引、引号段 dev/admin 门控、background 指引与恢复后的参数对齐（Start-Process 表述改回 background:true）
- **WORKFLOW.md 重写**：对齐当前 API（Hashline v2 编辑流程/reload(scope=)/新 5 层路径），移除 reload_extensions 等旧工具名与废弃路径
- **skills.ts 模块拆出**：技能发现/渲染从 prompt.ts 独立成文件（对齐 mcp.ts 独立文件模式），makeInjectSkillsHook 重新导出
- **token 估算口径对齐**：estimateMessagesTokens/truncateMessagesByTokenBudget 不再计入 reasoning（DeepSeek 历史 reasoning 不发送给模型）；前端 ChatView 删除流式估算，改后端权威数据 + chat.end 落盘后刷新（lastRunEndAt）

---
## [0.5.0] - 2026-08-06

### Added
- **5 层目标架构落地**（按 `architecture-target-20260805.md`）：目录重组为 `core`(L1 单 Agent 引擎) → `agents`(L2 多 Agent 调度) → `plugins`(L3 能力扩展) → `services`(L4 对外门面) → `app`(L5 装配启动)，依赖严格单向；顶层仅 6 目录 + `shared`
- **新路径别名**：新增 `@agents/*`、`@app/*`；`@llm/*` 指向 `core/llm`；删除 `@routing/@infra/@discovery/@rpc/@global`

### Changed
- **core 引擎重组**：`core/agent/index.ts` → `core/loop.ts`（ReAct 引擎）；`core/session/*` 三文件合并 → `core/context.ts`（RunSession/SessionManager/convKeyFor）；`agent-queue.ts` → `core/queue.ts`；`llm/` 从顶层移入 `core/llm/`
- **agents 调度层新建**：收纳 `registry` / `router` / `group`(原 group-manager) / `config` / `config-diff` / `virtual-agent` / `app-state` / `credential-store`(原 infra)
- **app 装配层新建**：收纳主入口(原 `src/index.ts`) / `supervisor` / `loader`(原 discovery/agent-loader) / `plugin-loader`(原 plugins/loader) / `shutdown`
- **services 门面扩充**：`rpc`(原 rpc/)、`backup`、`interactions`(原 infra) 移入；`index` 增补导出
- **插件目录改名**：`agent-core` → `builtin`、`agent-math` → `builtin-math`；`timer`/`sub-agent` 移入 `builtin/src/`（定时与子 Agent 归插件域）
- **shutdown 去重**：`core/shutdown.ts` 与 `infra/shutdown.ts` 两份重复文件合并为 `app/shutdown.ts`（router 域 → 插件域 → WebUI → exit 顺序）
- **构建脚本同步**：`package.json` / `build-supervisor` / `build-release` 入口与别名全部指向新路径；顺带修复 `build-release.ts` 失效的 `src/global` 引用（→ `plugins/{builtin,builtin-math}`）

### Removed
- **废弃脚本**：删除 `scripts/build-supervisor.ts`（supervisor bundle 无任何启动路径使用）+ `scripts/clean-releases.ts`（手动清理 GitHub Release body 的维护脚本，CI 已自动生成）；同步移除 package.json 的 `build:supervisor` 脚本
- **3 个复制实现逻辑的过期测试**：`networkDown.test.ts`（复制 isNetworkError，已由集成测试覆盖真实行为）、`socialArchive.test.ts`（复制 isoWeekKey + 字符串模板自证断言）、`tags-system.test.ts`（复制 roleToTags/canUseTool，真实实现已由 tagInject.test.ts 覆盖）
- **临时/构建产物清理**：`release/`、`.cache/`、`scripts/runtime/` 遗留旧发布副本、`dist/` 等（约 373 MB，均可再生；`backups/`、`workspace/` 用户数据保留）

---

## [0.4.12] - 2026-08-05

### Added
- **数据备份/恢复**：新增 `src/core/backup.ts` 核心模块 + `POST /api/backup`（手工触发）+ `GET /api/backup`（列表）；备份 workspace 全量数据到项目根 `backups/`（gitignore 排除，绝不入库防泄露）；保留最近 4 份循环覆盖；每日 04:00 定时任务（7 天间隔才执行 = 每周自动备份）；活动栏"更多"菜单加"数据备份"按钮
- **会话级并行（架构升级）**：Agent 状态从实例级改为会话级（RunSession per-conversation），每会话独立执行队列——一个 Agent 可同时处理多个会话（不同对方/群聊），互不阻塞；steer 转向消息按会话路由

### Changed
- **bash 下沉 agent 基础 tag**：bash 工具 requires dev→agent，全部 14 实 Agent 自动获得（查进程/清理文件不再锁 dev）；dev 剩 browser/code_search/inspect_session/read_logs/reload
- **continue_turn 方向修复**：自我续推 hint 不再落盘为"对方发来的 trigger"（幽灵消息曾导致 editor 多跑一轮 + 前端显示方向错乱）；selfContinue 标记
- **agent-prompt 新增 DONE.md 说明**：TODO 只保留未完成项，新完成事项直接记 DONE.md 不回填（防膨胀）
- **TODO/DONE 拆分**：50KB→9.8KB，179 项已完成迁 DONE.md

### Fixed
- **steer 会话路由**：转向消息按 ActiveSession.sender 路由，不误入其他会话

---

## [0.4.11] - 2026-08-04

### Changed
- **工具注入统一为 tag 驱动**：移除 autoInject 机制，全部工具按 requires 匹配 Agent tags 注入（agent 基础 / dev 开发 / conductor 调度 / admin 管理）；Agent 只需配 tags 即自动获得对应工具
- **新增 conductor 调度 tag**：子 Agent 工具（spawn/await/list/kill_subagent）从 dev 独立，仅艾吉/莉莉/test 有
- **list_tools → list_tags**：返回 tag→工具映射 + 缺失提示（想要某工具就知道打什么 tag）
- **manage_plugins 并入 update_agent_profile**：update 支持 tags/tools/pre_hooks/post_hooks 统一管理；manage_plugins 移除
- **get_agent_profile → read_agent_info**：查自己（persona+hooks+脱敏 llm）/ 查他人（公开信息 + 你对该 Agent 的记忆）；移除 system_prompt 暴露
- **tags 管控**：非 admin 禁止给自己打 admin 标签（拦截器+工具双重校验）
- **news 补 dev 标签**：爬虫写脚本/浏览器能力
- **math_pro 补 dev 标签**：数学研究写代码

### Fixed
- **历史消息加载打转/重复**：ChatView 滚动加载 offset 按实际链数校准 + 按 message_id 去重 + 滚动位置保持（此前往上翻一直加载相同消息）

---

## [0.4.10] - 2026-08-04

### Changed
- **角色体系重构为能力标签 tags**（架构级）：Agent 身份从单一 role（user/developer/admin）升级为组合式能力标签 `tags: string[]`；工具按 `requires`（AND 语义）匹配 tags 自动注入，替代 config.tools 写死白名单；`role` 字段已从全部 Agent 配置移除（老用户由 update-config 脚本自动迁移 role→tags）
- **工具集按标签自动注入**：基础工具 requires `["agent"]`、dev 工具 `["dev"]`、admin 工具 `["admin"]`、领域工具 `["sap"]` 等；Agent 只需配 tags 即自动获得对应工具，无需逐个配置
- **记忆注入预算 600 → 10000 tokens**：缓存 token 便宜，一次注入完整记忆，减少 Agent 频繁调工具查 memory.md（会话割裂缓解）
- **摘要配置合并**：`archiveSummaryInjectLen` 并入 `summaryPreviewLen`（统一 4000 字，控制上下文压缩 + 归档 SUMMARY.md 的生成与注入）
- **归档触发比例 50% → 70%**：延迟归档触发，减少整理轮成本

### Added
- **归档 SUMMARY.md 跨会话注入**：归档时生成会话总结写入 `archive/SUMMARY.md`，preHook 注入后续会话，防止归档后会话割裂（Agent 在归档整理轮亲自写，系统自动生成降级兜底）
- **归档整理轮 hint 注入截断上限**：告知 Agent SUMMARY.md（4000 字）与 memory.md（10000 tokens）的注入上限，引导控制篇幅避免"写了被截断"
- **update-config 迁移脚本**：`npm run update:config` 将旧工作区配置迁移到新默认值（memoryBudget 600→10000 / summary 1000→4000 / archiveRatio 0.5→0.7 / 废弃字段移除 / role→tags）；start.bat 启动时自动执行，老用户升级无感
- **start.bat 启动检测新版本**：静默查 GitHub 最新版，有新版询问是否更新（Y 打开 update.bat）；移除 install.bat

### Fixed
- **归档残留 pending 导致误归档**：`.archive_pending` 残留让超时监视器误判并强制归档最近对话（20:47 把 20:44 的对话归档）；`completeArchiveReview` 改 try/finally 保证标记清理 + `scanPendingArchives` 启动即扫 + idleArchive 日志区分触发源
- **system_restart 非 Supervisor 模式**：不再"工具不存在"，注入后执行时返回明确原因
- **admin 可管理其他 Agent 档案**：update_agent_profile / manage_plugins 支持 agent_id（admin 标签）

---

## [0.4.9] - 2026-08-04

### Added
- **MCP 切换官方 SDK**：自建 JSON-RPC 客户端（~930 行）→ `@modelcontextprotocol/sdk`（~310 行），支持 Streamable HTTP + headers
- **23:30 全局批量归档**：timer-manager 内置 `__archive_all__` 特殊 hint，深夜自动归档所有活跃 1:1 会话（缓存低价 + 不打断白天对话）

### Changed
- **LLM 热更新**：切换全局默认模型时所有 Agent 的 LLM 跟随（rawLlmConfigs + resolveLLMPool 重解析）
- **config 清理**：移除旧 times 遗留 + 23:30 归档任务入库

---

## [0.4.8] - 2026-08-03

### Fixed
- **群聊回复空转（严重）**：Agent 收到群聊 trigger 后直接输出文本不调工具，回复未投递到群聊（空转），形成负反馈死循环。三层修复：① router hint 强化（明确"若值得回应必须调 send_group，直接输出文本不会发送到群聊；无话可说则沉默"）② agent-prompt 恢复群聊规则（回复必须用工具）+ 术语约定/COLLAB_TOOLS 补全 ③ `loadGroupHistory` 合并相邻"对方视角纯发言"消息（242 条→71 条，压缩 71%，既省 token 又抬高 assistant 示范密度）
- **自主推理轮次一律不设上限**：归档整理轮被硬编码 `maxTurns: 12/15`、定时任务默认 `99999` 限制，复杂整理被截断（neko 归档到 12 轮被强制终止）；移除三处硬编码，仅显式配置 maxTurns 才生效
- **孤立 tool 日志误报**：跨视角历史加载时对方视角的 assistant（tool_calls）被转 user 丢弃（A3 协议），其 tool 结果成为孤立被过滤——预期行为，日志 WARN 降为 debug
- **群聊消息格式统一 `<msg>` 标签 + 死循环修复**：群聊实时消息/历史统一 `<msg from name group>` 格式，Agent 能识别"这是群聊发言"
- **agent-prompt 指引检测 bug**：`buildGuidelinesBlock` 用实际可用工具集（含 autoInject）检测，此前 autoInject 工具检测不到导致群聊/协作指引缺失
- **bootstrap LLM 未配置不再崩溃**：LLM 未配置时启动不崩 + 配置全局 LLM 后自动补默认

### Added
- **browser 工具结果结构化展示**：webui 对 browser 工具结果做结构化渲染
- **社交活动归档**：A→自对话按天 + A→群聊参与按周归档（agent-session）

### Changed
- **群聊回复语义收敛为 send_group**：实验验证 reply_group 语义引导有效（测试14），但 send_group 在明确 hint 下同样正常（测试17/18 全员投递成功），reply_group 冗余删除——API 精简
- **删除群聊行为引导（省 token）**：群聊行为引导由 router 的 hint 每轮携带（更贴近当前消息），agent-prompt 静态重复引导删除，保留术语约定与 `<msg>` 格式说明
- **移除 adjust_llm 工具**：LLM 强度调节工具回退（此前 0.4.6 Added）

---

## [0.4.7] - 2026-08-03

### Fixed
- **中断不再误判网络失效（严重）**：`isNetworkError` 把用户主动中断（AbortError）也算网络错误，连续中断 2 次会导致整个系统进入网络失效模式、所有消息入队不投递；已排除，并给错误计数加 5 分钟时间窗口（跨天两次偶然错误不再触发全局 down）

---

## [0.4.6] - 2026-08-03

### Added
- **adjust_llm 工具**：Agent 自主调节 LLM 强度（温度/深度思考/最大输出），任务难开 thinking 温度 0，闲聊关 thinking 省 token；persist 可选写配置重启生效
- **Token 云图面板**：Token 用量新增气泡图 tab，气泡面积∝用量一眼看出最活跃 Agent（零新依赖）
- **首次启动引导**：全新环境自动创建 user + admin（艾吉），触发自我介绍并引导配置 LLM/创建 Agent

### Changed
- **全局定时重构**：chime 独立机制移除，并入统一 scheduleEntry（`__global__` 虚拟 Agent）；配置键 `chime`→`timer`（兼容旧键）；提示支持 `{{now}}`/`{{time}}`/`{{date}}` 占位符；任务项新增复制按钮
- **附件上传重构**：原始文件名存 `files/<agentId>/_tmp/`（或全局 `_tmp`），重名 SHA-256 幂等/加序号；中文文件名修复；用户气泡渲染附件可点击预览

### Fixed
- **前端全局定时无法点击**：新建任务弹窗条件 bug（两条件都 false 永不显示）
- **附件看不到内容**：WS handler 用 a.hash 拼路径（实际存原始名）→ 改用 a.text
- **Release 构建失败（v0.4.6）**：GlobalSettings.vue 占位符文本 `{{now}}`/`{{time}}`/`{{date}}` 被 Vue 解析为插值导致 vue-tsc 报错（改用 HTML 实体转义）；ChatInput.vue 误用 `store.activeAgentId`（chat store 无此属性，应为 agent store）

### Added（稳定性/体验）
- **router 网络失效模式**：网络异常时消息入队不丢，30s 探测自动恢复重投（连续 2 次网络错误才 down，防抖动）
- **对方正忙提示**：给忙的 Agent 发消息时前端提示"已作为追加指令排队"，不再误以为无响应

---

## [0.4.5] - 2026-08-02

### Fixed
- **A→A 自对话提示词指引**：告知 Agent 自对话不落盘，重要信息需自行更新 memory/TODO/note（配套 B1）
- **思维链正文被吞**：末尾有纯文本消息时，最后一条 meaningful step 的正文不展示；改为「不等于 final 气泡正文」判定
- **同 sender 长间隔消息误合并**：超过 10 分钟视为不同轮次（定时广播不再合并进同一 turn 链）

---

## [0.4.4] - 2026-08-02

### Added
- **Agent 角色选择器 UI**：配置面板加 user/developer/admin 下拉，无需改配置文件即可分配角色层级

### Changed
- **消息角色体系重构**：trigger 一等角色（角色判定彻底脱离正文内容嗅探）+ provider 双向转换（toProviderMessages/fromProviderMessages）+ viewer 视角统一 + loadHistory 返回持久化格式 + safeSplitIdx 结构截断（tool 对保护）
- **脚本统一**：8 个会话维护脚本合并为 `session-maint.js`（scan/aa/compact/migrate/all），运行时脚本移入 `scripts/runtime/`
- **token 估算共享**：`src/utils/tokens.ts` 统一实现，webui/server 复用

### Fixed
- **archive 归档重建污染**：tool 结果含 `<trigger>` 子串被误标 trigger（query_history 内嵌历史文本）；toPersistedRole 强制 tool/error 保持原角色
- **前端 trigger 判定**：`isTrigger` 改为纯 `role==='trigger'`（移除正文内容回退）
- **A→A 自对话污染**：postHook 对自对话永不落盘消息历史（仅记录用量）

---

## [0.4.3] - 2026-08-01

### Added
- **语义化中断**：InterruptReason + ToolInterrupt 体系，abort 从核弹变可控信号；reload/restart 抛中断
- **manage_plugins 装配反馈**：返回 dropped tools + 原因（不存在/无权）
- **web_search 配额检查**：本地积分账本 + 查询前配额门控

### Changed
- **工具清理**：移除废弃 reload_self_tools/reload_extensions
- **重启自动恢复**：restart enqueues continue-trigger，会话自动恢复

### Fixed
- **重启继续触发器来源**：continue-trigger from=session counterpart
- **去重窗口**：60s → 30s（复读机场景反馈）

---

## [0.4.2] - 2026-08-01

### Added
- **一键重启**：Supervisor 模式后端完整重启，WebSocket 自动重连，重启后会话自动恢复
- **bash 后台执行**：长驻服务 detached 运行 + 日志写文件，立即返回 PID 不阻塞
- **工具中断**：SSE abort + 进程树杀，长思考/长命令可随时打断
- **自我续推**：continue_turn 主动触发自己下一轮推理，无需等待用户输入
- **隐藏工具机制**：危险管理工具（system_restart）不在发现流程中展示，仅显式配置启用
- **工具分级模型**：基础/工具/开发/管理四层，按用户角色自动注入/剔除

### Improved
- **系统提示词指引重编排**：11 组分类（基础→管理），同类型合并
- **重复消息去重窗口**：8s → 60s，防止用户无意重发被吞

### Fixed
- **打断链路不再崩溃**：abort 异常捕获 + 进程级兜底，长思考中打断进程存活
- **打断后消息重复持久化**：重连/reload 不产生重复消息
- **重启瞬间去重失效**：去重缓存跨重启保留

---

## [0.4.1] - 2026-08-01

### Added
- **read_logs 日志工具**：Agent 可直接读取后端运行日志（内存环形缓冲，支持级别/关键词/条数过滤），调试不再依赖人工复制
- **群聊归档**：群聊达到阈值自动归档，每个参与者独立整理自己的群聊记忆（sessions/<agent>/group__<id>/memory.md），配合摘要锚点解决长群聊的上下文膨胀
- **群聊双阈值**：归档触发阈值（默认 50K）+ 单次加载上限（默认 30K），多 Agent 共享历史时防止 token 消耗爆炸
- **归档前记忆整理**：1:1 会话和群聊归档前，系统自动触发参与者基于完整上下文整理记忆（memory/TODO/note），整理完成才归档
- **工具分类重构**：开发工具（reload/code_search/inspect_session）从自动注入改为按需配置；browser 整合为全局工具
- **全局定时任务管理**：全局面板可增删改定时任务（时间/提示/目标 Agent）

### Fixed
- **工具调用事件串台**：chat.toolcall 事件缺 sender 校验，其他 Agent 的工具调用会串流到当前会话界面
- **归档标记路径错位**：归档标记改为 canonical 排序路径，双边会话（Agent↔Agent）不再因路径不对称而无法归档
- **群聊归档参与者读不到**：AppState 未注入 GroupManager，导致群聊参与者列表为空、归档不触发
- **群聊整理轮被跳过**：postHook 的 group_id 分支在 archiveReview 判断之前，群聊整理轮被提前 return

---

## [0.3.3] - 2026-07-31

### Added
- **冷启动安装**：`install.bat` 从 GitHub latest release 一键下载 → 校验 → 解压 → 安装
- **缓存复用**：zip 有效则跳过下载，损坏则自动清理重试
- **aria2c 加速**：检测到 aria2c 时 16 连接多线程下载；否则 fallback curl（断点续传 + 重试）
- **zip 完整性校验**：下载后自动验证格式，损坏重试（最多 3 次）
- **下载统计**：curl `--write-out` 输出字节数、耗时、速度

### Fixed
- **CI zip 格式错误**：Git Bash GNU `tar -a` 生成 tar 而非 zip，改为 PowerShell `Compress-Archive`
- **`update.bat` 版本解析**：简化为 `findstr` 直接提取，移除 PowerShell 依赖
- **bat 语法错误**：`for /f` 单引号与 PowerShell 冲突、`echo` 在 if 块内提前闭合、延迟展开 + 缺少 `pause`
- **bat 编码**：移除 `chcp 65001` 和所有 Unicode，全 ASCII
- **原子下载**：先 `.tmp` 再校验后 move，防止中断产生半截文件

### Changed
- Node.js 便携版 → **v24.18.0**（Krypton LTS）

---

## [0.3.2] - 2026-07-31

### Fixed
- **`update.bat` 下载失败**：多行 PowerShell `^` 续行符传给 PowerShell 导致语法错误
- **`update.bat` 编码乱码**：Node.js 检测与 `start.bat` 统一（自动解压 `node-portable.zip`）
- **前端文件链接**：`FILE_PATH_PATTERN` 不匹配裸路径；`TurnDisplayItem` 未转发 `previewFile` 事件

---

## [0.3.1] - 2026-07-31

### Added
- **ratio 滑块**：比例型配置项拖动滑块 + 百分比显示

### Changed
- **会话归档**：`archiveMinMessages` → `archiveTokenRatio`，token 比例比消息数更精准
- **`keepRecentRatio`**：20% → 2.5%，更激进截断降成本

### Fixed
- **归档死循环**：水位过于接近导致归档后立即再次触发
- **bash**：循环依赖、maxBuffer OOM、危险命令检测补全、stdin 支持、5 类友好错误提示

---

## [0.3.0] - 2026-07-31

### Added
- **Hashline v2 编辑协议**：read 输出 `[PATH#TAG]` 头部 + `行号:内容`；edit 支持 DSL patch
- **DSL 操作**：`SWAP`（替换）、`INS.PRE/POST/HEAD/TAIL`（插入）
- **文件级哈希**：4 字符 TAG，edit 时验证防并发冲突
- **write 输出 TAG**：无需重新 read 即可 edit
- **compress 对话框**：trigger → trim 全流程
- **AgentList Token 水位**：侧栏实时显示每个 Agent 的 token 占用
- **Token 占用预测 API**：`/api/sessions/:agentId/tokens`

### Changed
- **read/edit 重组**：`shared.ts`（61 行）+ `hashline-parser.ts` + `hashline-executor.ts` + `edit/tool.ts` 纯路由
- **Hashline v1 → v2**：行级哈希 → 文件级哈希，JSON edits → DSL，8 字符 → 4 字符
- **压缩机制**：marker 文件替代直接 `agent.receive()`
- **滚动**：仅初始加载自动滚底，`requestAnimationFrame` 等布局

### Fixed
- **edit 模糊匹配越界**：`matchedLen` 精确追踪
- **LLM 孤 tool_calls**：调用前过滤
- **clean-sessions.py**：重写为顺序构建器，修复而非删除；扩展到归档文件
- **虚拟 Agent**、**重复 marker**、**archiveAndRebuild 绕过** 等多项修复

---

## [0.2.0] - 2026-07-30

### Added
- **Steer**：立即中止 LLM 推理，提前进入下一轮 ReAct
- **SVG Logo**：聊天气泡 + Agent 节点 + 品牌紫渐变
- **一键更新**：`update.bat` 从 GitHub latest release 下载
- **write 预览**：文件名点击弹窗，语法高亮 + 行号 + 复制
- **＋ 下拉菜单**：新增 Agent / 创建群组合并入口
- **群聊简介编辑**：抽屉 textarea
- **日期分隔符**：今天/昨天/前天/三天前
- **思维链时间标签**："已思考 X 秒"
- **思维链工具摘要**：折叠栏 `read · edit · bash`
- **edit 返回 updated_hashes**：下次 edit 直接定位
- **局域网访问**：绑定 `::`，Vite `host: true`

### Changed
- **MCP 独立扩展**：`agent-mcp` 与 `agent-prompt` 完全解耦
- **agent-prompt 瘦身**：移除工具/MCP 描述块，由模型 `tools` 参数注入
- **统一管线**：私聊 + 群聊共用 `TurnDisplayItem`，`agent_id` 驱动
- **Turns 重构**：computed → 事件驱动增量 ref
- **思维链**：流式展开 → 结束 500ms 折叠；chain-body 思考 → 工具 → 正文
- **Token 面板**：移除总览 tab → 汇总条 + Agent/日期双 tab
- **气泡宽度**：`turn-item` 70% 统一管控
- **Sidebar**：Agent + 群组按时间混排
- **历史查询**：按消息计数，默认 10 轮
- **发布脚本**：`启动AgentChat.bat` → `start.bat`

### Fixed
- **WS 串台**：`cid` 会话粒度路由
- **记忆审查**：`idleArchive` + VirtualAgent `postHook`
- **群聊合并**：UUID 格式 ID 自动识别、不再合并
- **edit diff 行号**：`mergeLineRanges` gap 2 → 0
- **markdown 连字**：`font-variant-ligatures` 禁用
- **归档重叠**、**文件指数膨胀**、**steer 内容保留** 等

### CI
- push `release` → latest pre-release；push `v*` → 正式版本

---

## [0.1.3] - 2026-07-29

### Changed
- **Node.js 延迟解压**：发布包 190MB → 89MB（首次 `start.bat` 时解压）

### Fixed
- **`plugin.json` 缺失**：tsc 不复制 `.json`，`build-release` 现在自动补齐
- **`timer-state.json` 孤儿**：启动 + 保存时自动清理
- **`set_timer` 重复**：新增 `replace` 参数

---

## [0.1.0] - 2026-07-29

### Added
- **Hash 行编辑**：read 显示行哈希，edit 用 `lineHash + newText` 精准修改
- **版本检测**：`/api/version` 对比 GitHub，弹窗显示变更日志
- **热加载**：`reload_extensions` 无需重启
- **write 上限**：1MB 防止误操作
- **自动打开浏览器**

### Changed
- **User Agent → virtual** 类型
- **更多按钮**：三处统一 `⋯`
- **版本弹窗**：700px 宽
- **名称变更即时生效**

### Fixed
- **401**：`resolveLLMConfig` 从凭据库回注
- **DeepSeek**：`baseURL` / `deepseek-v4-pro` 默认
- **编码乱码**：bat 全 ASCII
- **隐私泄露**：release 不复制开发 workspace
- **首个模型默认**、**菜单关闭** 等

