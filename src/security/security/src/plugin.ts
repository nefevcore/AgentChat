// ============================================================
// @agentchat/security/src/plugin.ts —— 安全钩子插件行
//
// 注册 security-check（toolExecutionStart）与
// security.redact-output（toolExecutionEnd 变换）到 ctx.hooks。
// 由 cordis.yml 挂载（inject: ['hooks']）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { registerSecurityHooks } from './register';

export const name = 'agentchat-security';
export const inject = ['hooks'];

export function apply(ctx: Context) {
  registerSecurityHooks(ctx.hooks, name);
}
