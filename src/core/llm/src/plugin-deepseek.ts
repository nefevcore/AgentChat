// ============================================================
// @agentchat/llm/src/plugin-deepseek.ts —— DeepSeek 适配器插件行
//
// 契约化阶段④：把 DeepSeekChatLLM 工厂注册进 ctx.llm（可替换后端——
// 不挂本行即无 deepseek provider；挂替代适配器行即替换）。
// 由 cordis.yml 挂载（inject: ['llm']）；registerCoreServices 兜底同构挂载。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { deepseekAdapter } from './adapters';

export const name = 'agentchat-llm-deepseek';
export const inject = ['llm'];

export function apply(ctx: Context) {
  ctx.llm.registerAdapter('deepseek', deepseekAdapter);
}
