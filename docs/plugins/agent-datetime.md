# @agentchat/agent-datetime
> 包路径 `src/agent-datetime/agent-datetime` · 版本 0.1.0 · 文档对应 v0.7.2（2026-08-18）

## 概述

Agent 日期注入扩展。自 `@agentchat/agent-prompt` 的对话信息块拆出：
把每轮变化的时间写进 system prompt 会破坏前缀 token 缓存，写进会话消息
则污染落盘历史。本插件采用折中形态——**runStart 一次性把仅日期的行追加
到 system prompt 尾部**：

- **仅日期**（`[当前时间] YYYY-MM-DD 周X`，无时分）：一天内 system prompt
  稳定，前缀缓存跨轮次持续命中；日期粒度的缓存重建每天至多一次。
- **不触碰消息流**：currentMessage 与落盘历史保持干净，不向会话消息注入
  任何时间信息。
- **清单钩子（无 automatic）**：仅当 Agent 配置在 `hooks.runStart` 显式列出
  `agent-datetime.datetime` 时才启用——默认所有 Agent 均不注入。
- **独立会话（single~）硬性跳过**：会话提示词全静态，保持最大 KV cache
  （预设 Agent 均不启用本钩子，双保险）。

## 目录（关键源文件 + 一句话）

| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | cordis 插件行：`agentchat-agent-datetime`，inject `hooks` |
| `register.ts` | 向 `HooksService` 注册 `agent-datetime.datetime`（runStart，清单钩子） |
| `datetime-hook.ts` | 钩子工厂：读 `agent.datetime.enabled`，singles/子 Agent 跳过，追加日期行 |
| `datetime.ts` | 纯函数：`datetimeLine`（仅日期行生成） |
| `index.ts` | 统一 re-export |

## 插件行

| 模块文件 | 插件 name | inject | 注册内容 |
| --- | --- | --- | --- |
| `plugin.ts` | `agentchat-agent-datetime` | `['hooks']` | runStart 钩子 `agent-datetime.datetime`（owner = 插件 name） |

## 启用方式（按 Agent 显式开启）

在某 Agent 的 `config.json` 中列出钩子（推荐排在 `agent-prompt.build-system-prompt`
之后，日期行落在装配结果尾部）：

```json
{
  "hooks": {
    "runStart": [
      "agent-persona.persona",
      "agent-prompt.build-system-prompt",
      "agent-datetime.datetime"
    ]
  }
}
```

若该 Agent 声明了 `presets` 数组，还需包含插件行 `"agentchat-agent-datetime"`
（owner preset 过滤）。内置预设（standard / dsh-minimal）均**不**启用——
独立会话保持全静态提示词。

## 注入语义

- **每 run 一次**（runStart）：run 内多 step 复用同一 system prompt，KV cache 稳定。
- 追加位置：`ctx.systemPrompt` 尾部（`\n\n` 分隔；既有装配原样保留在前）。
- 跳过：独立会话（`single~`，最大 KV cache）、无会话键（子 Agent）。
- 1v1（`chat~`）与群组（`group~`）注入（群消息 hint 里的 router 时间戳仍按消息存在，互不冲突）。

## 配置

- 命名空间：`agent.datetime`（常量 `NS_AGENT_DATETIME`，来自 `@agentchat/toolkit`）。
- 字段：`enabled`（默认 `true`；`false` 时钩子工厂返回 null，不入钩子数组）。

```json
{ "agent.datetime": { "enabled": false } }
```

## 与其他插件的关系

- 自 `@agentchat/agent-prompt` 拆出（对话信息块不再含 `[当前时间]`；
  旧 `agent.prompt.datetime` 开关随之废弃）。
- 依赖 `@agentchat/agents`（`isSingleDialog` 独立会话判定）。

## 测试

`package.json`：仅 `typecheck`（无 test script）。
测试文件：`tests/datetime.test.ts`（仅日期格式 / system prompt 尾部追加 /
singles 跳过 / 群组注入 / 子 Agent 跳过 / 空提示词独立成行 / 开关）。

## 相关文档

固定链接：[插件索引](./README.md) · [agent-prompt.md](agent-prompt.md) · [架构](../architecture.md)
