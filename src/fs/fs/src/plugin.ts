import type { Context } from '@agentchat/cordis';
import { registerFsTools } from './register';

export const name = 'agentchat-fs-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  registerFsTools(ctx.tools, name);
}
