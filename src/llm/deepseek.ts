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
import type { ConfigField } from '../discovery/config-types';

export interface DeepSeekConfig extends OpenAIChatConfig {
  thinking?: boolean;
  reasoningEffort?: 'high' | 'max';
}

export const DEEPSEEK_LLM_SCHEMA: ConfigField[] = [
  { name: 'api_key', label: 'API Key', description: '密钥保存在 ~/.agentchat/credentials.json', type: 'password', default: '' },
  { name: 'base_url', label: 'API 地址', description: 'DeepSeek API 端点', type: 'text', default: 'https://api.deepseek.com' },
  { name: 'model', label: '模型名称', description: '模型 ID，如 deepseek-v4-flash', type: 'text', default: 'deepseek-v4-flash' },
  { name: 'temperature', label: '温度', description: '控制输出随机性 (0-2)', type: 'number', default: undefined },
  { name: 'max_tokens', label: '最大 Token', description: '最大输出 token 数', type: 'number', default: undefined },
  { name: 'reasoning_effort', label: '思考强度', description: '深度思考模式强度', type: 'select', default: 'high', options: [{ label: 'High', value: 'high' }, { label: 'Max', value: 'max' }] },
  { name: 'thinking', label: '思考模式', description: '是否默认开启深度思考', type: 'checkbox', default: true },
];

export class DeepSeekChatLLM extends OpenAIChatLLM {
  private reasoningEffort: 'high' | 'max';

  constructor(config: DeepSeekConfig) {
    super({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? 'https://api.deepseek.com',
      model: config.model ?? 'deepseek-v4-flash',
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
