# @agentchat/shell
> 包路径 `src/shell/shell` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
命令执行工具包（bash + job），领域独立。bash 在工作区沙箱内执行 shell 命令，支持超时、后台执行、stdin、流式输出与跨平台 shell 探测；job 配套管理后台任务（list/kill/logs）。后台任务登记表为通用 `ctx.jobs` 服务（@agentchat/jobs）：bash/subagent 统一登记（kind 前缀 id）、owner 分桶、并发上限、完成通知。迁移自 `tools/files.ts`（bash 部分），配置命名空间 `tool.bash`。

## 目录（关键源文件 + 一句话）
| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | cordis 插件行：`registerShellTools(ctx.tools, name, ctx.jobs)`（inject: tools/jobs） |
| `register.ts` | `registerShellTools`：以 owner 注册 `makeShellTools(config, jobs)` 工厂 |
| `tools.ts` | `makeBashTool` + `bashCommandViolation` + 后台登记（ctx.jobs）+ 临时日志清理 + `BASH_CONFIG_SCHEMA` |
| `job.ts` | `makeJobTool`（list/kill/logs，消费 ctx.jobs）+ `killProcessTree`/`isProcessAlive`/`tailLogFile` |
| `index.ts` | re-export tools + job + register |

## 插件行
| 模块文件 | 插件 name | inject | 注册内容 |
| --- | --- | --- | --- |
| `src/shell/shell/src/plugin.ts` | `agentchat-shell-tools` | `['tools','jobs']` | `tools.registerFactory(owner, config => makeShellTools(config, ctx.jobs))` → **bash + job** |

## 提供的能力
| API | 说明 |
| --- | --- |
| `registerShellTools(tools, owner, jobs?)` | 注册 shell 工具工厂（jobs 服务可缺省，缺省时 background 不登记） |
| `makeBashTool(config, jobs?)` | bash 工具 |
| `makeJobTool(config, jobs?)` | job 工具（list/kill/logs，按 owner 隔离） |
| `makeShellTools(config, jobs?)` | `[makeBashTool(config, jobs), makeJobTool(config, jobs)]` |
| `bashCommandViolation(command, allowedRoots?)` | 命令级启发式沙箱检查，返回违规说明或 null |
| `killProcessTree(pid)` | 跨平台杀进程树（Windows taskkill /F /T；Unix 负 PID SIGKILL） |
| `isProcessAlive(pid)` | kill(pid,0) 存活探测 |
| `tailLogFile(file, lines)` | 日志文件尾部 N 行读取 |
| `BASH_CONFIG_SCHEMA` | `tool.bash` 配置表单字段（见下） |

> 后台任务登记表本体在 `@agentchat/jobs`（ctx.jobs）：`start({kind,label,ownerAgentId,meta,run})` → id（`<kind>-N`）、owner 分桶、每 owner 上限 8、settle first-wins、`onJobDone` 完成监听（boot 接线 → `job.done` 事件）。bash 是 kind=bash 的 producer；subagent 是 kind=subagent 的 producer（job 工具对两者通用）。

## 工具参考
| 工具 | name | label | requires | ns | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- | --- |
| 命令 | `bash` | 执行命令 | `['base']` | `tool.bash` | `command`（必填）、`description`、`workdir`、`timeout`、`background`（stdin 已移出 schema，execute 层兼容） | 见下 |
| 任务 | `job` | 任务管理 | `['base']` | — | `action`（list/kill/logs，必填）、`job_id`、`limit`（logs 尾部行数，1-500，默认 50；旧名 lines 兼容） | list：本 Agent 全部任务（bash-N/subagent-N；id/kind/命令/日志/状态/存活/日志大小）；kill：按 job_id 终止（仅已登记 id；bash 杀进程树、subagent abort 控制器；已完成返回 already-finished）；logs：按 job_id 读输出（bash 日志尾部 N 行，subagent 最终结果） |

### bash 参数与行为
- `command`：要执行的 shell 命令；Windows PowerShell 系会前置 `[Console]::OutputEncoding = UTF8`。
- `description`：一句话用途，供任务列表展示（extractLabel 优先取它，缺省显示 command）。
- `workdir`（旧名 cwd，execute 层兼容）：相对沙箱工作目录解析（默认沙箱工作目录）；经 `resolveSafePath` 校验，越界返回 error JSON。
- `timeout`：毫秒，默认 `tool.bash.defaultTimeout`（30000），上限 `maxTimeout`（120000）；`Math.min(timeout, maxTimeout)`。
- `background=true`：detached spawn（仅非 Windows `detached:true`）+ `stdio:['ignore',fd,fd]` 写入临时日志，立即返回 `{job_id, pid, log_file}`；日志文件 `agentchat-bash-<hex>.log` 在 `os.tmpdir()`，任务登记进 ctx.jobs（kind=bash，id=`bash-N`；进程 close 回写终态并触发完成通知）。
- `stdin`：schema 已移除；execute 层仍兼容读取（前台模式写入子进程 stdin 后 `end()`）。
- 前台返回结构化 JSON：`status: success/error/timeout` + `data{command,workdir,output,exit_code,success,truncated,total_bytes,timed_out}`；输出经 `stream.onChunk` 流式推送。
- 参数表中**无 `env` 字段**；环境变量由宿主进程继承。

