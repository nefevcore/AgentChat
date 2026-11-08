# 会话缓存与帧有序性改造计划

> **实施进展（2026-11-08）**
> - ✅ C1：prepareToolCall 收下 provider 真 id（feed-core）——卡片直接用真 id，无占位升级窗口；onToolStart 配对改 id 优先、name 兜底。
> - ✅ C2：建卡门槛改累积式（chatOps ToolCallAcc + feed-core delta 累积）——id/name 分片各自到达即记，双全才建卡。
> - ✅ A1：新增 client/viewParking.ts（滚动锚点泊位 + 思维链折叠位）；useConversationHistory 切换 watch 接线（切走泊位/切回 reveal 复位 + restoredFor 抑制首载滚底）；TurnDisplayItem 折叠位经 itemKey 登记/取回。测试 tests/view-parking.test.ts。
> - ✅ A2：feed-core 热集 LRU + 字节预算（_lru / estimateDialogBytes / maybeEvict；FeedCoreOptions.lruMaxDialogs/lruByteBudget 可注入；流式中/加载中/活跃分区永不淘汰；淘汰=resetDialog+弃派生态）。测试 tests/dialog-lru.test.ts。
> - ✅ B1（持久化+携带面）：writer.allocSeq 跨实例续接（tailMaxSeq 扫尾，tests/seq-seeding.test.ts）；session/history 行带 seq + 页区间 firstSeq/lastSeq（view.ts/user.ts/web-api.ts）；前端 PSessionRecord/ChatMessage 透传 seq，DialogFeed.historySeqHigh 水位维护（mergeHistory 只增不减，resetDialog 清零）。**前端水位过滤待 B2 帧携带落地后接线。**
> - ✅ C3（账本半边）：reader runFacts 跟踪 journal-settled.finish；projectStep 对 interrupted run 无结果调用合成 TOOL_NOT_STARTED（aborted 步）/ TOOL_OUTCOME_UNKNOWN（完整步）终态；ok 收束维持空成功合成。测试 tests/c3-synthetic-finality.test.ts。
> - ✅ B2（账本半边）：ProjectedStep.seq 随步行物化透传（records.ts/reader.ts projectStep）。
> - ✅ B2（帧携带半边，子代理实施）：时序调研确证 delta 帧无法携带步行 seq（journal 落盘在 after-step 之后，且 cr-707「事件先于落盘」不可反转）。落地为方案 a：writer.journal() 返回 seq → ac-ledger service 落盘后 emit ledger/step-journaled{agent,conversationId,runId,step,seq,stepId?}（刻意晚于落盘 = 「seq 已 durable」语义）→ ac-wire-format bridge-events 直转（ws-bridge/remote-link 两链路）→ feed-core 消费：st.lastStepSeq 水位补记（只进不退）+ seq 锚到 stepId 匹配的流式载体（settlement 前直播行即获稳定身份）。llm/delta 帧带 meta.seq 时同水位配对去重（回退帧整帧丢弃，先于 streaming 重点亮）；帧无 seq 零行为变化。测试 b2-step-journaled.test.ts + b2-frame-seq.test.ts。
> - ✅ B3（缩面而非整除役）：服务端锚点操作（singles/fork、session/truncate）按 message_id 定位，权威行仍须 settlement reload 换取（行级 seq 是身份锚不是服务端寻址键）——整除役会让 2026-09-21 分支按钮修复回退。已做：durable 确证驱动（run-settled，delay=0）2s 内到场过的分区，after-run 500ms 兜底重拉跳过（兜底只服务事件丢失/旧后端形态）。
> - A3/A4 维持可选。

> 2026-11-08 与 DSH（DeepSeek Harness）对照分析整理。结论先行：**AgentChat 数据层已是多会话保留，缺的是视图停靠与生命周期管理；帧竞态的根因是排序信号（seq / callId）没有送达需要它的地方，而其中大部分信号其实已经在链路里，只是被丢弃或没持久化。**

---

## 一、背景事实（已核实，勿重复调研）

### 1.1 AgentChat 现状

