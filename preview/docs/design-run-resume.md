# 设计：中断/崩溃的 run 原地续跑（A1/A2，leftovers-2026-10-24）

> 状态：**已实施（cr-667，2026-10-24）**——改动面与 §4 一致；A2 前端验证为零改动（feed-core.ts:2365 label 直出既有分支）。实施时补充：resumeStateFor 三态返回（对象 / 'degraded' / null）承载 §5 降级判据。
> 事实核对基准：cr-661 工作树（2026-10-24）。引用行号以当日源码为准；
> boot.ts 恢复面 leftovers 写 736-793，实测在 748-805（漂移已核实）。

## 0. 背景与用户否决点

handoff-2026-10-24-restart.md §1：restart_shell 后新壳正常拉起，但模型表现像
新会话——重新 load_skill、重读文档、重复步骤。用户原话「丢失了前面的历史
（从二次加载技能就能看出）」。cr-658 已把**上下文**修对（轨迹读侧重建），
但**动作仍会重做**：续跑单位是「信封」不是「run」——recoverPendingInbox
把在途信当新输入重投，machine.plan 从零开 run（会话 01a16c90 实锤：
新壳 30472 对同一 runId 从 step 0 重跑）。

本设计交付：恢复面识别可续跑 run → 用 journal 精确重建消息前缀 → 同 runId
从最后一个已提交步之后继续 → 同 runId 一致性（不二次计费/回信）→ 降级路径
+ resumedFrom 用户可见标注（A2）。

## 1. 现状链路（函数级，已核对）

### 1.1 正常 run 链

- boot.ts:529 server 收信 → admission.admit(requestId)
- → conv.receiveEnvelope(env, {fresh})            ac-shell-conversation/service.ts:101
  - machine.plan(...)                             service.ts:113（plan=run/queue/steer）
  - ledger.deliverRow(...)                        落账（requestId 幂等；recovered 时 hasInboundRow 判重跳过，:132）
  - driveRun(uuid, env, plan)                     service.ts:278（:151 调用点）
    - runId = 'run-' + env.requestId              service.ts:313
    - ledger.inboxStore(uuid, env)                在途标记（cr-639 at-least-once，:322）
    - history = ledger.historyMessagesFor(uuid)   ac-ledger/service.ts:216
    - ctx.agentLoop.run({runId, messages, maxSteps, ...})   service.ts:332
    - ledger.settleRun(...)                       终稿行 + journal-settled（+ usage meter）
    - ledger.inboxClear(uuid, requestId)          :361
    - emit conversation/run-settled               :367
    - postReply(replyTo ?? sender)                :386
    - 链跑 next-turn / restartPending 收口

### 1.2 journal 行形态（ac-ledger/src/records.ts:44-99，writer.ts:143 落盘）

- journal-step（loop/after-step，**工具执行前**发射——副作用前 durable）：
  {run, step, content, reasoning?, toolCalls?[{id,name,arguments}], toolResults?(恒空), seq}
- journal-tool-result（tool/after-execute 补行，ledger service.ts:78 接线）：
  {run, toolCallId, result:{ok,output?,error?}, subcall?, seq}
- journal-inject（steer 注入按消费点真序）：{run, content, requestId?, seq}
- journal-settled：{run, finish:'ok'|'interrupted'|'error', usage?, model?, seq}

关键事实：**seq 全文件单调、行序 = 模型消息数组实际序**（records.ts:44 注释）；
步行先落、结果后补——「工具结果已落 journal」即步提交点。

### 1.3 崩溃后现状（重投链，即被否决的语义）

boot.ts:748-805 恢复面（三步，fire-and-forget）：

- ① recoverOrphanRuns()        ac-ledger/service.ts:278
  - 扫全部会话 journal → orphanRunsOf（有步行/注入、无 settled）→ 补写
    journal-settled(interrupted)（settleMechanism）+ anchorableRuns 补 viewer 锚
- ② recoverPendingInbox()      ac-shell-conversation/service.ts:523
  - 逐封 inbox 信 → receiveEnvelope(env, {fresh}, {recovered:true})
    → machine.plan = run → driveRun 从 step 0 重跑同 runId
- ③ 已重启注入 / replayAnsweredInteractions（与本设计无涉，不动）

trajectoryOfRun（ac-ledger/src/reader.ts:167）已能把 journal 重建为
协议合法的 LlmMessage[]（assistant{content,tool_calls} + tool{tool_call_id}
对 + inject 的 user 行），**未提交调用（无结果补行）整调用剔除**——这正是
「步边界」的现成判据。historyMessagesFor（ac-ledger/service.ts:216）只对
带 run 键的**终稿行**前置轨迹；中断 run 无终稿行，其轨迹只在重投 run 收束后
（同 runId 落终稿行）才进后续上下文——所以模型「知道」但「重做」。

