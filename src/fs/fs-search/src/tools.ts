// ============================================================
// @agentchat/fs-search/src/tools.ts —— 发现工具族（glob + grep）
// ============================================================
import type { AgentConfig } from '@agentchat/agent-config';
import { makeGlobTool } from './glob';
import { makeGrepTool } from './grep';
import type { Tool } from '@agentchat/agent-loop';

/** 文件发现工具族（glob + grep） */
export function makeFsSearchTools(config: AgentConfig): Tool[] {
  return [makeGlobTool(config), makeGrepTool(config)];
}
