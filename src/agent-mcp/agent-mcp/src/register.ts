import type { HooksService } from '@agentchat/hooks';
import { makeOpenMCPHook } from './mcp';

/** 注册 agent-mcp 扩展钩子（open-mcp；owner = cordis 插件 name） */
export function registerMcpHooks(hooks: HooksService, owner: string): void {
  hooks.register('runStart', 'agent-mcp.open-mcp', (config) => makeOpenMCPHook(config), owner);
}
