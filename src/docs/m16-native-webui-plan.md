# M16 开工简报：原生 WebUI（preview 轨道原生设计）

> 生成于 2026-08-22（M7 收官当日；编号 M8-M15 已被历史里程碑占用，
> 顺延取 M16）。M7 实际路线是"src/ui/webui 移植 +
> 传输适配器合成"——组件/状态层原样保留，适配器把 preview 帧合成 src
> chat.* 契约（`webui/src/services/websocket.ts`）。能用，但骨架是 src
> 形状的：dialogId 靠 `chat~lo~hi`/`group~gid~aid` 解码、singles/workspaces/
> 版本/插件市场全是降级视图、src 概念（resume 快照/isTrigger）在 preview
> 无对应物。本文规划**原生重写**：preview 协议为一等公民，零适配层、
> 零 src 词汇。事实源：`preview/README.md`（M7 后现状）+
> `docs/m7-webui-plan.md`（M7 收官注记）。
>
> **开工决策（已裁定）**：① 旧壳（preview/webui 移植件）**立即删除**——
> 残件按 §四打捞清单搬运后整体移除，原生面为唯一前端；② 技术栈
> **Vue3 + Pinia + Vite**，复用移植件中传输无关件（ui/ 设计令牌与基础
> 组件、markdown 渲染、扩展宿主），视觉与现壳一致；③ 首期
> **全量一步到位**（聊天 + 群聊 + Agent 管理面 + 用量/扩展），不切
> 最小闭环；④ 新应用**复用 `preview/webui/` 路径**——cordis.yml
> `staticDir: './webui/dist'` 与 `pnpm preview:webui*` 脚本零改动。
>
> **收官注记（2026-08-23，M16 完成）**：全量 A+B+C+D 落地，按 §四
> 打捞清单搬运、旧壳死件整体删除（无悬空引用；scripts/yml 路径复用
> 零改动）。落地清单见 `preview/README.md` 布局图 webui/ 行 + M16
> 路线条目。测试锁定：webui/tests/wire.test.ts（连接/rpc/总线机制）、
> webui/tests/conversationReducer.test.ts（帧序状态机——run/step/delta/
> 终值修正/工具卡配对/收束/幂等重建/幽灵轮防回填）、ac-web-api
> 分页测试（limit/offset 尾部取页）、ac-supervisor-core 陈旧锁回收
> 测试、ac-app/tests/webui-e2e.test.ts（服务面契约，持续绿）。
> 真连验证：boot 3830 WS 探针全链路（建档→投递→帧流→历史分页→删除）
> + HTTP 三端点（/ /api/ui/extensions /ui-plugin-iframe.html）。
> 实测修正三处：① conversation/stats 真实形状 = {running, queued}
> （非 {runs}——前端类型按真连修正）；② 帧序 after-run 先于
> reply-completed——Turn 增 origin 标记（run/message/reply）防幽灵
> 空轮与视图串台；③ Windows 残留 .runtime 锁致 supervised 永久 78
> ——ac-supervisor-core 增陈旧锁回收（死 pid 判定 + 重试一次）。
> 显式降级（无面即无视图）：singles/workspaces/版本/插件市场/文件
> 上传与预览（wire/files.ts 垫片返回说明性错误）。

## 一、底座盘点（M7 后全部就绪，直接消费）

| 件 | 位置 | 现状 |
|---|---|---|
| RPC 面 | `ac-web-api` | 19 方法 `domain/action`：conversation/deliver·interrupt·stats（ack busy/parked/deduped 映射）、interaction/list·reply、session/history·delete-message·archive、agents/list·tool-defs、group 全套（含 rename）、usage/tokens |
| 管理面 | `ac-agent-admin` | 8 写侧 RPC：create·update-config·delete·get-config·save-doc·read-doc·set-credential·system-prompt（dry-run） |
| 事件帧 | `ac-ws-bridge` | 事件名直转 `{args:[...]}`；**后台过滤已在桥接完成**（sender='event' 流式抑制）——帧到达即可信，UI 无需 isBackgroundRunSource |
| 流式细分 | `ac-llm` events | llm/delta 单通道 chunk 字段分流（delta/reasoning/toolCalls[].argumentsDelta）+ meta{agent,conversationId,sender} |
| 工具流 | `ac-tools` | tool/progress（增量）/ tool/after-execute（终值，含执行身份 toolCallId） |
| 步终值 | `ac-agent-loop` | after-step 携带 step{text,reasoning,toolCalls} 终值（注意：工具结果不在 after-step 里，走 tool/after-execute） |
| 扩展宿主后端 | `ac-webui` + `ac-webui-extensions` | GET /api/ui/extensions + /ui-plugin/ 静态 + slot 白名单 + isolated 档 |
| 契约锁定 | `ac-app/tests/webui-e2e.test.ts` | 服务面全链路（投递→帧→历史→幂等）——与前端实现无关，重写后照常防漂移 |

