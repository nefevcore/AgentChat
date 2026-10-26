# 遗留项登记（2026-10-24，第四次 restart 测试后）

> **处置进度（2026-10-24 晚，cr-662…667）**：B1/B2 ✅（cr-662 壳/宿主 stderr 落日志滚动+退出现场）；C1 ✅（cr-663 单一仲裁——ensureAgent 在飞去重 + 标记 O_EXCL 共享领文件名原子领取 + TTL 10min；**实测修正：Windows 并发 rename 同源可双双成功，rename 不可作领取原语**，复现脚本 `preview/sandbox/c1-double-pull-repro.mjs` 50/50 闭环）；A1/A2 ✅（cr-667 原地续跑——设计 [design-run-resume.md](design-run-resume.md)，未提交调用合成「结果未知」错误、不做 at-least-once 重执行；A2 前端零改动——context-injected label 直出既有分支）；B3 ✅（cr-665 vitest TEMP 锚 sandbox/tmp，产品路径无 %TEMP% 写点核实）；C2 ✅（cr-666 reconcileUndelivered 收尾对账——**实测修正：补投须带行龄门（只收 boot 前落账行），否则与在途写入竞态误补投**）；D4/D5 ✅（cr-664 restart_shell 双防）；D3 ✅ 无需（seg- 行已 cr-658 读侧过滤，journal 708 行在）。D1 ✅（cr-668/669/670，活体 CDP 复验通过——`preview/sandbox/d1-busy-reset.mjs`：mid-run 双杀（宿主+壳）→ supervisor 重拉 → WS 重连 → busy 复位。过程抓到并修复两真 bug：① supervisor argv 透传丢无值旗标（--mock-provider 经 supervised 形态全丢——壳零 provider run 瞬间 error，cr-670）；② DSH 沙箱拒品牌 exe 连 named pipe（EPERM probe 实锤，真机无此限制——AGENTCHAT_NO_BRANDED_EXE=1 诊断旁路，cr-669）；另 AGENTCHAT_MOCK_DELAY_MS 延迟档造 mid-run 窗口（cr-668）。D2 ✅（cr-679，2026-10-25：cr-639…678 批次按域七层切 9 commit 入库、工作区清零）；D6 维持「不追」——至此本清单全部收口。

> 汇总自 handoff §1/§7.3/§8、plan §5、restart-lab STATE-FINAL，以及本轮（cr-661）实测新增观测。
> 每条给「现象 / 证据 / 根因判断 / 代码位置 / 修复方向 / 量级」，标 [实证] 的是有盘上或活体证据，[线索] 的是推断待证。

---

## A 类：语义缺口（现状已被用户否决，需要设计）

### A1 中断/崩溃的 run 不能原地续跑——一律从 step 0 重跑 [实证]

**现象**：壳重启或崩死后，模型虽然拿得到前序轨迹（cr-658 后上下文不丢），但**动作会重做**——重新 load_skill、重读文档、重复已完成的步骤。

**本轮证据（会话 01a16c90）**：
- 14:18:41 起跑的壳 26740 在 14:21:01 崩死（跑到本 run 的 step 8）；
- 新壳 30472 boot：`recoverOrphanRuns` 补 `journal-settled(interrupted)`（journal 行 43，seq=1）→ `recoverPendingInbox` 重投同一信封 → **同 runId 从 step 0 重跑**（journal 行 44 起 step 0 再来一遍）。

**根因**：续跑单位是「信封」不是「run」。`recoverPendingInbox` 把在途信当新输入重投，`machine.plan` 从零开 run；journal 里其实已精确记着 `journal-step.toolCalls` 与 `journal-tool-result`，足以重建 `LlmMessage[]`（assistant{tool_calls} + tool 结果对），但没有「从第 N 步继续」的入口。

**代码位置**：
- `preview/packages/ac-shell-conversation/src/service.ts:113`（plan）、`:151`、`:278`（driveRun）、`:523`（recoverPendingInbox）
- `preview/packages/ac-ledger/src/reader.ts:167`（trajectoryOfRun）、`service.ts:216`（historyMessagesFor）
- `preview/apps/shell/boot.ts:736-793`（恢复面：孤儿收口 → inbox 重投 → 已重启注入）

