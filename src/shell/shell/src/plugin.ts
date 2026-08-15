import type { Context } from '@agentchat/cordis';
import { registerShellTools } from './register';

export const name = 'agentchat-shell-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  registerShellTools(ctx.tools, name);
}
