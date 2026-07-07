// ============================================================
// LLM 抽象基类
// ============================================================

import { LLMRequest, LLMResponse, LLMProvider } from '../core/types';

/**
 * BaseLLM — 所有 LLM 适配器的抽象基类
 */
export abstract class BaseLLM implements LLMProvider {
  protected model: string;

  constructor(model: string) {
    this.model = model;
  }

  abstract chat(
    req: LLMRequest,
    signal?: AbortSignal,
    onChunk?: (delta: string) => void,
    onThinking?: (delta: string) => void,
  ): Promise<LLMResponse>;
}
