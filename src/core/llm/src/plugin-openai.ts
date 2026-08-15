// ============================================================
// @agentchat/llm/src/plugin-openai.ts —— OpenAI 兼容适配器插件行
//
// 契约化阶段④：注册 'openai' 与 'default' 两个 provider 键（default 兜底
// 未知 provider，对齐旧 createLLM 的 else 分支）。不挂本行即无兜底适配器。
// 由 cordis.yml 挂载（inject: ['llm']）；registerCoreServices 兜底同构挂载。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { openaiAdapter } from './adapters';

export const name = 'agentchat-llm-openai';
export const inject = ['llm'];

export function apply(ctx: Context) {
  ctx.llm.registerAdapter('openai', openaiAdapter);
  ctx.llm.registerAdapter('default', openaiAdapter);
}
