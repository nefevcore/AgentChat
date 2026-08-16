# @agentchat/shell
> 包路径 `src/shell/shell` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
命令执行工具包（bash），领域独立。在工作区沙箱内执行 shell 命令，支持超时、后台执行、stdin、流式输出与跨平台 shell 探测。迁移自 `tools/files.ts`（bash 部分），配置命名空间 `tool.bash`。

## 目录（关键源文件 + 一句话）
| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | cordis 插件行：`registerShellTools(ctx.tools, name)` |
| `register.ts` | `registerShellTools`：以 owner 注册 `makeShellTools` 工厂 |
| `tools.ts` | `makeBashTool` + `bashCommandViolation` + 进程树杀/临时日志清理 + `BASH_CONFIG_SCHEMA` |
| `index.ts` | re-export tools + register |

## 插件行
| 模块文件 | 插件 name | inject | 注册内容 |
| --- | --- | --- | --- |
| `src/shell/shell/src/plugin.ts` | `agentchat-shell-tools` | `['tools']` | `tools.registerFactory(owner, config => makeShellTools(config))` → **bash** |

## 提供的能力
| API | 说明 |
| --- | --- |
| `registerShellTools(tools, owner)` | 注册 shell 工具工厂 |
| `makeBashTool(config)` | bash 工具 |
| `makeShellTools(config)` | `[makeBashTool(config)]` |
| `bashCommandViolation(command, allowedRoots?)` | 命令级启发式沙箱检查，返回违规说明或 null |
| `BASH_CONFIG_SCHEMA` | `tool.bash` 配置表单字段（见下） |

## 工具参考
| 工具 | name | label | requires | ns | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- | --- |
| 命令 | `bash` | 执行命令 | `['agent']` | `tool.bash` | `command`（必填）、`timeout`、`cwd`、`background`、`stdin` | 见下 |

### bash 参数与行为
- `command`：要执行的 shell 命令；Windows PowerShell 系会前置 `[Console]::OutputEncoding = UTF8`。
- `cwd`：相对 workspaceRoot 解析（默认 workspaceRoot）；经 `resolveSafePath` 校验，越界返回 error JSON。
- `timeout`：毫秒，默认 `tool.bash.defaultTimeout`（30000），上限 `maxTimeout`（120000）；`Math.min(timeout, maxTimeout)`。
- `background=true`：detached spawn（仅非 Windows `detached:true`）+ `stdio:['ignore',fd,fd]` 写入临时日志，立即返回 `{pid, log_file}`；日志文件 `agentchat-bash-<hex>.log` 在 `os.tmpdir()`。
- `stdin`：可选字符串，写入子进程 stdin 后 `end()`（前台模式）。
- 前台返回结构化 JSON：`status: success/error/timeout` + `data{command,cwd,output,exit_code,success,truncated,total_bytes,timed_out}`；输出经 `stream.onChunk` 流式推送。
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
1. 盘符绝对路径（`C:\`/`C:/`）；2. Unix 绝对路径（`/etc`）；3. `cd ..`/绝对路径越界；4. 独立 `../` 引用。目标 `path.resolve` 后须落在 `[workspaceRoot, ...security.allowedPaths]` 内，否则拦截。这是纵深防御，不覆盖全部 shell 语法。

### 进程树杀与临时日志
- 超时或 `signal` abort：`killProcessTree(pid)`——Windows `taskkill /F /T /PID`；Unix `process.kill(-pid, 'SIGKILL')`。
- `cleanupOldBashLogs()`：前台执行前清理 `tmpdir()` 中前缀 `agentchat-bash-` 且创建超过 1 小时的日志。

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
package.json 仅 `typecheck`（tsc --noEmit），无 test 脚本与本包测试文件。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
