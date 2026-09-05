# 适配器作战笔记（webui-adapter-plan 执行期工作文档）

> 状态行见 `webui-adapter-plan.md`。本文件是执行期的**双向契约对照表与映射决策**，
> 跨 session 的作战地图；收口后可归并进 README 或删除。

## 一、两层 dialog 词汇（勿混淆）

- **前端分区键**（`utils/feed.ts` DialogId）：`direct:<agentId>` / `group:<gid>` / `single:<sid>` / `pair:<a>|<b>`。UI 内部用。
- **后端会话键**（事件载荷 `data.dialogId`，src 后端词汇）：`chat~<lo>~<hi>`（1v1 排序对）/ `group~<gid>~<aid>`（群内 Agent 推理）/ `single~<sid>`。
- feed.isUserDialog 规则：`group~*` 过滤；`single~*` 放行；`chat~*` 仅含 `user`（VIEWER_ID）放行；缺省放行。
- resolveDialogId：`single~sid` → single 分区；其余按 agentId → direct 分区。
- **适配器合成责任**：preview conversationId（1v1=agentId、single=sid、群成员=gid~agent）
  → data.dialogId 用 src 词汇合成：1v1=`chat~user~<agentId>`（排序：user 与 agentId 排序后 join，注意 lo~hi 排序——实测 'user' 与 agent id 字典序，按 [a,b].sort()）；single=`single~<sid>`；群成员 run=`group~<gid>~<agentId>`（被 UI 过滤，正好不串台）。

## 二、WS 出站（src WS_SEND → preview RPC）

| src 事件 | 载荷 | preview 映射 | 回执合成 |
|---|---|---|---|
| chat.send | {to, content, deepThink, reasoningEffort?, files, requestId?, session?} | conversation/deliver {agentId, message, conversationId?: sid, sender:'user', requestId} | deliver outcome steered/queued → 合成 chat.send.ack {busy:true, to}；ws/ack deduped → chat.send.ack {deduped:true, to} |
| chat.interrupt | {to, session?} | conversation/interrupt {agentId, conversationId?} | — |
| chat.continue | {to, session?} | **近似**：conversation/deliver 一条续写提示（显式降级，实测调优） | — |
| chat.subscribe | {to, session?} | conversation/stats {agentId, conversationId?} → 合成 chat.session.resume {active, session} | resume 无快照源：合成 {active:false}（前端 onSessionResume 对 inactive 直接 return，安全降级）；running 命中时合成 {active:true, messages:[]} 走前端兜底 |
| chat.delete_message | {agent, counterpart, messageId} | session/delete-message {conversationId=agent, messageId} | — |
| chat.interact.respond | {interaction_id, choice} | interaction/reply {id, answer:{answers:[choice]}} | — |
| history.request | {from, to, limit, offset} | session/history {conversationId=to, limit, offset} → 合成 history.response 帧 | 注意分页语义差异（见 §四） |
| agent.list | — | agents/list → agent.list.response {agents:[AgentInfo]}（合成见 §五） | — |
| agent.system_prompt | {agentId, session?} | agents/system-prompt → agent.system_prompt.response {success, systemPrompt} | — |
| agent.tool_defs | {agentId} | agents/tool-defs → agent.tool_defs.response {success, toolDefs} | 形状核对：前端读 data.toolDefs 数组 |
| session.compress | {agent, counterpart} | session/archive → 合成 session.compressed 帧；archive/completed 事件 → 合成 session.archived {success, agent, counterpart} | — |
| system.restart | — | system/restart | system/restarting 事件直转 |
| group.message | {group_id, content, from} | group/send {groupId, from, content} | — |

## 三、WS 入站（preview 事件帧 → src chat.* 合成）

