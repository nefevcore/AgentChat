import type { ToolsService } from '@agentchat/tools';
import { makeShellTools } from './tools';

/** 注册命令执行工具（bash；owner = cordis 插件 name） */
export function registerShellTools(tools: ToolsService, owner: string): void {
  tools.registerFactory(owner, (config) => makeShellTools(config));
}
