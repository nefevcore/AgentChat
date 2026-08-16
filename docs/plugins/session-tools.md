# @agentchat/session-tools
> 包路径 `src/session-tools/session-tools` · 版本 0.1.0 · 文档对应 v0.6.3（2026-08-16）

## 概述
会话工具包。提供 query_history（查询 1:1 对话 / 群聊 JSONL 历史）、continue_turn（无新消息自我续推）、inspect_session（诊断会话 messages.jsonl）。领域独立，可脱离 AgentChat 复用。

## 目录（关键源文件 + 一句话）
| 文件 | 说明 |
| --- | --- |
| plugin.ts | cordis 插件行，注册会话工具 |
| register.ts | `registerSessionTools(tools, owner)` 工厂注册入口 |
| tools.ts | query_history / continue_turn / inspect_session 实现 + JSONL 读取/格式化 |

## 插件行
| 模块文件 | 插件 name | inject | 提供/注册内容 |
| --- | --- | --- | --- |
| plugin.ts | agentchat-session-tools | tools | 经 `registerSessionTools` 注册 3 个工具（query_history/continue_turn/inspect_session） |

## 提供的能力
### 工具表
| 工具 | label | requires | 要点 |
| --- | --- | --- | --- |
| query_history | 查询聊天历史 | base | 按 dialog/agent 查 JSONL，先关键词过滤再分页，total 去工具行 |
| continue_turn | 继续推理 | base | 无消息续推：`void router.trigger` 自我继续（fire-and-forget） |
| inspect_session | 检查会话 | dev | 诊断会话文件：统计/过滤/重复检测/尾部消息 |

## 工具参考
| 工具 | name | label | requires | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- |
| query_history | query_history | 查询聊天历史 | base | agent_id 与 group_id 二选一；keyword；limit（默认 20，最大 100）；offset（默认 0） | 1:1 读 `chatSessionFile(selfId, counterpart)`（`<from>__<to>`）；群聊读 `groupSessionFile(groupId)`（`sessions/group~<gid>/messages.jsonl`）；先 keyword 过滤全量再倒序分页；total 剔除 `role==='tool'`；倒序取最新一页后恢复正序输出 |
| continue_turn | continue_turn | 继续推理 | base | hint（可选引导）、counterpart（默认 user） | 调 `void router.trigger(from, {target: counterpart, source: 'continue:'+from, maxSteps: 0, hint?})`（不等待 run 结果）；`maxSteps:0` 属 run 级选项 → 会话繁忙时默认 `next-run`（等当前 run 空闲后新开 run），空闲则直接新开 run；与 `chat.continue` 同 trigger 路径 |
| inspect_session | inspect_session | 检查会话 | dev | agentA+agentB 或 path；limit（默认 10，最大 50）；filterRole；filterAgent；dupCheck（默认 true）；includeArchive（默认 false） | 读 JSONL（跳过损坏行）；统计 byRole/byAgent；重复检测 = 完全重复 `{role,content,agent_id}`；`includeArchive` 合并同级 archive 目录下 *.jsonl；尾部内容截断 120 字符 |

## 关键契约 / API
```ts
registerSessionTools(tools: ToolsService, owner: string): void
// 工厂：makeSessionTools(config, services) → [query_history, inspect_session, continue_turn]
function readJsonl(filePath: string): Record<string, any>[]   // 忽略空行与损坏行
function formatMessage(msg: Record<string, any>, selfId: string): string
```
- `formatMessage` 摘要规则：
  - `role==='tool'` → `[调用工具: <name>]`（不展示工具结果内容）。
  - 有 `tool_calls` → `[调用工具: <names>]` + 内容预览（截断 100 字符）。
  - 其他 → 内容截断 200 字符；`agent_id==='user'` 显示「用户」，`agent_id===selfId` 显示「自己」，否则显示 agent_id。
  - 带 `label` 时追加 `[label]`。
- `query_history` 算法：无 agent_id 且无 group_id 报错 → 读文件 → keyword 先过滤全量 → total（排除 tool）→ reverse → slice(offset, offset+limit) → reverse 恢复正序 → 汇总输出，提示剩余更早消息与下一次 offset。
- 存储为方向敏感 dialogId：`<from>__<to>`；查询历史使用本 Agent 视角文件。
- `inspect_session` 文件不存在时返回 `{status:'ok', total:0, message:'文件不存在或为空'}`。

## 配置
本包无自有命名空间。相关默认值与位置：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| query_history.limit | `config.messageQueryDefaultLimit` 缺省 20，上限 100 | 单页条数 |
| query_history.offset | 0 | 从最新一条开始 |
| inspect_session.limit | 10，上限 50 | 尾部返回条数 |
| inspect_session.dupCheck | true | 完全重复 content 检测 |
| inspect_session.includeArchive | false | 是否合并 archive/*.jsonl |
| 会话文件 | `chatSessionFile(from,to)` / `groupSessionFile(gid)` | 位于 workspace 的 sessions/ 下 |
| 归档目录 | `messages.jsonl` 同级 `archive/` | includeArchive 合并 |

## 与其他插件的关系
package.json 依赖：`@agentchat/agent-loop`、`@agentchat/toolkit`、`@agentchat/tools`、`@agentchat/cordis`、`@agentchat/agent-config`。

使用方：工具经 `ctx.tools` 注册；运行期依赖 ToolContext 注入的 `router`（AgentRouter）与 config.agent_id；`continue_turn` 与 `chat.continue` 同走 `trigger` 路径（工具自身 fire-and-forget；WS `chat.continue` 额外用 `whenSessionIdle` 等 run 收尾）；`query_history` 的 `extractLabel` 经 registry 解析 Agent 显示名。

## 行为细节
- `query_history` 的 group 与 1:1 分支共用同一分页算法：keyword 过滤全量 → total（排除 tool）→ reverse → slice → reverse 恢复正序；无结果时返回「没有聊天记录」并提示关键词。
- 群聊文件为回话记录（无思考/工具），1:1 文件为平铺消息（按条数分页，旧实现按 user 链）。
- `continue_turn` 触发时 `maxSteps: 0`（不限制），`source` 为 `continue:<from>`，hint 会作为 trigger 消息注入；因带 run 级选项，placement 默认 `next-run` 而非 steer。
- `inspect_session` 返回 JSON（非纯文本）：`{path, total, byRole, byAgent, filtered, dupCount, tail[]}`；`dupCount` 在 `dupCheck=false` 时省略。
- `readJsonl` 对空行与损坏 JSON 行静默跳过，保证诊断工具在文件损坏时仍可用。
- `query_history` 的 limit 上限 100 由 `Math.min(..., 100)` 强制；`inspect_session` 的 limit 上限 50。

## 测试
package.json 仅 `typecheck`（tsc --noEmit），无 test 脚本。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
