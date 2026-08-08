// ============================================================
// src/core/llm/base.ts —— LLM 抽象基类
//
// 实现 core 的 LLMProvider 接口，作为所有 LLM 适配器的抽象基类。
// 铁律：零外部依赖，仅引用 ../types 的类型。
// ============================================================

import type { LLMRequest, LLMResponse, LLMProvider, LLMRequestMessage, StreamToken } from '../types';

/**
 * BaseLLM — 所有 LLM 适配器的抽象基类
 */
export abstract class BaseLLM implements LLMProvider {
  protected _model: string;

  constructor(model: string) {
    this._model = model;
  }

  /** 模型名（供 usage 记录按模型统计） */
  get model(): string {
    return this._model;
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
