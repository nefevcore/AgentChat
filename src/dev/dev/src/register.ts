import type { ToolsService } from '@agentchat/tools';
import type { PluginHost } from '@agentchat/plugins';
import { makeDevTools } from './tools';
import { makeRegisterTool } from './register-tool';
import { makeRegisterPluginTool, makeUnregisterPluginTool } from './plugin-tools';

/** 注册开发辅助工具（code_search/read_logs/reload，均 requires dev）
 * @param owner cordis 插件 name（presets 过滤依据） */
export function registerDevTools(tools: ToolsService, owner: string): void {
  tools.registerFactory(owner, (config) => makeDevTools(config));
}

/** 注册插件/运行时扩展管理工具（register_tool/register_plugin/…，均 requires admin）
 * @param owner cordis 插件 name（presets 过滤依据）
 * @param host 动态插件装载器（register_plugin 用） */
export function registerPluginAdminTools(tools: ToolsService, owner: string, host: PluginHost): void {
  tools.registerFactory(owner, (config, services) => [
    makeRegisterTool(tools, `runtime:register-tool:${config.agent_id}`), // 闭包注入 ctx.tools：Agent 可运行时注册新工具
    makeRegisterPluginTool(host, config, services),
    makeUnregisterPluginTool(host, config, services),
  ]);
}
