# M7 开工简报：WebUI / 可视化（preview 轨道）

> 生成于 2026-08-22（M15 收官后）。M15 对账结论：preview 传输设施全部就绪、
> 真缺口集中在**传输接线层**（WS RPC 业务方法零注册）与**前端本体**。
> 本文是 M7 的开工地图：已有底座盘点 → 工作分解 → 决策点 → src 参考。
> 事实源：`docs/src-to-preview-map.md`（总图）+ `docs/m15-reconciliation.md`（缺口）。
>
> **收官注记（2026-08-22，M7 完成）**：决策点裁定——全量 A+B+C+D；前端移植
> src/ui/webui（组件层零改动）；RPC 命名取 preview 目录风格（`domain/action`，
> 两个命名空间并存）；ac-web-api 单行起步。落地清单与范式见 `preview/README.md`
> 的 "WebUI 接线与前端本体" 一节 + M7 路线条目；测试锁定 = ac-web-api（RPC 面
> 与 ack 映射）、ac-agent-admin（管理面）、webui/tests/adapter.test.ts（帧合成
> 表）、ac-app/tests/webui-e2e.test.ts（服务面全链路）。遗留（显式降级）：
> file.upload HTTP 面、singles/workspaces/版本/插件市场后端面、chat.subscribe
> resume 快照、chat.continue 自主续写。
>
> **后续路线（2026-08-22 补记）**：本移植壳为过渡形态（src 骨架 + 传输
> 适配器合成），非终态——原生重写见 **`docs/m16-native-webui-plan.md`**
> （决策已裁定：打捞传输无关件后立即删除本壳、新应用复用 preview/webui
> 路径、全量一步到位；adapter.test.ts 随壳退役，webui-e2e 持续锁契约）。

## 一、已有底座（全部就绪，只差消费方）

