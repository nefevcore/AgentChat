# @agentchat/agent-session
> 包路径 `src/agent-session/agent-session` · 版本 0.1.0 · 文档对应 v0.6.3（2026-08-16）

## 概述

Agent 会话扩展：以 runStart/stepEnd/toolExecutionStart/runEnd 钩子提供历史加载、
**step 级增量落盘**、空闲重置、归档触发与用量记录。历史/会话/归档的存储路径基于
`workspaceRoot()`（`AGENTCHAT_WORKSPACE` 可覆盖），职责为 L3 会话持久化。

## 目录（关键源文件 + 一句话）

| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | cordis 插件行：`agentchat-agent-session`，inject `hooks` |
| `register.ts` | 注册 1 个 runStart + step/tool 自动持久化钩子 + 3 个显式 runEnd 钩子 |
| `run.ts` | load-history 钩子工厂、`recoverHistory` 调和、idle-reset/archive-session、`SESSION_CONFIG_SCHEMA` |
| `session.ts` | `loadHistory/loadGroupHistory/saveSession/logRunUsage` 与持久化格式 |
| `writer.ts` | `SessionLogWriter`：per-dialog 增量写队列 + flush barrier + step/tool/runEnd checkpoint 钩子工厂 |
| `index.ts` | 统一 re-export |

## 插件行

| 模块文件 | 插件 name | inject | 注册内容 |
| --- | --- | --- | --- |
| `plugin.ts` | `agentchat-agent-session` | `['hooks']` | runStart `agent-session.load-history` + automatic `agent-session.recover-history`；automatic stepEnd `agent-session.step-persist`、toolExecutionStart `agent-session.tool-persist`、runEnd `agent-session.save-session`；显式 runEnd `idle-reset`、`archive-session`、`log-usage` |

## 提供的能力（钩子）

| 钩子 | 阶段 | 行为 |
| --- | --- | --- |
| `agent-session.load-history` | runStart | 1v1：装配层已有 history 则复用，否则 `loadHistory(dialogId)`；群聊：`loadGroupHistory` 注入 |
| `agent-session.recover-history` | runStart（automatic） | 在显式 runStart 钩子后调用宿主注入的 `recoverHistory` 对账（ask_questions 崩溃恢复） |
| `agent-session.tool-persist` | toolExecutionStart（automatic） | 先持久化 assistant(tool_calls) 并 flush；失败返回 `allow=false` fail-closed |
| `agent-session.step-persist` | stepEnd（automatic） | 追加本步新增消息并 flush（每步 checkpoint） |
| `agent-session.save-session` | runEnd（automatic） | 持久化剩余 delta + 最终 flush；整理 run（`meta[META_ARCHIVE_REVIEW]`）不落盘 |
| `agent-session.idle-reset` | runEnd | 重置空闲归档计时器；整理 run不重置 |
| `agent-session.archive-session` | runEnd | 调用 L5 注入的 `archiveSession(ctx, result)`；群聊由 save-session 周归档承载 |
| `agent-session.log-usage` | runEnd | 控制台打印执行状态 + Token 用量，写入 `<ws>/usage/token_<date>.jsonl` |

## 存储约定

| 会话类型 | 路径 | 说明 |
| --- | --- | --- |
| 1v1 | `<ws>/sessions/chat~<lo>~<hi>/messages.jsonl` | lo/hi 排序共享；消息 `agent_id = selfId` |
| 群聊本体 | `<ws>/sessions/group~<gid>/messages.jsonl` | 由 L4 GroupService 监听 `group.message.received` 落盘，只含真实回话（无思考/工具） |
| 群聊周归档 | `<ws>/sessions/group~<gid>/archive/<aid>/history_<YYYY>-<WW>.jsonl` | 增量 writer 对群聊 run 写全量（含思考/工具），仅复盘分析 |

