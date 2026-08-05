// ============================================================
// LLM 抽象基类
// ============================================================

import { LLMRequest, LLMResponse, LLMProvider, LLMRequestMessage, StreamToken } from '@core/types';

/**
 * BaseLLM — 所有 LLM 适配器的抽象基类
 */
export abstract class BaseLLM implements LLMProvider {
  protected model: string;

  constructor(model: string) {
    this.model = model;
  }

  /** 非流式调用 */
  abstract chat(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse>;

  /** 流式调用 —— 返回 ChatStream（AsyncIterable<StreamToken> + .result()） */
  abstract stream(req: LLMRequest, signal?: AbortSignal): AsyncIterable<StreamToken> & { result(): Promise<LLMResponse> };

  /** 正向转换：项目消息（持久化或内存格式）→ 本 provider 的 LLM API 原生消息（角色解析 + 视角转换 + 防御过滤） */
  abstract toProviderMessages(messages: LLMRequestMessage[], viewer?: string): any[];

  /** 反向转换：LLM API 原生消息 → 项目消息（OpenAI 格式归一化为简化 ToolCall） */
  abstract fromProviderMessages(messages: any[]): LLMRequestMessage[];
}
