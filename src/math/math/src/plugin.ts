// ============================================================
// @agentchat/math/src/plugin.ts —— math 共享工具插件（cordis 工具行）
//
// 把数学工具（vm 沙箱求值）注册进 ctx.tools。
// 由 cordis.yml 挂载（inject: ['tools']）；registerCoreServices 的无 Loader
// 兜底同样经本插件行挂载（统一形态）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { registerMathTools } from './register';

export const name = 'agentchat-math';
export const inject = ['tools'];

export function apply(ctx: Context) {
  registerMathTools(ctx.tools, name);
}
