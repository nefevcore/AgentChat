import type { ToolsService } from '@agentchat/tools';
import type { JobService } from '@agentchat/jobs';
import { makeShellTools } from './tools';

/** 注册 shell 工具（bash + job 后台任务管理；owner = cordis 插件 name） */
export function registerShellTools(tools: ToolsService, owner: string, jobs?: JobService): void {
  tools.registerFactory(owner, (config) => makeShellTools(config, jobs));
}
