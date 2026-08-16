# @agentchat/llm
> 包路径 `src/core/llm` · 版本 0.1.0

## 概述
LLM 抽象基座包：提供 `ctx.llm`（`LLMService`）适配器注册表、`LLMConfig/LLMRequest/LLMResponse/LLMUsage/LLMProvider/StreamToken` 契约、`BaseLLM` 抽象基类与 `ChatStream` 流式抽象。具体适配器拆至 `@agentchat/llm-openai`（openai/default）与 `@agentchat/llm-deepseek`（deepseek）；库级 provider 分发由 `@agentchat/llm-factory` 提供。

## 目录
| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | 服务插件行：`ctx.llm = new LLMService(ctx)` |
| `service.ts` | `LLMService`：`create/registerAdapter/resolveKey` |
| `contracts.ts` | LLM 契约 |
| `adapters.ts` | `AdapterFactory` + `resolveApiKey`（不含具体实现） |
| `base.ts` | `BaseLLM` 抽象基类 |
| `chat-stream.ts` | `ChatStream`：`AsyncIterable<StreamToken>` + `.result()` |

## 插件行
| 模块文件 | 插件 name | inject | 提供 |
| --- | --- | --- | --- |
| `llm/src/plugin` | `agentchat-llm` | — | `ctx.llm = LLMService` |
| `llm-openai/src/plugin` | `agentchat-llm-openai` | `['llm']` | 注册 `openai` + `default` |
| `llm-deepseek/src/plugin` | `agentchat-llm-deepseek` | `['llm']` | 注册 `deepseek` |

## ctx.llm（LLMService）
| 成员 | 语义 |
| --- | --- |
| `static factory?` | 测试注入点；缺省 undefined = 走注册表分发 |
| `create(config)` | 静态 factory 优先 → 按 provider 查适配器注册表 → 无注册抛错（组合装配必须挂适配器行） |
| `registerAdapter(provider, factory)` | 注册可替换后端；随插件卸载自动注销 |
| `resolveKey(apiKey)` | 解析 `${ENV_VAR}` |

## 其他
- 契约与 `StreamToken` 语义不变；流式“错误进流”见 `ChatStream.error`。
- 具体实现行为（OpenAI SSE 解析、DeepSeek `\x` 规避、request body 构建）见 `@agentchat/llm-openai` / `@agentchat/llm-deepseek`。
- `@agentchat/llm-factory`：`createLLM(config)` = deepseek ? deepseekAdapter : openaiAdapter（库级直接调用）。

## 测试
- `llm/tests/chat-stream.test.ts`：ChatStream。
- `llm-factory/tests/factory.test.ts`：provider 分发与 smoke。
- `llm-deepseek/tests/deepseek-body-json.test.ts`：DeepSeek `\x` 规避回归。

## 相关文档
[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md)
