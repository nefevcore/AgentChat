# 第 6 步：定时与自主行动

> 目标：让 Agent 按时自主工作，理解 timer / 归档 / 备份三大自主机制。

## 6.1 timer 工具与五种调度

对 Agent 说：`每天早上 9 点帮我查询新闻热点`。Agent 调用：

```
timer(action="set", mode="workday", time="09:00", hint="查询新闻热点", target="user")
```

| mode | 参数 | 说明 |
|------|------|------|
| delay | `delay: "1h"` | 固定间隔 |
| random | `delayMin` / `delayMax` | 随机间隔 |
| time | `time: "08:00"` | 每天定点 |
| workday | `time` | 工作日（chinese-lunar；可用 `agent.timer.holidays/makeupWorkdays` 覆盖） |
| holiday | `time` | 节假日 |

其他 action：`list`（查看）、`disable`（禁用）。条目持久化到 `timer-state.json` / `timer-archive.jsonl`。

## 6.2 全局 timer（原 chime 泛化）

`workspace/default/config.json`：

```json
"timer": {
  "enabled": true,
  "tasks": [
    { "time": "08:00", "hint": "现在是 {{time}}，早安报时。请简要汇报今日计划与待办。" },
    { "time": "23:30", "targets": ["*"], "hint": "__archive_all__", "builtin": true },
    { "time": "04:00", "targets": ["*"], "hint": "__backup_all__", "builtin": true }
  ]
}
```

- 普通 task：到点向目标 Agent 发 `trigger`（fire-and-forget，受理即返回；`maxSteps` 非空时繁忙会话默认 `next-run`）；
- `__archive_all__`：批量触发全量会话归档；
- `__backup_all__`：调用 `@agentchat/backup` 做数据备份。

## 6.3 归档：先整理后归档

1. 1v1 会话超过 `maxContextTokens × archiveTokenRatio` 触发归档；
2. 系统写 `.archive_pending`，`void router.trigger(...)` 触发参与方「整理 run」（meta `archive-review`；fire-and-forget，带 meta 时繁忙会话后台等空闲后新开 run）：Agent 在完整上下文里重写 `memory.md` / `SUMMARY.md`；
3. 各方完成 → 归档重建；超时（10 分钟）由 watcher 强制归档；
4. 空闲超过 `idleArchiveSec`（默认 14400s）也会触发归档。

完整机制见 [archive-orchestration.md](../archive-orchestration.md) 与 [plugins/archive.md](../plugins/archive.md)。

## 6.4 记忆（agent-memory）

- `runStart` 的 `agent-memory.load-memory` 把 `memory.md` 注入系统提示词；
- 注入预算 `agent.memory.memoryBudgetTokens`（默认 10000）超限时截断注入（文件不删）；
- 文件硬上限 `memoryMaxTokens`（默认 15000）超限时剪除中间过时内容并落盘；
- 记忆更新统一在归档整理 run 完成（重写而非追加）。

## 6.5 备份（@agentchat/backup）

- `createBackup()`：压缩打包 workspace 到 `backups/`（weekly 轮转 + 到期检查）；
- 由全局 timer 的 `__backup_all__` 触发，或 HTTP `/api/backup` 手动执行。

## 6.6 练习

1. 给 Agent 设一个 `delay=2m` 的任务，观察 2 分钟后的 trigger 与新消息。
2. 看 `workspace/default/` 下的 `timer-state.json` 与 `timer-archive.jsonl`。
3. 把 `agent.session.idleArchiveSec` 临时调小，观察空闲归档标记与整理 run。

## 下一步

[第 7 步：开发第一个工具插件](07-writing-a-tool-plugin.md)
