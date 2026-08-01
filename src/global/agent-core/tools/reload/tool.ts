// ============================================================
// reload 工具 —— 统一热加载（v0.4.0 合并 reload_self_tools + reload_extensions）
//
// scope:
//   self   重载当前 Agent 的 tools/（自举工具开发）
//   global 重载全局扩展（PreHook/PostHook/Interceptor）+ 全局工具
//   all    两者都做（默认）
//
// 旧工具 reload_self_tools / reload_extensions 保留为别名（内部转发到此工具）。
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getAppState } from '@core/app-state';
import { getGlobalConfig } from '@core/config';
import { discoverTools, reloadGlobalExtensions } from '@discovery/agent-loader';
import type { AgentRegistry } from '@routing/registry';
import type { Agent } from '@core/agent';
import * as path from 'path';
import { logger } from '@utils/logger';

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'reload',
      description:
        '热加载工具与扩展。scope=self 重载自己的 tools/ 目录（创建新工具后调用即可用）；scope=global 重载全局扩展与全局工具（修改 src/global/agent-core/ 后调用，所有 Agent 生效）；scope=all 两者都做（默认）。',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string', enum: ['self', 'global', 'all'],
            description: '重载范围（默认 all）',
          },
        },
        required: [],
      },
    },
  },

  extractLabel: (args: Record<string, any>) => `⟳ ${args.scope || 'all'}`,

  execute: async (args: Record<string, any>): Promise<string> => {
    const scope = (args.scope || 'all') as string;
    const results: Record<string, any> = {};
    const errors: string[] = [];

    // ---- self：重载自己的 tools/ ----
    if (scope === 'self' || scope === 'all') {
      try {
        const selfId = args.from as string;
        const state = getAppState();
        const registry = state.registry as AgentRegistry | undefined;
        const agent = selfId ? (registry?.getAgent(selfId) as Agent | undefined) : undefined;
        if (!agent) {
          throw new Error(`Agent "${selfId}" 不存在`);
        }
        const toolsDir = path.join(getGlobalConfig().agentsDir, selfId, 'tools');
        const discovered = discoverTools(toolsDir);
        const currentNames = new Set(agent.getToolNames());
        const newTools: string[] = [];
        const updatedTools: string[] = [];
        for (const [name, t] of discovered) {
          if (currentNames.has(name)) updatedTools.push(name);
          else newTools.push(name);
          (agent as any).registerTool(t);
        }
        results.self = {
          agent_id: selfId,
          total: discovered.size,
          newly_loaded: newTools,
          updated: updatedTools,
        };
        logger.info(`[reload] self ${selfId}: +${newTools.length} new, ~${updatedTools.length} updated`);
      } catch (err: any) {
        errors.push(`self: ${err.message}`);
      }
    }

    // ---- global：重载全局扩展 + 工具 ----
    if (scope === 'global' || scope === 'all') {
      try {
        const state = getAppState();
        const registry = state.registry as AgentRegistry;
        const agentMap = state.agentMap as Map<string, Agent>;
        const srcRoot = state.srcRoot as string;
        if (!agentMap || agentMap.size === 0) {
          throw new Error('没有运行中的 Agent，无法热加载');
        }
        const globalDir = path.join(srcRoot, 'global');
        const { extensions, interceptors, tools } = reloadGlobalExtensions(globalDir);

        const agentIds: string[] = [];
        let totalPreHooks = 0, totalPostHooks = 0, totalTools = 0;
        for (const [agentId, agent] of agentMap) {
          const config = (agent as any).config;
          if (!config) continue;
          const preHookNames: string[] = config.pre_hooks ?? [];
          const postHookNames: string[] = config.post_hooks ?? [];
          const newPreHooks = preHookNames
            .map((name: string) => extensions.get(name)?.preHook)
            .filter((h): h is NonNullable<typeof h> => h != null);
          const newPostHooks = postHookNames
            .map((name: string) => extensions.get(name)?.postHook)
            .filter((h): h is NonNullable<typeof h> => h != null);
          const currentToolNames = agent.getToolNames();
          const allNewTools: any[] = [];
          const currentToolsMap: Map<string, any> = (agent as any).tools;
          for (const name of currentToolNames) {
            const newTool = tools.get(name);
            if (newTool) allNewTools.push(newTool);
            else {
              const oldTool = currentToolsMap?.get(name);
              if (oldTool) allNewTools.push(oldTool);
            }
          }
          agent.reload({ config, tools: allNewTools, preHooks: newPreHooks, postHooks: newPostHooks, interceptors });
          agentIds.push(agentId);
          totalPreHooks += newPreHooks.length;
          totalPostHooks += newPostHooks.length;
          totalTools += allNewTools.length;
        }
        results.global = {
          agents_reloaded: agentIds.length,
          agents: agentIds,
          tools_loaded: tools.size,
          extensions_loaded: extensions.size,
          interceptors_loaded: interceptors.length,
          total_pre_hooks: totalPreHooks,
          total_post_hooks: totalPostHooks,
          total_tools: totalTools,
        };
        logger.info(`[reload] global: ${agentIds.length} agents, ${tools.size} tools, ${extensions.size} ext`);
      } catch (err: any) {
        errors.push(`global: ${err.message}`);
      }
    }

    return JSON.stringify({
      status: errors.length === 0 ? 'ok' : 'error',
      data: { results, errors: errors.length ? errors : undefined },
    });
  },
};
