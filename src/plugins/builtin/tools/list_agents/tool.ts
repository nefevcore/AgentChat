// ============================================================
// list_agents 工具 —— 获取 Agent 清单
//
// 设计原则：
//   1. 无参数调用，返回所有已注册 Agent 的 ID 和名称
//   2. 通过 getAppState().registry 获取运行时 AgentRegistry
//   3. 虚拟 Agent 和真实 Agent 都会列出
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getAppState } from '@agents/app-state';
import type { AgentRegistry } from '@agents/registry';

// ---- 工具定义 ----

export const tool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_agents',
      description:
        '列出所有可用 Agent 的 ID、名称和类型（虚拟/真实）。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  ...meta,

  execute: async (_args: Record<string, any>) => {
    const state = getAppState();
    const registry = state.registry;
    if (!registry) {
      return `[list_agents] 错误：AgentRegistry 未注册到 AppState。可用键：${Object.keys(state).join(', ') || '(无)'}`;
    }
    const reg = registry as AgentRegistry;

    const ids = reg.listIds();
    const agents = ids.map((id) => ({
      id,
      name: reg.getAgentName(id),
      type: reg.isVirtual(id) ? 'virtual' : 'agent',
    }));

    const virtualCount = agents.filter((a) => a.type === 'virtual').length;
    const agentCount = agents.filter((a) => a.type === 'agent').length;

    const summary = `共 ${agents.length} 个 Agent（${agentCount} 个真实 Agent，${virtualCount} 个虚拟 Agent）`;
    const list = agents
      .map((a) => `  - ${a.id}: ${a.name}`)
      .join('\n');

    return `${summary}\n\n${list}`;
  },
};
