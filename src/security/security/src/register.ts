import type { HooksService } from '@agentchat/hooks';
import { makeSecurityStartHook } from './security';
import type { ToolContext } from '@agentchat/tools';

/** 注册安全检查钩子（security-check；owner = cordis 插件 name） */
export function registerSecurityHooks(hooks: HooksService, owner: string): void {
  hooks.register('toolExecutionStart', 'security.security-check', (config, s) => makeSecurityStartHook((s as { agentsDir?: string }).agentsDir ?? '', config.agent_id), owner);
}