**修复方向**（handoff §1 原案，建议单独立项）：
1. 恢复面识别「该 run 有 journal 步行 + 无 settled」→ 走**续跑分支**而不是重投信封；
2. 用 `trajectoryOfRun` 重建消息前缀，从**最后一个已提交步之后**继续同一 runId；
3. 步边界原子性：只从「工具结果已落 journal」的步之后恢复；未落结果的 tool_call 按 at-least-once 重试——需工具幂等或副作用登记（write/edit 覆盖型安全，pwsh 不安全）；
4. 同 runId 一致性：不二次计费、不二次 postReply、maxSteps 按剩余额度；
5. 降级：轨迹缺失/版本不兼容 → 退回当前「重投 + 轨迹上下文」路径，并在 UI/终稿显式标注「已中断按摘要继续」。

**量级**：中—大（run 级 resume 状态机 + 幂等策略）。**风险**：工具副作用重复执行——第 3 点是难点。

### A2 崩溃收口无用户可见提示 [实证]

崩溃/中断后没有任何面向用户的「上一轮被中断、以下为重启续跑」标记，用户只能从模型行为（重做）看出异常。
**修复**：A1 落地时顺带在收束行/注入信封里带 `resumedFrom` 标注，前端在会话流里渲染中断分割线。**量级**：小（依赖 A1）。

---

## B 类：诊断面缺口（本轮实测直接踩到，性价比最高）

### B1 壳的 stderr 无人消费 → 崩溃零现场 + 潜在写阻塞 [实证]

**现象**：壳 26740 崩死**没有任何现场**——无退出码、无 stderr、无日志，只能从 activation.lock 时间戳推断死亡时刻。

**证据（代码）**：`preview/apps/host/orchestrate.ts:63-107`
- `spawnOpts()` 返回 `{ stdio: ['pipe', 'pipe', 'pipe'], detached: true }`；
- `defaultSpawn` 只挂了 `child.stdout.on('data', ...)`，**`child.stderr` 从未挂监听**。

**两层危害**：
1. 诊断全丢（本轮直接后果）；
2. Node 的管道缓冲区约 64KB 且**不读就会反压**——壳里 `process.stderr.write` 写满即阻塞，长命壳 + 反复错误可累积成「壳莫名卡住」。

**修复方向**（小改，收益立刻）：
- `defaultSpawn` 里 `child.stderr.on('data')` 按行切分：转发宿主 stderr（`[shell:<agent>]` 前缀）+ 追加 `dataRoot/.runtime/logs/shell-<agent>.log`（带大小滚动上限）；
- 退出回调里记录 `code/signal` + 尾部 N 行，经 `supervise.ts` 的 exit 事件带进 `ShellWarden` 事件面（与 `plugin.load-failed` 同处上报给宿主）；
- 顺带：`host-revive.ts:210-214` 拉宿主用 `stdio: 'ignore'`，宿主侧崩溃同样零现场——同款处理。

**量级**：小（半天内）。**建议第一个做**——没有它，A/C 类问题的下一次复现同样无证据。

### B2 宿主 stderr 只进终端（supervisor `stdio: 'inherit'`）[实证]

**证据**：`supervisor.mjs:41-42`、`:94-97` 宿主 spawn 为 `stdio: 'inherit'`——宿主的所有 `[host]` 诊断只落在用户终端，终端关了/滚过去了就没了。
**修复**：supervisor 给宿主加 tee（同时写 `dataRoot/.runtime/logs/host-<ts>.log`），或 supervisor 自身 stdout/stderr 落文件。**量级**：小。

### B3 `%TEMP%` 瞬时 EPERM（cr-593 同域）[实证]

**现象**：后台 job、vitest 临时目录偶发 `EPERM`（本轮实测多次，测完自愈）。
**已知**：`orchestrate.ts:55-61` 注释记录了「沙箱对未知镜像 exe 拒写 %TEMP%（EPERM 建激活锁）」。
**修复方向**：AgentChat 自身一切临时文件（含激活锁、node-compile-cache）统一走数据根 `.tmp`，不走继承的 `%TEMP%`；测试/探针启动脚本显式设 `TEMP/TMP`。**量级**：小—中（要盘一遍所有写到 TEMP 的点）。

