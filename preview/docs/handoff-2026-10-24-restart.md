# 交接：restart 双件与「run 续跑」（2026-10-24 下午）

> **【14:10 更新——cr-658 已落地，§1 方案已被取代】**用户裁决改自然收束语义：restart_shell 不中断 run（收束后兑现重启 + 新壳注入「已重启」开续跑轮），轨迹完整性修在读侧（`historyMessagesFor` 重建 assistant/tool 协议对——通用修复，崩溃重投路径同修）；cr-650 回队特判与 cr-653 摘要物化已退役。全量 577/577 + smoke 绿；**活体复测待做**。见 plan.md §5 cr-658 行。

> 给下一个会话的入口。先读本文，再读 `handoff-2026-10-23.md` §6（那里是 647/648/650 的简述）。
> 今天全部改动**未提交**（沿用 G8 分批入库惯例，见文末 git status）。
> 数据根 = `workspace/home`（产品根，非 preview 测试根）；用户会话 `01a16c53-…`【第三次测试】在本文写作时仍在跑。

## 0. 一句话现状

`restart_host` / `restart_shell` 的**进程复活链路**已修好并逐条活体验证（5 处根因：cr-647/648/650/651/653）；
但**「run 续跑」的语义仍是错的**——中断后是把用户消息当**新一轮**重投、靠把 journal 摘要塞进历史来「补上下文」。用户明确否决：

> 「哪能是这么处理的……丢失了前面的历史（从二次加载技能就能看出）」

真正需求 = **在中断步边界原地续跑同一个 run**（精确恢复含 tool_calls/tool_results 的模型消息数组），不是重放用户消息 + 摘要。

## 1. 用户否决点与真正缺口（下个会话优先）

**现象**：`restart_shell` 后新壳正常拉起，但模型表现像新会话——重新 `load_skill`、重读文档、重复之前步骤。

**当前实现链**（错的那条）：
1. 收束点把在途**用户信封**回队 inbox（cr-629/650）；
2. 新壳 boot `recoverPendingInbox` → `receiveEnvelope(recovered: true)` → `machine.plan` = run（step 0 起）；
3. 模型上下文 = `ledger.historyFor(uuid)`（messages.jsonl 的 user/assistant 文本行）；
4. 中断前的 journal 步行**不在**上下文里；cr-653 把「reasoning + 工具名/参」渲染成 assistant 段行补进 messages（单段 2k / 总 20k）。
   → 这只是**摘要文本**：工具调用/结果没有以 `tool_calls` / `tool` 消息形态回灌，模型无法从中间步继续，只能重做。

**真正的做法（待设计/实现，建议单独立项）**：
1. **持久化 run 消息轨迹**：每步落 `LlmMessage[]` 形态（assistant `{content, tool_calls}` + `tool {tool_call_id, content}`）。journal 已有 `toolCalls` 与 `journal-tool-result`，可精确重建；也可在 loop 层直接落 run-trace 文件（更简单、无歧义）。
2. **续跑信封**：回队时标注 `resume: {runId, nextStep}`（或 boot 恢复面识别「该 run 有 journal 步行 + 无终稿」→ 走续跑分支），新壳用重建的 messages 前缀 **从下一个未提交步继续**，而不是从 step 0。
3. **步边界原子性**：只从「工具结果已落 journal」的步之后恢复；未落结果的工具调用按 at-least-once 重试——需工具幂等或副作用登记（write/edit 是覆盖型，pwsh 不是）。
4. **同 runId 续跑的一致性**：不二次计费、不二次 postReply、maxSteps 按剩余额度、`lastSettledSeq` 防重物化继续有效。
5. **降级**：轨迹缺失/版本不兼容 → 才退回 cr-653 摘要续跑，并在 UI/终稿显式标注「已中断，按摘要继续」。

**代码位置**：`preview/packages/ac-shell-conversation/src/service.ts`（driveRun 装配 messages / 重启回队）、`ac-ledger/src/reader.ts`（stepsOfRun）、`ac-ledger/src/writer.ts`（stepSegmentsOf，cr-653）、`apps/shell/boot.ts`（恢复面）。

## 2. 今天已落地（均活体实测，未提交）

