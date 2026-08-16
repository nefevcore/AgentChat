import type { Context } from '@agentchat/cordis';
import { registerDevTools } from './register';

export const name = 'agentchat-dev-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  registerDevTools(ctx.tools, name);
}
