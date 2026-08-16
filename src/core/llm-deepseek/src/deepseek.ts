// ============================================================
// src/core/llm/deepseek.ts —— DeepSeek LLM 适配器
//
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
//
// 铁律：零外部依赖，仅引用 ../types ../logger ./openai。
// ============================================================

import type { LLMRequest } from '@agentchat/llm';
import { OpenAIChatLLM } from '@agentchat/llm-openai';
import type { OpenAIChatConfig } from '@agentchat/llm-openai';

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

  /**
   * 请求体 JSON 文本后处理 —— 规避 DeepSeek 网关的 \x 解析 bug。
   *
   * 现象：消息 content 含字面反斜杠+x（如 Windows 路径 "C:\xampp"、正则 "\x1b"）时，
   * JSON.stringify 会输出 "\x"（合法 JSON，表示反斜杠+x）。DeepSeek 网关 parser
   * 解码 "\\" 后贪婪消费后续转义，把 "\xampp" 误判为 hex escape "\xam"，
   * 在非 hex 字符处报 400 "unexpected end of hex escape"（2026-08-02 neko 实测）。
   *
   * 修复：将字面反斜杠改用 \u005c（Unicode 转义）表示。
   *  \u005c 与 \\ 在 JSON 语义上完全等价（都解码为单个反斜杠），
   *  但 parser 不会再遇到 "\\" + 后续字符的贪婪误判。
   */
  protected postProcessBodyJson(json: string): string {
    return json.replace(/\\\\/g, '\\u005c');
  }
}
