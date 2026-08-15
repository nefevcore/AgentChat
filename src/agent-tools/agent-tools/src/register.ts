import type { ToolsService } from '@agentchat/tools';
import { makeAgentTools } from './tools';

/** 注册协作工具（send_agent/send_group/list_agents 等；owner = cordis 插件 name） */
export function registerAgentTools(tools: ToolsService, owner: string): void {
  tools.registerFactory(owner, (config, services) => makeAgentTools(config, services));
}