- **数据层已是多会话保留**：`feed-core.ts` 的 `dialogs = Partial<Record<DialogId, DialogFeed>>` 字典在整个应用生命周期常驻，切会话不清空；切走期间新消息经 WS 直播帧持续路由进后台分区；切回时 fingerprint（`size:mtimeMs`）短路——文件未变则服务端返回 `unchanged` 轻载荷，本地零重渲染（2026-09-19 优化）。
- **`hasMore`/`offset` 水位、未读数、`_version` 已 per-dialog**（cr-844 字典化版本号，多会话并行流式不互相弄脏）。
- **缺三样**：① 视图状态（滚动位置、思考链展开态）切回即丢；② `ConversationView` 单容器常驻组件，切回全列表重渲染（"身份守卫"族补丁的来源）；③ `dialogs` 字典无淘汰、无重启持久化（无上限增长，与 DSH 同病）。

### 1.2 内存量级（1224 个真实会话实测）

| 指标 | 数值 |
|---|---|
| 平均会话 | 17 条消息 / 85KB JSON |
| 中位数会话 | 7 条消息 / 12KB |
| 平均单条消息 | 5.2KB |
| 最大会话 | 2.2MB |
| 客户端典型会话驻留（rawMessages 对象化 ×1.5 + turns memo +10-20%） | 20-50KB；重会话 3-4MB |

客户端默认只装首屏 5 轮（`HISTORY_PAGE_SIZE = 5`），所以多数 dialog 常驻比全量还小。LRU 保 30 个热 dialog 预算仅 10-50MB。

### 1.3 DSH 参照模型（要点）

- **seq 单调序号统一一切**：每事件落盘拿不回退的 SessionSeq（durable、跨重启），历史页/直播帧/投影值全部锚定；投影 store 同 key 按 seq 裁决（`seq <= row.seq` 丢弃，"重放帧不能回退值，过期基线不能覆盖新帧"）。
- **瞬态流与持久层显式配对**（ClientAssistantStream）：chunk 带 attemptId+index，断号/不配对 → `rebaseline`（重开 follow 流原子替换，不增量缝合）；transient chunk 赋伪 seq（`durableCursor + 1 - 1/(n+1)`）插进 durable 序列间。
- **世代号挡迟到响应**：openGeneration 递增，旧循环检查即停。
- **callId 先于流存在**：provider 的工具调用 id 在流式**首个分片**就返回（OpenAI 首 delta 带 id+name / Anthropic content_block_start / pi-ai toolcall_start），适配器块开始捕获、盖在每片上。UI 无"占位升级窗口"。
- **配不上是协议内状态**：repair.js 对崩溃/中断/fork 尾部合成确定性收尾事件（TOOL_NOT_STARTED / TOOL_OUTCOME_UNKNOWN + step/end + turn/end，合成事件继续 seq 序列）——"合不上"从运行时竞态变成恢复时确定性计算。
- 代价：读侧人人折叠（需投影 checkpoint 层省冷读），文档模型的优势（见 1.4）不放弃。

### 1.4 AgentChat 消息格式是合理取舍，不动

run 终稿行自带 `steps[]`（文档模型）带来：读放大 O(runs) 行 vs O(events) 折叠、行内 steps 即自带 checkpoint（不需要投影缓存层）、journal 收束即清有界、LLM 上下文线性扫行、客户端零折叠、移动端 lite 截断一行搞定。**不改为事件溯源**；要补的只是排序信息随行携带（见 §三）。

### 1.5 seq 现状（畸形根源）

- `LedgerWriter.allocSeq()`：`nextSeq++`，writer 实例内单调，messages.jsonl / journal partials / subcalls 共用计数器；**每实例从 1 重来**（一 run 一 writer，A5 单写者）。实测 `admin~admin` 38 行 seq 有 13 处回退边（`1,2,1,3,1,3,...`）。
- reader 明注："真序 = 文件行序；按 seq 排序会跨重启段交错，不做"。
- **seq 从不出 host**：`PSessionRecord` 无 seq 字段，WS 帧 meta 只有 stepId。
- **seq 不是稳定身份**：settlement 两阶段物化（journal 步行 seq A → messages 段行重新 allocSeq 拿 seq B），`ProjectedStep` 只保留 stepId、丢弃原 seq。
- journal 顺序保证是**分段的**：run 内 step/inject 相对序正确（注入按消费点落盘 + sealed 边界 + 迟到 steer 回落 next-run，D3）；`journal-tool-result` 补行**设计上迟到**（副作用前 durable，按 toolCallId 覆盖合并，不按位置）；跨 run/跨 writer 实例完全不保证。

