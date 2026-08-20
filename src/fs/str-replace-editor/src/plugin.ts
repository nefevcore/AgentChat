import type { Context } from '@agentchat/cordis';
import { registerStrReplaceEditorTool } from './register';

export const name = 'agentchat-str-replace-editor-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  registerStrReplaceEditorTool(ctx.tools, name);
}
