# @agentchat/timer
> 包路径 `src/svc/timer` · 版本 0.1.0 · 文档对应 v0.6.3（2026-08-16）

## 概述
定时任务服务与工具。服务行 `agentchat-timer-service` 构造并持有 `TimerManager`（5 种调度 + 节假日判断 + chime 兼容），工具行 `agentchat-timer-tools` 注册单一 `timer` 工具（action 分发 set/list/disable）。迁移自旧 `services/timer + tools/timer`。`chinese-lunar.d.ts` 仅类型声明。

## 目录（关键源文件 + 一句话）
| 文件 | 说明 |
| --- | --- |
| plugin.ts | 工具插件行：注册 timer 工具 |
| service-plugin.ts | 服务插件行：构造 TimerManager，写 ctx.timerManager 与 core.services.timer |
| register.ts | `registerTimerTool(tools, owner)` 工厂注册入口 |
| tool.ts | timer 工具（action=set/list/disable） |
| timer.ts | TimerManager：调度/节假日/持久化/补偿/归档 |
| service.ts | `TimerService`（ctx.timerManager，避开 cordis-timer 的 `timer` 服务名） |
| chinese-lunar.d.ts | chinese-lunar 类型声明（仅声明） |

## 插件行（工具行与服务行）
| 模块文件 | 插件 name | inject | 提供/注册内容 |
| --- | --- | --- | --- |
| plugin.ts | agentchat-timer-tools | tools | 注册 timer 工具（经 registerTimerTool） |
| service-plugin.ts | agentchat-timer-service | bootstrap + archive | 构造 TimerManager → `ctx.timerManager` 与 `core.services.timer`；停止时 `stopAll()` |

两行共用同一 TimerManager：工具运行时经 `services.timer` 取服务行构造的实例。

## 提供的能力
### ctx 服务表
| 服务 | 挂载点 | 说明 |
| --- | --- | --- |
| TimerService（name=`timerManager`） | `ctx.timerManager.manager` | TimerManager 实例 |
| ToolContext.timer | `core.services.timer` | 工具运行时读取同一 TimerManager |

### 工具表
| 工具 | label | requires | 要点 |
| --- | --- | --- | --- |
| timer | 定时任务 | base | action=set/list/disable，5 种 mode |

### TimerManager 调度模式（5 种）
| mode | 关键字段 | 语义 |
| --- | --- | --- |
| delay | delay（默认 `1h`） | 固定间隔重复 |
| random | delayMin（默认 `30s`）/ delayMax（默认 `5m`） | 随机间隔重复 |
| time | time（默认 `08:00`） | 每天定时（支持 `HH:mm`、`YYYY-MM-DD HH:mm`、`Sun 12:00`/`周日 12:00`） |
| workday | time | 仅工作日触发（`!isHoliday()`） |
| holiday | time | 仅节假日触发（`isHoliday()`） |

## 工具参考
| 工具 | name | label | requires | action 枚举 | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- | --- |
| timer | timer | 定时任务 | base | set / list / disable | action（必填）；set：id、replace、mode（delay/random/time/workday/holiday）、delay、delayMin、delayMax、time、repeatCount（0=永久）、hint、target（逗号分隔，默认 user）、source、maxSteps；disable：id | set 添加/修改（`id` 已存在则更新）；`replace` 为新任务创建后删除旧 id；disable 仅置 `enabled=false` 不删除，可用 set 重新启用；list 列出本 Agent 全部任务 |

## 关键契约 / API
```ts
export class TimerManager {
  constructor(options: TimerOptions)          // workspaceDir/agentsDir/timezone/holidays/makeupWorkdays/globalTimer/archiveAll/backupAll
  setRouter(router: AgentRouter): void
  reloadAll(): void                            // stopAll → loadState → 扫描 agentsDir → compensate → startAll → startHeartbeat
  getEntries(agentId: string): TimerEntry[]
  saveEntries(agentId: string, entries: TimerEntry[]): void
  stopAll(): void
}
export interface TimerEntry { id; enabled; mode; time?; delay?; delayMin?; delayMax?; repeatCount?; hint; target?; source?; maxSteps? }
export function parseInterval(input: string): number | null  // 0s/5m/1h/2h30m/d
```
- 节假日判断：调休工作日优先 → 配置 `agent.timer.holidays` → 农历（chinese-lunar：春节 1/28-1/30 与 1/1-1/7、端午 5/3-5/5、中秋 8/14-8/16）→ 阳历固定（元旦 1/1、清明 4/4-4/5、五一 5/1-5/3、国庆 10/1-10/3）→ 周末。
- 全局定时：`globalConfig.timer ?? globalConfig.chime`；`timer.tasks` 优先，无则用 `timer.times`；注入为 `__global__` Agent，id=`chime-<time>`，target `*` 时触发所有 Agent。
- 特殊 hint（纯机制，不走 LLM）：`__archive_all__`（archiveAll 批量归档会话）、`__backup_all__`（createBackup 数据备份）。
- 触发路径：到点/补偿触发经 `void router.trigger(...)` fire-and-forget 投递（不等待 run 结束）；`entry.maxSteps` 非空属 run 级选项 → 会话繁忙时默认 `next-run`（等待空闲后新开 run），否则注入为 steer。
- hint 模板占位符：`{{now}}`、`{{time}}`、`{{date}}`、`{time}`。
- 持久化：运行态 `<workspace>/timer-state.json`（每条目 lastTriggeredAt/executedCount/startedAt/totalDelayMs + `_heartbeat` 30s 心跳）；停机 >5 分钟启动时补偿错过的触发（最多补 3 次/有限次按剩余次数）。
- 完成归档：限定次数任务完成后从 config.json 移除，追加到 `<agentDir>/timer-archive.jsonl`（含 `status:'completed'`、`completedAt`、`executedCount`）；过期一次性日历任务自动归档。

## 配置
- 全局：`timezone`（默认 `Asia/Shanghai`）；`timer`（或旧键 `chime`）：`enabled`、`times[]`、`tasks[{time,hint,targets}]`、`defaultHint`。
- 命名空间 `agent.timer`：`holidays[]`（额外节假日 `YYYY-MM-DD`）、`makeupWorkdays[]`（调休工作日）。
- Agent 级：`<agentsDir>/<id>/config.json` 的 `timer.entries[]`（timer 工具 set/disable 写入）。

## 与其他插件的关系
package.json 依赖：`@agentchat/agent-loop`、`@agentchat/archive`、`@agentchat/backup`、`@agentchat/router`、`@agentchat/tools`、`@agentchat/util`、`@agentchat/cordis`、`@agentchat/toolkit`、`@agentchat/agent-config`，外部 `chinese-lunar`。

使用方：boot 经 `ctx.plugin()` 挂载两行；`__archive_all__` 依赖 archive 插件行，`__backup_all__` 依赖 `@agentchat/backup` 的 `createBackup`；服务名 `timerManager` 避免与 `@agentchat/cordis-timer` 的 `timer` 服务冲突。

## 测试
package.json：`typecheck`（tsc --noEmit）、`test`（vitest run）。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
