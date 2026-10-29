# 孤儿 shell 子进程事故报告（2026-10-13）

> 报告日期：2026-10-13　|　登记：cr-381　|　状态：**建议 1/2/3/4 已随 cr-382 落地**（2026-10-13；桌面壳无条件树杀、后端台账 + exit 补刀、boot 期指纹对账、kill 未确认告警；建议 5 Job Object 与建议 6 台账落盘暂缓）。建议 3 曾随 ac-app 退役漏迁（2026-10-27 审计发现），**已回迁 apps/host/orphans.ts 并在 bootHost 锁后接线（cr-800，2026-10-29）**
>
> 一句话：`ac-shell-tools` 前台执行体的子进程**没有与宿主进程建立任何 OS 级生命周期绑定，也没有跨重启可对账的 pid 台账**——宿主一死，正在跑的 `pwsh` 就变成永久孤儿，重启 AgentChat 也不会被回收，直到有人在任务管理器里发现它占满一个核。

## 1. 现象

| 视角 | 观察 |
|---|---|
| 用户 | 机器上「有几个后台疯狂占 CPU」，AgentChat 重启后依旧存在，无法从 AgentChat 侧定位 |
| 整机 | 常驻 CPU 43%–50%（20 逻辑核 ≈ 8–9 个核满载），空闲率仅 ~55% |
| 进程面 | 8 个 `pwsh.exe` 各占 ~92%–102% 单核；累计烧掉 **约 215 万 CPU 秒 ≈ 25 核·天**（最老的一个从 10-04 就在跑） |
| 归因面 | 8 个进程的父进程**全部已不存在**（纯孤儿）；AgentChat 的会话/任务/日志里没有任何活引用 |

用户直觉「是 AgentChat 启动的」**证据成立**（判据见 §2.3），但 AgentChat 自身没有任何一条链路能回答「我启动过它、它还在跑」。

## 2. 现场证据

### 2.1 进程明细（杀前快照）

| PID | 父 PID | 启动时间 | 累计 CPU(s) | 命令摘要（会话态已截断） |
|---|---|---|---|---|
| 22784 | 23456（亡） | 10-04 00:06:43 | 658,550 | `Get-ChildItem -Recurse src -Include *.vue -File \| Where-Object { $_.FullName -notmatch 'node_modules' }` |
| 34824 | 11508（亡） | 10-06 16:48:02 | 431,374 | `$p = @("$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe", …)` 路径探测 |
| 3492 | 32652（亡） | 10-07 23:09:06 | 368,008 | 前缀形态不同（见 §2.3 例外项） |
| 40440 | 8260（亡） | 10-11 09:34:27 | 147,364 | `Get-ChildItem -Recurse -Include *.vue,*.ts -Path src \| …` |
| 43452 | 8260（亡） | 10-11 10:22:17 | 144,595 | `Get-ChildItem -Path src -Recurse -Include *.vue,*.ts -File \| …` |
| 17368 | 8260（亡） | 10-11 11:44:02 | 139,848 | `Get-ChildItem -Recurse -Include *.ts,*.vue,*.json,*.yml -Path …\src \| …` |
| 38000 | 8260（亡） | 10-11 12:10:23 | 138,294 | `Select-String -Path src\ac-client-ui-settings\client\types.ts -Pattern 'from' \| …` |
| 37168 | 6528（亡） | 10-11 15:47:19 | 126,789 | `Get-ChildItem -Recurse -File src/webui/src, src/webui/*.ts …` |

合计 2,154,822 CPU·s ≈ 24.9 核·天。

**形状特征**：清一色「`-Recurse` 递归整棵 `src`，再在管道下游 `Where-Object { $_.FullName -notmatch 'node_modules' }` 过滤」——过滤发生在**递归之后**，`node_modules` 的几万个条目照爬不误。这类命令在本仓库是天然的准死循环，CPU 满载且**长时间零输出**。

