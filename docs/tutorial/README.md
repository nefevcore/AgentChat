# AgentChat Step-by-Step 学习资料

> 版本：v0.6.3（2026-08-16）。面向第一次接触 AgentChat 的开发者：从装环境、建 Agent，到写插件、看懂依赖图。
> 每步 10–30 分钟，按顺序完成即可。

| 步骤 | 主题 | 产出 |
|------|------|------|
| [01](01-environment-and-first-run.md) | 环境与首次启动 | 跑起 WebUI，完成 LLM 配置 |
| [02](02-creating-your-first-agent.md) | 创建第一个 Agent | 拥有一个可对话的 Agent |
| [03](03-agent-config-in-depth.md) | Agent 配置详解 | 理解 tags/presets/tools/hooks |
| [04](04-tools-and-hooks.md) | 工具与钩子 | 看懂工具清单与执行链路 |
| [05](05-multi-agent-communication.md) | 多 Agent 通信 | send_agent 协作与群聊 |
| [06](06-timer-and-autonomy.md) | 定时与自主行动 | 定时任务、归档、备份 |
| [07](07-writing-a-tool-plugin.md) | 开发第一个工具插件 | 一个可热加载的工具插件 |
| [08](08-dynamic-plugins-and-library.md) | 动态插件与插件库 | 发布/审批/启用闭环 |
| [09](09-webui-and-events.md) | WebUI 与事件流 | 看懂流式事件与 UI 扩展 |
| [10](10-architecture-and-dependency-graph.md) | 架构与依赖图 | 读懂插件化架构全貌 |

## 学习路径建议

- **用户路径**：01 → 02 → 05 → 06
- **配置管理员路径**：01 → 03 → 04
- **插件开发者路径**：01 → 02 → 03 → 07 → 08 → 10
- **架构学习路径**：10 → [../architecture.md](../architecture.md) → [../plugins/README.md](../plugins/README.md)

## 贯穿全程的关键事实

1. 启动命令 `pnpm dev`；WebUI 默认 `http://localhost:3830`。
2. 工作区 `workspace/default/`：`agents/`（Agent 定义）、`sessions/`（会话 JSONL）、`groups/`、`files/`（Agent 工作文件与共享指引）、`plugins/`（插件库）、`usage/`（Token 统计）、`config.json`（全局配置）。
3. 所有能力都是插件行：`cordis.yml` 挂行即启用、摘行即停用。
4. 工具按 `requires` 能力标签注入；`base` 是隐式基础层（人人都有），`dev/conductor/admin` 需显式打标签。
5. 改 Agent 配置用 `reload(scope=global)`；改插件源码用 `system_restart`（`register_plugin` 加载的开发插件会自动 watch 热重载，是例外）。

## 遇到问题

- 启动失败：看终端日志；`pnpm typecheck` / `pnpm test` 检查基线。
- 工具不出现：`list_tools` 看当前启用；检查 tags、requires、presets。
- 找不到服务：读 [plugin-system.md](../plugin-system.md) 的 ctx 服务契约表。
- 归档/定时等机制细节：读对应插件文档（`docs/plugins/*`）。
