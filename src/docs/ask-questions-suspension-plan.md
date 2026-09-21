# ask_questions 挂起机制重构（suspension plan）

> 2026-02 立项。把 ask_questions 从「工具体内长阻塞等待」重构为「发起即返 +
> 系统（loop）持有等待」的挂起形态——等待脱离工具执行环境，run 在自然停点
> 挂起而非收束，用户作答后**同 run** 续走。

## 一、动机与形态

### 旧形态的问题

- 工具体内四重等待（replied 事件 + 150ms 轮询 + deadline + signal）约 150 行，
  且等待发生在 execute 里——工具执行环境（含 run_code worker 内存）为「等人」
  这种纯人类时间挂内存态；
- 正常路径（工具等待）与崩溃恢复路径（late-reply deliver）是两条并行代码路径，
  复杂度双份；
- 无人桶（excludeForms:['self']）的不设 deadline 等待挂到 setTimeout 上限
  （2^31ms）——病灶面靠预防性裁剪压制；
- run_code 内调用依赖预算冻结豁免，且 worker 必须存活到人作答。

### 新形态（时序）

```
step N     model → tool_call(ask_questions)
           execute（发起体，同步即返）：
             归一校验 → durableInteraction.open（write-ahead，interactions.jsonl）
             → session.recordContext(source:'durable-interaction')——run 活跃时
               落 run journal（partials.jsonl 注入行，消费点真序提升由 settlement 完成）
           → 返回 {ok, output:{status:'awaiting_user', interaction_id, questions}}
step N+1   model 见 awaiting 标记 → 收尾文本（描述引导；继续做不依赖答案的事也合法）
自然停      无工具调用且无 pending steer → loop/run-idle waterfall
           → ask 监听器发现本 run 未消费交互 → 挂起 await（replied/closed 事件）
用户作答    interaction/reply RPC（弹窗/待答清单，已有链路）→ replied 事件
           → 监听器返回答案消息 → loop 注入工作数组 → for 循环续步
           → 推进 → 无未消费交互的自然停 → 收束（settlement 折叠全程）
```

崩溃于等待期：journal 留 partial 步行（result = awaiting 标记，非 null，
stepsComplete 门天然满足）+ 注入行；interactions.jsonl 留 pending 记录 →
既有 late-reply 路径接管（deliver 唤醒新 run，答案纯 context 行）。
**活续走与崩溃恢复产出完全相同的会话转录形状**。

## 二、五项裁决

1. **run 如何停住：L0.5** —— 停止仍是模型自然驱动（无强制 interrupt、无新
   finish 词汇），loop 增加一个通用 idle seam（`loop/run-idle` waterfall）
   作为「不收束、同 run 续走」的唯一必需 loop 改动。
2. **run_code 语义损失：接受** —— 子调用即时返回 awaiting 标记，程序体无法
   在本 run 内拿到答案做分支；SDK 投影注释 + 工具描述同步声明新契约。
   worker 早已退出，挂起发生在 loop 层，run_code 的 ask 分支无需预算冻结
   （冻结机制保留给 approval）。
3. **approval 不动** —— 提权审批的答案是门禁判定（恢复执行点语义），与本次
   改动无关，保持挂起形态与预算冻结。
4. **答案回填形态：纯 context 行** —— 不走 backfillToolResult。late-reply
   路径移除补记调用；session.backfillToolResult API 可另行评估退役。
5. **竞态窗口：同 run 续走** —— context:durable-interaction 不收束 run；
   用户回复后经 idle seam 注入继续走相同 run（消息数组连续，KV 前缀稳定）。
   答案同走 recordContext 落账（journal 注入行 → settlement 提升 context 行，
   与提问行/late-reply 同形状——2026-09-21 修正：此前漏落账，转录缺席）。

## 三、loop/run-idle 事件契约

```ts
/**
 * run 自然停点拦截——模型本轮无工具调用且 steer 队列已消费尽时，循环
 * 先不收束，把「是否有系统持有的待注入材料」交给领域行裁决。
 * @mode waterfall
 * @scope run
 * 监听器两种姿势：
 *   · 持有注入：等待材料就绪后返回 LlmMessage[]（如 ask_questions 的答案
 *     context 消息）——循环注入工作数组并继续步循环（同 run 续走）；
 *   · 无事可做：return next()（透传下游）——全体空手 → 收束照旧。
 * 续走时 messages 尾部注入：自然停步的 assistant 终文本先补进工作数组，
 * 注入材料追加其后（idle 点尾部不悬空 tool_calls，相邻性安全）。头部注入
 * （splice 于 system 后）已废弃（2026-09-21 实测：已缓存前缀整体后移使
 * provider 前缀缓存 miss 扩大，且注入材料位置先于用户原始消息）。
 * 注意 maxSteps 语义：idle 注入的续走步不占预算（语义 = 会话中断后的
 * 接续，不是自主推理延长——注入本身体现的是外部输入，不是模型自主性）。
 */
'loop/run-idle'(
  call: LoopRunCall,
  next: () => Promise<LlmMessage[]>,
): Promise<LlmMessage[]>;
```

实现要点（service.ts 收束点）：

- 判定点在自然停判定（`step.toolCalls.length === 0 && !pendingSteer`）处，
  **先于** maxSteps 上限判定——预算用尽时模型仍给出终文本（无工具调用）的
  情形，idle 注入照常续走（maxSteps 上限只防自主推理失控，外部输入的接续
  不属于自主性）；
