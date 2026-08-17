// ============================================================
// @agentchat/llm-glm/src/plugin.ts —— GLM 适配器插件行
//
// 注册 provider: 'glm'。不挂本行即无 glm provider。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { glmAdapter } from './adapters';

export const name = 'agentchat-llm-glm';
export const inject = ['llm'];

export function apply(ctx: Context) {
  ctx.llm.registerAdapter('glm', glmAdapter);
}
