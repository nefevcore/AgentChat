# DSH 的 pwsh ↔ job_* 关系设计（与 AgentChat bash+job 对比）

> 2026-08-20 · 分析对象：`@deepseek-ai/dsh-tool-pwsh` / `@deepseek-ai/dsh-tool-jobs` / `@deepseek-ai/dsh-jobs` / `@deepseek-ai/dsh-jobs-local`（`C:\Users\xiaofeng\node_modules\@deepseek-ai\`）。
> 背景：AgentChat 刚把 bash background 的后台管理做成 `job` 工具（进程内登记表 + list/kill/logs），本文对比 DSH 的做法，供后续对齐参考。

---

## 1. DSH 的三层架构

DSH 把"执行"、"任务登记"、"模型可见的工具面"拆成三个独立插件层，**pwsh 与 job_* 之间没有直接耦合**：

```
┌─ 模型 ──────────────────────────────────────────────┐
│  pwsh { command, run_in_background:true }           │
│    → { kind:'background', jobId:'pwsh-1' }          │
│  job_list / job_output / job_kill { job_id }        │
└──────────────────────┬──────────────────────────────┘
                       │ ctx.tools
┌──────────────────────▼──────────────────────────────┐
│ ① 工具插件（Consumer，不 spawn）                    │
│    dsh-tool-pwsh（inject: tools/shell/systemPrompt/ │
│      shellEnv）→ 解析沙箱策略/DSH_* env/工作目录后    │
│      前台: ctx.shell.run(...)                       │
│      后台: ctx.jobs.start({ kind:'pwsh', run:... }) │
└──────────────────────┬──────────────────────────────┘
                       │ ctx.shell / ctx.jobs
┌──────────────────────▼──────────────────────────────┐
│ ② 能力接缝（Seam，真正的执行者）                    │
│    ctx.shell   ← dsh-pwsh-local（PowerShell 执行器）│
│    ctx.jobs    ← dsh-jobs（抽象契约）+              │
│                  dsh-jobs-local（进程内实现）        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│ ③ 管理面插件（Controller）                          │
│    dsh-tool-jobs（inject: tools/jobs/systemPrompt） │
│    → 注册 job_output/job_list/job_kill +            │
│      attachController("tool-jobs") + 完成通知       │
└─────────────────────────────────────────────────────┘
```

## 2. pwsh ↔ job 的关系（核心机制）

### 2.1 pwsh 不做任何后台管理——它只"登记"

`dsh-tool-pwsh` 的 `execute` 里，`run_in_background: true` 分支只做一件事（`lib/index.js`）：

```js
return { kind: "background", jobId: jobs.start({
  kind: "pwsh",            // job id 前缀，id = `pwsh-N`
  label: args.command,
  owner: exec.agent,       // 归属会话（隔离/通知依据）
  run: () => {             // 把执行器进程句柄适配成"通用任务词汇"
    const proc = ctx.shell.start(ctx.shell.resolve(request));
    return {
      cancel:     () => void proc.kill(),              // job_kill → 句柄取消
      done:       proc.done.then(processOutcome),      // 终态 → 通用结局
      readOutput: () => renderPwshProcessRead(proc.readOutput(), ...) // 增量读
    };
  }
})};
```

关键点：
- **进程是执行器（`ctx.shell`，如 dsh-pwsh-local）spawn 的**，pwsh 工具只是个消费壳；后台句柄被包装成通用任务词汇 `{cancel, done, readOutput}` 交给注册表。
- 返回给模型的**不是 PID，而是不透明的 job id**（`pwsh-1`）。模型从此只能通过 job_* 工具按 id 管理。
- `processOutcome` 把进程结局映射到通用任务状态：`killed → {status:'killed', detail:signal}`，否则 `{status:'completed', detail:'exit code: N'}`——**非零退出是"完成"，不是失败**（与前台渲染一致，由模型决定怎么反应）。
- 输出 schema 是判别联合：`{kind:'background', jobId}` vs `{kind:'foreground', exitCode/signal/stdout/stderr/sandbox}`。
- bash 工具是完全同构的孪生（`dsh-tool-bash/lib/index.js:414` 同样 `jobId: jobs.start({...})`）。

### 2.2 ctx.jobs：一个通用后台任务注册表（与 shell 无关）

- `dsh-jobs` 只定义**抽象契约**（`JobRegistry` 抽象类，直 new 会抛错），进程内实现是 `dsh-jobs-local`（内存 Map）。
- 契约要点（注释即规范）：
  - **注册比 producer/controller 的 fiber 活得更久**；Agent/服务销毁时 cancel 活任务并 await 合规 producer 收敛；teardown cancel 抛错则仅强制失败该记录（报可能孤儿）。
  - **会话隔离**：有 owner 的 job 只有同 session id 的 caller 能读/杀（"authorization — not secrecy — is the boundary"，id 可预测）。
  - **settlement 先到先得**：一个终态记录、释放所有 waiter、一轮受控的完成通知；完成通知最后发出（因为 reporter 可能同步开一个模型回合）。
  - `start` 在**没有已挂载的 controller 服务该 owner 时拒绝工作**（`servesOwner`）——不能启动 owner 收不到/停不掉的任务。
- 每 owner 并发上限：`maxConcurrentJobsPerOwner`（默认 10），超限直接报错提示先 job_kill。
- 通用任务状态机：`running → stopping → completed | killed | failed`（`killed` 与 `failed` 都是终态，语义：被杀 vs 内部失败——pwsh 只产生 completed/killed，failed 留给契约违规/teardown）。

### 2.3 job_* 工具面（dsh-tool-jobs）

- 注册 **`job_output`**（增量读：流式任务只返回上次读之后的 delta；`wait:true` 阻塞到终态或超时，超时返回 `[status: running]` 且任务存活）、**`job_list`**（本 owner 全部任务 id/kind/status）、**`job_kill`**（按 id 请求取消，立即返回，任务真正停下后才 settle 为 killed；可带 reason）。
- `job_kill` 走 `ctx.jobs.kill → job.cancel(reason) → proc.kill()`——**只能杀注册过的任务句柄，没有"任意 PID"通道**。
- 完成通知：`onJobDone` → 给 owner 注入一条 user 消息 `background job pwsh-1 (pwsh: <cmd>) finished [status: completed, exit code: 0]`；owner 忙时注入下一步，闲时 `wakeup` 开新回合（默认，每 owner 最多 3 次连续 wake）。
- 系统提示词注入（order 106）："Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; … job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering."——**把协议教给模型**。

## 3. 生命周期时序（pwsh 后台任务）

```
模型调用 pwsh(run_in_background:true)
  → jobs.start() 生成 id "pwsh-1"，登记 running
  → 返回 {kind:'background', jobId:'pwsh-1'}（立即）
