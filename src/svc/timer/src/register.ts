// ============================================================
// @agentchat/timer/src/register.ts —— timer 工具注册（cordis 插件形态）
// ============================================================
import type { ToolsService } from '@agentchat/tools';
import { makeTimerTool } from './tool';

/** 注册 timer 工具（列表/新建/删除定时任务；owner = cordis 插件 name） */
export function registerTimerTool(tools: ToolsService, owner: string): void {
  tools.registerFactory(owner, (config, services) => [makeTimerTool(config, services)]);
}
