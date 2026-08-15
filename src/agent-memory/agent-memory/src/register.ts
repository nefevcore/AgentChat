import type { HooksService } from '@agentchat/hooks';
import { makeLoadMemoryHook } from './memory';

/** 注册 agent-memory 扩展钩子（load-memory；owner = cordis 插件 name） */
export function registerMemoryHooks(hooks: HooksService, owner: string): void {
  hooks.register('runStart', 'agent-memory.load-memory', (config) => makeLoadMemoryHook(config), owner);
}