- 持久化角色转换：`toPersistedRole` 将 `user`/`assistant` → `agent`；`user` 且带事件来源（`source.form ∈ hint/notice/resume` 或 `kind ∈ system/timer/group/subagent/continue/restart/archive`）→ `event`；`system/tool/error` 原样保留。
- 读取归一化：`loadHistory` 把持久化 `event` 与旧 `trigger` 归一化为 `user + source`（旧 trigger 保留 `legacyRole` 标记、解包 `<trigger>` 正文）；`trigger/event + tool_call_id` 历史损坏兜底为 `tool`。
- 消息 ID：`genMessageId()`（`msg-<ts>-<rand>`）；旧数据无 ID 时用 `stableMessageIdOf` 补稳定 ID。
- 整理 run：`saveSession` 对 `META_ARCHIVE_REVIEW` 直接 return，不污染会话文件。

## 关键契约 / API

| API | 签名 | 说明 |
| --- | --- | --- |
| `loadHistory` | `(dialogId: string) => LLMRequestMessage[]` | 1v1 读 messages.jsonl 并归一化 event/旧 trigger；群聊返回 `[]` |
| `loadGroupHistory` | `(groupId, viewer, opts?) => LLMRequestMessage[]` | 非当前视角 agent 消息套 `<msg from name group>`；合并相邻对方发言；按 token 尾部截断 |
| `saveSession` | `(ctx: CurrentContext, result: RunResult) => Promise<void>` | 兼容保留的 runEnd 全量写入（新装配经 `makeSaveSessionHook` 使用增量 writer） |
| `SessionLogWriter` | `enqueue / flush / flushAll / dispose` | per-dialog 增量写队列；flush 为 quiescence barrier；失败批次保留 |
| `logRunUsage` | `(ctx, result) => Promise<void>` | 用量统计与 usage JSONL |
| `toPersistedRole` | `(role, source?) => 'agent'\|'system'\|'tool'\|'event'\|'error'` | user/assistant → agent；user+事件来源 → event |
| `SESSION_CONFIG_SCHEMA` | `ConfigField[]` | `agent.session` 命名空间 UI 配置声明 |

## 配置（`agent.session`，`SESSION_CONFIG_SCHEMA`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxContextTokens` | `1000000` | 上下文 Token 上限 |
| `keepRecentRatio` | `0.03` | 截断时保留最近消息比例 |
| `summaryPreviewLen` | `4000` | 摘要预览字符数 |
| `idleArchiveSec` | `14400` | 空闲多少秒后自动归档 |
| `messageQueryDefaultLimit` | `20` | 历史消息查询默认返回条数 |
| `archiveTokenRatio` | `0.5` | 超出上下文预算比例时触发归档 |

另有群聊加载上限：`groupLoadLimitTokens` 缺省 `DEFAULT_GROUP_LOAD_LIMIT_TOKENS = 30000`。

## 与其他插件的关系

- 依赖（package.json）：`@agentchat/agent-loop`、`@agentchat/agent-prompt`（run.ts 保留
  build-system-prompt 迁移注释与 import）、`@agentchat/agents`（`isGroupDialog/groupIdOfDialog`）、
  `@agentchat/hooks`、`@agentchat/toolkit`、`@agentchat/tools`（`sessionFileOf/groupHistoryFile`）、
  `@agentchat/util`、`@agentchat/agent-config`。
- 使用方：boot/host 将 `loadHistory` 作为 `AgentAssembly.loadHistory` 实现；L4 负责群聊
  本体落盘与 ArchiveService；`agent-memory` 的整理 run meta 与本包 `META_ARCHIVE_REVIEW` 配合。

## 测试

`package.json`：仅 `typecheck`（无 test script）。
测试文件：`tests/group-history-load.test.ts`、`tests/load-history-dangling.test.ts`、`tests/group-hint-dedup.test.ts`、`tests/writer.test.ts`（step checkpoint）。

## 相关文档

固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
