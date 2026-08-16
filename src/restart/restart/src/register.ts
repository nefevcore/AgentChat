import type { ToolsService } from '@agentchat/tools';
import { makeRestartTools } from './tools';

/** 注册系统重启工具（system_restart；owner = cordis 插件 name） */
export function registerRestartTools(tools: ToolsService, owner: string): void {
  tools.registerFactory(owner, (config) => makeRestartTools(config));
}