| CR | 根因 → 修 | 文件 | 活体证据 |
|---|---|---|---|
| cr-647 | 壳侧 host-revive 用 stdin EOF kick 抢跑 supervisor（宿主 exit 42 当刻即 spawn）→ supervisor 重拉撞 EADDRINUSE **退出 78 且不再拉起**（终端拓扑下连带全壳死）→ supervised 档让路宽限 10s（`AGENTCHAT_SUPERVISED`，非 supervised 恒 0）；另两处：ensureHook 前置读 activation.lock 救援、dispatch 先落箱再 ensureHook | `apps/shell/host-revive.ts`、`apps/host/orchestrator.ts`、`ac-post-office/src/post-office.ts`、`apps/shell/boot.ts` | supervisor 日志 `exit code=42` → 1.5s 重拉、无 78；换代父 pid = supervisor |
| cr-648 | ①直投失败（陈旧 hint）只落 outbox，不摘可达项/不拉起 → 壳死后每封信静默进箱 ②宿主换代后活壳不在句柄池，其 `restart_shell` 的 exit 42 无人 respawn → ①失败即 markGone(local 除外)+store+ensureHook ②壳退出前发 `restartShell` 信，宿主轮询锁退净后 ensureAgent | `ac-post-office/src/post-office.ts`、`apps/shell/boot.ts`、`apps/host/boot.ts` | B3 孤壳：壳 44152→9020 自动重拉（无新消息）→ B3-RESUME-OK |
| cr-650 | 恢复面拉起的 run（recovered=true）内 `restart_shell`：收束点回队 inbox 后 `receiveEnvelope` 的「恢复面消费即清」照常 inboxClear → 把刚回队的信删掉 | `ac-shell-conversation/src/service.ts`（driveRun 增 `restarted`，清行门跳过） | B4：恢复面 run → 壳 46104→10060 → 原信重投 → B4-RESUME-OK |
| cr-651 | `restart_shell` 撞 `restart_host` 换代窗口，重拉请求随旧宿主丢失 → 壳退出前落 `dataRoot/.runtime/restart-shell/<agent>.json` 复活标记；宿主 boot 扫标记、锁死者 ensureAgent；新壳 boot 自清标记 | `apps/shell/boot.ts`、`apps/host/boot.ts` | RACE：marker 出现（t+10）→ 新宿主扫到 → 壳自动拉起 → RACE-OK |
| cr-653 | 中断 run 的步行物化只取 `content`；工具密集 run（content 恒空、只有 reasoning/toolCalls）零段行 → 重投后上下文只剩用户消息。修 = 空 content 步渲染「推理 + 行动」 | `ac-ledger/src/writer.ts` + `tests/ledger.test.ts` | 单测 17 绿；**语义被用户否决**（见 §1） |

验证基线：cr-653 前全量 **575/575**；cr-653 后只跑定向（ledger 17）+ `preview:typecheck` 0 + 定向 lint 0——**全量未重跑**，下个会话先补。

## 3. 现场状态（2026-10-24 13:30）

- 进程：supervisor **40704**（用户终端 `pnpm dev:supervised` 起的，日志不落文件）→ host **23528**（写作时刚换代）→ 壳 `restart-lab` 8852 / `__creator__` 2464（用户测试会话仍在跑，会继续调 restart_host/shell，宿主/壳 pid 会变）。
- 用户会话 `01a16c53-0fb0-79ad-bdb9-9bd5f817aa63`（`agents/__creator__`）：多代续跑中，inbox 有 1 封在途信（正常，收束即清）。
- 临时测试身份：`agents/restart-lab` + 会话 `01a16c0d-d14d-79db-8588-f0d71be16f57`（可整目录删）。
- 复活标记目录：`workspace/home/.runtime/restart-shell/`（正常应为空）。
- 探针/证据：`sandbox/probe-rescue.mjs`、`sandbox/probe-deliver.mjs`、`sandbox/restart-lab-phase.txt`、`sandbox/restart-lab-resume.log`、`sandbox/evidence/`、`sandbox/supervised-*.log`；预览侧 `preview/sandbox/rpc-args-probe.cjs`（带参 RPC）。
- 未提交改动 18 文件（`git status` 见 §5）。

## 4. 下一步（按优先级）

0. **设计/实现「中断步原地续跑」**（本文 §1）——用户当前唯一关心点；cr-653 降级保留。
1. 补 cr-651/653 的 plan §5 状态板行（cr-650 已有）；补全量 `pnpm preview:test`。
2. `01a16c53` 中断前 32 步已被 `lastSettledSeq` 过滤跳过，需 `preview/sandbox/backfill-segments.mjs` 才能进上下文——但真续跑落地后此问题自然消失，勿把 backfill 当正解。
3. 遗留未闭环：①壳 boot 窗口期消息只落账未执行（观察一次，未复现）②「supervisor 退出 → 全壳连坐」物理机制（控制台关闭假设）未取证。
4. 用户环境别乱杀：`Stop-Process AgentChat.exe` 会连用户 supervisor/host/壳一起；要重载宿主只杀 host（supervisor 会重拉），要重载壳杀对应壳。

