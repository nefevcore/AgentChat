// ============================================================
// @agentchat/llm —— LLM 抽象契约与基座
//
// 契约化阶段④ + 实现拆分：
//   · contracts.ts   LLMConfig/LLMRequest/LLMResponse/LLMUsage/LLMProvider/StreamToken
//   · base.ts        BaseLLM 抽象基类
//   · chat-stream.ts 流式响应统一抽象
//   · service.ts     ctx.llm（适配器注册表）
//   · adapters.ts    AdapterFactory + resolveApiKey
// 具体实现：
//   · @agentchat/llm-openai   OpenAI 兼容适配器（含 default 兜底）
//   · @agentchat/llm-deepseek DeepSeek 适配器
//   · @agentchat/llm-glm      智谱 GLM 适配器（glm-5.3）
//   · @agentchat/llm-factory  createLLM 库级分发（组合场景请走 ctx.llm）
// ============================================================

export * from './contracts';
export * from './base';
export * from './service';
export * from './chat-stream';
export * from './adapters';
