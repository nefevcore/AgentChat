import type { ToolsService } from '@agentchat/tools';
import { makeInteractionTools } from './tools';

/** 注册用户交互工具（ask_questions；owner = cordis 插件 name） */
export function registerInteractionTools(tools: ToolsService, owner: string): void {
  tools.registerFactory(owner, (config, services) => makeInteractionTools(config, services));
}
