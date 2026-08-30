import type { ToolsService } from '@agentchat/tools';
import type { PluginHost } from '@agentchat/plugins';
import { makeDevTools } from './tools';
import { makeRegisterPluginTool, makeUnregisterPluginTool } from './plugin-tools';
import type { ModuleReloadHmr } from './module-reload';

/** 注册开发辅助工具（read_logs/reload/reload_modules，均 requires dev）
 * @param owner cordis 插件 name（presets 过滤依据）
 * @param getHmr 惰性取 HMR 服务（reload_modules 模块热重载 / reload 水位线告警用；
 *   组合树行序不定，执行期再取；缺省 = 不可用，工具自报错误） */
export function registerDevTools(
  tools: ToolsService,
  owner: string,
  getHmr?: () => ModuleReloadHmr | undefined,
): void {
  tools.registerFactory(owner, (config) => makeDevTools(config, getHmr));
}

/** 注册插件管理工具（register_plugin/unregister_plugin，均 requires admin）
 * @param owner cordis 插件 name（presets 过滤依据）
 * @param host 动态插件装载器（register_plugin 用） */
export function registerPluginAdminTools(tools: ToolsService, owner: string, host: PluginHost): void {
  tools.registerFactory(owner, (config, services) => [
    makeRegisterPluginTool(host, config, services),
    makeUnregisterPluginTool(host, config, services),
  ]);
}
