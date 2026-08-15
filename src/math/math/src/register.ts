import type { ToolsService } from '@agentchat/tools';
import { mathTools } from './tools';

/** 注册数学工具（math，共享数组；owner = cordis 插件 name） */
export function registerMathTools(tools: ToolsService, owner: string): void {
  tools.register(owner, mathTools);
}