---

## C 类：竞态 / 未复现异常（有线索）

### C1 R3 anomaly：一次 restart_shell 产生 2 代宿主 + 2 代壳 [线索]

**现象**：手记于 handoff §7.3，被重启的壳当时为孤儿态（生父宿主已被 restart_host 换代）。其后孤儿/非孤儿两形态各测均未复现。

**线索（三条重拉面并存）**：
1. `restartShell` 信封钩子（`preview/apps/host/boot.ts:150`）——收到信后轮询锁退净再 `ensureAgent`；
2. boot 扫 `.runtime/restart-shell/*.json` 标记（`boot.ts:264-277`）——锁持有者死了就 `ensureAgent`；
3. 邮局 ensureHook 的救援分支（`orchestrator.ts:153`）。

标记只在**新壳 boot 完成后**才自清（`apps/shell/boot.ts:335-344`）——这个窗口内「锁缺失或陈旧」都成立，两条路径可能各自拉起一次；本轮的壳换代采样也观察到 `marker` 出现→消失之间锁短暂为 0（新壳尚未持锁）。

**修复方向**：
1. **单一仲裁**——重拉一律以 activation.lock 为唯一事实：`ensureAgent` 前再读锁，存在即跳过；
2. **标记原子领取**——宿主扫到标记先 `rename` 成 `.claimed-<hostBootId>` 再拉起，成功才删、失败回滚，消除双触发；
3. **标记 TTL**——`at` 超过 10 分钟即丢弃并记 stderr（防「新壳永不起来」时每次宿主 boot 都白拉一次）。

**量级**：小（30 行内）。**注意**：改完需要构造孤儿态复现脚本才算闭环。

### C2 壳 boot 窗口期消息只落账未执行（cr-648 观测一次）[线索]

**现象**：观察到一次「消息进了账本但 run 没跑」，靠下一条消息才带出来。
**修复方向**：boot 恢复面收尾后做一次一致性对账——回读 inbox + 最近账本行，发现「有落账无 run 键」即补投；把「观察一次」变成确定性收敛。**量级**：小—中。

---

## D 类：验证缺口 / 工程债

| # | 项 | 现状 | 建议 |
|---|---|---|---|
| D1 | cr-659 前端侧（feed-core 忙态复位） | 只有单测绿，未 CDP 复验 | 用 `preview/sandbox/cdp-*.mjs` 跑一次 restart_host：断线窗口内杀 WS → 重连后 busy 是否复位 |
| D2 | 工作树 ~26 项未提交 | cr-628…659 两批改动混在同一批文件（`ac-ledger/*`、`ac-shell-conversation/service.ts`、`restart.ts`、`orchestrate.ts`） | G8 分批入库前先按 CR 切分归属，别把两批混成一条 |
| D3 | 01a16c53 存量 32 步 | 需 `preview/sandbox/backfill-segments.mjs` 才能进上下文 | cr-658 读侧轨迹重建后**先确认是否还缺**，缺才跑 |
| D4 | restart_shell 同轮重复调用无硬防 | `requestRestart` 幂等，仅靠工具描述叮嘱「勿重复调用」 | 第二次调用直接返回「已排程」态或拒绝，避免模型反复刷 |
| D5 | restart_shell 在 CLI 直连形态（无邮局） | `notifyHostRestartShell` 直接 return → 壳退 42 **无人重拉** | 该形态下让工具 fail-loud 拒绝，或改为只 reload 不退出 |
| D6 | `supervisor 退出 → 全壳连坐` 物理机制 | 控制台关闭假设，未取证 | cr-642 detached 后该路径已断，除非再复现，否则记为「不追」 |

---

## 建议顺序

1. **B1 + B2（诊断面）** —— 半天，先把「下次崩了能不能查」这件事解决；
2. **C1 标记/重拉单一仲裁** —— 半小时，消掉唯一还活着的竞态线索；
3. **A1 原地续跑** —— 主线缺口，需单独立项设计（工具幂等是真正难点）；
4. B3、C2、D1-D5 穿插清理；D2 入库切分在下次提交前做。