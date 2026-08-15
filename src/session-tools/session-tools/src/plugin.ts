import type { Context } from '@agentchat/cordis';
import { registerSessionTools } from './register';

export const name = 'agentchat-session-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  registerSessionTools(ctx.tools, name);
}
