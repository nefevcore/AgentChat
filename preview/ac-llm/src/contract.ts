// ============================================================
// ac-llm/src/contract.ts —— LLM 域契约（纯类型，零运行时）
//
// 契约归属 owning package：谁提供 ctx.llm，谁声明本域类型与
// llm/* 事件（events.ts）。跨域消费方 `import type {} from 'ac-llm'`
// 即同时获得服务类型、域类型与事件目录的类型增强。
//
// provider 接口有意与 ac-openai-completions 的返回形状结构化
// 兼容：适配器工厂零胶水直接返回库实例。
// ============================================================

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmRole;
  content: string;
  /** 协议细节透传（tool 调用关联等） */
  name?: string;
  tool_call_id?: string;
  [key: string]: unknown;
}

/**
 * Token 用量（usage 双轨的"单次调用"轨；run 级双轨聚合见
 * ac-agent-loop 的 LoopRunUsage）。
 * 缓存字段由 provider 归一化（ac-openai-completions）：
 * DeepSeek 顶层 prompt_cache_hit/miss_tokens；OpenAI/GLM 嵌套
 * prompt_tokens_details.cached_tokens（hit=cached、miss=prompt−cached 推导）。
 */
export interface LlmUsage {
  prompt: number;
  completion: number;
  total?: number;
  /** 缓存命中的输入 token 数（provider 归一化） */
  cacheHit?: number;
  /** 缓存未命中的输入 token 数（provider 归一化） */
  cacheMiss?: number;
}

/**
 * 流式事件的上下文元数据（M13 载荷增强，地图 §2：WS 桥接过滤后台会话
 * 需要 source 细分）。调用方（agent-loop）把信封子集填进 input.meta，
 * LlmService 发射 llm/delta-* 时透传；**dispatch 时剥离**——provider
 * 请求体永远不包含本字段（透传键约定，非 OpenAI 参数）。
 * sender/source 用 string 而非 loop 域 union：llm 是 L1，不 type-import
 * 上游词汇（M19：sender=端点 id、source=拓扑类）。
 */
export interface LlmStreamMeta {
  agent?: string;
  conversationId?: string;
  sender?: string;
  source?: string;
}

export interface LlmChatInput {
  /** 显式 provider 名；缺省按 model 路由（精确 > 前缀） */
  provider?: string;
  model: string;
  messages: LlmMessage[];
  /** 模型可调用的工具清单（OpenAI function calling 形态） */
  tools?: LlmToolSpec[];
  temperature?: number;
  max_tokens?: number;
  /** 取消信号（透传到底层请求） */
  signal?: AbortSignal;
  /** 流式事件上下文（delta-* 载荷增强；不进 provider 请求体） */
  meta?: LlmStreamMeta;
  /**
   * 单次调用的 API key（凭据链上层注入，如 ac-credentials 的
   * llm/before-chat 订阅）：优先于适配器行构造默认。传输层键——
   * provider（ac-openai-completions）序列化请求体前剥离，绝不进 body。
   */
  api_key?: string;
  /** 其余参数（response_format/...）原样透传给 provider */
  [key: string]: unknown;
}

/** 工具规格（OpenAI function calling 形态，由 ToolDefinition 转换） */
export interface LlmToolSpec {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** 流式工具调用分片（arguments 跨分片拼接，按 index 聚合） */
export interface LlmToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  /** arguments JSON 的增量片段 */
  argumentsDelta?: string;
}

/** 聚合后的完整工具调用 */
export interface LlmToolCall {
  id: string;
  name: string;
  /** JSON 字符串参数 */
  arguments: string;
}

export interface LlmStreamChunk {
  /** 内容增量 */
  delta: string;
  /** 推理增量（deepseek reasoning_content / glm thinking） */
  reasoning?: string;
  /** 工具调用分片（本 chunk 携带的增量） */
  toolCalls?: LlmToolCallDelta[];
  finish?: string;
  usage?: LlmUsage;
}

export interface LlmChatResult {
  /** 名义 provider（拦截器短路时可能与实际执行方不同） */
  provider: string;
  model: string;
  text: string;
  reasoning?: string;
  /** 本轮聚合出的工具调用（无则空） */
  toolCalls?: LlmToolCall[];
  finish?: string;
  usage?: LlmUsage;
}

/** provider 实例契约：由适配器薄行经工厂注册，路由器懒实例化 */
export interface LlmProvider {
  stream(input: LlmChatInput): AsyncIterable<LlmStreamChunk>;
  /** 资源回收（路由器注销该 provider 实例时调用） */
  close?(): void | Promise<void>;
}

export type LlmProviderFactory = () => LlmProvider;

/**
 * LLM 调用的可变载体（waterfall 拦截链的事实对象）。
 * cordis waterfall 的 next() 不携带参数——拦截器改写输入的唯一方式是
 * 变异本载体（`call.input = { ...call.input, model: '...' }`），
 * 路由发生在拦截之后，改写 input 即改写路由。
 */
export interface LlmChatCall {
  input: LlmChatInput;
}
