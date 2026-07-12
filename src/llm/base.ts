// ============================================================
// LLM 抽象基类
// ============================================================

import { LLMRequest, LLMResponse, LLMProvider, StreamToken } from '@core/types';

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
}