## 关键契约 / API
### 跨平台 shell 探测（getShellConfig）
| 平台 | shell | args |
| --- | --- | --- |
| 非 Windows | `/bin/bash` | `['-c']` |
| Windows（优先） | `pwsh`（PowerShell 7） | `['-NoProfile','-Command']` |
| Windows（回退） | `powershell.exe` | `['-NoProfile','-Command']` |
| Windows（最后） | `cmd` | `['/d','/s','/c']` |

Windows 探测用 `spawnSync(shell, args, {timeout:3000, stdio:'ignore'})` 且结果缓存。

### 命令级沙箱（bashCommandViolation）
启发式静态检查，按 `; && || | 换行` 分段：
1. 盘符绝对路径（`C:\`/`C:/`，盘符前邻须为行首或非字母数字字符——URL scheme（`https://` 等）的冒号不误判）；2. Unix 绝对路径（`/etc`）；3. `cd ..`/绝对路径越界；4. 独立 `../` 引用。目标 `path.resolve` 后须落在 `[workspaceRoot, ...security.allowedPaths]` 内，否则拦截。这是纵深防御，不覆盖全部 shell 语法。
here-string（`@'…'@`/`@"…"@`）与 bash heredoc（`<<'EOF'`）载荷视为**数据**（要写入文件的内容），剥离后不参与路径扫描——载荷里的正则字面量/路径样例文本不误判；载荷之后同一行的管道/命令（`| Set-Content …`）与写盘目标照常受检。剥离匹配失败时保留原文扫描（只会多拦不会漏拦）。已知残留误报：引号内直接执行的代码（`node -e "…正则…"`）。

### 进程树杀与临时日志
- 超时或 `signal` abort：`killProcessTree(pid)`——Windows `taskkill /F /T /PID`；Unix `process.kill(-pid, 'SIGKILL')`。job 工具按已登记 id 复用同一实现（任意 PID 的进程操作请走 bash 内 Stop-Process，工具层不提供该通道）。
- `cleanupOldBashLogs()`：前台执行前清理 `tmpdir()` 中前缀 `agentchat-bash-` 且创建超过 1 小时的日志。
- 后台任务登记表在 `ctx.jobs`（@agentchat/jobs，进程内内存态、重启即失）：bash/subagent 统一登记；owner（agent_id）分桶，job 工具只能操作本 Agent 的任务；每 owner 活跃上限 8（超限报错提示先 kill）；settle first-wins，完成触发 `onJobDone` → boot 接线 `job.done` 事件 → WS 广播。

### 输出上限（以源码为准）
`BASH_CONFIG_SCHEMA` 声明 `outputMaxLen`（默认 50000 字符）与 `maxBuffer`（默认 10485760 字节），但当前 `makeBashTool` 前台实现**未强制截断**：输出全量累积，返回 `truncated:false` 与 `total_bytes`；`maxBuffer` 未用于 spawn。文档按现状如实记录。

## 配置
`BASH_CONFIG_SCHEMA`（命名空间 `tool.bash`）：
| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `defaultTimeout` | 30000 | 默认超时（毫秒） |
| `maxTimeout` | 120000 | 最大超时（毫秒） |
| `outputMaxLen` | 50000 | 输出最大保留字符（当前未强制执行） |
| `maxBuffer` | 10485760 | 缓冲区上限字节（当前未强制执行） |

## 与其他插件的关系
- 依赖（package.json）：`@agentchat/agent-loop`、`@agentchat/toolkit`、`@agentchat/tools`、`@agentchat/cordis`、`@agentchat/agent-config`。
- 使用方：boot/host 装配层把 `agentchat-shell-tools` 加入 presets/目录；agent-prompt 会根据工具集提示 shell 能力。

## 测试
package.json 仅 `typecheck`（tsc --noEmit）；测试文件 `tests/tools.test.ts`（bashCommandViolation：URL scheme 不误判为盘符回归 + 越界路径拦截），随根 vitest（`pnpm test`）运行。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
