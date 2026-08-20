import type { ToolsService } from '@agentchat/tools';
import { makeFsSearchTools } from './tools';

/** 注册文件发现工具（glob/grep；owner = cordis 插件 name，presets 过滤依据） */
export function registerFsSearchTools(tools: ToolsService, owner: string): void {
  tools.registerFactory(owner, (config) => makeFsSearchTools(config));
}
