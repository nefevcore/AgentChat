import type { Context } from '@agentchat/cordis';
import { registerAppTools } from './register';

export const name = 'agentchat-app-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  registerAppTools(ctx.tools, name);
}
