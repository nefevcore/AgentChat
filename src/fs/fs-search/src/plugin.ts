import type { Context } from '@agentchat/cordis';
import { registerFsSearchTools } from './register';

export const name = 'agentchat-fs-search-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  registerFsSearchTools(ctx.tools, name);
}
