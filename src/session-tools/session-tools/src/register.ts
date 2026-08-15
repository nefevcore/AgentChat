import type { ToolsService } from '@agentchat/tools';
import { makeSessionTools } from './tools';

/** 注册会话工具（query_history/continue_turn/inspect_session；owner = cordis 插件 name） */
export function registerSessionTools(tools: ToolsService, owner: string): void {
  tools.registerFactory(owner, (config, services) => makeSessionTools(config, services));
}