### 1.6 工具卡合并现状

- 直播路径三重键控：参数流按 index 建 `prep-<idx>-<ts>` 占位 → delta-end 按 "preparing 标记 + name 精确配对"升级真 id（2026-09-04 同名并行错位教训）→ onToolEnd 按 tool_call_id 精确匹配写 result（无 id 旧事件才退位置匹配）。
- 丢失窗口全靠兜底链：spinHold 300ms、settlement reload 500ms、悬挂探针 STREAM_STALE_PROBE_MS 180s、权威轮询 authoritativeRuns、重连 onOpen 全清、convergeDialog。
- **重大发现：id 已全链路到达前端，被丢弃**。`mapChunk`（ac-openai-completions）首分片转发 provider id → `llm/delta` 事件原样带 `chunk.toolCalls[].id` → ws-bridge 原样转发（cr-586）→ feed-core 用 `tc.id && tc.name` 做建卡门槛、存进 `st.tools` Map，**却给卡片发自编 prep id**。升级窗口是历史遗留，非协议限制。
- 隐藏脆弱点：建卡门槛要求 id 和 name **同一分片**到达；provider 若拆片则卡永远建不出。chat() 聚合器是累积式判定（`if (frag.id) acc.id = frag.id`），前端应对齐。

---

## 二、工作项 A：多会话体验补全（原 ①+②）

### A1. per-dialog 视图停靠（1-2 天，体验收益最大）

- 切走时记录：滚动锚点（消息 key + offset；`TranscriptList` 已有 `reveal(key)` 能力）+ 思考链展开态。
- 存放：per-dialog 停靠区，模式照抄 `draftParking.ts`。
- 切回：fingerprint 命中 `unchanged` 路径下直接 `reveal` 复位，不滚底。

### A2. dialogs 热集 LRU + 字节预算（1 天）

- LRU 按 `touch()`（已有）排序；保留最近 N=30 个 dialog 或总字节预算 ~30MB（按 `rawMessages` 内容长度估算）。
- 流式中的分区（`d.streaming` 或有占位）**永不淘汰**。
- 淘汰 = `resetDialog(id)` + 丢弃对应 `_version` / turns memo。

### A3.（可选，慎做）渲染保活

- `ConversationView` 单实例 → per-dialog 实例 + `<KeepAlive :include="hotIds" :max="5">`。内存 ×5，需重审"身份守卫"族测试。**先做 A1/A2，卡顿仍明显再上。**

### A4.（可选）重启预热

- 最近 5-10 个 dialog 的 `rawMessages` + 指纹落 IndexedDB（中位数 12KB/会话），启动回填，首切命中 unchanged 短路。不建议学 DSH 全量 localStorage。

---

## 三、工作项 B：帧有序性三层 seq 方案

**原则：不引入事件溯源、不动文档格式，只把已有的排序信号持久化并送达前端。两个 seq 空间分开，永不混比。**

### B1. 行级 seq 持久化（历史面水位）

- writer 打开时扫尾行取 `max(seq)` 续接（消灭每实例归零）。
- 读侧"按 seq 排序会交错"注释随之作废。
- `session/history` 响应行带 seq + 页区间 `[firstSeq, lastSeq]`。
- 前端 per-dialog 维护已见水位：`seq <= 水位` 丢帧；检测断裂 → 走现成 `convergeDialog` **整窗替换**（不增量补，对齐 DSH gap-repair 语义）。

### B2. 步级 seq 保留 + 帧携带（直播面配对）

- 物化时把 journal 步行 seq 透传进 `ProjectedStep.seq?`（存量行缺席回落现有启发式）。
- delta / 补行 / after-execute 帧带 `runId + seq`（journal 行已有，转发时带上）。
- 用途：run 内步级配对去重、检测"占位无真 id"断裂。**跨 run 边界用 runId 分段；tool-result 补行永远按 toolCallId 合并、永不按 seq 排序（现状保持）。**
- 可选加固：writer 层断言——同一 run 的 journal 行 step 号回退（补行除外）即 warn，把纪律变可检测。

