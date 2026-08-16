# @agentchat/restart
> 包路径 `src/restart/restart` · 版本 0.1.0 · 文档对应 v0.6.3（2026-08-16）

## 概述
系统重启工具包。提供 system_restart（Supervisor 模式优雅重启链路）。领域独立，可脱离 AgentChat 复用。
（2026-08-16 自 `@agentchat/app-tools` 拆分：system_restart 与 ask_questions 各自独立插件行，可分别启停。）

## 目录（关键源文件 + 一句话）
| 文件 | 说明 |
| --- | --- |
| plugin.ts | cordis 插件行，注册系统重启工具 |
| register.ts | `registerRestartTools(tools, owner)` 工厂注册入口 |
| tools.ts | system_restart 实现 |

## 插件行
| 模块文件 | 插件 name | inject | 提供/注册内容 |
| --- | --- | --- | --- |
| plugin.ts | agentchat-restart-tools | tools | 经 `registerRestartTools` 注册 system_restart |

## 提供的能力
### 工具表
| 工具 | label | requires | 要点 |
| --- | --- | --- | --- |
| system_restart | 重启后端 | admin | `ToolInterrupt restart-requested` → supervisor/优雅重启链路 |

## 工具参考
| 工具 | name | label | requires | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- |
| system_restart | system_restart | 重启后端 | admin | reason（可选，缺省 `tool-system-restart`） | 非 Supervisor 模式（`isSupervised()` 为 false）拒绝执行；Supervisor 模式下抛 `ToolInterrupt({type:'restart-requested', reason})`，由 loop 收尾后调用 `requestRestart`（L5 装配），进程以退出码 42 退出并由父进程拉起（WebSocket 约 2s 自动重连） |

## 关键契约 / API
```ts
registerRestartTools(tools: ToolsService, owner: string): void
// 工厂：makeRestartTools(config) → [makeSystemRestartTool(config)]
```
- `system_restart` 不直接重启进程，而是抛 `ToolInterrupt`，由 agent-loop 收尾后调用 L5 装配的 `requestRestart(reason)`；该链路要求 Supervisor 模式（`AGENTCHAT_SUPERVISED=1`），进程退出码 42。

## 配置
本包无自有配置命名空间。相关项：

| 项 | 值/默认 | 说明 |
| --- | --- | --- |
| Supervisor 模式 | `AGENTCHAT_SUPERVISED=1` | 经 `isSupervised()` 判断；false 时 system_restart 拒绝 |
| system_restart.reason | `tool-system-restart` | 记入日志 |

## 与其他插件的关系
package.json 依赖：`@agentchat/agent-loop`、`@agentchat/toolkit`、`@agentchat/tools`、`@agentchat/util`、`@agentchat/cordis`、`@agentchat/agent-config`。

使用方：工具经 `ctx.tools` 注册；`system_restart` 依赖 agent-loop 的 `ToolInterrupt` 与 L5 装配的 `requestRestart`。

## 行为细节
- `system_restart` 的完整链路：工具抛 `ToolInterrupt({type:'restart-requested', reason})` → agent-loop 收尾 → L5 装配的 `requestRestart(reason)` → Supervisor 模式进程以退出码 42 退出 → 父进程拉起 → WebSocket 约 2s 自动重连。会中断所有运行中的任务。
- 非 Supervisor 模式（`isSupervised()` 为 false）时 `system_restart` 直接拒绝并返回提示，不抛中断。
- `system_restart` 的 `reason` 只接受 string 类型，其他类型会被忽略并回落为默认值。

## 备注
- `system_restart` 与 dev 包 `reload` 的分工：改配置用 reload（热重载配置），改 `src/` 下源码用 system_restart（进程级重启）。
- 工具 owner 为 `agentchat-restart-tools`（presets 过滤依据），可与 ask_questions 的 owner 独立启停。

## 测试
package.json 仅 `typecheck`（tsc --noEmit），无 test 脚本。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
