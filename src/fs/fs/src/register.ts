import type { ToolsService } from '@agentchat/tools';
import { makeFileTools } from './tools';

/** 注册文件工具（read/write/edit；owner = cordis 插件 name，presets 过滤依据） */
export function registerFsTools(tools: ToolsService, owner: string): void {
  tools.registerFactory(owner, (config) => makeFileTools(config));
}
