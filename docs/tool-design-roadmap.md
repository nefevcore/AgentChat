# AgentChat 工具设计：吸纳 DSH 经验的路线图

> 2026-08-20 · 依据：docs/dsh-jobs-comparison.md（DSH 三层架构 + 双 bash 模型分析）。
> 原则：**只吸收与 AgentChat 形态匹配的设计，不照搬实现**。AgentChat 是异步多 Agent 社区平台（非单会话编码 IDE），
> 面向的吸纳点集中在"异步任务管理"与"工具模型协议"，执行分层（seam）按需取舍。

---

## 0. DSH 经验可归纳为五条设计原则

1. **任务管理要有通用词汇**：`cancel / done / readOutput` 三元组 + `running→stopping→completed/killed/failed` 状态机，让 bash/pwsh/subagent/定时器任何异步能力都能进同一张注册表。
2. **生产者与控制器分离 + owner 隔离**：起任务的工具（producer）只管登记，管理面（job_list/job_output/job_kill）是独立插件；任务按 owner 会话 fencing、每 owner 有并发上限。
3. **模型拿到不透明句柄，不是 OS 对象**：job id 而非 PID；管理只能走工具，不能绕过。
4. **完成通知 push，模型不轮询**：注册表完成 → 通知注入 owner 下一步；system prompt 直接教协议（"不要忙轮询、wait 仅真阻塞时用、及时 kill 已不重要的任务"）。
5. **结果语义：报告不报错**：非零退出是"结果 + [exit code: N] 标记"，由模型决定如何反应；只有基础设施故障才是 error。

---

## 1. 第一阶段（小改动，立即可做）：把现有 job 工具对齐 DSH 的任务管理模型

> **✅ 已落地（2026-08-20）**：1.1/1.2/1.3 完成；1.4 未做（log 文件方案够用）。
> 落点：`src/shell/shell/src/job.ts`（登记表重构）、`tools.ts`（返回 job_id + close 回写）、`boot/src/plugin.ts`（完成通知 → `job.done` 事件）、`agent-prompt/src/prompt.ts`（协议段）。

### 1.1 job id 不透明化 + owner 分桶（`src/shell/shell/src/job.ts`）

现状：bash background 返回裸 `PID + log_file`；job 登记表是模块级 `Map`（全进程共享、无 owner）。
改法（已实施）：

- 登记表加 `ownerAgentId` 字段（bash execute 时从 config.agent_id 拿）；list/kill/logs 只作用于调用者自己的登记（`assertAccess` 同款语义）。
- bash background 返回改为登记表生成的 id（如 `bash-3`，内部仍保留 pid 与 log_file）；`job` 工具的 list/kill/logs 全部按 id 走。
- kill 语义：**A（收窄，已实施）**——kill 只允许已登记 id（`killBackgroundJob → killProcessTree`），任意 PID 走 bash 内 Stop-Process。
- 每 owner 活跃任务上限（`MAX_CONCURRENT_JOBS_PER_OWNER = 8`），超限报错提示先 kill。
- 状态跟踪：`running→stopping→completed/killed`，bash `child.on('close')` 回写（first-wins），供 list 展示与完成通知。

### 1.2 完成通知（`src/boot/boot/src/plugin.ts` + `job.ts` 监听）

现状：后台任务完成没有任何推送，Agent 只能自己 `job logs`/`job list` 轮询。
改法（最小闭环，已实施）：

- job 登记表加 `setJobDoneListener(fn)`（任务 settle 时触发，first-wins）；
- boot 装配层接线：完成时经 router `emit('message', { type:'job.done', ... })` → WS 广播（前端可据 `job.done` 事件做通知）；
- 更进一步（未做）：给 owner Agent 注入一条消息（类似 DSH 的 notice）——AgentChat 有 send_agent 机制，天然支持"异步把完成通知送达 owner 下一步"。

### 1.3 协议进 system prompt（`src/agent-prompt/agent-prompt/src/prompt.ts`）

在 `buildSystemPrompt` 加一段固定指引（对应 DSH tool:jobs 的 order-106 段；已实施，仅当工具集含 job/bash 时注入）：

> 后台任务用 job 工具按 id 管理（bash background 返回 job_id）。启动后记住 id，任务完成时你会收到通知——不要用 job list 忙轮询。job logs 读取输出；不再重要的任务用 job kill 及时清理，避免占用并发额度。

### 1.4 输出读取加游标（可选，未做）

log 文件方案够用；若做增量，记录"上次读到的字节偏移"，`logs` 只返回新内容（DSH 的 delta + spill 语义），省 token。

**工作量**：已实施（半天）；改动集中在 `src/shell/shell/src/job.ts`、`src/shell/shell/src/tools.ts`、`boot/src/plugin.ts`、agent-prompt。

---

## 2. 第二阶段（中等）：ctx.jobs 服务化 + 异步能力统一

