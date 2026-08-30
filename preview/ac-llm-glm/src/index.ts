// ============================================================
// ac-llm-glm —— 智谱 GLM 适配器薄行
//
// inject ['llm'] 注册工厂（懒实例化）；GLM 开放平台为 OpenAI 兼容协议。
// Config schema（Schemastery）：loader 在 apply 前校验并填默认值。
// ============================================================
import type { Context } from '@agentchat/cordis';
import z from '@agentchat/schemastery';
import { OpenAICompletions } from 'ac-openai-completions';
import type {} from 'ac-llm'; // ctx.llm 服务类型增强（type-only，无运行时依赖）

export const name = 'ac-llm-glm';
export const inject = ['llm'];

export interface Config {
  /** 智谱 API key（缺省读 GLM_API_KEY） */
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
    'glm',
    () =>
      new OpenAICompletions({
        apiKey: config.apiKey ?? process.env.GLM_API_KEY,
        baseUrl: config.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4',
        defaultModel: config.defaultModel ?? 'glm-5.3',
      }),
    {
      models: ['glm-5.3'],
      description: '智谱 GLM 开放平台',
    },
  );
}