## 二、原生架构（与移植壳的根本差异）

| 维度 | 移植壳（src 形状） | 原生面（preview 形状） |
|---|---|---|
| 会话寻址 | dialogId 字符串解码（chat~/group~/single~） | **conversationId 直用**（1v1 缺省 = agentId；群 = gid——与服务端同键，规约 2） |
| 事件消费 | 适配器合成 src chat.\* 26 型 | **事件目录直消费**（帧 type 即事件名，args 按目录解构） |
| 步边界 | 位置推断（lastStreaming 占位链） | step-started/after-step 显式边界 + chunk 字段分流 |
| 后台判定 | 前端 isBackgroundRunSource | 桥接已过滤，**帧到达即可信** |
| 重连恢复 | src resume 快照（preview 无对应，降级） | **幂等重建**：session/history + conversation/stats + interaction/list(pending) + agents/list 重拉 |
| 不存在的面 | 降级视图/静默吞（singles/workspaces/版本/市场） | **不进 UI**（无面即无视图；后续开面再进） |

### 分层

1. **wire 层** `src/wire/`（协议客户端，可独立单测）
   - `connection.ts`：连接管理——身份守卫/重连退避/积压队列(上限)/半开看门狗。从旧壳 `services/websocket.ts` 抽**连接半边**（协议无关，原样可用），丢弃合成半边。
   - `rpc.ts`：rpc/call 相关性（requestId → Promise；60s 超时）。
   - `events.ts`：帧解析 + **类型化事件目录**（事件名 → args 元组类型，手抄自 preview 各域 events.ts——前端自包含原则，同旧壳 compat 垫片做法；codegen 有规模再议）。
2. **状态层** `src/stores/`（Pinia；reducer 纯函数化，喂帧即可测）
   - `conversations.ts`：`Map<conversationId, Conversation{id, kind, steps, streaming, 分页}>`。run 消费协议（生命周期表）：

     | 事件 | 动作 |
     |---|---|
     | loop/run-started | 开 turn（request{agent,conversationId,sender}） |
     | loop/step-started | 开 step 占位（agent,index,envelope） |
     | llm/delta | chunk 分流：reasoning→思考流 / delta→正文流 / toolCalls→参数流（index 聚合 argumentsDelta） |
     | loop/after-step | **终值修正**（text/reasoning/toolCalls 为权威值，覆盖流式聚合） |
     | tool/progress → tool/after-execute | 工具卡：输出流 → 终值（按 call.toolCallId 配对） |
     | loop/after-run | 收束（finish=interrupted → 中断标记；text 兜底） |
   - `agents.ts`：agents/list 拉取 + agents/updated 增量刷新（change=updated/removed）。
   - `groups.ts`：group/list + group/created·deleted·renamed·member-\*·message-posted 事件维护 + group/history 分页。
   - `interaction.ts`：durable-interaction/opened（桥接已整形 questions 上提）→ ask_questions 弹窗；interaction/reply 应答；重连带 interaction/list(pending) 恢复。
   - `usage.ts`：usage/tokens 四维 + archive/completed → 会话已归档提示（重拉 history）。
   - `ui.ts`：主题/选中会话/未读计数（交互语义沿用 src 壳沉淀，但按 conversationId 寻址）。
3. **视图层** `src/views|components/`
   - Sidebar（agents + groups + 未读 + 忙闲[conversation/stats]）；
   - ChatView（turns 流：markdown + thinking 折叠 + **工具卡注册表**——toolResultViews 范式照搬）；
   - InteractionBar（ask_questions）；
   - SettingsPanel（ac-agent-admin 面：建档/局部补丁表单/凭据（apiKey 只写不读）/AGENT.md 文档编辑/system-prompt 预览/生效工具集）；
   - UsagePanel（byAgent/byModel/byDay 图表）。
4. **扩展宿主** `src/extensions/`：旧壳 `core/extensions/**` **整体搬迁**——它本就按 preview 协议写（/api/ui/extensions + slots + iframe isolated 档），不是 src 形状。

## 三、工作分解（单里程碑全量，内序 A→D，一次验收）

