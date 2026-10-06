# 消息处理链路根因分析（message-pipeline-analysis.md）

> 登记批 cr-87（2026-10-01）。配套图谱：[message-pipeline-graph.html](message-pipeline-graph.html)。
> 依据：src/README.md 轨道事实源、src/docs/cr-log.md 全部 47 条修复史、ac-session / ac-ws-bridge /
> ac-wire-format / ac-client-ui-conversation 源码。

## 一、问题陈述

「聊天的消息区域总是有些小问题修不好」——修复史证实了这一体感：cr-log 中与消息
显示直接相关的修复至少 15 条（cr-33~37 的会话视图批、cr-44/45/46 的投影/恢复/串台批、
cr-60/61 的合并/前缀复用批、cr-78 桶键、cr-85 线格式），其中多条互为因果或同根异症。
修一条、又出一条的循环模式，指向结构性原因而非个别缺陷。

## 二、链路全景（四层）

```
L1 写路径   ac-conversation(状态机) → ac-agent-loop(事件) → ac-ws-bridge(帧桥)
             产出：emit 事件流（delta/step/run 边界）——「直播管线」
L2 存储     ac-session：partials.jsonl(journal 台账) → settlement 切段物化 → messages.jsonl(权威)
L3 读路径   ① LLM history()（每 run 上下文重派生）
             ② web-api session/history（webui 首屏/分页，records() 活投影）
             ③ remote-link forwardRpc（手机端：钳页 + lite 投影 + 加密帧）
L4 前端     feed-core.ts(2315 行)：直播帧 ingest + 历史分页 + 双源合并 → buildTurns → 渲染
```

关键事实：**直播流（WS 事件）与历史投影（RPC）是两条物理独立的管线**，最终视图是两者
在前端时序敏感合并的结果。这是整条链路的结构重心，也是问题重心。

## 三、结构性发现（五条，按严重度排序）

### F1 · 双管线无收敛协议 —— 主根因

一个 turn 的生命周期：直播行先出现（本地 uid，无 persistedMsgId），run 收束后 settlement
物化出权威行（message_id），前端再延时 300ms（TURN_DONE_DELAY）重拉首屏，用
mergeHistoryPage 双键去重（persistedMsgId|id）完成「直播行 → 权威行」的替换。

问题：**替换的成立依赖时序赌注**——300ms 内 settlement 必须已落盘且 records() 已可见；
两条管线之间没有任何「权威行已到达，可以替换了」的确认信号。任何一条管线迟到、乱序、
多投，视图就错位，然后长出一个针对性补丁：

| 症状 | 补丁 | 性质 |
|---|---|---|
| 重拉拿到旧数据 / resume 快照越过活投影 | fingerprint 短路 + resume 身份匹配特判（cr-60） | 缝合 |
| 同锚步行被去重吞掉 | persistedMsgId+id 双键（2026-09-21） | 修复（但双 ID 体系本身是症状） |
| event 行直播/历史重复渲染 | liveEventIds 过滤 | 缝合（每类新行都要记得补） |
| 前缀复用过期 Turn | turnContentSig 加 tool result 长度（cr-61） | 缝合 |

这解释了「修不好」的机制：每个补丁都在修补某一个窗口，而窗口本身（双管线时序差）是
结构性的，补丁只会移动窗口，不会消除窗口。

### F2 · 三读路径口径漂移

同一存储被三种口径读取（LLM history / web-api records / remote lite），叠加 viewer 投影
变体（pair/group/single）。口径一致性靠人工同步，没有构造保证。实例：cr-55 lite 投影直接
变异 records() 共享缓存对象（污染 LLM 回放读侧）、cr-78 sender 前缀致桶键分裂（流式门控
拦帧 + 历史读不回）、cr-45 recoverJournal agentId 错根（singles 整轮丢失）。

### F3 · feed-core 单体承载合流

2315 行的 feed-core.ts 同时承载：帧路由、ingest 状态机、历史分页、resume 合并、未读
持久化、run 计时、归档标记——七种关切在同一作用域。直接后果：① 修复的影响面不可局部
化，改合并逻辑可能碰计时；② 同类 bug 在不同关切下重复出现（去重逻辑至少在
mergeHistoryPage / liveEventIds / resume 快照三处各写一遍）；③ 测试只能黑盒整文件
（本包 26 个测试文件全部驱动完整状态机）。

### F4 · 存储层设计健康（排除项）

journal/settlement/切段物化三段式在崩溃恢复上证明了价值：cr-44/45 修复的都是「窗口外的
意外」（双进程并发写、桶键推导缺失），而非设计本身。**问题不在存储层，在存储之上的投影
与合流层**——这一排除很重要，避免把修复力气花错地方。

### F5 · 部分补丁已是正确方向

fingerprint 短路（unchanged 语义干净）、双键去重、cr-85 wire-format 并源（两条下行链路
各自为政 → 共享纯库）都是向「构造保证」演进的成功先例。说明架构方向可救，不需要重写。

## 四、修复方向（按杠杆率排序，供裁决）

### D1 · 收敛协议显式化（治 F1，最高杠杆）

给「直播行 → 权威行」的替换一个显式信号，替代 300ms 赌窗。两个候选形态：

- **方案 a（后端补齐）**：settlement 物化完成后 emit 一个收敛事件（如 session/run-settled，
  载荷含 conversationId + runId + 收束行 message_id）→ 前端收到即重拉/精准替换。
  优点：语义最干净、事件归位正确（after-* 观察通知）；代价：ac-session 加一个事件目录。
- **方案 b（前端去赌）**：重拉后校验「权威收束行已含该 run」——未含则退避重试而非接受旧数据。
  优点：零后端改动；代价：仍是轮询语义，只是从赌一次变成赌到中。

推荐 a：与「事件模式完整形」（before → started → 主体 → transform → after）完全同构，
settlement 落账后本就该有通知位——现有 router/reply-completed 只覆盖整轮回复，不覆盖
journal 物化边界。落地后 TURN_DONE_DELAY / resume 快照特判 / liveEventIds 三类补丁可
逐步退役。

### D2 · 读投影单源化（治 F2）

三种读口径的投影函数收进 ac-session 单源（lite 截断、viewer 投影、partial 排除都做成
同一函数的参数化投影），web-api / remote-link 只做传输层适配。cr-55 的缓存污染正是
投影逻辑放错层（web-api 直接变异 session 缓存对象）的实例。

### D3 · feed-core 拆分（治 F3，配合 D1 做）

按关切切开：ingest 状态机 / 历史分页 / 双源合并器 / 展示派生（未读、计时、归档标记）。
其中「双源合并器」独立成纯函数模块后，去重/替换语义有了单点，D1 的收敛事件也有了
明确的落点。建议在 D1 落地后做，避免为拆而拆。

### D4 · 不建议的方向

- 重写存储层（F4 已排除）；
- 继续在现结构上打时序补丁——修复史已证明这是移动窗口而非消除窗口。

## 五、与现有裁决的衔接

- 本分析不改动任何行为，纯诊断 + 方向，符合「先根因后动手」的开发纪律；
- D1 若采纳，事件归位走 after-*（观察通知），需在 ac-session 事件目录登记并过
  event-catalog 静态锁定（cr-19 已建防线）；
- D2 若采纳，注意 ac-session 现无事件目录（契约表中事件列为 —），投影单源属服务方法
  演化，不涉新事件；
- 均为渐进式改动，符合插槽-插头可逆性验收（摘掉改动能零改动恢复）。