import type { HooksService } from '@agentchat/hooks';
import { makeDatetimeHook } from './datetime-hook';

/**
 * 注册 agent-datetime 扩展钩子（datetime；owner = cordis 插件 name）。
 * 清单钩子（非 automatic）：仅当 config.hooks.runStart 显式列出
 * 'agent-datetime.datetime' 时进入 run（仍受 owner preset 过滤）。
 * 推荐排在 agent-prompt.build-system-prompt 之后（日期行追加到装配结果尾部）。
 */
export function registerDatetimeHooks(hooks: HooksService, owner: string): void {
  hooks.register('runStart', 'agent-datetime.datetime', (config) => makeDatetimeHook(config), owner);
}