### 2.2 CPU 计量证据（修复前后）

```
杀前：\Processor(_Total)\% Processor Time = 47.9, 47.9, 45.5
      % Privileged Time = 41.06   % User Time = 2.34   % Idle = 55.38
杀后：\Processor(_Total)\% Processor Time = 5.5, 9.1, 3.6, 3.7, 6   (avg 5.6%)
      % Privileged Time = 6.59    % User Time = 2.07   % Idle = 91.18
```

特权态占 41% 而用户态仅 2% —— 这 8 个 `pwsh` 的 CPU 几乎全记在内核态（进程/IO 管理的系统调用 + 本机安全代理 `SangforPromoteService` 的过滤驱动开销），也是本机 CPU 曲线「看着忙、却找不到是谁」的直接原因。

### 2.3 归属判据：命令行前缀是单源指纹

`src/ac-shell-tools/src/shells.ts:44`（`preparePwsh`）是这条前缀的**唯一产地**：

```ts
return { commandToRun: `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${commandToRun}`, translatedCommand };
```

配合 `src/ac-shell-tools/src/shells.ts:67-70` 的 `pwshSpec()`，AgentChat 发出的每条 shell 命令都长这样：

```
pwsh -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; <用户命令>"
```

8 个进程里 **7 个**逐字命中该形态（`pwsh -NoProfile -Command` + `[System.Text.Encoding]::UTF8`，无 `-NoLogo -NonInteractive`）。

> **例外项**：PID 3492 用的是 `C:\Users\…\WindowsApps\pwsh.exe -NoLogo -NoProfile -NonInteractive -Command "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); …"`——前缀不同（`UTF8Encoding::new($false)`），来自**另一套 harness**（非 AgentChat）。它同样跑成了孤儿，说明这是**同类设计缺陷的共性**，AgentChat 不是唯一患者；本文只对 AgentChat 负责，该进程一并已清。

## 3. 根因

四条结构性原因叠加，缺一条都不会出现「跨重启存活的不可追踪孤儿」。

### A. 子进程与宿主之间没有 OS 级生命周期绑定（根因）

- 前台 spawn（`src/ac-shell-tools/src/executor.ts:245-254`）在 Windows 上 `detached: false`，**没有 Job Object**。
- 全仓检索 `kill-on-close / JobObject / CreateJobObject / JOB_OBJECT` → **零命中**。Windows 上父进程退出**不会**连带杀子进程，唯一的 OS 级保障（作业对象 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）没有被使用。
- 因此「宿主死亡 → 子进程必然存活」不是偶发，而是**默认行为**。

### B. 桌面壳的兜底 reap 在优雅退出路径上被跳过

`desktop/main.mjs:184-197`：

```js
/** 杀后端进程树：先礼后兵（3s 后 taskkill /F /T——shell 工具孙进程不孤儿） */
function killBackendTree() {
  if (!backend || backend.exitCode !== null) return;   // ← 后端已退 → 直接返回
  const pid = backend.pid;
  backend.kill();
  setTimeout(() => {
    if (!backend || backend.exitCode !== null) return;  // ← 3s 内优雅退出 → 再返回，taskkill 永不执行
    … taskkill /F /T /PID …
  }, 3000).unref();
}
```

注释写明了设计意图（「shell 工具孙进程不孤儿」），但实现是「先 SIGTERM 等 3 秒，若已退就不再补刀」。**后端正常退出恰恰是最常见的路径**——于是 `taskkill /T` 一次都不跑，孙进程原地变孤儿。这是「重启后依旧存在」的直接机制：重启 = 旧后端优雅退出 = 跳过 reap。

### C. 前台 kill 路径会留活口，而且留得很安静

`src/ac-shell-tools/src/executor.ts:386-405`（`killWithConfirm`）：