### 1.4 loop 侧事实（src/ac-agent-loop）

- LoopRunRequest（contract.ts:26）：{runId?, agent?, model, messages, tools?,
  maxSteps?, sender?, source?, conversationId?, signal?, ...}——**messages
  即输入前缀，runId 外部指定即沿用**；续跑零 loop 改动。
- 步序 index 由 loop 内部从 0 编号（loop service.ts:545 stepId = runId:index）——
  续跑段 index 重新从 0 起，journal step 字段跨段重复；**seq 才是权威序**
  （读侧已按 seq 排序，见 §4.5）。

## 2. 设计裁决：未提交步怎么处理

leftovers 原案第 3 点给了 at-least-once 重试 + 工具幂等分类。核对工具面后
（§3 幂等表）**v1 不做工具重执行**，改「合成错误结果」方案（方案甲）：

- 已提交步（工具结果已落 journal）：原样进前缀。
- 未提交步（步行已落、结果补行未达）：**保留该 assistant 消息（含
  tool_calls），每个未确认调用合成 tool 结果**
  {ok:false, error:'壳在该调用执行中崩溃，是否已产生副作用未确认——请先核查（如重读文件/查进程）再决定是否重做'}。
  协议对完整，模型拿到「调用结果未知」的明确信号，自行核查后决策。

理由（根因优先 + 最小改动）：

1. 崩溃窗口 = 工具执行中——该调用**可能已执行**（pwsh 建了目录、
   send_agent 已发信）。盲目重执行 = 副作用重复；盲目丢弃 = 模型失忆。
   合成「结果未知」是把唯一诚实的状态交给模型，无新增机制。
2. 免掉幂等登记/副作用对账整套机制（原案难点直接消解）；
   §3 分类表降级为「未来若做 at-least-once 重试的安全边界参考」。
3. 对模型等价于一次工具失败重试语义，loop 无需任何改动。

at-least-once 重试留作 v2 可选：对 §3 中「纯读/覆盖型」工具白名单内调用
直接重执行而非合成错误（收益：省一步模型往返）。

## 3. 工具幂等分类表（ac-shell-rows 行集投影面，已扫实现）

| 工具 | 包/行 | 副作用 | 重执行分类 |
|---|---|---|---|
| read / grep / glob / search 族 | ac-fs-tools / ac-fs-search | 无 | 纯读，任意次安全 |
| write | ac-fs-tools | 覆盖文件 | 覆盖型，安全（同参重写同果） |
| edit | ac-fs-tools / ac-str-replace-editor | 字面替换 | 重放可检测失败（目标已替换 → not found 报错，无损坏）；边界：old_string 在别处再现时可能改错位置——v2 白名单内也建议排除 |
| load_skill / skill | ac-skill | 读+注册 | 幂等（同键重载） |
| datetime / list_* / read_agent_info | ac-datetime / ac-collab-tools | 无 | 纯读安全 |
| todo | ac-todo | 覆盖状态 | 覆盖型基本安全（重放旧全量会覆盖续跑期间的新编辑——v2 排除） |
| memory_write | ac-memory | 追加 | 不安全（重复条目） |
| ask_questions | ac-ask-questions | 开交互 | 重开重复弹窗——不安全 |
| send_agent / send_group | ac-collab-tools | 发信封 | 不安全（重复消息，requestId 每次新生成，对端幂等不接） |
| submit_issue / sap-adt / mcp | ac-issue-tools / ac-sap-adt / ac-mcp | 外部写 | 不安全（不可预知） |
| pwsh / bash / job | ac-shell-tools（rowset: tools:['pwsh','bash']） | 任意命令 | 不安全（原案已点名） |
| run_code | ac-run-code | 任意代码 | 不安全 |
| browser / web 检索点击 | ac-web-tools | 导航/检索 | 检索安全；导航动作不安全 |
| restart_shell / restart_host | ac-shell-rows/restart.ts | 幂等挂起/请求 | 幂等（requestRestart 置位语义） |

结论：不安全工具占大头且含最高危的 pwsh/run_code——佐证 §2 方案甲。

## 4. 改动点清单（文件 + 函数 + 签名）

### 4.1 ac-ledger/src/reader.ts —— 纯函数新增

    /** 续跑上下文重建（纯库）：返回消息前缀 + 未确认调用档案。
     *  已提交步原样（复用 trajectoryOfRun 的协议对重建）；未提交调用
     *  （步行在、结果补行缺）保留 tool_calls 并标记 uncommitted——由调用方
     *  决定合成结果（方案甲）或重执行（v2）。run 无步行或 journal 空 → null。 */
    export function resumeContextOfRun(
      lines: JournalLine[], run: string, uncommittedError: string,
    ): { messages: LlmMessage[]; committedSteps: number } | null

