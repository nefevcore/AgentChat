import type { ToolsService } from '@agentchat/tools';
import { makeAppTools } from './tools';

/** 注册应用管理工具（system_restart/ask_questions；owner = cordis 插件 name） */
export function registerAppTools(tools: ToolsService, owner: string): void {
  tools.registerFactory(owner, (config, services) => makeAppTools(config, services));
}