> **✅ 已落地（2026-08-20）**：新增 `@agentchat/jobs` 核心包（`src/core/jobs`），bash 与 subagent 统一接入；job 工具扩展为通用管理面。
> 落点：`src/core/jobs/src/service.ts`（JobService）+ `plugin.ts`（组合行 id: jobs）；`src/shell/shell/src/job.ts`（消费 ctx.jobs）；`src/svc/subagent/src/subagent.ts`（spawn 登记 kind=subagent）。
> 未做：timer 事件登记为 job（触发型任务语义不同，暂不纳入）；job 工具拆分三工具（保持单工具 action 面）。

现状（已改）：三个异步能力各管各的——`job` 工具（bash background，模块 Map）、`subagent`（SubAgentManager，自带 spawn/await/kill/list）、`timer`（TimerManager，调度）。

改法（已实施）：

- **`ctx.jobs` 服务**（cordis Service，组合行 `jobs`，先于 shell/subagent 行）：统一任务词汇 `start({kind, label, ownerAgentId, meta, run})` → 不透明 id（`<kind>-N`）；run 返回 `{cancel, done, readOutput?}`；owner 分桶 + 每 owner 活跃上限（默认 8）+ settle first-wins + `onJobDone` 完成监听；
- **bash 接入**：`makeShellTools(config, jobs)`，background 分支 `jobs.start({kind:'bash', ...})`（cancel=杀进程树，done=child close 终态，meta 带 pid/logFile/cwd）；job 工具改为消费 ctx.jobs（list/kill/logs 按 owner 隔离，kill 仅已登记 id）；
- **subagent 接入**：`SubAgentManager.setJobs(ctx.jobs)`，spawn 时 `jobs.start({kind:'subagent', ...})`（cancel=manager.kill，done=执行终态映射 done→completed / error→failed / timeout|killed→killed，readOutput=最终结果）；subagent 工具自身动作面不变；
- **完成通知**：boot 改接 `ctx.jobs.onJobDone` → `job.done` 事件（bash/subagent 统一）；
- **管理面统一**：job 工具的 list 现在能看到 bash-N 与 subagent-N（含 kind 字段），kill/logs 对两者通用。

**收益（已兑现）**：模型只需学一套任务协议（id + list/kill/logs + 通知），bash/subagent 复用同一登记表、并发额度与完成通知；为 workflow 预留了统一词汇。

---

## 3. 第三阶段（远期，按需）：执行分层与双 shell 模型

### 3.1 ctx.shell 执行器 seam（可选）

现状：bash execute 里揉着 spawn + PowerShell 翻译 + 命令级启发式沙箱（`bashCommandViolation`）+ 后台登记。

DSH 的做法是工具壳（tool-bash）与执行器（bash-local/pwsh-local/sandbox）分离。AgentChat 是单平台（Windows 优先），**不建议现在就拆**；但有两个低成本的"准分层"动作：

- 把 `bashCommandViolation`、`killProcessTree`、shell 探测、`translateUnixToPowerShell` 归入 `src/shell/shell/src/` 的独立执行模块（已基本如此），确保未来加 pwsh 孪生时只加"执行器适配"不改工具壳；
- 若未来需要远程执行（如对 SAP/云环境），再抽 `ctx.shell`。

### 3.2 持久 shell（PTY）——给"编码类"预设的真终端（大工程，慎入）

DSH minimal 用 `dsh-tool-bash-persistent`（PTY）获得：状态跨调用、交互式程序可跑、后台 = shell job control。AgentChat 若要做"编码 Agent 预设"的真终端体验，需要：

- `ctx.terminals` 服务（PTY 后端；Windows 下 node-pty 兼容性要评估）+ 持久 shell 工具；
- 会话级 cwd 持久化（轻量替代：bash 每会话记住 cwd，避免每次 cd——这个**低成本可以先做**）；
- 与 per-call 沙箱的关系要设计（DSH 的结论是持久 shell 只能会话级包裹沙箱，与逐命令判定互斥）。

### 3.3 沙箱升级通道（安全议题，需产品决策）

DSH 的 `sandbox_permissions/justification` 审批升级（deny-only + 会话内一次性升级 + approval UI）。AgentChat 目前是配置驱动的路径白名单（security.allowedPaths）——**升级通道是更强的交互模型，但要引入 approval 流程与前端，属于产品级改动**，建议单独立项评估，不并入工具改造。

---

## 4. 立即可以吸收的"软"经验（零基建）

| 经验 | AgentChat 落点 | 状态 |
|------|---------------|------|
| 非零退出 = 结果非错误 | bash 前台目前非零 → `status:'error'`；DSH 是"结果 + `[exit code: N]` 标记"。改不改取决于前端 ToolResultTerminal 的渲染契约，需评估 | 待评估 |
| 描述教协议（不忙轮询等） | agent-prompt 的 buildSystemPrompt 加段落 | 一阶段 1.3 |
| 工具描述精简（KV cache/prefix 稳定） | 已做（browser/update_agent_profile/timer） | ✅ |
| 输出有界 + spill 提示 | bash 已有 truncateMiddle；可补"完整输出落盘路径提示" | 低成本 |
| 通用任务词汇 | subagent 的 spawn/await/kill/list 已是雏形 | 二阶段统一 |

---

## 5. 不建议照搬的部分

