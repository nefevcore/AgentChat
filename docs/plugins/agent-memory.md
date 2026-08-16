# @agentchat/agent-memory
> 包路径 `src/agent-memory/agent-memory` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述

Agent 长期记忆扩展：runStart 钩子 `agent-memory.load-memory` 读取对话对专属的
`memory.md`，按 token 预算拼接到 `ctx.systemPrompt` 末尾。记忆按对话对方向敏感
隔离，更新统一由 [归档整理] 整理 run 完成。

## 目录（关键源文件 + 一句话）

| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | cordis 插件行：`agentchat-agent-memory`，inject `hooks` |
| `register.ts` | 注册 runStart 钩子 `agent-memory.load-memory` |
| `memory.ts` | `loadMemory/truncateMemory/pruneMemory` + 钩子工厂 + `MEMORY_CONFIG_SCHEMA` |
| `index.ts` | 统一 re-export |

## 插件行

| 模块文件 | 插件 name | inject | 注册内容 |
| --- | --- | --- | --- |
| `plugin.ts` | `agentchat-agent-memory` | `['hooks']` | runStart 钩子 `agent-memory.load-memory`（owner = 插件 name） |

## 提供的能力

### 钩子

| 钩子 | 阶段 | 行为 |
| --- | --- | --- |
| `agent-memory.load-memory` | runStart | 读 `<ws>/files/<selfId>/memory/<counterpart>.memory.md`，非空则 `ctx.systemPrompt += "\n\n" + memory` |

- 路径：`memoryFileOf(dialogId, selfId)`；1v1 counterpart=对方 id，群聊=`group~<gid>`。
- 注入方式：直接拼接在 system prompt 末尾，**无 `<memory>` 标签、无去重**。
- `loadMemoryToMessages`：兼容辅助，把记忆追加到 messages 数组 system 消息末尾。

### 预算与截断（以 `memory.ts` 为准）

| 参数 | 默认 | 语义 |
| --- | --- | --- |
| `budgetTokens`（`memoryBudgetTokens`） | `10000` | 注入预算：超预算 `truncateMemory` 保留**头部**（人设/偏好/方向）并追加“完整内容见文件、用 read 读取”提示；**不修改文件**；0=不限制 |
| `maxTokens`（`memoryMaxTokens`） | `15000` | 文件硬上限：超限 `pruneMemory` **物理剪除中间**过时内容（头部约 1/3 + 尾部最近内容）并落盘（遗忘）；0=不限制 |

- `truncateMemory` 与 `pruneMemory` 区别：前者只影响本次注入，后者真正改写文件。
- 文件读取失败/不存在/为空 → 返回 `null`，钩子不注入。

### 记忆更新语义

- 记忆更新由 [归档整理] 整理 run 统一完成：**重写 memory.md**（合并/压缩/删除过时记忆）。
- 2026-08-08 起不再维护 `.memory_update_needed` / `.memory_review_needed` 审查标记。

### 路径与对象键

| 项 | 规则 |
| --- | --- |
| 记忆文件 | `<ws>/files/<selfId>/memory/<counterpart>.memory.md`（`memoryFileOf` 实现） |
| 1v1 counterpart | `counterpartOfDialog(dialogId, selfId)`：对方 Agent id |
| 群聊 counterpart | `group~<gid>`（每群一份，与 1v1 记忆隔离） |
| 读取失败 | 返回 `null`，钩子静默跳过（不阻塞 run） |

### 执行位置

`agent-memory.load-memory` 作为 runStart 钩子注册，位于 `agent-prompt.build-system-prompt`
之后：先构建基础 system prompt，再追加记忆文本。整理 run等带 `meta` 的执行同样会加载记忆。

## 关键契约 / API

| API | 签名 | 说明 |
| --- | --- | --- |
| `loadMemory` | `(dialogId, selfId, options?: MemoryLoadOptions) => string \| null` | 读取 + 硬上限裁剪 + 预算截断 |
| `truncateMemory` | `(content, budgetTokens, dialogId, selfId) => string` | 保留头部 + 截断提示 |
| `pruneMemory` | `(content, maxTokens) => string` | 剪除中间，保留头部与尾部并落盘 |
| `makeLoadMemoryHook` | `(config: AgentConfig) => RunStartHook` | 工厂烘焙 `agent.memory` 配置 |
| `MEMORY_CONFIG_SCHEMA` | `ConfigField[]` | UI 配置声明 |

## 配置（`agent.memory`，`MEMORY_CONFIG_SCHEMA`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `memoryBudgetTokens` | `10000` | 注入 system prompt 的记忆 token 预算（0=不截断） |
| `memoryMaxTokens` | `15000` | memory.md 文件硬上限 token（0=不限制） |

## 与其他插件的关系

- 依赖（package.json）：`@agentchat/agent-loop`、`@agentchat/hooks`、
  `@agentchat/toolkit`、`@agentchat/tools`（`NS_AGENT_MEMORY`/`memoryFileOf`）、
  `@agentchat/util`、`@agentchat/agent-config`。
- 使用方：作为独立 runStart 钩子与 `agent-prompt.build-system-prompt` 解耦（先构建
  system prompt，再追加 memory）；整理 run 由 agent-session 的 archive 编排触发。

## 测试

`package.json`：仅 `typecheck`（无 test script）。包内未发现独立测试文件。

## 相关文档

固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
