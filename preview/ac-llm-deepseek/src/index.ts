// ============================================================
// ac-llm-deepseek —— DeepSeek 适配器薄行
//
// inject ['llm'] 注册工厂（懒实例化）；deepseek-reasoner 的
// reasoning_content 增量由 ac-openai-completions 统一映射为 chunk.reasoning。
// Config schema（Schemastery）：loader 在 apply 前校验并填默认值。
// ============================================================
import type { Context } from '@agentchat/cordis';
import z from '@agentchat/schemastery';
import { OpenAICompletions } from 'ac-openai-completions';
import type {} from 'ac-llm'; // ctx.llm 服务类型增强（type-only，无运行时依赖）

export const name = 'ac-llm-deepseek';
export const inject = ['llm'];

export interface Config {
  /** DeepSeek API key（缺省读 DEEPSEEK_API_KEY） */
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseUrl: z.string(),
  defaultModel: z.string(),
}) as z<Config>;

export function apply(ctx: Context, config: Config = {}) {
  ctx.llm.register(
    'deepseek',
    () =>
      new OpenAICompletions({
        apiKey: config.apiKey ?? process.env.DEEPSEEK_API_KEY,
        baseUrl: config.baseUrl ?? 'https://api.deepseek.com/',
        defaultModel: config.defaultModel ?? 'deepseek-v4-flash',
      }),
    {
      models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
      description: 'DeepSeek 官方 API',
    },
  );
}
