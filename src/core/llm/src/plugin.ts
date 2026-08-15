// ============================================================
// @agentchat/llm/src/plugin.ts —— LLM 服务插件（cordis 服务行）
//
// 提供 ctx.llm（LLMService：适配器工厂 + API Key 解析）。
// 由 cordis.yml 挂载（无 inject 依赖）；boot 装配行经 inject: ['llm'] 消费。
// registerCoreServices 的无 Loader 兜底同样经本插件行挂载（统一形态）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { LLMService } from './service';

export const name = 'agentchat-llm';

export function apply(ctx: Context) {
  new LLMService(ctx);
}