### B3. persistedMsgId 时机问题（归属本方案）

- 身份在 durable 写入时刻才生 → 曾致"分支/编辑/删除按钮刷新才出现"，现靠 settlement reload 缝合。B1 落地后行级 seq 即稳定身份锚，此补丁可退役。

---

## 四、工作项 C：工具卡 callId 前置（最便宜，最先做）

1. **`prepareToolCall` 收下已在手的真 id**：`prepareToolCall(dialogId, st, idx, tc.id, tc.name)`，卡片 id 直接用 provider id；`onToolStart` 的 name 配对降级为无早期 id provider 的兜底。
2. **建卡门槛改累积式**：对齐 chat() 聚合器——id/name 分片到达即记，双全才建卡；消灭"provider 拆片则永不建卡"的脆弱点。
3. **合成收尾进 durable（对齐 DSH repair 思想）**：中断 run 的 settlement 把未收到结果的调用物化为终态步（cr-766 `aborted` 标记已为步级做了，扩展到"未开始的调用合成 not-started / 结果未知合成 unknown 终态"）。UI 兜底链（spinHold/探针）降级为纯保险。
4. （可选）子调用已本地铸造 `toolCallId = <runId>#<seq>` 先于执行、start 帧携带——无升级窗口，不动。

---

## 五、实施顺序与依赖

```
C1-C2（传参级，独立可先行，立刻消灭升级窗口）
  ↓
A1 → A2（体验补全，互相独立）
  ↓
B1（行级 seq 持久化 + 过线 + 水位过滤）
  ↓
B2（步级 seq + 帧携带）→ C3（合成收尾，依赖 B2 的断裂检测）
  ↓
B3（settlement reload 退役）
  A3 / A4 视 A1/A2 效果决定
```

预期收益链：C 消灭占位升级竞态；A1/A2 补齐体验与内存上界；B1 消灭重放回退/顺序异常（前端水位过滤）；B2+C3 把"合不上"从竞态补丁变成恢复计算；B3 收敛补丁族。

---

## 六、关键代码坐标

| 主题 | 位置 |
|---|---|
| dialogs 字典 / fingerprint 短路 / 装载水位 | `packages/ac-client-ui-conversation/client/feed-core.ts`（loadHistory / requestHistoryPage / mergeHistory / convergeDialog） |
| 滚动装载与身份守卫 | `packages/ac-client-ui-conversation/client/useConversationHistory.ts`、`switchTrace.ts` |
| 草稿停靠（A1 参照） | `packages/ac-client-ui-conversation/client/draftParking.ts` |
| seq 分配 / 两阶段物化 | `packages/ac-ledger/src/writer.ts`（allocSeq / deliver / journal / settlement） |
| seq 读面语义 / 补行合并 | `packages/ac-ledger/src/reader.ts`（runFacts / stepsOfRun） |
| 读面组装 / 指纹 | `packages/ac-ledger/src/view.ts`（assembleSessionView / historyView） |
| 行协议（ProjectedStep 加 seq 落点） | `packages/ac-ledger/src/records.ts` |
| 工具分片 id 转发 | `packages/ac-openai-completions/src/index.ts`（mapChunk） |
| 占位/升级/合并 | `packages/ac-client-ui-conversation/client/feed-core.ts`（prepareToolCall / onToolStart / onToolEnd / onToolUpdate / onSubcall*） |
| 事件发射与 stepId 贯通 | `packages/ac-agent-loop/src/service.ts`（step-started / envelope / llm.chat meta） |
| delta 微批转发 | `packages/ac-ws-bridge/src/index.ts`、`packages/ac-post-office/src/stream-bridge.ts`、`ac-wire-format` LlmDeltaBatcher |

## 七、明确不做 / 不改

- 不引入事件溯源、不拆文档格式（steps[] 随行的读侧收益保留）。
- 不照搬 DSH 的无限会话保留与全量 localStorage 持久化（A2 的 LRU 上界正是对它的修正）。
- tool-result 补行继续按 toolCallId 合并，不改按序。
- journal seq 不承担跨 run 排序（runId 分段前提）。
- usage / apiMs / runCalibMs 天生步末，校准对模式正确，不动。
