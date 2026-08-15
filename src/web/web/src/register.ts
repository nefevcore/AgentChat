import type { ToolsService } from '@agentchat/tools';
import { makeWebTools } from './tools';

/** 注册网络工具（web_search + browser；owner = cordis 插件 name） */
export function registerWebTools(tools: ToolsService, owner: string): void {
  tools.registerFactory(owner, (config, services) => makeWebTools(config, services));
}
