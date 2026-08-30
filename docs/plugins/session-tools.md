# @agentchat/session-tools
> 包路径 `src/session-tools/session-tools` · 版本 0.1.0 · 文档对应 2026-08-20 调整后形态

## 概述
会话历史工具包。提供 grep_history（关键词检索聊天历史）与 read_history（分页翻阅聊天历史），两者都支持查自身与任何 Agent 的 1:1 对话（agent_id）或任意群聊（group_id）。领域独立，可脱离 AgentChat 复用。

> 2026-08-20 调整：query_history 拆分为 grep_history + read_history（检索与翻阅语义分离，参数各自收敛）；inspect_session 移除（使用数据：近 7 天 46 次主要是"看会话尾部"→ read_history 覆盖；诊断场景 bash+grep 承担）。

## 目录（关键源文件 + 一句话）
| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | cordis 插件行：`registerSessionTools(ctx.tools, name)` |
| `register.ts` | `registerSessionTools`：以 owner 注册 `makeSessionTools` 工厂 |
| `tools.ts` | grep_history / read_history 实现 + JSONL 读取/格式化/会话定位 |
| `index.ts` | re-export tools + register |

## 插件行
| 模块文件 | 插件 name | inject | 注册内容 |
| --- | --- | --- | --- |
| `src/session-tools/src/plugin.ts` | `agentchat-session-tools` | `['tools']` | `tools.registerFactory(owner, (config, services) => makeSessionTools(config, services))` → **grep_history + read_history** |

## 提供的能力
| API | 说明 |
| --- | --- |
| `registerSessionTools(tools, owner)` | 注册会话历史工具工厂（owner = cordis 插件 name，presets 过滤依据） |
| `makeSessionTools(config, services)` | `[makeGrepHistoryTool(config), makeReadHistoryTool(config)]` |

## 工具参考
| 工具 | name | label | requires | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- |
| 检索历史 | `grep_history` | 检索聊天历史 | `['base']` | `pattern`（必填）；`agent_id`/`group_id` 二选一 | 全量检索含关键词的消息（不区分大小写），返回全部命中（上限 50 条提示收窄）；用于回忆约定/结论 |
| 翻阅历史 | `read_history` | 读取聊天历史 | `['base']` | `agent_id`/`group_id` 二选一；`limit`（默认 20，最大 100）；`offset`（默认 0 从最新往前） | 按时间正序返回最近一页；total 剔除工具行；提示剩余更早消息与下一次 offset |

## 关键契约 / API
```ts
registerSessionTools(tools: ToolsService, owner: string): void
makeGrepHistoryTool(config: AgentConfig): Tool
makeReadHistoryTool(config: AgentConfig): Tool
makeSessionTools(config, services): Tool[]   // [grep_history, read_history]
function readJsonl(filePath: string): Record<string, any>[]   // 忽略空行与损坏行
function formatMessage(msg, selfId): string  // 单行摘要（工具调用只显示名称，内容截断 200 字符）
```
- 会话定位：`resolveTarget`——agent_id → `chatSessionFile(selfId, counterpart)`（本 Agent 视角 `<from>__<to>`）；group_id → `groupSessionFile(gid)`；二选一冲突/缺失运行时报错。
- `read_history` 算法：倒序 → slice(offset, offset+limit) → 恢复正序输出。
- `grep_history` 全量过滤（不受分页影响），群聊分支按 timestamp 排序后检索。

## 配置
| 项 | 默认 | 说明 |
| --- | --- | --- |
| read_history.limit | `config.messageQueryDefaultLimit` 缺省 20，上限 100 | 单页条数 |
| read_history.offset | 0 | 从最新一条开始 |

## 与其他插件的关系
package.json 依赖：`@agentchat/agent-loop`、`@agentchat/toolkit`、`@agentchat/tools`、`@agentchat/cordis`、`@agentchat/agent-config`。

使用方：boot/host 装配层把 `agentchat-session-tools` 加入 presets；工具仅依赖 config（agent_id 身份），ToolContext 注入预留。

## 行为细节
- `formatMessage` 摘要规则：`role==='tool'` → `[调用工具: <name>]`；有 `tool_calls` → 工具名列表 + 内容预览 100 字符；其他内容截断 200 字符；`agent_id==='user'` 显示「用户」、`agent_id===selfId` 显示「自己」。
- 1:1 会话文件为方向敏感 dialogId（`<from>__<to>`）：查任何 Agent 都读本 Agent 视角的文件（lo/hi 字典序目录）。
- 无记录时返回「没有聊天记录」而非报错。

## 测试
`@agentchat/tools/tests/tool-adjust-20260820.test.ts` 覆盖 grep_history 检索命中/无命中、read_history 分页、二选一冲突与缺失报错（隔离会话目录）。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [工具 Schema](../tool-schemas.md)
