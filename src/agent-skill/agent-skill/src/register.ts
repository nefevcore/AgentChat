import type { HooksService } from '@agentchat/hooks';
import { makeInjectSkillsHook } from './skills';

/** 注册 agent-skill 扩展钩子（discovered_skills；owner = cordis 插件 name） */
export function registerSkillHooks(hooks: HooksService, owner: string): void {
  hooks.register('runStart', 'agent-skill.discovered_skills', (config, s) => makeInjectSkillsHook(config, s), owner);
}