| 件 | 位置 | 现状 |
|---|---|---|
| HTTP/WS 传输 | `ac-web-server` | 路由注册中心 `route(method, pattern, handler)`（:param/尾*；注册即归属）；WS 广播/定向/心跳；**`registerRpc(method, handler)` 显式分发表**（重名抛错、注册即归属）；requestId 幂等（30s deduped ack）；`ack(kind: deduped\|busy\|parked)`；静态/SPA fallback；监听失败降级。yml 生产 3830 / TREE 测试 port 0 |
| 事件桥接 | `ac-ws-bridge` | **27 个 emit 事件直转 WS 帧**（`type=事件名`、载荷 `{args}`）——机器可读事件目录即协议目录。后台过滤零状态化（delta/step 事件 sender 判定；tool/* 经 run 边界登记表；边界事件广播） |
| 帧协议 | `ac-ws-protocol` | `parseFrame/buildFrame` + 控制帧 `rpc/call`、`rpc/result`、`ws/ack`、`ws/ready` + `isBackgroundSender` |
| UI 扩展宿主 | `ac-webui` + `ac-webui-extensions` | entries 清单（`GET /api/ui/extensions`）+ `/ui-plugin/:name/*` 静态 + `webui/extensions-changed(E)`；slot 白名单（宿主先开口六 slot/插件填空 fail-closed）+ install 15s 超时回滚 + isolated 档 |
| 事件载荷 | 各域 events.ts | run/step 级信封 `{conversationId, sender}`；delta 三通道 kind 分流（text/reasoning/toolcall）；执行身份进 tool/* 载荷 |

**手测路径**：`pnpm preview:chat`（REPL：真实 provider 对话 + 流式打印，`preview/ac-app/src/chat.ts`）。

## 二、工作分解（M15 遗留缺口 → M7 任务）

### A. WS RPC 业务方法注册（阻断级：前端无法接入的根因）

方法面按 src WS 协议对照（`src/host/server/src/ws/protocol.ts` ~56 型）。**每方法一个薄注册行**（`ctx.webServer.registerRpc`，注册即归属）——preview 弃反射全量，按消费域显式注册。归属行建议：

| 方法（src 名） | preview 数据源 | 归属行建议 |
|---|---|---|
| `chat.send`（+ack busy/parked） | `ctx.conversation.deliver`（outcome steered/queued → ack busy/parked；timeout → error） | 新行 ac-web-api（编排层） |
| `chat.interrupt` | `ctx.conversation.abort(agent, convId)` | 同上 |
| `chat.interact.respond` | `ctx.durableInteraction.reply` | 同上 |
| `chat.delete_message` | **缺口**：session 无删除 API（需增） | ac-session 域 |
| `agent.list` | `ctx.agents.list()` | ac-web-api |
| `agent.config` get/set（CRUD/热重载） | **ac-agent-admin 首期**（见 D） | 同上 |
| `agent.system_prompt`/`agent.tool_defs`（调试预览） | system-prompt 装配 dry-run / tools 生效集（`resolveToolNames`） | 同上（低优） |
| `group.list/create/delete/join/leave` | `ctx.group.*`（M15 已持久化） | 同上 |
| `group.history` | `ctx.group.historyFor(gid, viewer)` | 同上 |
| `history.request` | `ctx.session.history/records` | 同上 |
| `usage.tokens` | `ctx.usage.byAgent/byModel/byDay/totals`（M15 已带回读） | 同上 |
| `file.upload`（HTTP） | **缺口**：上传面整体缺失（multipart → workspace files） | 低优/延后 |

### B. 事件面补齐（出站）

| 缺口 | src 对应 | 落点 |
|---|---|---|
| 工具流式增量 | `chat.tool_execution.update` | 新事件 `tool/progress`（onProgress 回调已挂 call——bash 流式在；需事件通道 + bridge 转发 + 后台过滤沿用 run 登记表） |
| 归档完成通知 | `archive.completed`/`session.archived` | ac-archive 补 emit（requestArchive/archiveAll 收尾处） |
| Agent 档案变更通知 | `agent.profile.updated`（src 写侧本就缺失——**勿照搬**，preview 补真的） | update_agent_profile / 管理面写后 emit（agents 域目录 `agents/updated`） |
| 逐消息汇总 | `chat.message.end` | 二选一：前端按 kind 聚合 delta（零服务端改动）或 bridge 派生汇总帧。**建议前端聚合**（delta-end 后有 after-step 终值） |
| interaction wire 载荷 | `chat.interaction`（已整形 question/options） | bridge 端整形 durable-interaction/opened（record → wire 形） |
| source/hint 展示 | `chat.start` 的 source 细分 | 低优：信封补可选 sourceMeta（判定不缺——sender='event' 已覆盖；纯展示） |

### C. 前端本体（决策点见 §三）

src 前端 = **Vue 3 + Pinia + vite 全家桶**（234+ 文件，功能完整：聊天流/工具结果视图/设置面板/群组/用量/插件管理/UI 扩展宿主）。preview 侧无任何前端产物——ac-webui 的 `staticDir`/SPA fallback 已备托管能力。

### D. ac-agent-admin 首期（M15 从 F 审计 #2 延后的管理面）

src 参考 `src/host/server/src/agent-service.ts`（350 行）+ `api/agents.ts`（~480 行）：
- CRUD：写 config.json（经 agentStore 唯一写口）+ `ctx.agents.reassign` 覆盖注册（M15 已备）+ **agents-dir 热重扫**（config/changed 或写后触发——现仅启动扫描）
- 凭据剥离：写配置遇 api_key → `ctx.credentials.set` 后剔除（M15 勘误 #1 同款归属语义）
- `GLOBAL_ONLY_KEYS` 白名单（preview 形态：各域已 owning 化，按 AgentConfig 字段白名单校验即可——`PROFILE_ALLOWED_FIELDS` 参照）
- diff 保存：`ac-config-merge`（deepMerge/computeDiff 纯库 M10 已备、**零消费**——此处接上）
- 头像/文档写口：`agentStore.saveDoc`

## 三、开工决策点（先定再做）

1. **前端形态**（最大分叉）：
   - **移植 src/ui/webui**：保全部功能（聊天/工具视图/设置/群/插件），需换传输层——`core/api/client.ts`（HTTP 端点）+ `core/events/contract.ts`（chat.\* 26 型 → preview 事件名直转 + rpc/call）。组件层（chat/Message、ToolResult/*、settings/*）高复用。代价：中-大。
   - **新写最小聊天面**：一个 vite 应用（对话 + 流式 + 工具气泡 + ask_questions 应答），吃 27 事件 + 5 个 RPC。代价：中。UI 扩展/设置面后续增量。
   - 建议：先 B+A 最小闭环（能对话）再定是否全量移植。
2. **RPC 方法命名**：沿用 src 名（`chat.send`/`agent.list`…——前端移植成本低）vs preview 目录风格新名。建议沿用 src 名（rpc 方法名与事件名是两个命名空间，不冲突）。
3. **前端托管**：预构建 dist 进 ac-webui 静态目录（对齐 M13 决策：manifest.ui 不做发布期构建——要求预构建产物）。dev 期 vite proxy → 3830。
4. **ac-web-api 行的边界**：纯编排（inject conversation/session/agents/group/usage…注册 RPC 转发），零业务逻辑——业务住各域服务。若嫌一行过大可按域拆（chat-api/agent-api/group-api）。

## 四、src 参考索引

| 内容 | 文件 |
|---|---|
| WS 线协议（~56 型全清单） | `src/host/server/src/ws/protocol.ts` |
| 事件桥接 + 后台过滤 + 重连 resume | `src/host/server/src/ws/handler.ts` |
| HTTP API 面（21 文件：agents/groups/history/usage/singles/upload/workspace/plugins…） | `src/host/server/src/api/*.ts` |
| Agent 管理面（GLOBAL_ONLY_KEYS/热重载/凭据剥离） | `src/host/server/src/agent-service.ts` |
| 前端事件契约 | `src/ui/webui/src/core/events/contract.ts` |
| 前端 HTTP client（端点封装） | `src/ui/webui/src/core/api/**` |
| 前端工具结果视图注册表 | `src/ui/webui/src/core/registry/toolResultViews.ts` |
| 前端 UI 扩展宿主（与 ac-webui-extensions 对齐） | `src/ui/webui/src/core/extensions/**`、`ui-plugin-iframe.html` |
| 前端聊天组件（流式 markdown/思考/工具气泡） | `src/ui/webui/src/components/chat/**` |

preview 侧范式参考：`ac-web-server/tests/web-server.test.ts`（ws client + registerRpc 测试范式）、`ac-ws-bridge/tests/ws-bridge.test.ts`（帧断言范式）、`ac-webui/src/index.ts`（route 注册范例）。

## 五、验收路径

1. 每项：`pnpm preview:typecheck && pnpm preview:test`（新行配 tests/；组合根双表同步——tree.test.ts 防漂移）
2. RPC 面：web-server 测试范式扩（rpc/call → handler → rpc/result + ack 幂等）
3. 端到端：`pnpm preview:boot`（3830）+ wscat/脚本 rpc/call 手测；前端接入后浏览器直连
4. 事件面：ws-bridge 帧断言范式（新事件转发 + 过滤语义）
5. 收尾全量：typecheck + test + smoke + boot + supervised
