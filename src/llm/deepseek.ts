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
//       https://api-docs.deepseek.com/zh-cn/api/create-chat-completion
// ============================================================

import { LLMRequest } from '@core/types';
import { OpenAIChatLLM, OpenAIChatConfig } from './openai';
import type { ConfigField } from '@discovery/config-types';

export interface DeepSeekConfig extends OpenAIChatConfig {
  thinking?: boolean;
  reasoningEffort?: 'high' | 'max';
  /**
   * [DeepSeek] 是否返回输出 token 的对数概率 (可选，默认 false)。
   * 开启后可在 message.content 中获取每个 token 的 logprob。
   */
  logprobs?: boolean | null;
  /**
   * [DeepSeek] 返回 top N 概率 token 及其对数概率 (可选，范围 0-20)。
   * 设置此参数时 logprobs 必须为 true。
   */
  topLogprobs?: number | null;
  /**
   * [DeepSeek] 工具选择策略 (可选)。
   *   - "none": 不调用任何工具
   *   - "auto": 模型自行决定 (默认)
   *   - "required": 必须调用至少一个工具
   */
  toolChoice?: 'none' | 'auto' | 'required' | null;
}

export const DEEPSEEK_LLM_SCHEMA: ConfigField[] = [
  { name: 'api_key', label: 'API Key', description: 'AES-256-GCM 加密存储于 ~/.agentchat/credentials.json', type: 'password', default: '' },
  { name: 'base_url', label: 'API 地址', description: 'DeepSeek API 端点', type: 'text', default: 'https://api.deepseek.com' },
  { name: 'model', label: '模型名称', description: '模型 ID，如 deepseek-v4-flash', type: 'text', default: 'deepseek-v4-flash' },
  { name: 'temperature', label: '温度', description: '控制输出随机性 (0-2)，留空使用默认值', type: 'number', default: undefined },
  { name: 'max_tokens', label: '最大 Token', description: '最大输出 token 数，留空不限制', type: 'number', default: undefined },
  { name: 'top_p', label: 'Top P', description: '核采样参数 (0-1)，留空使用默认值', type: 'number', default: undefined },
  { name: 'response_format', label: '输出格式', description: 'text=普通文本, json_object=强制JSON', type: 'select', default: undefined, options: [{ label: 'text', value: 'text' }, { label: 'JSON', value: 'json_object' }] },
  { name: 'stop', label: '停止词', description: '遇到即停止输出，逗号分隔多个', type: 'text', default: undefined },
  { name: 'reasoning_effort', label: '思考强度', description: '深度思考模式强度', type: 'select', default: 'high', options: [{ label: 'High', value: 'high' }, { label: 'Max', value: 'max' }] },
  { name: 'thinking', label: '思考模式', description: '是否默认开启深度思考', type: 'checkbox', default: true },
  { name: 'logprobs', label: '对数概率', description: '是否返回每个 token 的对数概率', type: 'checkbox', default: false },
  { name: 'top_logprobs', label: 'Top Logprobs', description: '返回 top N 概率 token 的对数概率 (0-20)', type: 'number', default: undefined },
  { name: 'tool_choice', label: '工具选择', description: 'none=不调用, auto=自动, required=必须调用', type: 'select', default: undefined, options: [{ label: 'auto', value: 'auto' }, { label: 'none', value: 'none' }, { label: 'required', value: 'required' }] },
];

export class DeepSeekChatLLM extends OpenAIChatLLM {
  private reasoningEffort: 'high' | 'max';
  /** 是否返回对数概率 */
  private logprobs: boolean | undefined;
  /** top N logprobs (0-20) */
  private topLogprobs: number | undefined;
  /** 工具选择策略 */
  private toolChoice: 'none' | 'auto' | 'required' | undefined;

  constructor(config: DeepSeekConfig) {
    super({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? 'https://api.deepseek.com',
      model: config.model ?? 'deepseek-v4-flash',
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      topP: config.topP,
      responseFormat: config.responseFormat,
      stop: config.stop,
    });
    this.logPrefix = '[DeepSeekChatLLM]';
    this.reasoningEffort = config.reasoningEffort ?? 'high';
    this.logprobs = config.logprobs ?? undefined;
    this.topLogprobs = (config.topLogprobs != null) ? config.topLogprobs : undefined;
    this.toolChoice = config.toolChoice ?? undefined;
  }

  /**
   * 构建请求体 —— 在父类基础上注入 DeepSeek 特有的 thinking / logprobs / tool_choice 等参数。
   */
  protected buildRequestBody(req: LLMRequest, stream: boolean): any {
    const body = super.buildRequestBody(req, stream);

    // user_id 隔离：传入 "<sender>__<receiver>" 格式的对话对标识
    // 每个对话对拥有独立的上下文缓存与限速命名空间，避免多 Agent 场景下缓存污染
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

    // logprobs: 仅在开启时传输
    if (this.logprobs != null) {
      body.logprobs = this.logprobs;
    }

    // top_logprobs: 仅在非 null/undefined 且 >0 时传输
    if (this.topLogprobs != null && this.topLogprobs > 0) {
      body.top_logprobs = this.topLogprobs;
    }

    // tool_choice: 仅在非 null/undefined 且非默认值 "auto" 时传输
    if (this.toolChoice != null && this.toolChoice !== 'auto') {
      body.tool_choice = this.toolChoice;
    }

    return body;
  }
}