实现 = trajectoryOfRun 的变体：不再「无结果整调用剔除」，未确认调用直接以
uncommittedError 合成 tool 消息（纯函数一步到位，service 零拼装）；
committedSteps 供 maxSteps 剩余额度计算。约 +35 行。

### 4.2 ac-ledger/src/service.ts —— 读面 + 恢复面改造

    /** 续跑状态读面：run 有步行且无 settled → 重建前缀；否则 null（走重投）。 */
    resumeStateFor(uuid: string, runId: string): { messages: LlmMessage[]; committedSteps: number } | null
    // 内部：readJournal + resumeContextOfRun（uncommittedError 常量在此定义单源）

    /** inbox 在途 requestId 集（恢复面仲裁用——recoverOrphanRuns 跳过判据）。 */
    pendingInboxRequestIds(): Set<string>
    // 内部：扫 agentDirOf()/sessions/*/inbox/*.json，取 envelope.requestId

recoverOrphanRuns（:278）改签名：recoverOrphanRuns(defer?: Set<string>)
——defer = pendingInboxRequestIds()：requestId 命中的 run（run-&lt;requestId&gt;）
**不补 settled**，留给续跑面；其余照旧（interrupted 收口 + 锚补）。
fail-safe：recoverPendingInbox 对损坏信封 fail-soft 跳过时，若其 runId
是孤儿则补一次 settled（防「永不消费的 partial run」——见 §7 风险 R1）。

### 4.3 ac-shell-conversation/src/service.ts —— 续跑分支

    // receiveEnvelope :101 不改签名；driveRun :278 增第 4 参：
    private async driveRun(uuid: string, env: Envelope, plan: DeliverPlan,
      resume?: { runId: string; prefix: LlmMessage[] }): Promise<'steered' | 'settled' | 'queued'>

- messages 装配（:331）：resume 在场时
  messages = [...historyMessagesFor(uuid), ...resume.prefix]。
  中断 run 无终稿行 → historyMessagesFor 天然不含其轨迹，**无双计**
  （已核对 :223-241 只认带 run 键的 agent 行）。
- runId：resume?.runId ?? 'run-' + env.requestId（:313 一行改动——
  两者本就同值，显式传入只为语义清晰）。
- maxSteps 剩余额度（:338）：
  config.maxSteps > 0 时传 config.maxSteps - committedSteps（已用尽 → 传 1，
  只给收尾轮——loop 的 maxSteps>0 才是硬闸，剩余 ≤0 逼收束）；
  缺省/0 维持不限。
- 其余链路（settleRun / inboxClear / run-settled / postReply / 链跑）**零改动**：
  崩溃 run 从未 settle → 从未 postReply → 续跑后恰好一次（不变式由
  「无 settled 才可续跑」这个准入条件直接保证）。
- A2 标注：续跑分支起跑前
  ctx.emit('session/context-injected', uuid, agentId, { source: 'resume', label: '上一轮被中断，已原地续跑' })
  ——事件归位（观察通知，emit）；boot.ts:725 已有旁带转发链，前端零新增协议。

recoverPendingInbox（:523）改循环体：

    for id of inbox:
      env = inboxRead
      const runId = 'run-' + env.requestId
      const resumeState = ledger.resumeStateFor(uuid, runId)
      if (resumeState) → receiveEnvelope(env, {fresh}, {recovered, resume: {runId, ...resumeState}})
      else            → 现状重投（recovered: true）

receiveEnvelope opts 增 resume 字段（内部传递面，非契约），plan=run 时
透传 driveRun。plan=queue/busy 的极端（boot 期不该发生，重启注入兜在
inboxRecovery 之后）→ resume 忽略，退回排队语义；队列消费下轮 driveRun 前
重取 resumeStateFor（幂等，防 defer run 悬置）。

### 4.4 apps/shell/boot.ts —— 恢复面编排（:748-805）

- ①recoverOrphanRuns 调用点传入 defer 集：boot 先取
  ledger.pendingInboxRequestIds()（新读面）再调用——顺序仍在 ②前
  （幂等收口先清非续跑孤儿，续跑 run 由 defer 保护）。
- ②recoverPendingInbox 调用点零改动（分支逻辑在 conversation 服务内）。

### 4.5 前端（A2）—— src/ac-client-ui-conversation/client/feed-core.ts

session/context-injected 已有消费分支（feed-core.ts:2365，cr-625 事件行
渲染，label 直出）。改动预计仅：为 source === 'resume' 的 label 样式加
中断分割线观感（对齐既有分割线先例）或直接复用现有 event 行。
实施时验证 label 渲染现状，若已满足则前端零改动。降级路径标注
（§5）同走此事件，label 文案区分。

## 5. 降级路径

准入失败（任一）→ 退回现状「重投 + 轨迹上下文」并标注：

