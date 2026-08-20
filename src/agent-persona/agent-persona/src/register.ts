import type { HooksService } from '@agentchat/hooks';
import { makePersonaPromptHook } from './persona-hook';

/** 注册 agent-persona 扩展钩子（persona；owner = cordis 插件 name）
 *  推荐排在 agent-prompt.build-system-prompt 之前（角色块先行，框架块追加；后置亦兼容） */
export function registerPersonaHooks(hooks: HooksService, owner: string): void {
  hooks.register('runStart', 'agent-persona.persona', (config, s) => makePersonaPromptHook(config, s), owner);
}
