// ============================================================
// list_tools 工具 —— 列出可用工具供 Agent 自查
//
// 背景（v0.4.0 工具集管理）：
//   并非所有 Agent 都需要全部工具。autoInject 注入的是框架级
//   基础设施，业务工具（如 subagent/code_search/inspect_session）
//   由 Agent 按需启用。
//
// 本工具列出：
//   · global_pool   —— 全部全局工具（含未启用的）
//   · agent_tools   —— 当前 Agent 已配置的工具（config.json tools）
//   · enabled       —— 当前实际可用的工具名集合（config.tools + autoInject）
//   · available     —— 当前未启用但可添加的全局工具
//
// Agent 据此判断缺口，用 manage_plugins({ tools: [...] })
// 更新自己的工具清单。
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getAppState } from '@core/app-state';
import type { AgentRegistry } from '@routing/registry';
import type { Agent } from '@core/agent';

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'list_tools',
      description:
        '列出所有可用工具（全局 + Agent 专属）及其启用状态。用于发现可通过 manage_plugins 启用的工具。返回全局工具池、你当前的工具、已启用集合、可添加的工具。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },

  extractLabel: () => '🧰 工具清单',

  execute: async (args: Record<string, any>) => {
    try {
      const state = getAppState();
      const registry = state.registry as AgentRegistry;
      if (!registry) {
        return JSON.stringify({ status: 'error', data: { message: 'registry 未就绪' } });
      }

      // 当前 Agent：from 由拦截器注入
      const selfId = args.from as string;
      const self = selfId ? (registry.getAgent(selfId) as Agent | undefined) : undefined;
      const enabledTools = self?.getTools?.()
        ? [...self.getTools().keys()]
        : [];

      // 全局工具池：优先从 AppState.toolManager（bootstrap 注入），
      // 否则从 loader 的 getAllPlugins 扫描 plugin.json（重启后可用）
      let globalPool: string[] = [];
      const manager = state.toolManager as any;
      if (manager?.listTools) {
        globalPool = manager.listTools();
      } else if (state.loader) {
        const loader = state.loader as any;
        if (typeof loader?.getAllPlugins === 'function') {
          try {
            // getAllPlugins() 返回扁平 PluginMeta[]（type: 'tool' | 'pre_hook' | 'post_hook'）
            const plugins = loader.getAllPlugins() as Array<{ type?: string; name: string }>;
            globalPool = plugins.filter(p => p.type === 'tool').map(p => p.name);
          } catch { globalPool = enabledTools; }
        } else {
          globalPool = enabledTools;
        }
      } else {
        globalPool = enabledTools;
      }

      // 当前 Agent 配置声明的 tools（不含 autoInject）
      const configured = self?.config?.tools ?? [];

      // 可用但未启用（全局池 - 当前启用）
      const enabledSet = new Set(enabledTools);
      const available = [...new Set(globalPool)].filter(t => !enabledSet.has(t));

      return JSON.stringify({
        status: 'ok',
        data: {
          self_id: selfId,
          global_pool: [...new Set(globalPool)].sort(),
          configured_tools: [...configured].sort(),
          enabled_tools: enabledTools.sort(),
          available_tools: available.sort(),
          note: '通过 manage_plugins({ tools: [...] }) 更新工具清单；autoInject 工具始终可用无需配置',
        },
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
    }
  },
};
