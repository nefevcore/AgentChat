// ============================================================
// ac-llm-openai —— OpenAI 适配器薄行
//
// inject ['llm'] 注册工厂（懒实例化：首次 stream/chat 才构造 client）；
// 协议实现全部住在 ac-openai-completions 纯库。与 deepseek/glm 薄行
// 互不依赖。卸载本行：工厂与已实例化 client 自动回收（fiber effect）。
// Config schema（Schemastery）：loader 在 apply 前校验并填默认值。
// ============================================================
import type { Context } from '@agentchat/cordis';
import z from '@agentchat/schemastery';
import { OpenAICompletions } from 'ac-openai-completions';
import type {} from 'ac-llm'; // ctx.llm 服务类型增强（type-only，无运行时依赖）

export const name = 'ac-llm-openai';
export const inject = ['llm'];

export interface Config {
  /** OpenAI API key（缺省读 OPENAI_API_KEY） */
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
    'openai',
    () =>
      new OpenAICompletions({
        apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
        baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
        defaultModel: config.defaultModel ?? 'gpt-4o-mini',
      }),
    {
      models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'o3'],
      description: 'OpenAI 官方 API',
    },
  );
}
