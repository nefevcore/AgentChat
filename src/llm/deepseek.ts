// ============================================================
// DeepSeek LLM 适配器
// 继承 OpenAIChatLLM，仅覆盖 thinking（深度思考）相关逻辑。
//
// DeepSeek 思考模式 API：
//   - thinking: { type: "enabled" | "disabled" }  控制思考开关
//   - reasoning_effort: "high" | "max"             控制思考强度
//   - reasoning_content 在响应中返回思维链内容
//   - 思考模式下 temperature/top_p 等参数不生效但可传递
//
// chat / chatStream 统一为 chat() 方法，通用逻辑继承自 OpenAIChatLLM。
//
// 参见: https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
// ============================================================

import { LLMRequest } from '../core/types';
import { OpenAIChatLLM, OpenAIChatConfig } from './openai';

export interface DeepSeekConfig extends OpenAIChatConfig {
  /** 默认是否开启思考模式 */
  thinking?: boolean;
  /** 思考强度 */
  reasoningEffort?: 'high' | 'max';
}

export class DeepSeekChatLLM extends OpenAIChatLLM {
  private reasoningEffort: 'high' | 'max';

  constructor(config: DeepSeekConfig) {
    super({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? 'https://api.deepseek.com',
      model: config.model ?? 'deepseek-chat',
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });
    this.logPrefix = '[DeepSeekChatLLM]';
    this.reasoningEffort = config.reasoningEffort ?? 'high';
  }

  /**
   * 构建请求体 —— 在父类基础上注入 DeepSeek 特有的 thinking 参数。
   */
  protected buildRequestBody(req: LLMRequest, stream: boolean): any {
    const body = super.buildRequestBody(req, stream);

    // user_id 隔离：传入 agent_id 用于业务侧限速与调度隔离
    // 参见: https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit
    if (req.userId) {
      body.user_id = req.userId;
    }

    // 思考模式开关
    // req.thinking: true = 开启, false = 关闭, undefined = 使用默认 (开启)
    const thinkingEnabled = req.thinking !== false;
    if (thinkingEnabled) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = this.reasoningEffort;
    } else {
      body.thinking = { type: 'disabled' };
    }

    return body;
  }
}