## 5. 验证命令与坑

```powershell
$env:TEMP='...\preview\sandbox\tmp'; $env:TMP=$env:TEMP   # 本机 %TEMP% 写不了（EPERM）
pnpm preview:typecheck
npx vitest run --config preview/packages/vitest.config.ts <file>   # 定向
npx vitest run --config preview/packages/vitest.config.ts --reporter=json --outputFile=preview/sandbox/test-report.json  # 全量（读 numFailedTests）
node preview/sandbox/rpc-args-probe.cjs 3830 '<[{method,params}]>' [截断]
```

坑：
- 全量 vitest 若 `*> file` 或 `Tee-Object` 会挂（detached 壳继承句柄）——用 `| Select-Object -Last N` 或 `--reporter=json --outputFile`。
- 宿主代码改动必须重启宿主（supervisor 重拉）；壳代码必须重启壳（`restart_shell` 或杀壳）。
- 数据根单宿主；测试数据根一律 `preview/sandbox/`（本次活体验证用的是产品根 `workspace/home`，属用户授权范围内的真机验证）。
- `cr.mjs append` 号可能被别人占（今天 649/652 就被占）——注释里写号前先看头行。

## 6. git status（写作时）

```
 M cr-log.md
 M preview/apps/host/boot.ts
 M preview/apps/host/orchestrate.ts
 M preview/apps/host/orchestrator.ts
 M preview/apps/host/tests/orchestrator.test.ts
 M preview/apps/shell/boot.ts
 M preview/apps/shell/host-revive.ts
 M preview/apps/shell/tests/host-revive.test.ts
 M preview/docs/handoff-2026-10-23.md
 M preview/docs/plan.md
 M preview/packages/ac-ledger/src/service.ts
 M preview/packages/ac-ledger/src/writer.ts
 M preview/packages/ac-ledger/tests/ledger.test.ts
 M preview/packages/ac-post-office/src/post-office.ts
 M preview/packages/ac-post-office/tests/post-office.test.ts
 M preview/packages/ac-shell-conversation/src/service.ts
 M preview/packages/ac-shell-conversation/tests/service.test.ts
 M preview/packages/ac-shell-rows/src/restart.ts
```

注：`ac-ledger/{service,writer}.ts`、`ac-shell-conversation/service.ts`、`ac-shell-rows/restart.ts`、`orchestrate.ts` 里有一部分是**上一轮会话（cr-628/629/639/640/641/642）遗留的未提交改动**，本次在其上继续改；入库切分时注意别把两批混成一条。


## 7. 本轮实测记录（2026-10-24 第三/五/六/七轮，cr-654 / cr-655 / cr-657）

验证对象 = restart_host / restart_shell，环境 = __creator__ 会话 01a16c53 跨代续跑、产品根 `workspace/home` 真机。
观测手法：detached pwsh 300–400ms 采样（宿主按 3830 端口 listener 认 pid、壳按 CommandLine 匹配 `shell.boot.ts`、healthz `uptimeMs` 连续性是「同一宿主进程」的判据）；`background:true` 后台 job 因本机 `%TEMP%` 瞬时 EPERM 不可用，改前台采样 + detached 采样器。

### 7.1 稳定复现的行为矩阵

| 维度 | restart_host | restart_shell |
|---|---|---|
| 退出/换代 | 宿主 exit 42 → supervisor 快路重拉（新宿主父 pid 恒 = supervisor，supervisor 全程未动） | 壳 exit 42 → 宿主重拉新壳（新壳父 = 在世宿主） |
| 发起方存活 | **壳与发起 run 全程存活**（同一 program 跨两次换代执行到底） | run 被中止（interrupted 收束），原消息 durable 回队 |
| healthz | 宕窗 ≈1–2s 后恢复，uptime 重置 | **全程 ok 且 uptime 连续无断点**（宿主未动） |
| 会话续跑 | 终稿在宿主恢复后照常送达 | 新壳 boot 恢复面重投 → 会话续跑（cr-639/650/651 链） |
| 其他会话 | 零影响（旁壳存活） | 零影响 |
| 连续调用 | 同壳连调 N 次均成功（cr-656 前第 2 次必失败） | 每代仅一次（重复调用无意义） |

### 7.2 本轮修掉的缺陷（cr-656）