| 条件 | 判据 | 动作 |
|---|---|---|
| 轨迹缺失/空 | resumeStateFor 返回 null（无步行） | recoverOrphanRuns 正常收口 interrupted + 重投（现状） |
| journal 损坏 | readJournal 解析异常 | 同上 + stderr 记录 |
| 版本不兼容 | 前缀重建抛错（未来 journal 格式演进） | try/catch 包 resumeStateFor，同上 |

降级时在重投 run 起跑前 emit context-injected
{ source: 'resume-degraded', label: '上一轮被中断，已按摘要继续' }
（cr-658 读侧保证重投 run 收束后轨迹进上下文——同 runId 终稿行锚定）。
「摘要」即 historyMessagesFor 的文本投影 + 后续 run 的轨迹注入，不再有
cr-653 写侧物化（已退役）。

## 6. 测试计划

单测（npx vitest run --config preview/packages/vitest.config.ts <pkg>）：

- ac-ledger/tests/ledger.test.ts
  - resumeContextOfRun：全提交 run 前缀=trajectoryOfRun；含未提交调用的
    步保留 tool_calls + 合成错误 tool 消息；inject 行入序；无步行 → null。
  - recoverOrphanRuns(defer)：defer 命中 run 不补 settled；未命中照旧；
    defer run 的锚补投仍执行（锚面与收口面解耦）。
  - pendingInboxRequestIds：多会话/影子域/空 inbox。
- ac-shell-conversation/tests/service.test.ts
  - recoverPendingInbox：mock agentLoop 断言（a）messages 末尾 = 前缀
    （b）runId 同值（c）maxSteps = 剩余额度（d）settleRun/postReply/
    run-settled 各恰一次（e）context-injected(resume) 已发。
  - 降级：journal 无步行 → 走 receiveEnvelope 普通重投。
  - 未提交步含 pwsh 调用 → 前缀含合成错误（不重执行）。
- 前端（若 feed-core 有改动）：补 resume label 渲染断言；
  零改动则只登记验证结论。

集成（preview test:integration 面向）：

- e2e-cli 形态：预置 journal（run-x 3 步、第 3 步结果缺失）+ inbox 标记 →
  boot 壳（--mock-provider）→ 断言：新 journal 续写同 run-x、最终
  settled(ok)、messages.jsonl 用户行恰一条、无二次 reply 行。
- 活体（restart-lab，按 handoff §5 命令与数据根纪律）：restart_shell /
  硬杀壳两形态各一次，观测 journal 续写与前端分割线。

验证阶梯：typecheck + test:unit + check:deps + 定向 lint + smoke（动了
行集编排面）；前端动了再 webui:typecheck。

## 7. 风险与回滚

| # | 风险 | 缓解 |
|---|---|---|
| R1 | defer 的孤儿 run 永不收口（续跑持续失败） | recoverPendingInbox fail-soft 跳过时补 settled（§4.2）；续跑连续失败 TTL 收口可后续加（同 C1 标记 TTL 先例） |
| R2 | 恢复面竞态：①②均 fire-and-forget | defer 集在 ①前快照；②串行 await；重启注入链在 inboxRecovery 之后（boot.ts:782 现状 chaining 保持） |
| R3 | resume 信封 plan=queue（boot 期忙） | resume 忽略退回排队；队列消费时 run 仍无 settled → 下轮 driveRun 前重取 resumeStateFor（幂等） |
| R4 | step 字段跨段重复（loop index 重起） | 读侧按 seq 排序（trajectoryOfRun :177 已然），step 仅展示用；stepsOfRun 同序——登记为已知形态 |
| R5 | 崩溃段 usage 计量丢失（runMeters 内存态） | v1 接受（journal 欠计、不双计）；v2 可在 loop/after-run 即落 journal usage 快照 |
| R6 | 合成错误误导模型重做高危操作 | 错误文案显式要求「先核查副作用」；§3 表是护栏参考 |
| R7 | 前缀超模型上下文 | historyMessagesFor 同风险（既有），归档 compact 收敛，不在本设计扩面 |

回滚：改动面 = 读侧纯函数 + 恢复面分支 + boot 一处传参，无写侧格式变更、
无契约/事件目录变更——单 CR revert 即回到 cr-658 语义，盘上数据两向兼容
（resume 只是少读少续，不产生新行形态）。

## 8. 明确不做（缩水声明）

- 工具 at-least-once 重执行与幂等登记机制（v2，§2/§3）。
- run 级断点持久化文件（handoff §1 提的 run-trace 文件）——journal 已足，
  不引入第二事实源（根因：轨迹单源 = journal，cr-658 裁决延续）。
- 崩溃段 usage 补计（R5）。
- 前端独立「中断分割线」组件——复用 context-injected 事件行。
