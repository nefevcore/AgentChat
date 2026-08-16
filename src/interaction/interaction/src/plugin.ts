import type { Context } from '@agentchat/cordis';
import { registerInteractionTools } from './register';

export const name = 'agentchat-interaction-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  registerInteractionTools(ctx.tools, name);
}