- 现象：同一壳内第二次 `restart_host` 恒返回 `{"ok":false,"error":"This socket has been ended by the other party"}`，宿主不重启。
- 根因：`ac-shell-rows/src/restart.ts` 惰性缓存邮局 uplink（`let uplink` + fiber effect 关闭），宿主换代把该连接一并带走后仍复用缓存 socket。首调用/新壳首调恒成功，故此前实测与 e2e 全漏。
- 修：每次调用新建 `IpcClient`、`connect` → `send` → `close()`（与 `boot.ts` 的 `notifyHostRestartShell` 同款）；失败回执改可读软失败；回归用例「旧监听关闭 → 新监听接管 → 二次调用仍送达」。
- 验证：定向 3 测绿、`pnpm preview:typecheck` 0、定向 eslint 0；活体同壳连调两次均换代成功。

### 7.3 遗留

1. **R3 anomaly 未定位**：一次 `restart_shell`（被重启的壳当时为孤儿态：生父宿主已被 restart_host 换代）产生 2 代宿主 + 2 代壳。其后孤儿壳 / 非孤儿壳两种形态各测一次均未复现；线索仅剩 `.runtime/restart-shell` 标记自清时机与 cr-648 轮询锁重拉 / cr-651 标记扫尾两条重拉面可能双触发。
2. `%TEMP%` 瞬时 EPERM（后台 job 与 vitest 临时目录）：实测时把 `TEMP/TMP` 指向 `preview/sandbox/tmp` 即全绿；默认 Temp 稍后自愈（瞬时性，疑外部干扰，cr-593 同域）。
3. 中断步「原地续跑」仍未实现——`restart_shell` 之后模型仍靠 cr-653「推理+行动」摘要补上下文（用户已否决为终态），正解见 §1。
## 8. 第四次测试实测（2026-10-24 14:19–14:35，cr-661）

验证对象 = restart_host / restart_shell，环境 = `__creator__` 会话 `01a16c90-1ee9-7156-a70b-150367f10f31`（本会话即被测会话，产品根 `workspace/home` 真机）。
判据全部取自盘上事实（activation.lock / `.runtime/restart-shell/*.json` / journal partials.jsonl / messages.jsonl / sample 日志），不依赖 UI 观感。

### 8.1 进程代际（实测）

| 对象 | 变化 |
|---|---|
| supervisor | 40704 全程未动（12:55:07 起） |
| 宿主 | 39648（13:41:23）→ H1 → 35224（14:28:00 监听）→ H2 → 43388（14:28:26） |
| 本 agent 壳 | 26740（14:18:41）→ **14:21:01 崩死** → 30472（lock acquiredAt 14:21:01.737）→ restart_shell → 45920（14:29:37 创建，14:29:38.446 持锁） |
| 旁壳 news | 45188（14:11:02）全程存活（父 = 已死宿主 39648，detached 形态） |

### 8.2 restart_host（两次，同壳）

- H1：宕窗 ≈1.2–2.5s（WS 探针 7 次 ECONNREFUSED → 重连）；新宿主 healthz `uptimeMs=1s`、`agents=16 / conversations=903` 不变；**本 run 与两壳均未受影响**。
- H2（同壳二次，cr-656 复验）：同样 ok，宿主 35224→43388，壳仍存活。
- cr-659 面：换代后**新宿主上本壳的直播帧继续到达**（`llm/delta-batch`、`loop/after-step`、`tool/started`…）→ 活壳 re-tap 生效（`rescueLiveShells`），前端不刷新即可恢复。

### 8.3 restart_shell（cr-658 自然收束语义）

- 工具回执 `{restarting:true,inFlight:true}`，且**本 run 未被中断**（模型继续执行到终稿）。
- 终稿送达后：旧 run 恰好一次 `journal-settled ok`（含 usage）+ `messages.jsonl` 恰好一条 reply 行（seq 129）→ 壳退 42。
- 复活标记 `.runtime/restart-shell/__creator__.json` 于 14:29:35.837 落盘（含 `conversationId`），由新壳 boot 兑现后自清（采样器：marker null → 出现 → null）。
- 新壳 45920 由在世宿主 43388 重拉；**宿主 pid 与 healthz uptime 连续无断点**（壳换代与宿主无关）。
- 新壳注入「已重启」（requestId `restarted-dad0918f…`，sender=`user` 即桶对端，落账 seq=1 = 新进程首写），开续跑轮；**续跑上下文含前序 30 余步工具轨迹**（本会话延续，无重做、无二次 load_skill 强制）。

### 8.4 附带发现（非本次测试动作引入）

