// ============================================================
// src/plugins/builtin/index.ts —— 内置插件 mod 入口
//
// 单入口 default 导出 PluginDefinition（meta + tools + hooks + services）。
// 工具按领域聚合于 tools/（files/agent/session/timer/subagent/app/web），
// 钩子按领域聚合于 hooks/（memory/session/prompt/mcp/run/security）。
// 服务（timer/sub-agent）经 plugin.services 声明，L5 useService 惰性装载。
//
// 依赖方向：仅依赖 src/core + @agents/config + 本层（相对导入）。
// ============================================================

import type { PluginDefinition, PluginServices, PluginServiceContext } from '../types';
import type { AgentConfig } from '@agents/config';
import type { Tool } from '@core/types';
import { makeFileTools } from './tools/files';
import { makeAgentTools } from './tools/agent';
import { makeSessionTools } from './tools/session';
import { makeTimerTools } from './tools/timer';
import { makeSubagentTools } from './tools/subagent';
import { makeAppTools } from './tools/app';
import { makeWebTools } from './tools/web';
import { builtinHooks } from './hooks';
import { loadHistory, agentOfDialog, toPersistedRole, logRunUsage } from './hooks/session';
import { loadMemory } from './hooks/memory';
import { buildSystemPrompt } from './hooks/prompt';
import { TimerManager } from './services/timer';
import { SubAgentManager } from './services/subagent';

/** 内置工具工厂：全部领域（files/agent/session/timer/subagent/app/web） */
export function builtinTools(config: AgentConfig, services: PluginServices): Tool[] {
  return [
    ...makeFileTools(config),
    ...makeAgentTools(config, services),
    ...makeSessionTools(config, services),
    ...makeTimerTools(config, services),
    ...makeSubagentTools(config, services),
    ...makeAppTools(config, services),
    ...makeWebTools(config, services),
  ];
}

/** 内置插件定义 */
const plugin: PluginDefinition = {
  meta: { name: 'builtin', label: '内置', description: '核心工具与 prompt/session/memory 装配' },
  // 工具工厂：per-Agent 烘焙（沙箱 + tool.* 配置 + 身份）
  tools: builtinTools,
  hooks: builtinHooks,
  // 对外暴露的服务：L5 经 useService(name) 惰性装载
  services: {
    // 会话服务（AgentAssembly.loadHistory 实现等）
    'loadHistory': () => loadHistory,
    'agentOfDialog': () => agentOfDialog,
    'toPersistedRole': () => toPersistedRole,
    'logRunUsage': () => logRunUsage,
    // 记忆服务
    'loadMemory': () => loadMemory,
    // 提示词装配
    'buildSystemPrompt': () => buildSystemPrompt,
    // 定时任务 / 子 Agent 运行时
    'timer': (ctx: PluginServiceContext) => new TimerManager({
      workspaceDir: ctx.workspaceDir,
      agentsDir: ctx.agentsDir,
      timezone: ctx.timezone,
      holidays: ctx.holidays as string[] | undefined,
      makeupWorkdays: ctx.makeupWorkdays as string[] | undefined,
      globalTimer: ctx.globalTimer as never,
      // L5 装配经 setServiceContext 注入（__archive_all__ / __backup_all__ 特殊 hint 用）
      archiveAll: ctx.archiveAll as (() => { length: number }) | undefined,
      backupAll: ctx.backupAll as (() => { skipped: boolean; file?: string; size?: number }) | undefined,
    }),
    'subagent': () => new SubAgentManager(),
  },
};

export default plugin;

// 服务类与函数（具名导出，供 L5 装配类型引用 / 兼容；实例统一走 useService）
export { TimerManager, parseInterval } from './services/timer';
export { SubAgentManager } from './services/subagent';
export { loadHistory, agentOfDialog, toPersistedRole, logRunUsage } from './hooks/session';
export { loadMemoryToMessages, updateMemory, loadMemory, makeLoadMemoryHook } from './hooks/memory';
export { buildSystemPrompt } from './hooks/prompt';
export { makeSecurityStartHook } from './hooks/security';
export { makeOpenMCPHook } from './hooks/mcp';
export { makeBuildSystemPromptHook, makeLoadHistoryHook, makeIdleResetHook, makeArchiveSessionHook } from './hooks/run';
export { estimateTokens } from './tools/shared';
export { NS_SECURITY, NS_AGENT_MCP, NS_AGENT_PROMPT, NS_AGENT_MEMORY, NS_AGENT_SESSION, NS_TOOL_BASH, NS_TOOL_WEB_SEARCH } from './namespaces';
