import type { ToolsService } from '@agentchat/tools';
import { makeSessionTools } from './tools';

/** 注册会话历史工具（grep_history/read_history；owner = cordis 插件 name） */
export function registerSessionTools(tools: ToolsService, owner: string): void {
  tools.registerFactory(owner, (config, services) => makeSessionTools(config, services));
}
