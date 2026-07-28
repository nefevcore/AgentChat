// ============================================================
// reload_extensions 工具 —— 热加载全局扩展/工具（无需重启）
//
// 与 reload_self_tools 不同，此工具重载全局扩展（PreHook/PostHook/Interceptor）
// 和全局工具（read/write/edit/bash 等），并应用到所有运行中的 Agent。
// ============================================================

import { Tool } from '@core/types';
import { getAppState } from '@core/app-state';
import { reloadGlobalExtensions } from '@discovery/agent-loader';
import type { AgentRegistry } from '@routing/registry';
import type { Agent } from '@core/agent';
import { logger } from '@utils/logger';
import * as path from 'path';
import { meta } from './meta';

export const tool: Tool = {
  ...meta,
  definition: {
    type: 'function',
    function: {
      name: 'reload_extensions',
      description:
        '热加载全局扩展（PreHook/PostHook/Interceptor）和全局工具，如 agent-prompt、agent-session、agent-memory、read、edit 等。' +
        '修改了 src/global/agent-core/ 下的代码后调用此工具，所有 Agent 立即生效，无需重启。' +
        '返回加载结果：加载了几个工具、几个扩展、几个拦截器。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },

  execute: async (_args: Record<string, any>): Promise<string> => {
    try {
      const state = getAppState();
      const registry = state.registry as AgentRegistry;
      const agentMap = state.agentMap as Map<string, Agent>;
      const srcRoot = state.srcRoot as string;

      if (!agentMap || agentMap.size === 0) {
        return JSON.stringify({ status: 'error', data: { message: '没有运行中的 Agent，无法热加载。' } });
      }

      const globalDir = path.join(srcRoot, 'global');

      // 1. 重新扫描全局插件（tools + extensions + interceptors，cache bust + re-import）
      const { extensions, interceptors, tools } = reloadGlobalExtensions(globalDir);

      // 2. 为每个 Agent 重建钩子 + 工具并应用
      const agentIds: string[] = [];
      let totalPreHooks = 0;
      let totalPostHooks = 0;
      let totalInterceptors = 0;
      let totalTools = 0;

      for (const [agentId, agent] of agentMap) {
        const config = (agent as any).config;
        if (!config) continue;

        // 根据 Agent 配置选择对应的扩展钩子
        const preHookNames: string[] = config.pre_hooks ?? [];
        const postHookNames: string[] = config.post_hooks ?? [];

        const newPreHooks = preHookNames
          .map((name: string) => extensions.get(name)?.preHook)
          .filter((h): h is NonNullable<typeof h> => h != null);
        const newPostHooks = postHookNames
          .map((name: string) => extensions.get(name)?.postHook)
          .filter((h): h is NonNullable<typeof h> => h != null);

        // 获取 Agent 所有当前工具名称，尝试从新的全局工具池中加载替换
        // 这同时覆盖了 config.tools 声明的工具和 autoInject 工具
        const currentToolNames = agent.getToolNames();
        const allNewTools: any[] = [];
        const currentToolsMap: Map<string, any> = (agent as any).tools;
        for (const name of currentToolNames) {
          // 优先从新工具池取，取不到保留旧实例
          const newTool = tools.get(name);
          if (newTool) {
            allNewTools.push(newTool);
          } else {
            const oldTool = currentToolsMap?.get(name);
            if (oldTool) allNewTools.push(oldTool);
          }
        }

        agent.reload({
          config,
          tools: allNewTools,
          preHooks: newPreHooks,
          postHooks: newPostHooks,
          interceptors,
        });

        agentIds.push(agentId);
        totalPreHooks += newPreHooks.length;
        totalPostHooks += newPostHooks.length;
        totalInterceptors += interceptors.length;
        totalTools += allNewTools.length;
      }

      logger.info(
        `[reload_extensions] 已重载 ${agentIds.length} 个 Agent: ` +
        `${tools.size} tools, ${extensions.size} extensions, ${interceptors.length} interceptors`
      );

      return JSON.stringify({
        status: 'success',
        data: {
          agents_reloaded: agentIds.length,
          agents: agentIds,
          tools_loaded: tools.size,
          tool_names: Array.from(tools.keys()),
          extensions_loaded: extensions.size,
          extension_names: Array.from(extensions.keys()),
          interceptors_loaded: interceptors.length,
          total_pre_hooks: totalPreHooks,
          total_post_hooks: totalPostHooks,
          total_tools: totalTools,
        },
      });
    } catch (err: any) {
      return JSON.stringify({
        status: 'error',
        data: { message: err.message },
      });
    }
  },
};
