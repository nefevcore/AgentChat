import type { HooksService } from '@agentchat/hooks';
import { makeSecurityStartHook } from './security';
import { makeRedactEndHook } from './redact';
import type { ToolContext } from '@agentchat/tools';

/** 注册安全检查钩子（security-check）+ 工具结果脱敏变换钩子（security.redact-output） */
export function registerSecurityHooks(hooks: HooksService, owner: string): void {
  hooks.register('toolExecutionStart', 'security.security-check', (config, s) => makeSecurityStartHook((s as { agentsDir?: string }).agentsDir ?? '', config.agent_id), owner);
  hooks.register('toolExecutionEnd', 'security.redact-output', (_config, s: ToolContext) => makeRedactEndHook(() => s.redactSecrets ?? []), owner);
}