- **每次调用全新进程 + DSH_* 环境注入机制**：AgentChat 单进程宿主、无嵌套 harness 场景，无此需求。
- **minimal 的固定完整 persona（complete: true）**：AgentChat 是社区多 Agent 平台，persona 自由；极简预设只需"工具少"不需要"提示词锁死"。
- **per-call 审批升级通道**：见 3.3，产品决策后再议。
- **"报告不报错"的全盘改造**：bash 非零退出的语义与前端渲染契约耦合，单独评估，不随行改。

---

## 6. 建议的落地顺序（可执行清单）

1. **P0（本周）**：job id 不透明化 + owner 分桶 + 并发上限（§1.1）→ 完成通知事件（§1.2）→ 协议段落（§1.3）。**✅ 已全部落地（2026-08-20）**；§1.4（logs 游标）可选未做。
2. **P1（下轮）**：ctx.jobs 服务化，subagent 接入统一词汇（§2）；bash cwd 会话级持久化（§3.2 轻量项）。**✅ ctx.jobs 服务化 + subagent 接入已落地（2026-08-20）**；bash cwd 持久化未做（轻量项，可后续）。
3. **P2（远期）**：通用 job 管理面三工具拆分（job_list/job_output/job_kill）与 DSH 对齐；timer 事件登记；持久 PTY shell（编码预设）；沙箱升级通道评估。

---

## 7. 持久化收益分析（2026-08-20 · 讨论记录）

**先摆正一个前提**：DSH 自己**没有**跨重启持久化——`dsh-jobs-local` 是纯内存态（"The process-local registry lives in @deepseek-ai/dsh-jobs-local"），`dsh-terminal` README 明说 "Sessions are process-local and are not restored after a harness restart"。DSH 的收益点是**生命周期纪律**（注册比 producer 活得更久；owner/服务销毁时 cancel + await 收敛）与**完成通知**，不是持久化。所以"持久化"是 AgentChat 超出 DSH 的增值项，需要自己按收益排序。

"持久化"拆成三层，逐项评估：

### 7.1 跨回合送达（完成通知进 owner 下一步）——收益最高，非重启持久化

- **内容**：job settle 时不仅发 `job.done` WS 事件，还把完成通知作为一条消息送入 owner Agent 的下一步（复用 router 的 inbox 机制 + durable-interaction 的 JSONL 落盘），实现"模型不丢完成事件"。
- **收益**：AgentChat 是异步多 Agent 平台，Agent 常在跑别的回合；通知落进 inbox 后，owner 下一回合必然看到（而不依赖 WS 在线）。这与 DSH 的 notice 注入对齐，且 AgentChat 已有消息持久化底座（sessions/messages.jsonl + durable suspension）。
- **成本**：中（复用 inbox 投递 + 持久化消息格式），机制已存在。
- **结论**：**✅ 已落地（2026-08-20）**：boot 的 `onJobDone` 双通道送达——① `job.done` WS 事件（前端）；② `router.followup` 以 `role:'user'` + `source{kind:'system', form:'notice'}` 入队 owner 的 next-turn（空闲开新 run，忙时 run 结束后消费，即"跨回合必达"）；自主来源受 router `MAX_AUTO_WAKES` 兜底防自激，通知 run 以 `delivery.maxSteps=8` 封顶。

### 7.2 注册表快照恢复（跨进程重启）——有条件收益

- **内容**：`ctx.jobs` 登记表落盘 JSONL（id/kind/owner/pid/logFile/startedAt），启动时恢复并在 boot 时 reconcile。
- **为什么可行**：bash background 的进程是 **detached + unref** 的 OS 进程——**宿主重启后进程可能还活着**（日志文件也在 tmpdir 里），丢的只是注册表句柄。恢复后 Agent 能重新 list/kill/logs 自己的长驻服务（dev-server、mock、watcher）。
- **收益**：对"社区/运维类 Agent"真实；对一次性任务场景收益≈0。
- **风险与成本**：PID 复用（旧 pid 可能被新进程占用 → 误杀）——需存 startedAt 并做"进程启动时间晚于任务启动时间 = 陈旧"校验，或用日志文件 birthtime 佐证；另需清理策略（settled 条目保留窗口、重启时标记 reconciled）。工作量中。
- **结论**：**做，但要带 PID 复用校验**；与 7.1 解耦，可独立排期。

### 7.3 bash cwd 会话级持久化——收益最小

- **内容**：每个会话记住上次 bash cwd，减少重复 cd。
- **收益**：省少量上下文噪音；但 AgentChat 的 bash 是无状态模型（每调用新进程），引入会话态会破坏确定性，且与沙箱 cwd 解析语义纠缠。
- **结论**：**不做**（除非做持久 PTY shell，那时才自然获得）。

### 小结

| 层 | 类型 | 收益 | 成本 | 建议 |
|----|------|------|------|------|
| 7.1 完成通知进 owner inbox | 回合间持久化 | 高（不丢事件） | 中（复用已有底座） | **先做** |
| 7.2 注册表快照恢复 | 重启持久化 | 中（长驻服务场景） | 中（+PID 复用校验） | 择机做 |
| 7.3 bash cwd 持久化 | 会话态 | 低 | 低-中（破坏无状态性） | 不做 |
