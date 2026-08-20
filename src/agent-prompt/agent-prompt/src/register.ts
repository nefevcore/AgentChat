import type { HooksService } from '@agentchat/hooks';
import { makeBuildSystemPromptHook } from './prompt-hook';

/** 注册 agent-prompt 扩展钩子（build-system-prompt；owner = cordis 插件 name）
 *  （persona 人设注入已拆至独立插件包 @agentchat/agent-persona） */
export function registerPromptHooks(hooks: HooksService, owner: string): void {
  hooks.register('runStart', 'agent-prompt.build-system-prompt', (config, s) => makeBuildSystemPromptHook(config, s), owner);
}
