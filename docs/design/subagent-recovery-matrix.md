# subagent 恢复面边界矩阵（cr-857 预研档案）

> 状态：**分析档案**（未实施）。本文回答「六个恢复面要不要合并成统一对账器」——
> 结论是**不合并**，理由与替代方案见 §四。下次任何恢复面改动前先读本文对齐窗口边界。
> 目标形态对照：subagent-disk-rendezvous.md（盘面会合——多数恢复面的消解方向，
> 其 §五 含对本文的对账表；post-office 独立进程见 post-office-detach-plan.md）。

## §零 一句话

恢复面的「乱」不是 bug 群，是**一个对账事实源（盘上 journal/inbox/账本行）× 多个
观察者（每个崩溃窗口一个）**的固有形态——每个面补一个窗口，窗口之间靠判据互斥
（defer 集 / 幂等键 / 行龄门）衔接。合并成一个大对账器 = 把判据互斥变成代码互斥，
出错面更大。正解 = 判据文档化（本文）+ 三个有界小修（§四）。

## §一 九个恢复面与崩溃窗口矩阵

盘上事实源（崩溃后幸存）：journal/partials.jsonl（步行）、inbox/*.json（durable
在途信封）、messages.jsonl（账本行：入站行/终稿行/段行/注入行）、
interactions.jsonl（子域提问 store）、children/<id>/activation.lock（子壳活锁）、
outbox/（邮局不可达滞留）、.deliver-seen.json（投递幂等面）。

运行时易失（崩溃即蒸发）：children 句柄、childMeta（busy/exit）、askWatchers、
askNotified、convOf、机器队列、activeRuns、recentSettled。

| # | 恢复面 | owning | 触发 | 覆盖的崩溃窗口 | 判据（防双处理） |
|---|---|---|---|---|---|
| R1 | recoverOrphanRuns | ac-ledger | 子壳/壳 boot | run 中途死：journal 有步行无 settled（读侧恒「在途」） | defer 集（inbox 在途信的 run 让给 R2）；幂等（已 settled 不动） |
| R1' | settleOrphan | ac-ledger | 同上 | 同上的物理面：段行物化 + interrupted 收口 | 同上 |
| R2 | recoverPendingInbox | ac-shell-conversation | 壳 boot | 已落账未消费：inbox durable 里的信（排队/steer 落空/安全重启回队） | requestId 落账幂等；续跑分支按 resumeStateFor 准入 |
| R3 | reconcileUndelivered | ac-shell-conversation | 壳 boot（兜在 R2 后） | 只落账未执行：deliverRow 后、plan 队列/inbox 落盘前死 | 行龄门（只收 boot 前的行）；replyTo=user 防自激；盘面查重 |
| R4 | replayAnsweredInteractions | ac-shell-conversation | 壳 boot | answered 落盘但无人消费（作答时 run 已死 + 壳换代） | answerNotice 正文精确比对（inject 行在场 = 已消费） |
| R5 | reconcilePendingAsks（subagent 行） | ac-shell-subagent | 父壳 boot + 500ms 重试（60s 上限） | 换代后 watcher/askNotified/convOf 蒸发：pending ask 无推送 | ask-notice-<id> requestId 幂等；archived 跳过 |
| R6 | awaitReply 合成回执（cr-724） | ac-shell-subagent | await 轮询内 | 子壳带任务硬退出：无终稿行 | exit.aborted 一次定性 |

注（cr-862 换轨）：send/answer 的换代直投面（cr-736/856）已并入 deliver()
盘面会合（subagent-disk-rendezvous §六 第 2 步）——send 死子不再 fail-loud，
落 inbox + owner 重拉（reviveChild）；answer 落 inbox = 挂起方已死，维持
fail-loud。矩阵行保留作历史对照，恢复语义以 rendezvous 文档为准。
| R7 | outbox flush（cr-628 断链重试） | ac-post-office | 端点转可达时 | 对端不可达时投递滞留 | at-least-once；接收方 requestId 幂等 |
| R8 | usage 对账回填（cr-842） | ac-ledger | 宿主 boot | usage 事件信丢失（断链） | journal 是计量事实源；宿主补录按 run 键 |
| R9 | runs/snapshot 对账（cr-748） | 宿主 | 轮询 | 短命 run 的 settled 帧丢失（宿主没见到） | recentSettled 尾巴（容量 8） |

注：R1/R1' 同属孤儿 run 收口（判据/物化两层）；boot 时序 = ① R1（defer=快照）
→ ② R2 → ④ R3 → ③「已重启」注入 → ③ R4（boot.ts L857-928——编号沿用代码注释）。

## §二 已修断点回顾（为什么会有这些面）

每条 CR 都是一个实锤崩溃窗口：cr-628（run 7vmy 中断不重投）、cr-629/658（安全
重启回队）、cr-636（answered 死信 dur-mvjk1ook）、cr-639（at-least-once inbox
标记）、cr-666（reconcileUndelivered 死信收敛）、cr-667（续跑前缀重建）、cr-724
（硬退出 await 永挂）、cr-727（signal 遵守）、cr-731/733（ask 通知换代对账）、
cr-736（answer 换代直投）、cr-856（send 换代直投 + detached）。

**共同根因**：跨进程无事务——「投递→收信→run→settle→回执→父忙态回落」链上任一
环死掉都停在中途，盘上事实是最终一致的，但**谁负责把运行时态收敛回盘上事实**没有
单一 owner，于是每个窗口长出一个面。

## §三 窗口缝隙清单（本次新核证）

### S1（中危）R4 未兜在 R2 后——boot 链竞态双投

boot.ts L920-928：R4（replayAnsweredInteractions）fire-and-forget，与 R2
（recoverPendingInbox）**并行**——而 R3 与「已重启」注入都有 .then(inboxRecovery)
兜底串行。R4 的队列在途跳过判据（machineFor(uuid).queued 快照）在 R2 尚未重投时
快照为空 → 已在 inbox 的答案信会被 R4 重放（R2 随后又消费）→ 同一答案双投双跑。
触发条件：boot 时 inbox 有在途信 ∧ durable-interaction 有 answered 记录 ∧ 两者
同 id。修复成本：一行（R4 改 .then(inboxRecovery) 串行，与 R3 同款）。

### S2+S3（复合中危）换代后「活子」的 ask 推送面蒸发 → busy 永真

> **2026-11-02 落地（cr-863）**：S2 已断根——双通道：子壳 opened 事件推
> childAsk 信封（deliver 双层会合）+ reconcile 对活锁子重建 watch（P2）。
> S3（asking 永挂无超时兜底）仍在触发线上。

父壳换代后，活着的子壳（R-5）新落 pending ask：
- S2：askWatchers 随旧壳蒸发，新壳只在 spawn 时 watchAsksOf——**换代不重建**
  （R5 只补投一次通知，不建 watch）。此后子的新提问对父永不可见（直到父恰巧
  重启或 answer 面被调）。〔cr-863 已修——见上方标注〕
- S3：父 Agent 不答、子也不超时（durable-interaction pending **永不清理**，
  「write-ahead 恢复源」语义），子壳 run 挂起永生 → 子 busy 永真 → await 永报
  asking。宿主侧无超时兜底。
- 复合形态：用户看板见子恒 running，无任何提示——「异常中断后处理非预期」的
  一个未被 cr-856 覆盖的切面。

### S4（低危）R3 行龄门的时钟假设

row.timestamp > bootedAtMs 判「本代写入不动」——跨机器/时钟回拨场景失效。单机
产品可接受，记录在案。

### S5（低危）R5 的 60s 放弃窗口

conversation 行 60s 仍未装（病态行集）→ pending ask 对账放弃，退化为 S2 形态。
execute 首调兜底仍在，实际可达性高，记录在案。

## §四 裁决建议

**不建大一统「子域对账器」**。理由：
1. 九个面的判据互不相同（defer 集/幂等键/正文比对/行龄门），合并后单一函数持有
   全部判据 = 每次修改都在同一处叠加分支——正是 subagent 域补丁累积的老路。
2. 各面 owning 不同（ledger/conversation/subagent/post-office/宿主），合并跨
   行依赖，违反插槽-插头。
3. R6-R9 与会话机无关（投递/计量/对账），强行并入是范畴错位。

替代方案（有界小修 + 文档即对账面）：
- **P1**（一行）：boot.ts R4 改串行兜底（S1 断根）。
- **P2**：subagent 行 boot 对账（R5）时对有活锁的子顺带 watchAsksOf 重建 watcher
  （S2 断根；判据复用 readActivationLock）。**已落地（cr-863）**。
- **P3**：awaitOp 报 asking 时附带「若认为不该等待可 stop 或答复自行决断」提示 +
  子域 pending 超时（如 24h）兜底 close（S3 缓解；超时值待产品裁决）。
- 本矩阵文档 = 恢复面的统一对账面（改动任何恢复面前更新 §一/§三）。

## §五 测试锁定建议

- S1：boot 链 e2e——inbox 在途信 + answered 同 id 双源在场，断言只消费一次。
- S2：boot 对账后断言 askWatchers 含活锁子（服务测试直查私有面或经行为断言）。
- S3：超时兜底的单测（fake timer）+ asking 提示词回归锁。