| preview 帧 | 合成的 src 事件 | 关键载荷换算 |
|---|---|---|
| loop/run-started (request) | chat.start | dialogId 合成（§一）；request.sender→sender；source: preview 无 → 可选合成 {kind:'user',form:'prompt'}（非后台，前端只走 isBackgroundRunSource 分支判断）。后台 run（sender='event'）大多已被 ws-bridge 过滤 |
| loop/step-started (agent,index,messages,envelope) | chat.step.start | envelope.conversationId→dialogId；envelope.sender→sender；agentId=agent |
| llm/delta-start (input, meta) | （内部状态：开流） | 记录 per-conversation 流上下文（step 边界） |
| llm/delta (input, chunk, meta) kind 分流 | chunk.reasoning→chat.thinking.update {delta, dialogId, sender}；chunk.delta→chat.message.update {delta,...}；chunk.toolCalls→chat.toolcall.start {name,index} 首见时 + 内部累积 argumentsDelta；首 reasoning 分片前合成 chat.thinking.start {label?} | meta.agent/conversationId/sender → dialogId/sender |
| llm/delta-end (input, meta) | chat.thinking.end {label}；工具参数累积完成后合成 chat.tool_execution.start {tool_name, tool_call_id, arguments(解析后对象), label}（升级 preparing 占位为真 id） | arguments JSON 解析失败降级 {} |
| tool/progress (call, chunk) | chat.tool_execution.update {tool_call_id, delta} | call.toolCallId → tool_call_id |
| tool/after-execute (call, result, error) | chat.tool_execution.end {tool_call_id, result: result.output 字符串化} | result.output 形状→src result 是字符串（feed m.content = data.result ?? ''）——需字符串化策略（JSON.stringify 或 output 直接是 string） |
| loop/after-step (agent, step, envelope) | chat.step.end {interrupted?} | — |
| loop/after-run (request, result) | finish='interrupted' → chat.interrupted；否则 chat.end {content: result.text, dialogId, sender} | 前端 onChatEnd 用 content 兜底补气泡 |
| llm/chat-error (input, error) | chat.message.error {content: String(error)} | — |
| conversation/steered | （无 UI 需求；deliver outcome 已合成 send.ack busy） | — |
| group/message-posted (groupId, message) | group.message {group_id, from, payload: message.content} | UI 读 data.payload ?? data.content |
| group/created·deleted·renamed·member-added·member-removed | group.created/group.deleted/group.join/group.leave（群列表刷新语义核对：src 消费方待 WS 侦察报告确认） | — |
| durable-interaction/opened (payload) | chat.interaction {interaction_id: id, agent_id: owner, question, options, allow_custom, timeout_ms} | questions[0] 上提（bridge 已整形 AskQuestionsWire） |
| archive/completed (payload) | session.archived {success:true, agent: payload.agentId, counterpart:'user'} | — |
| agents/updated (config, change) | agent.profile.updated {}（前端触发 requestAgents 重拉） | — |
| singles/updated | singles.updated | — |
| system/restarting | system.restarting | — |
| plugin/installed·reloaded·catalog-changed | plugin.catalog.changed / plugin.reload | — |
| webui/extensions-changed | （extensions host 内部消费；核对 src 事件名 ui.extensions.changed） | — |
| job/settled | （src 无直接对应；忽略或后续映射） | — |

### 事件顺序契约（feed 状态机依赖）
1. chat.step.start 开流式占位（分区 streaming=true）
2. thinking/message/toolcall 增量（lastStreaming 定位）
3. chat.tool_execution.start 升级占位 id（prep- → 真 tool_call_id）
4. chat.tool_execution.end 按 tool_call_id 精确关卡
5. chat.step.end 关闭占位（interrupted 标记 → onInterrupted）
6. chat.end 关分区流式态 + content 兜底
- isForCurrentUser：`!sender || sender==='user'`——preview sender='agent'（send_agent 转述帧）会被拦，符合防串台语义
- isForActiveAgent 只门控全局信号；分区状态上下文无关处理（适配器无需关心查看上下文）

## 四、REST 端点映射（endpoints 层内部 RPC 化——M7 旧壳同款，签名/返回形状不变）

