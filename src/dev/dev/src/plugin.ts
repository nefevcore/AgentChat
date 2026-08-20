import type { Context } from '@agentchat/cordis';
import { registerDevTools } from './register';
import type { ModuleReloadHmr } from './module-reload';

export const name = 'agentchat-dev-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  // hmr 行为可选服务（组合路径提供；dist 直调路径无）：执行期惰性取，
  // 不进 inject 声明——缺失不阻断 dev 工具行启动，reload_modules 自报不可用。
  const getHmr = () => ctx.get('hmr') as ModuleReloadHmr | undefined;
  registerDevTools(ctx.tools, name, getHmr);
}
