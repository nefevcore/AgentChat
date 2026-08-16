# @agentchat/types
> 包路径 `src/core/types` · 版本 0.1.0 · 文档对应 v0.6.3（2026-08-16）

## 概述
AgentChat 核心域契约包：统一消息模型、来源元数据、工具定义与流式回调等跨包共享类型。它是整个插件化架构的“语言层”，仅类型 + 纯分类函数、零运行时依赖。LLM、ReAct 引擎、工具与装配层均以 `import type` 消费本包，避免包间运行时耦合。

v0.6.2 起角色模型分层：
- **内存/LLM 层**：入站消息统一 `role='user'`，来源语义由 `source.kind/form/summary` 表达；`MessageRole` 不再包含 `trigger`。
- **持久化层**：系统事件消息统一 `role='event'`（`@agentchat/protocol.PersistedRole`），取代旧 `trigger`。

## 目录
| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 全部类型契约：消息角色、消息、工具调用、工具定义、工具流回调 |

## 插件行
无插件行（纯契约/运行库）。本包只导出类型，由 `@agentchat/llm`、`@agentchat/agent-loop`、`@agentchat/agent-config` 等以 `import type` 使用。

## 提供的能力
| 类型 | 职责 |
| --- | --- |
| `MessageRole` | 内存/LLM 消息角色联合类型（见下；无 `trigger`） |
| `MessageSource` / `MessageSourceKind` / `MessageForm` | 入站消息来源元数据（已收编进本包） |
| `DeliveryLane` / `MessageDelivery` | inbox 投递 lane（next-turn/next-step）与 wakeup/maxSteps 调度元数据 |
| `isBackgroundRunSource(source?)` | 纯函数：按 source 分类后台/前台 run（替代旧 `isTrigger`） |
| `ToolCall` | 内存格式工具调用（`arguments` 为对象） |
| `PersistedToolCall` | OpenAI 原生/持久化格式（`type:'function'`，`arguments` 为 JSON 字符串） |
| `AgentMessage` | 统一领域消息（唯一消息契约） |
| `LLMRequestMessage` | LLM 请求消息，与 `AgentMessage` 同构 |
| `ToolDefinition` | OpenAI 兼容 function-calling 工具定义 |
| `ToolStream` | 工具执行流式回调（`onChunk`；loop 借此发射 `chat.tool_execution.update`） |

## 关键契约 / API
```ts
export type MessageRole =
  | 'system' | 'user' | 'assistant' | 'tool'
  | 'error' | 'agent';   // agent = 持久化发言格式，按 viewer 视角转换；无 trigger

export interface AgentMessage {
  role: MessageRole;
  content: string;
  message_id?: string;      // 持久化唯一标识
  agent_id?: string;        // 持久化 role='agent' 必填
  name?: string;            // tool 角色：工具名
  tool_call_id?: string;    // tool 角色：与 assistant.tool_calls 配对
  tool_calls?: ToolCall[] | PersistedToolCall[];  // 兼容两种格式
  reasoning_content?: string;
  label?: string;
  timestamp?: string;
  source?: MessageSource;   // 入站来源元数据；事件触发消息必有
}

export type LLMRequestMessage = AgentMessage;

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, any> };
}

export interface ToolStream {
  onChunk: (delta: string) => void;  // loop 借此发射 chat.tool_execution.update
}
```
- `role='agent'` 为持久化发言格式：归属由 `agent_id` 标记，provider 依据 `viewer` 做视角转换（`agent_id===viewer` → assistant，否则 → user，`agent_id==='user'` 恒为 user）。
- `role='user'` + `source` 为事件触发入站消息（原 trigger 语义）；持久化时由 session 层映射为 `PersistedRole='event'`。
- `MessageSourceKind`：`user/agent/system/timer/group/subagent/continue/restart/archive`；`MessageForm`：`prompt/hint/notice/resume/relay`。
- 旧 `role='trigger'` 与持久化 `role='event'` 在 `loadHistory` 读取时归一化为 `user + source`（旧 trigger 保留 `source.legacyRole='trigger'` 诊断标记）；`trigger+tool_call_id` 历史损坏运行时兜底为 `tool`。
- `role='error'` 由 provider 解析为 tool。

## 配置
无配置项（纯类型包）。

## 与其他插件的关系
- 工作区依赖：package.json 未声明 `@agentchat/*` 运行时依赖；源码仅 `import type` `src/shared/types`（跨端类型依赖根，编译后无引用）。
- 典型使用方：`@agentchat/llm`（消息/工具定义）、`@agentchat/agent-loop`（消息/工具定义/流回调）、`@agentchat/agent-config`（继承 `CurrentContext` 时传递消息类型）。

## 测试
无独立测试（纯类型，随消费方测试间接覆盖）。

## 相关文档
[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
