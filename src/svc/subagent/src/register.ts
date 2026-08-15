// ============================================================
// @agentchat/subagent/src/register.ts —— subagent 工具注册（cordis 插件形态）
// ============================================================
import type { ToolsService } from '@agentchat/tools';
import { makeSubagentTool } from './tool';

/** 注册 subagent 工具（spawn/list/await/kill 子 Agent；owner = cordis 插件 name） */
export function registerSubagentTool(tools: ToolsService, owner: string): void {
  tools.registerFactory(owner, (config, services) => [makeSubagentTool(config, services)]);
}