- **A wire + 聊天**：wire 三件 + conversations/agents/ui store + Sidebar/ChatView（1v1：历史/发送+ack busy·parked·deduped 处理/流式/工具卡/ask_questions）。
- **B 群聊**：groups store + 群视图（成员表/发言/群历史分页/多参与者 run 的消息归属——group/message-posted 唯一内容源，peer 回复走 router/reply-completed conversationId≠agent 判群）。
- **C 管理面**：SettingsPanel 全件（admin RPC + agents/updated 热刷新 + system-prompt dry-run 展示）。
- **D 用量/扩展/收尾**：UsagePanel + 扩展宿主搬迁 + 旧壳删除（§四）+ staticDir 验证。

### 后端配套小项（原生面暴露，均小改）

1. `session/history` 服务端分页：records 现全量回读、UI 本地分页是权宜——ac-web-api 加 limit/offset（从尾部往回取），随 A 做。
2. `LlmStreamMeta.stepIndex` 信封细化：**决策不做**——step 边界 + meta{agent,conversationId} 已够分桶；出现跨步乱序实证再开（改 ac-llm 契约成本高，有证据再议）。
3. 忙闲指示：conversation/stats 轮询（会话切走时停）即可，不新增事件。

## 四、旧壳处置（打捞后删除——开工第一步执行）

**打捞**（拷入新应用后再删整目录）：
`ui/`（令牌+基础组件 14 件）、`assets/main.css|markdown.css`、
`composables/useMarkdown.ts|useChunkedMarkdown.ts`、`utils/abap-hljs.ts`、
`markdown-it-texmath.d.ts`、`core/extensions/**`、
`core/registry/toolResultViews.ts|messageViews.ts`（注册表范式）、
`env.d.ts`、`index.html`、`ui-plugin-iframe.html`、`public/`。

**死件**（随壳删除，不搬）：`stores/**`（src 形状 feed/chat/websocket/…）、
`services/websocket.ts`（连接半边抽进 wire/connection.ts 后原文件死）、
`core/api/**`、`core/preview/rpc.ts`（理念由 wire/rpc.ts 承接）、
`compat/protocol.ts`（类型由 wire/events.ts 承接）、`settings/**`（src
形状组件，按 admin RPC 重写）、`tests/adapter.test.ts`（合成表随适配器
退役；**MockWebSocket 范式留给新 reducer 单测照抄**）。

**保留不动**（不在 webui/ 内）：`ac-app/tests/webui-e2e.test.ts`（wire
契约锁定）、`ac-app/src/m7-rpc-check.ts`（手测探针）。测试计数预期先降
11（adapter 随壳删）再随新单测回升。

## 五、src/旧壳参考索引

| 内容 | 文件 |
|---|---|
| 连接管理半边（身份守卫/看门狗/积压，协议无关） | 旧壳 `src/services/websocket.ts`（删除前抽） |
| mock WS 测试范式 | 旧壳 `tests/adapter.test.ts`（MockWebSocket 类） |
| 扩展宿主（preview 原生，整体搬） | 旧壳 `src/core/extensions/**` |
| 工具卡/消息视图注册表范式 | 旧壳 `src/core/registry/*` |
| markdown 流式渲染（分块/高亮/公式） | 旧壳 `src/composables/useMarkdown*.ts` |
| wire 契约 e2e（重写后照常跑） | `preview/ac-app/tests/webui-e2e.test.ts` |
| 服务面真连手测 | `preview/ac-app/src/m7-rpc-check.ts` |
| preview 事件目录（wire/events.ts 手抄源） | 各域 `src/events.ts`（ac-llm/ac-tools/ac-agent-loop/ac-router/ac-group/ac-archive/ac-agents/…） |

## 六、验收路径

1. 每步：`pnpm --filter ac-webui-app typecheck`（vue-tsc）+ wire/reducer
   单测（jsdom + MockWebSocket 泵帧断言状态机——**测 reducer 不测适配器**）
2. 契约：`ac-app/tests/webui-e2e.test.ts` 持续绿（前端无关的防漂移）
3. 端到端：`pnpm preview:webui:build` → `pnpm preview:boot`（3830）→
   浏览器全功能手测：1v1 对话/流式/工具卡/ask_questions 应答/群聊/建档改配
   凭据/用量/断线重连幂等重建
4. dev 链：`pnpm preview:webui`（3831 proxy→3830）热更可用
5. 收尾全量：`pnpm preview:typecheck && pnpm preview:test && pnpm
   preview:smoke && pnpm preview:boot && pnpm preview:supervised`
   + 旧壳删除后仓库无悬空引用（scripts/yml 路径复用故零改动）
