// ============================================================
// @agentchat/llm-openai/src/plugin.ts —— OpenAI 适配器插件行
//
// 注册 'openai' 与 'default' 两个 provider 键（default 兜底未知 provider）。
// 不挂本行即无兜底适配器。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { openaiAdapter } from './adapters';

export const name = 'agentchat-llm-openai';
export const inject = ['llm'];

export function apply(ctx: Context) {
  ctx.llm.registerAdapter('openai', openaiAdapter);
  ctx.llm.registerAdapter('default', openaiAdapter);
}
