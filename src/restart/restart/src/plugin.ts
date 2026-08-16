import type { Context } from '@agentchat/cordis';
import { registerRestartTools } from './register';

export const name = 'agentchat-restart-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  registerRestartTools(ctx.tools, name);
}