- 树杀只有 `taskkill /F /T /PID`（`src/ac-shell-tools/src/process.ts:30-51`）一条路；
- 4 秒内确认不到死亡（`KILL_CONFIRM_MS`）就**只销毁本端读写管道并收束 Promise**，不再重试、不升级、**不留任何日志**。

于是「kill 失败」的用户可见后果 = 工具照常返回超时结果，而进程活着继续烧 CPU、且因为管道被销毁**连输出都不会再产生**。本次 5 个父进程已亡的孤儿都属此类形态：进程活着、无输出、无引用。

### D. 没有跨重启可对账的 pid 台账，前台命令更是零留痕

- `src/ac-jobs/src/service.ts:36`：`private store = new Map<string, JobRecord>()`——**纯内存**。重启后 job 清单连同 `meta.pid` 一起蒸发，没有任何启动期对账。
- 只有 `background`/`handoff` 路径才会 `deps.jobs.start({ meta: { pid, command, cwd, logFile } })`（`executor.ts:177-195`、`357-375`）——**登记 + 落日志文件**。前台命令什么都没有：没有登记、没有 logFile（`bashTempLogPath()` 只在后台/handoff 调用）。
- 结果：前台命令一旦成孤儿，**输出无落点、pid 无记录、job list 看不到**。这就是「无法追踪」的全部原因——不是查得不够，是根本没记。
- 对照：会话侧早有成熟范式——`ac-session` 的孤儿 run 恢复（`src/ac-session/src/index.ts:1167`、`journal-recover` 用例）会把崩溃窗口的记录收口。**但恢复面只收口「记录」，没有任何一行代码回收「进程」**。缺的正是进程面的对等机制。

### E. 放大因素：命令形态 + 无输出

`-Recurse` 后过滤的写法让「短查询」退化成准死循环；而它与宿主死亡叠加时，进程既不产出输出、也不报错，只能靠任务管理器的 CPU 列发现。

## 4. 回答用户的两个问题

**为什么无法追踪？** 因为前台命令不登记任何持久 pid、不落日志文件（§3D），job 台账又是内存态；宿主死后，会话侧的孤儿 run 恢复只补记录不碰进程（§3D 尾）。四个面同时缺位，事后回溯没有任何抓手。

**为什么重启还在？** 因为 Windows 上父进程退出不会杀子进程（§3A）；而唯一尝试兜底的桌面壳 reap 在最常见的优雅退出路径上被提前 return 跳过（§3B）。重启看到的「新 AgentChat」与旧孤儿之间没有任何继承关系，也就没有任何一方会去清它。

## 5. 影响

- 单机 8–9 个核被隐性占用（约 45% 整机 CPU），持续 10 天，累计约 25 核·天；伴随全机响应变慢、风扇与功耗上升。
- 本机装有端点安全代理（`SangforPromoteService`），孤儿的高频系统调用全部走内核态过滤，进一步抬高单进程开销。
- **可观测性受损**：表现为「无主的内核态 CPU」，从 AgentChat 侧完全不可见——从 DSH 沙箱内看更是只剩 17 个可见进程且全空闲，一度只能靠 `Get-Counter` 反推。
- 同类风险面不止此处：`ac-harness-core/src/gateway.ts`（agent CLI 子进程）、`ac-cdp-core/src/launch.ts`（浏览器）用的是同一套「按需 `taskkill /T`、无生命周期绑定」的模式，同样会在宿主崩溃时漏。

## 6. 修复建议（按性价比排序，未实施）