直接映射（有 RPC/HTTP 对应物）：
- fetchAgents → agents/list + 合成 AgentInfo[]（§五）
- createAgent → agents/create {config:{id,name→description?,provider,model}}
- deleteAgent → agents/delete
- uploadAvatar/deleteAvatar → POST/DELETE /api/agents/:id/avatar（HTTP 已有）
- fetchSessionTokens → session/tokens {conversationId=agentId}（形状对齐：tokenCount↔lastContextPrompt 近似，status 四档已有）
- fetchGroups → group/list {groups:[GroupConfig→GroupInfo 合成]}
- createGroup/updateGroup/deleteGroup → group/create / group/rename + join/leave 合成 / group/delete
- fetchGroupHistory → group/history（GroupMessageRecord→GroupPersistedMessage 宽松形状）
- fetchSingles/createSingle/updateSingle/archiveSingle/deleteSingle → singles/* RPC（注意 src DELETE=purge 语义 ↔ preview archive/delete 两方法）
- fetchWorkspaces/create/update/deleteWorkspace → HTTP /api/workspaces CRUD（已有）
- fetchWorkspaceTree/fetchWorkspaceFile → HTTP /api/workspace/tree|file（已有）
- uploadFile → HTTP /api/upload（路径形状核对）
- fetchUsageTokens → usage/tokens RPC（形状合成：src 期望的结构待 REST 侦察报告）
- fetchVersion → system/version + system/version-check 并取（更新功能修复批：latest/hasUpdate/latestUrl/checkFailed 齐备；simulate 透传）
- fetchChangelog → system/version-changelog；runVersionUpdate → system/version-update（git 检出自更新；npm 安装 unavailable）
- backupNow → backup/run
- interruptRun → runs/interrupt {conversationId=convKey 换算}
- fetchRuns → runs/snapshot（形状大改：src RunsSnapshot members/pairs/windows... → 合成或显式降级；runs 时间窗属"后端补最小推导"档）
- fetchPairHistory → session/history {conversationId=<a~b 排序会话键>}——pair 会话键在 preview 不存在（agent⇄agent 委托走各自 conversationId）→ 显式降级或按 sender='agent' 帧归类。**M16 原生面无 pair 概念，src 的 pair 视角依赖 src 会话文件命名——降级处理（矩阵格子点击无历史）**
- getUiExtensions → /api/ui/extensions（已有，形状对齐）
- fetchAgentModels → llm/providers stats.models 拼近似（M17 同款）
- fetchPools → config/get 键 llm/searchProviders（pools CRUD 无面=只读降级）
- browseReadFile → /api/workspace/file 近似；browseFolder → 已知降级（手动路径）

无面（显式降级：入口在、点了空、tooltip 说明）：
- agentPresets（fetchAgentPresets）→ 空 presets 数组
- （版本更新检查 runVersionUpdate/fetchChangelog 曾长期降级——更新功能修复批已补 RPC 直连，移出本清单）

## 五、AgentInfo 合成（已知硬伤顺手修）

preview AgentConfig {id, description?, provider?, model?, virtual?} → src AgentInfo：
- name ← description ?? id（src AgentInfo.name 硬依赖——nameOf 硬伤）
- description ← description ?? ''
- avatar ← /api/agents/:id/avatar GET 存在性（agents/list 载荷不含头像 URL——HTTP HEAD 探测太贵；方案：agents store 加载后 404 探测按需，或 avatar 字段合成 `/api/agents/:id/avatar`（浏览器 img onerror 隐藏）——实测定）
- virtual ← virtual
- lastActivity/lastMessage/hasActiveSession：前端 bump 驱动 + conversation/stats 合成 hasActiveSession

## 六、分页语义核对（history）

- src history.request {from,to,limit,offset}：mergeHistoryPage 按 persistedMsgId 去重，userCount 校准 offset（feed.loadHistory 内部逻辑——REST 报告确认）
- preview session/history {conversationId, limit, offset}：offset=0 尾部 limit 条；offset 递增往早翻
- 合成：from→忽略（VIEWER），to→conversationId（pair 场景降级）
- 返回 records→src messages 形状：SessionRecord {role,content,message_id,timestamp,name} → {role 归一化, content, message_id→persistedMsgId, timestamp→ms, agent_id: name ?? conversationId, name}——**文本级保真**（无 tool_calls/reasoning 历史回放，流式期完整保真、历史回放简化——已知边界，README 记录）

## 七、传输外壳复用决策

- 保留 src `services/websocket.ts` WebSocketClient **整体**（身份守卫/退避/积压/看门狗——UI 代码零改动原则下最忠实）；适配器作为 onMessage/send 的拦截层挂在其上（monkey-patch 形态：包装 WebSocketClient 或在其 send/onMessage 缝上翻译）。
- 备选：换 preview wire/connection.ts（同款机制）——但那要求改 stores/websocket.ts（UI 文件）。**决策：不动 UI 文件，适配器外挂。**
- 适配器位置：`preview/webui/src/adapter/`（新目录，OWNED 新代码）：`ws-adapter.ts`（帧翻译）+ `rest-adapter.ts`（endpoints 拦截）+ `dialog-map.ts`（会话键合成）+ `agent-shape.ts`（AgentInfo 等形状合成）。
- 挂载点：main.ts 是 UI 文件但只是 createApp——适配器 import 加在 main.ts 顶部（这是唯一允许的 UI 文件微改，或用独立 entry `main.preview.ts` 替换 index.html 引用——**决策：独立 entry 文件 + index.html 改一行**，UI 文件零改动）。

## 八、@agentchat/protocol 垫片

src UI import 的协议类型/函数：MessageSource、PersistedMessage、PersistedToolCall(ToolCall)、PluginMeta、UIExtensionDescriptor、UISlotId、isBackgroundRunSource。
→ `preview/webui/shims/@agentchat/protocol.ts` 自包含垫片（类型 + isBackgroundRunSource 函数复制），vite alias `"@agentchat/protocol": shims 路径`。types/index.ts 等 UI 文件零改动。
- 还有 `@agentchat/protocol` 之外：plugin.ts/index.ts import @agentchat/server + @agentchat/cordis——这俩文件是 src 轨道的宿主插件入口（cordis 插件形态），**不搬**（preview 有自己的托管方式：dist 静态托管）。
- settings/types.ts import 的 protocol 类型也在垫片范围。

## 九、搬运清单（src/ui/webui → preview/webui）

搬：src/（除 index.ts、plugin.ts——cordis 宿主半边）、index.html（改 entry 一行）、ui-plugin-iframe.html、public/、vite.config.ts（preview 版保留+ alias 增补）、tsconfig*、package.json（对齐 ac-webui-app 名字与依赖，去掉 @agentchat/* 依赖）。
不搬：node_modules、dist、tests/（另行拣选：feed-parallel-tools、feed-rapid-switch、feed-resume-merge、ws-backlog-flush 直接搬；csp-audit 适配新结构；perf/pool/policy 类按需）。
preview/webui 现有内容处置：归档分支保存（阶段〇）；src/、tests/ 退场；dist 保留托管占位；wire/ 不搬（适配器自包含，不依赖 preview 词汇——保持 src UI 纯度）。vite.config.ts 用 src 版 + proxy 增补 /ui-plugin。

## 十、锁测试设计（阶段一完成标准）

1. `preview/webui/tests/adapter.test.ts`（重建）：帧合成表——构造 preview 事件帧序列（run-started→step-started→delta 三通道→delta-end→tool/after-execute→after-step→after-run）→ 断言合成的 src 事件序列与载荷（dialogId 合成、sender 传递、占位升级链）。纯函数测试（适配器核心做成纯翻译函数 `translateFrame(state, frame) → srcEvents[]`）。
2. `ac-app/tests/webui-e2e.test.ts`（已有，保留）：后端缝锁定。
3. src 搬运测试（feed-*）：前端行为等价锁定。
4. REST 适配层：adapter 形状测试（agents/list→AgentInfo 等）。

## 十一、侦察定案（三份规格书合成后的补充决策）

1. **传输拦截形态（定案）**：patch `window.WebSocket` 为 TranslatingWebSocket 门面（readyState/onopen/onmessage/onclose/onerror/send/close 全表面积仿真，静态常量同数值）；src WebSocketClient 零改动拿到翻译层。REST 走 patch `window.fetch`（覆盖 endpoints 层 + settings/api.ts 两层 + 4 处资源 URL 中非 fetch 的留给真实 HTTP）。入口 = 新 `preview-main.ts`，index.html script 标签一行改（构建环境文件，非 UI 逻辑）。
2. **历史分页（定案）**：src offset 单位=轮次（HISTORY_PAGE_SIZE=5），前端按页内 userCount 回校 offset、hasMore=页内 viewer≥5。适配器维护 per-conversation 消息数游标：offset==0 → preview {limit:50, offset:0} 并重置游标；offset 增 → preview {limit:50, offset:游标}。前端回校基于我们返回的 userCount，数字本身不用于寻址。终止：返回页 userCount<5 或 preview hasMore=false。
3. **心跳**：ac-web-server 心跳=协议级 ws.ping()（浏览器 onmessage 不可见）→ 90s 空闲重连是 src/原生两代 UI 共有行为，接受并 README 记录（重连路径本身自愈：loading→ready + 流式占位清理）。
4. **toolCallId=tc.id**（ac-agent-loop 直接透传 LLM 调用 id）→ llm/delta 累积的 id 与 tool/after-execute 的 call.toolCallId 天然配对。
5. **chat.message.end 源**：loop/after-step（step.text/reasoning/toolCalls 全量，替换语义匹配 onMessageEnd）。顺序在工具结束之后（src 是先 message.end 后工具执行；延迟不影响正确性——替换同一占位对象）。
6. **chat.session.resume 降级（定案）**：chat.subscribe → conversation/stats；running 命中（agentId+conversationId 匹配）→ {active:true, messages:[], phase:'message', content:'', thinking:''}（前端 mergeResumeSnapshot 对空快照走兜底）；否则 {active:false}（前端无害 no-op）。
7. **群发送解锁**：group/send RPC result → 合成 group.delivered {group_id}（单播本连接）；群消息回显靠 group/message-posted 广播（含 from='user' 自己的）。
8. **chat.virtual.receive**：router/message-received 且 agentId=虚拟 user → 合成 {from: message.name ?? conversationId, payload: message.content}（尽力而为，实测调优）。
9. **runs 视图（显式降级）**：fetchRuns → runs/snapshot 合成最小合法 RunsSnapshot（members=agents+groups+[user,system]，pairs/groups/singles 从 conversations 推导，windows 全零，running 映射，coverage 零，subagents 空）——矩阵渲染活但无热力；pair 格子历史→session/history {conversationId:to} 近似。
10. **settings/api.ts 33 函数**（/api/config、/api/plugins/*、/api/agents/:id/config、/timer、/api/browse/file）全走 fetch 拦截 → 对应 RPC（config/*、plugin/*、agents/get-config·assembly、timer/*）；无面者降级形状。
11. **history.response 消息行合成（定案）**：preview SessionRecord {role,content,message_id,timestamp(ISO),name?} → src 行 {role: user→'agent'+agent_id:'user'；assistant→'agent'+agent_id:(name ?? convId)，tool/system→'tool'/'event'}；message_id→message_id（前端映射 persistedMsgId）；timestamp 保持 ISO 字符串。文本级保真边界 README 记录。
12. **事件顺序硬约束（适配器必须满足）**：step.start 先于一切 delta；toolcall.start（可省）→ tool_execution.start（升级占位 id）→ update* → end（按 tool_call_id 关卡）；step.end 闭合；chat.end 最后。isForCurrentUser 门（sender!=='user' 丢弃）天然过滤 agent 转述帧。

## 十二、风险与开放问题（原十一）

- chat.tool_execution.start 的 arguments 对象：从 toolCallsDelta 累积 JSON，delta-end 解析。多工具并行（index 多路）需 per-index 累积。解析失败降级 {}（卡片少显示参数不致崩）。
- tool result 字符串化：src onToolEnd m.content = data.result ?? ''（字符串拼接）。preview ToolResult.output 是 unknown（工具各自的 src data 形状）。合成策略：output 为 string 直用；对象 JSON.stringify（缩进 2）。（ToolCard 渲染的是注册表视图——按 name 分发，参数/result 展示待实测）
- 群列表刷新：group/created 等帧 → src 词汇映射待 WS 报告（src group.created 消费方）。
- history offset 校准：src 按 user 链数校准（mergeHistoryPage userCount）；preview 按消息条数 offset。前端 loadMoreHistory 的 offset 步进逻辑与 preview 语义可能错位 → 适配层换算（offset*平均轮次不可靠；方案：请求放大 limit + 前端去重兜底——mergeHistoryPage 本身按 persistedMsgId 去重，安全）。
- llm/delta 的 meta.agent 可能 undefined（loop 直连 run）——dialogId 合成兜底链：meta.conversationId ?? meta.agent ?? input.meta?.agent。
- run-started 无 conversationId（loop 直连）：不合成 chat.start（后台 run 不该进 UI）。