模型继续干别的（不轮询）
  → 进程退出 → proc.done → processOutcome → registry.settle(completed/killed)
  → onJobDone → tool-jobs 注入完成通知到 owner 下一步
模型 job_output {job_id, wait:true}（仅当真被阻塞时）
  → 增量文本 + [status: completed, exit code: 0]
模型 job_kill（任务已不重要时）
  → cancel → proc.kill() → settle(killed) → 通知
Owner/service 销毁
  → cancelForTeardown → await settled → 清记录
```

## 4. 与 AgentChat bash+job 的对比

> AgentChat 侧为 **Phase 1+2 落地后（2026-08-20）** 的状态：ctx.jobs 服务化、bash/subagent 统一登记、owner 分桶/上限/完成通知/协议段全部实施（docs/tool-design-roadmap.md §1-2）。

| 维度 | DSH（pwsh/job_*） | AgentChat（bash+job，当前实现） |
|------|-------------------|-------------------------------|
| 谁 spawn 进程 | 执行器服务 `ctx.shell`（dsh-pwsh-local）；pwsh 工具只消费 | bash 工具 execute 内**直接 spawn**（无执行器层） |
| 后台登记载体 | 通用注册表服务 `ctx.jobs`（dsh-jobs-local，进程内） | **通用服务 `ctx.jobs`（@agentchat/jobs，进程内）**（Phase 2 对齐） |
| 模型拿到的句柄 | 不透明 job id（`pwsh-1`） | **不透明 job id（`bash-N`/`subagent-N`）+ pid/log_file** |
| 管理工具 | job_list / job_output / job_kill（三个独立工具） | 单个 job 工具（action=list/kill/logs；bash/subagent 通用） |
| kill 语义 | 只能取消已登记句柄（`handle.cancel → proc.kill()`） | **只能按已登记 id**（bash 杀进程树、subagent abort；任意 PID 走 bash 内 Stop-Process） |
| 输出读取 | 增量 delta（上次读之后），丢失时给 spill 路径提示 | bash 日志尾部 N 行 / subagent 最终结果（非增量） |
| 完成通知 | ✅ 注入 owner 下一步 / wakeup 开回合（自动） | **✅ 双通道：`job.done` WS 事件 + `router.followup` 进 owner inbox**（source kind=system form=notice；忙时 run 结束后消费 = 跨回合必达；MAX_AUTO_WAKES 兜底） |
| 隔离 | 按 owner session fencing + 每 owner 并发上限 10 | **按 owner agent_id 分桶 + 上限 8** |
| 生命周期 | 注册比 producer 活得更久；owner/服务销毁 cancel+await | 注册表随进程存亡（重启即失）；无 owner 销毁联动 |
| 与 shell 解耦 | 通用任务词汇，bash/pwsh/任意 kind 都能喂 | **通用任务词汇，bash/subagent 已接入**（timer 未接入） |
| 模型协议 | system prompt 教协议（不忙轮询、wait 仅真阻塞、kill 已不重要任务） | **buildSystemPrompt 注入协议段**（有 job 工具时） |
| 失败语义 | 非零退出 = completed（报告不报错），模型自己决定 | bash 前台非零 = error 结构化 JSON（语义不同） |

## 6. 那极简模式呢？（minimal preset 没有 jobs，怎么后台？）

**答案：极简模式根本不走 jobs 系统——它的 bash 是持久 shell（PTY），后台交给 shell 自己的 job control。**

`@deepseek-ai/dsh/config/agent-presets/minimal/agent.cordis.yml` 的装配只有三个部分：

- `persona`（固定完整提示词，`complete: true`，无运行时上下文）
- **persistent-shell 组**（`isolate: terminals`）：`dsh-terminal`（PTY 服务）+ `dsh-terminal-bash` + **`dsh-tool-bash-persistent`**
- filesystem 组（`isolate: fs`）：`dsh-fs-local` + `dsh-tool-str-replace-editor`

**没有** `tool-bash`（带 run_in_background 的那个）、**没有** `tool-jobs`。所以：

- **启动后台**：`dsh-tool-bash-persistent` 的参数只有 `command`（inject: `["tools","terminals"]`，无 `jobs`、无 `run_in_background`）。工具描述直接指示模型："Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background."——即**在持久 shell 里用 `&` 起后台任务**（`sleep 10 &`、`nohup server &`）。因为 shell 是 PTY 持久会话（agent 私有、跨调用存活），任务在同一个 shell 里继续跑，模型下一次调用还能看到/操作它。
- **杀掉后台**：同样在持久 shell 里用 shell 命令：`jobs` / `ps` 查，`kill %1` / `kill <pid>` / `pkill` 杀。没有 job_output/job_list/job_kill 可调。
- **超时/异常兜底**：命令超时（timeoutMs=300000）或 shell 退出时，持久 shell 被 reset（`SHELL_RESET_MESSAGE`）——此时后台任务随 shell 一起被清掉。

**为什么两个模式设计分叉**（standard/agent.cordis.yml §background jobs 的注释说得很直白："What a preset chooses is whether its agent can collect and stop background work at all."）：

| | standard | minimal |
|---|---|---|
| bash 工具 | `dsh-tool-bash`（每次调用**全新进程**，无状态） | `dsh-tool-bash-persistent`（**持久 PTY shell**，状态跨调用） |
| 后台机制 | `run_in_background:true` → `ctx.jobs.start()` → job id | shell 原生 `&` job control |
| 管理面 | `tool-jobs`（job_output/job_list/job_kill + 完成通知） | 无；`jobs`/`ps`/`kill` 都在 shell 里做 |
| 根源 | 新进程 spawn 后 detach，模型必须有个句柄（opaque job id） | shell 本身活着，任务的生命周期由 shell 承载，无需抽象 |

即：**fresh-shell 必须配 jobs 注册表（否则后台任务无主可管）；persistent-shell 天然不需要它**。极简模式不是"阉割了 job 工具"，而是它的 bash 模型（持久 shell）根本不需要这层抽象——这也解释了 AgentChat 的 bash（每次调用新进程 + background）更接近 standard 一侧的简化版。

## 7. 为什么设计两种 bash 工具（设计动机）

两种工具对应**两种 shell 执行模型**，各有明确的产品定位，不是"重复造轮子"：

### 7.1 fresh shell（`dsh-tool-bash` / `dsh-tool-pwsh`）——平台级沙箱化执行

- 每次调用 = 全新进程，**无状态、可预测、幂等**（"No state persists between calls — use workdir, not cd"）；cwd 由 session 提供，每个会话各跑各的工作区。
- 走 `ctx.shell` **执行器 seam**：执行器可插拔（bash-local / pwsh-local / bash-sandbox…），跨平台（Win 用 pwsh 孪生）。
- **per-call 沙箱 + 审批升级是它的核心**：deny-only 沙箱按调用判定，`sandbox_permissions`/`justification` 升级通道、会话级模式切换、DSH_* 环境注入——安全模型逐调用可控。
- 后台必须配 `ctx.jobs`（新进程 detach 后无主可管），job_output/job_kill + 完成通知。
- 用于 **standard / code 全功能预设**：文件/网页/技能/计划/目标/子代理/工作流都要与沙箱、审批、jobs 一致地协同。

### 7.2 persistent shell（`dsh-tool-bash-persistent`）——"真终端"编码 Agent

- 每个 agent 一个 **PTY 持久 shell**（`ctx.terminals` seam）：cwd、导出的变量、激活的 venv、函数、后台任务**跨调用存活**——像真人坐在终端前。
- 参数只有 `command`；**无 per-call 沙箱升级**（沙箱是 spawn 时包裹整个 shell 会话，模式切换在会话打开期间被拒绝）；也无独立 system prompt 段（"the deployment owns persona"——minimal 的完整 persona 就是它）。
- 能跑**交互式/需要 tty 的程序**（REPL、编辑器、ssh、top），fresh pipe 模式（isatty=false）跑不了。
- 后台 = shell 原生 `&` + jobs/kill；状态污染风险靠 300s 超时重置 / `exit` 丢弃 / 取消重置兜底。
- 用于 **minimal 预设**：固定提示词、无运行时上下文、无压缩的"双工具极简编码 Agent"。

### 7.3 分叉的根因（三选一都指向同一结论）

| 维度 | fresh（bash/pwsh） | persistent（bash over PTY） |
|---|---|---|
| 状态模型 | 无状态、幂等 | 有状态、像真终端 |
| 沙箱 | per-call deny-only + 审批升级 | 会话级包裹，无 per-command 判定 |
| 后台 | ctx.jobs 注册表（opaque job id） | shell job control（`&`/jobs/kill） |
| 能力缝 | `ctx.shell`（执行器可插拔） | `ctx.terminals`（PTY 后端可插拔） |
| 适用预设 | standard / code | minimal |
| 设计者意图 | 平台通用、安全可控、可组合 | 最小依赖、真终端体验 |

一句话：**fresh 是"平台的安全默认执行通道"，persistent 是"最小 agent 的真终端"**——两者是 `ctx.shell` 与 `ctx.terminals` 两条独立能力缝的消费端，因沙箱兼容性与状态模型互斥（persistent 无法 per-call 判定沙箱），所以一个 agent 只会挂其中一种（工具名都叫 `bash`，预设二选一）。

## 5. 对 AgentChat 的启示（可选采纳项）

> 落地状态（2026-08-20，docs/tool-design-roadmap.md §1）：1/2（事件广播版）/3/6 已实施；4 未做（log 文件方案够用）；5 远期。

1. **✅ job id 替代裸 PID**（低成本高收益，已实施）：bash background 返回不透明 id（`bash-N`），管理面统一按 id 走；job.kill 收窄为仅已登记 id，消除"任意 PID 可杀"的歧义。
2. **✅ 完成通知**（中等成本，多 Agent 平台收益大，已实施事件广播版）：job settle → `job.done` 事件 → WS 广播；"注入 owner 下一步"（DSH notice 版）列为后续可选。
3. **✅ 每 owner 并发上限 + 会话隔离**（已实施）：登记表按 owner agent_id 分桶 + `MAX_CONCURRENT_JOBS_PER_OWNER=8`，多 Agent 互不可见。
4. **增量输出读**（未做）：DSH 的"上次读之后 delta + spill 路径"比"读文件尾 N 行"对长任务更省 token；AgentChat 的 log 文件方案简单够用，属可选优化（roadmap §1.4）。
5. **执行器层分离（ctx.shell）**（远期）：AgentChat 的 bash 直接 spawn + 自建沙箱翻译，把执行抽成服务是更大的重构，非必要不做（roadmap §3.1）。
6. **✅ system prompt 协议注入**（已实施）：buildSystemPrompt 在含 job/bash 工具时注入"记住 id、不忙轮询、及时 kill"指引段。