| # | 建议 | 性质 | 代价 |
|---|---|---|---|
| 1 | `desktop/main.mjs:185` 改为**无条件**先 `taskkill /F /T /PID <backend>`（win32），再等进程退出——删掉两处 `exitCode !== null` 早退。`/T` 本身就同时覆盖后端与其孙进程，不需要「先礼后兵」 | **最小闭环**，直接断 §3B | 1 处改动，桌面壳需重启生效 |
| 2 | 后端建「子进程台账 + 退出钩子」：每次 spawn 记 `{pid, startedAt, command, ownerAgentId}`（内存 Map 即可），在 `process.on('exit')` 里用 `spawnSync('taskkill', ['/F','/T','/PID', pid])` **同步**补刀（`exit` 钩子只允许同步工作，`spawnSync` 是唯一可用形态，与 `ac-app/src/boot.ts:75` 释放数据根锁同一姿势） | 断 §3A 的常用分支（优雅退出/正常重启） | 小；需注意 `exit` 里只做同步短操作 |
| 3 | **启动期对账清扫**（针对性安全网，§4 的「可追踪」由此补上）：boot 时枚举进程，按指纹 `pwsh* -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;` 命中，且①父 pid 已不存在或不属于本实例 ②进程启动时间早于本次 boot，则判为上一世孤儿 → 记 warn（pid + 命令行摘要）后 `taskkill /T /F`。**必须**保留 ② 的启动时间护栏，否则会误杀并行运行的另一实例的活子进程 | 安全网（即使 1/2 漏了也能自愈，且首次让孤儿可见） | 小-中；建议配 `AGENTCHAT_ORPHAN_REAP=off` 之类开关与干跑模式 |
| 4 | `killWithConfirm` 宽限过后若 pid 仍活：**升级为显式告警**（`console.warn` + 事件/日志行，带 pid/命令），并登记进「泄漏清单」周期重试；不再静默销毁管道了事 | 断 §3C 的「安静留活口」 | 小 |
| 5 | 终局方案：把后端（或其 shell 子进程）放进 **Windows Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`**，由 OS 保证宿主消失即全树回收（含崩溃/硬杀路径）。Node 侧无原生 API：需要原生模块，或在桌面壳用 `Add-Type` P/Invoke 起一个 launcher 再挂作业对象 | 根因终局（覆盖 1/2/3 覆盖不到的一切路径） | 大；引入原生依赖或 launcher 层，建议等 1–3 稳定后再评估 |
| 6 | （可选，治「可见性」）`ac-jobs` 台账落盘（id/pid/startedAt/command/owner），重启后 `job list` 能列出「上一世的 stale 任务」并提供一键清理 | 可观测性 | 中；与建议 3 的 pid 台账可合并成一份 |

**建议 1 + 2 + 3 一起做**才算闭环：1 覆盖「桌面壳退出」、2 覆盖「后端自身退出」、3 覆盖「前两者都没救到」并给出跨重启的兜底与留痕。

> **落地记录（cr-382，2026-10-13）**：建议 1 → `desktop/main.mjs` killBackendTree 无条件树杀 + reap 日志；建议 2/4 → `ac-shell-tools/src/executor.ts` 子进程台账 + `process.on('exit')` 同步补刀 + kill 未确认泄漏告警；建议 3 → `ac-app/src/orphans.ts`（boot.ts / bootstrap.ts 两形态锁后接线，`AGENTCHAT_ORPHAN_REAP=off` 关闭）；工具面收窄 → pwsh 工具描述劝阻 `-Recurse` 管道过滤。回归测试：`ac-app/tests/orphans.test.ts`、`ac-shell-tools/tests/shell-ledger.integration.test.ts`、`desktop/tests/desktop-kill-tree.test.ts`（cr-481 归位壳域）。

> ✅ 裁决（cr-800，2026-10-29）：确认漏迁非有意废除——宿主入口已两轨合一（cr-703，dev 与 supervisor worker 均为 apps/host/boot.ts），孤儿对账回迁 apps/host/orphans.ts（实现原样），并在 bootHost 邮局锁后即扫单点接线；executor.ts 失效注释同步指向新落点。建议 1/2/4 落点复核仍在位。

同时建议**顺手收窄工具面**：在 `ac-system-prompt` / 工具描述里明确「枚举文件优先用 `glob`/`grep` 工具，不要在 shell 里 `Get-ChildItem -Recurse` 后管道过滤」，从源头减少准死循环命令（本次 8 个孤儿有 6 个是这类命令）。

## 7. 验证方式（修复后如何证明断了根）

1. **宿主死亡连带回收**：起后端 → 前台跑一个长任务（如 `Get-ChildItem -Recurse C:\Windows -Include *.dll`）→ 在工具调用进行中直接 `taskkill /F` 掉后端/桌面壳 → 断言对应 `pwsh` 在 5 秒内消失。修复前：存活（本次事故形态）。
2. **优雅重启路径**：同上，但走正常退出/重启（`desktop/main.mjs:751/882/1038` 三条路径，尤其不要在 3 秒宽限内手动干预）→ 断言孙进程同样被回收（这一条专打 §3B）。
3. **跨重启对账**：人为留一个孤儿（干跑模式造一个假 pid 条目）→ 重启后端 → 断言 boot 日志出现孤儿清扫记录，且 pid 确实消失；再断言**并行运行的第二实例的活子进程不被误杀**（护栏回归）。
4. **kill 未确认告警**：注入一个 `taskkill` 失败场景 → 断言出现 warn + 泄漏清单登记，而非静默收束。
5. **回归门**：按仓库验证阶梯，`npx vitest run src/ac-shell-tools src/ac-jobs`（定向集成）+ `pnpm typecheck && pnpm test:unit && pnpm check:deps`；动了子进程链路按 ladder 加 `pnpm test:integration`。

## 8. 未决 / 不确定项

- **发起会话不可回溯**：8 个孤儿的原始会话与 run id 已无从查证（前台命令零留痕，见 §3D）。若需要精确归因，得靠建议 4/6 落地后的「泄漏清单」。
- **§3B 是推测还是实证**：`killBackendTree` 的早退是**代码可读事实**；本次 4 个孤儿同属一个已亡父进程 8260（10-11 09:34→12:10 两小时半内累积 4 条），与该机制一致，但**没有当时的退出日志**可确证是哪一次退出跳过了 reap。建议 1 落地后，建议在同一处补一行日志（记录 reap 是否执行、清理了几个 pid），把这条推测变成可观测事实。
- **第 8 个孤儿（PID 3492）不属 AgentChat 指纹**，来自另一套 harness；本文不覆盖其修复面，但它的存在说明这类缺陷在同生态里是共性问题。

---

### 附录 A：测量/复现命令（Windows）

```powershell
# 整机 CPU 与内核/用户态拆分
Get-Counter -Counter '\Processor(_Total)\% Processor Time','\Processor(_Total)\% Privileged Time','\Processor(_Total)\% User Time','\Processor(_Total)\% Idle Time' -SampleInterval 2 -MaxSamples 3

# 逐进程 CPU%（含被隐藏进程；注意 #N 后缀为同名实例消歧）
Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
  Where-Object { $_.Name -notin @('_Total','Idle') -and $_.PercentProcessorTime -gt 0 } |
  Sort-Object PercentProcessorTime -Descending | Select-Object -First 20 Name,IDProcess,PercentProcessorTime

# 孤儿判定：命令行指纹 + 父进程是否存活
Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" | ForEach-Object {
  $pp = Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue
  [pscustomobject]@{ PID=$_.ProcessId; PPID=$_.ParentProcessId; ParentAlive=[bool]$pp; CmdLine=$_.CommandLine }
} | Format-List
```

### 附录 B：本次处置动作（已完成，仅止血）

- 8 个孤儿 `pwsh.exe` 全部 `Stop-Process -Force` 结束：22784 / 34824 / 3492 / 40440 / 43452 / 17368 / 38000 / 37168。
- 未触碰：VS Code 集成终端 PowerShell（PID 31792）、微信附带的两个长驻 `powershell.exe`（累计 CPU 仅数百秒，非负载源）。
- 整机 CPU 46% → 5.6%，空闲率 91%。
- **代码零改动**：根因按 §6 待修。