测试前 **14:21:01** 上代壳 26740（14:18:41 起，正在跑本 run 的 step 0–8）崩死；新壳 30472 boot 时：
1. `recoverOrphanRuns` 对该在途 run 补 `journal-settled(interrupted)`（journal 行 43，seq=1 = 新进程 writer 首写）；
2. `recoverPendingInbox` 重投同一信封 → **同 runId 从 step 0 重跑**（journal 行 44 起）。

→ 这正是用户否决过的「重做」语义，但它属**崩溃路径既有行为**（cr-628/639），与 restart 双件无关；cr-658 的轨迹读面让该次重跑的上下文不丢。**遗留**：26740 崩死原因未取证（壳 stderr 未落盘，宿主 39648 当时正在建立期）。

### 8.5 探针与留档

- `sandbox/restart-sample.mjs`（宿主换代采样，250ms）、`sandbox/shell-sample.mjs`（壳换代采样，300ms）、`sandbox/ws-frame-watch.mjs`（WS 帧旁听 + 自动重连）、`sandbox/probe-host.mjs`（一行状态）
- 证据：`sandbox/evidence/r4-restart-host-1.log`、`r4-restart-host-2.log`、`r4-restart-shell.log`、`r4-ws-frames.log`
- 结论留档：`preview/sandbox/restart-lab-20261024/STATE-R4.md`
## 9. 会话标题生成面（cr-672，2026-10-24 晚）

**问题**：preview 的会话列表标题全是首条消息原文——多条重名「继续 AgentChat preview 轨…」、
定时唤醒会话拿到触发词与 DSML 残片、CRLF 会话标题带脏尾、**192 个存量会话的标题是同一
条仓库路径**（用户习惯把附件路径粘在消息开头）。主线那套 LLM 自动命名在重建里整套缺席。

**落地**（裁决 D13，`src/docs/host-shell-decisions.md`）：

- 新壳行 `auto-title`（`preview/packages/ac-shell-rows/src/auto-title.ts`）：run-started 暂存
  → 首个 after-step 结合 Agent 首步思考/正文 LLM 一句概括 → **标题请求信**
  （`ac-envelope-core/title-request.ts`，uuid = `title-<会话键>` 的 host 请求域独立键）
  → 邮局 → 宿主 singles 行 HostInbox 受理 → write-if-absent 落盘 + `singles/updated`；
  after-run 兜底；只命名用户会话；无邮局形态不命名。
- 标题词法下沉 `src/ac-core-utils/src/session-title.ts`（上限 24 / 提示词 / 清洗 / 截断回落
  / 材料行筛选 / 日期快照前缀）——主线 ac-singles 与 preview 派生面同口径。
- 宿主派生面：用户自己的首条发言优先（旧取首条非空内容行）、材料行筛选（跳过附件路径 /
  @ 引用 / URL 行——192 个路径簇标题归零）、CRLF 剥尾、24 字上限。
- 行集 86 = 宿主 48 + 壳 38（catalog / catalog.test / rowset 恒并基座第五条 / manifest R2
  补记 restart + auto-title 两行）。

**验证**：preview 611/611 + 主线 2758/2758 + 两树 typecheck 0 + check:deps + 定向 lint 0 +
smoke 绿；e2e（`preview/apps/host/tests/e2e-title.test.ts`）真宿主 + 真子进程壳 + mock
provider 当 LLM，断言盘上 session.json 标题来自 LLM 面。**活体**：宿主 11292→25840 换代后
`singles/list` 的路径簇消失、CRLF 脏尾消失。

**活体闭环（22:05，壳重启后）**：壳 pid `30924 → 21328`、行集 `rows 23 → 24`（+1 = auto-title
在集）；新壳**首轮**首步后即生成本会话标题并落盘 `session.json` = 「修复AgentChat会话标题生成
问题」（13 字，来自 Agent 首步理解而非首条消息原文）→ 生成面兑现；下一轮（用户消息轮）盘上
标题预检命中 → 不重算（`updatedAt` 未变 = 幂等活体证据）；`singles/list` 回显一致、路径开头
标题数 0（修前 192）。重启窗口观察：新壳拉起前 4 次 `boot 失败：activation 锁被进程 30924
持有`（旧壳未退净时多条重拉面各试一次，单例锁正确拒绝、末次成功）——语义正确、日志噪声偏大，
记观察不立项。

**未做 / 下一步**：① 存量会话不回填（只有派生面改善）；要批量回填需脚本 + 逐个 LLM 调用，
另议。② `singles/list` 每次全量解析 900+ 会话账本仍是性能债（未动）。③ 重拉面锁未退时的
退避静默（若上述噪声复现率高再做）。