- 监听器返回非空数组 → 停步 assistant 终文本先补入工作数组，注入材料尾部追加 → continue；
- 续走步不占预算的实现：budget 计数（只数模型自主步）与 for index（恒自然递增，
  步序唯一——settlement 折叠键）分离；初版 index-- 方案会导致续走步与被挂起步
  index 重复、session 折叠吞步（webui 全链路测试暴露），已废弃；
- 全体空手 → break 收束，行为与改动前逐字节一致；
- 挂起期间 signal 中止：监听器自查 `request.signal?.aborted`，返回空数组
  → 正常收束路径接管（interrupted 检测在步边界）。

## 四、ac-ask-questions 重写

### execute（发起体，同步即返）

校验与归一不变（optionText / normalizeQuestionItem 全保留）；等待段删除：

```
open({key: conversationId, kind:'ask_questions', payload:{questions, elevation?},
      correlationId: toolCallId, owner: agentId, deadline?})
recordContext(conversationId, agentId, 展示文本, {source:'durable-interaction'})
return {ok, output:{status:'awaiting_user', interaction_id, questions,
        notice:'已向用户发起提问…本 run 将在空闲时挂起等待，收到回答后自动继续'}}
```

session 软依赖（可选能力面）：缺席时降级——返回结果仍可用（弹窗照常由
interactions.jsonl 驱动），但无 context 行、无 idle 监听器挂起（等待退化为
「模型读 notice 自行收尾 → late-reply」形态）。

### idle 监听器（等待体）

- 只认**本 run 打开**的交互：以 (owner, key) 为粒度登记 runId（run-started
  后清点 activeRuns 无从查起，改由发起体写入登记表——交互打开时刻
  activeRuns 已在场，登记即对账）；
- 挂起 await：replied/closed 事件（id 匹配）+ signal abort + 轻轮询（外进程
  reply 双保险，150ms）；
- resolved 后注入一条答案 context 消息（与 late-reply 通知文本同格式，
  格式函数共用），并经 recordContext 落账（journal → settlement 提升——
  跨 run 转录形状与 late-reply 完全一致）；
- timeout（deadline 到 → closed('timeout')）：注入「未响应超时」context 消息，
  由模型自行决断——不再伪造 error 工具结果。

### late-reply（保留，精确化）

- 仍订阅 durable-interaction/replied；
- 精确判定「run 已收束」：登记表在场且 activeRuns 命中 → idle 监听器活着
  → 不打扰（双消费防御从「listRunning 探测」收窄为登记表精确判定）；
- **移除 backfillToolResult 补记**（裁决 #4）：答案只走 deliver 通知文本
  （context 行形态，新 run 消费）。partial 行的 result = awaiting 标记
  （非 null），stepsComplete 门天然满足，无需补记。

## 五、改动面清单

| 包 | 改动 |
|---|---|
| ac-agent-loop | `loop/run-idle` 契约（contract/events + ~15 行 seam）——事件词汇新增需过 event-catalog 锁定测试 |
| ac-ask-questions | execute 瘦身为发起体；新增 idle 监听器；late-reply 精确化（去 backfill） |
| ac-session | 零改动（recordContext / journal 注入行 / settlement 提升全部复用） |
| ac-run-code | SDK 投影 ask_questions 注释更新；budget-freeze 的 ask 用例退役或改写 |
| webui | 等待态锚点从工具卡转圈变为 pending interaction（弹窗/待答清单已有）——测试适配 |
| ac-system-prompt | 如有 ask_questions 行为描述则同步 |

## 六、测试清单

**ac-agent-loop（新增）**

1. idle 注入续跑：脚本 [tool_call → awaiting，终文本] 两套——第一轮自然停
   被 idle 监听器接住（注入答案）→ 第二轮模型答 → 收束；步数/finish 正常；
2. 无监听恒等：不注册 idle 监听器的自然停，行为与旧版一致（finish stop）；
3. 挂起中中止：idle 监听器 await 期间 abort signal → 返回空 → 收束
   interrupted；
4. 预算上限绕行：maxSteps=1 + 第一轮终文本 + idle 注入 → 续走不被预算拦截。

**ac-ask-questions（重写）**

1. 发起体：execute 即返 awaiting 标记 + open 落盘 + context 行
   （session mock 断言 recordContext 调用）；
2. 归一化回归：对象选项/嵌套题形/映射形选项全保留（既有用例照跑）；
3. idle 监听器挂起-注入：集成 run 后作答，断言续步消息包含答案文本；
4. timeout 注入：deadline 过期 → closed('timeout') → 注入超时 context 消息；
5. late-reply：run 死后作答 → deliver 调用（mock conversation），且
   **无 backfillToolResult 调用**；
6. run_code 形态：子调用返回 awaiting（直接 execute 断言输出形状即可）。

**回归面**：session / app catalog / ws-bridge / webui 相关集成。

## 七、暂不做（out of scope）

- 自由文本启发式匹配 pending 问题自动 reply；
- session.backfillToolResult API 退役评估（另行）；
- 无人桶（excludeForms）放松——待新形态稳定后评估；
- 群/独立会话的 UI 等待态视觉细化。
