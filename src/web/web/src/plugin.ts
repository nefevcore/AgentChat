import type { Context } from '@agentchat/cordis';
import { registerWebTools } from './register';

export const name = 'agentchat-web-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  registerWebTools(ctx.tools, name);
}
