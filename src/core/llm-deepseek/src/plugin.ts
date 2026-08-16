// ============================================================
// @agentchat/llm-deepseek/src/plugin.ts —— DeepSeek 适配器插件行
//
// 注册 provider: 'deepseek'。不挂本行即无 deepseek provider。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { deepseekAdapter } from './adapters';

export const name = 'agentchat-llm-deepseek';
export const inject = ['llm'];

export function apply(ctx: Context) {
  ctx.llm.registerAdapter('deepseek', deepseekAdapter);
}
