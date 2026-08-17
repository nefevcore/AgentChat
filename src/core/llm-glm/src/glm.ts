// ============================================================
// src/core/llm/glm.ts —— 智谱 GLM LLM 适配器
//
// 继承 OpenAIChatLLM（智谱开放平台 /paas/v4 为 OpenAI 兼容 API），
// 仅覆盖 thinking / reasoning_effort / tool_choice / stop / 采样等
// GLM 特有约束。
//
// GLM 思考模式 API：
//   - thinking: { type: "enabled" | "disabled" }   思考开关
//     · GLM-5.3 / GLM-4.7 / GLM-4.5V 为强制思考模型：传 disabled 会报错，
//       适配器对这类模型恒传 enabled
//     · 其余（GLM-5.2/5.1/5/5-Turbo/4.6/4.5 等）为模型自动判断，可关
//   - reasoning_effort: "max" | "high" | "low"     推理强度（GLM-5.3 档位）
//   - reasoning_content 在响应中返回思维链内容（流式 delta.reasoning_content）
//   - 交错思考 + 工具调用场景须回传 assistant 的 reasoning_content
//     （基类已按"最后一条 assistant"回传，恰好覆盖 ReAct 工具轮）
//
// 其他协议差异（相对 OpenAI / DeepSeek）：
//   - tool_choice 仅支持 "auto"（不支持 none/required，非 auto 不传）
//   - stop 必须为数组（maxItems 4），字符串形式需包装
//   - temperature 取值 [0,1]、top_p [0.01,1]（超界由服务端拒绝，此处收敛）
//   - user_id 要求 6-128 字符（"<sender>__<receiver>" 天然满足，短 ID 不传）
//   - stream_options 不在协议内：usage 由最后一个 chunk 自动携带
//
// 参见: https://docs.bigmodel.cn/cn/api/introduction
//       https://docs.bigmodel.cn/cn/guide/capabilities/thinking
//       https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode
//
// 铁律：零外部依赖，仅引用 @agentchat/llm @agentchat/llm-openai。
// ============================================================

import type { LLMRequest } from '@agentchat/llm';
import { OpenAIChatLLM } from '@agentchat/llm-openai';
import type { OpenAIChatConfig } from '@agentchat/llm-openai';

/** GLM 推理强度档位（GLM-5.3：max 默认推荐 / high 增强 / low 轻度） */
export type GLMReasoningEffort = 'low' | 'high' | 'max';

export interface GLMConfig extends OpenAIChatConfig {
  /** 是否开启思考模式（强制思考模型忽略此开关，恒为开启） */
  thinking?: boolean;
  /** 推理强度（thinking 开启时生效，默认 max） */
  reasoningEffort?: GLMReasoningEffort;
}

/** 智谱开放平台 API 端点（OpenAI 兼容，按量付费） */
export const GLM_DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

/**
 * GLM Coding Plan（编码套餐）专属端点：套餐额度仅在此端点生效，
 * 套餐 Key 打标准端点会报 1113「余额不足或无可用资源包」。
 * 订阅了编码套餐的用户应把池配置的 base_url 换成此端点。
 */
export const GLM_CODING_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';

/** 默认模型（GLM-5.3：强制思考 + 1M 上下文旗舰） */
export const GLM_DEFAULT_MODEL = 'glm-5.3';

/**
 * 强制思考模型：thinking.type 传 disabled 将被服务端拒绝（1211 参数错误）。
 * GLM-5.3 / GLM-4.7 / GLM-4.5V 系列官方文档明确"强制思考"。
 */
const FORCED_THINKING_PATTERN = /glm-(5\.3|4\.7|4\.5v)/i;

/** 判断模型是否为强制思考系列 */
function isForcedThinkingModel(model: string): boolean {
  return FORCED_THINKING_PATTERN.test(model);
}

export class GLMChatLLM extends OpenAIChatLLM {
  /** 推理强度档位 */
  private reasoningEffort: GLMReasoningEffort;

  constructor(config: GLMConfig) {
    super({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? GLM_DEFAULT_BASE_URL,
      model: config.model ?? GLM_DEFAULT_MODEL,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      topP: config.topP,
      responseFormat: config.responseFormat,
      stop: config.stop,
    });
    this.logPrefix = '[GLMChatLLM]';
    this.reasoningEffort = config.reasoningEffort ?? 'max';
  }

  /**
   * 构建请求体 —— 在父类基础上注入 GLM 特有参数并收敛协议差异。
   */
  protected buildRequestBody(req: LLMRequest, stream: boolean): any {
    const body = super.buildRequestBody(req, stream);

    // ---- thinking 开关 ----
    // 强制思考模型（GLM-5.3/4.7/4.5V）传 disabled 会报错 → 恒 enabled；
    // 其余模型 req.thinking !== false 即开启（默认开，与 GLM 5 系默认行为一致）
    const forced = isForcedThinkingModel(this.model);
    const thinkingEnabled = forced || req.thinking !== false;
    body.thinking = { type: thinkingEnabled ? 'enabled' : 'disabled' };

    // ---- reasoning_effort（仅思考开启时传递；GLM-5.2+ 支持）----
    if (thinkingEnabled) {
      body.reasoning_effort = this.reasoningEffort;
    }

    // ---- stream_options：GLM 协议无此字段（usage 由最后一个 chunk 携带）----
    delete body.stream_options;

    // ---- tool_choice：GLM 仅支持 auto，非 auto 不传 ----
    if (body.tool_choice !== undefined && body.tool_choice !== 'auto') {
      delete body.tool_choice;
    }

    // ---- stop：GLM 要求数组形式（maxItems 4），字符串需包装 ----
    if (typeof body.stop === 'string') {
      body.stop = [body.stop];
    }
    if (Array.isArray(body.stop) && body.stop.length > 4) {
      body.stop = body.stop.slice(0, 4);
    }

    // ---- 采样参数收敛：GLM temperature [0,1] / top_p [0.01,1]，超界报错 ----
    if (typeof body.temperature === 'number') {
      body.temperature = Math.min(Math.max(body.temperature, 0), 1);
    }
    if (typeof body.top_p === 'number') {
      body.top_p = Math.min(Math.max(body.top_p, 0.01), 1);
    }

    // ---- user_id：GLM 要求 6-128 字符（"<sender>__<receiver>" 天然满足）----
    if (req.userId) {
      if (req.userId.length >= 6 && req.userId.length <= 128) {
        body.user_id = req.userId;
      }
    } else {
      delete body.user_id;
    }

    return body;
  }
}
