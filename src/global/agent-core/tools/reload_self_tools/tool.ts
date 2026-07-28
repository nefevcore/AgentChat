// ============================================================
// reload_self_tools 工具 —— 运行时热加载 Agent 自身工具
//
// 使用场景：Agent 通过 bash/write 创建了新工具文件后，
// 调用此工具扫描自身 tools/ 目录，注册新工具，下一轮 LLM 即可使用。
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getAppState } from '@core/app-state';
import { getGlobalConfig } from '@core/config';
import { discoverTools } from '@discovery/agent-loader';
import type { AgentRegistry } from '@routing/registry';
import * as path from 'path';
import { logger } from '@utils/logger';

export const tool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'reload_self_tools',
      description:
        '扫描当前 Agent 的 tools/ 目录，热加载新增或修改过的工具文件。' +
        '当你创建了新工具（通过 write/bash 写入 tools/ 下的 tool.ts）后，调用此工具即可立即使用新工具，无需重启。' +
        '返回加载结果：新增了哪些工具、跳过了哪些、总数。',
      parameters: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: '要重载工具的 Agent ID（通常是你自己的 agent_id）',
          },
        },
        required: ['agent_id'],
      },
    },
  },
  ...meta,

  execute: async (args: Record<string, any>) => {
    const agentId = args.agent_id as string;
    if (!agentId) {
      return JSON.stringify({ status: 'error', data: { message: '缺少 agent_id 参数' } });
    }

    // 获取运行时引用
    const state = getAppState();
    const registry = state.registry as AgentRegistry | undefined;
    if (!registry) {
      return JSON.stringify({ status: 'error', data: { message: 'AgentRegistry 未初始化' } });
    }

    const agent = registry.getAgent(agentId);
    if (!agent) {
      return JSON.stringify({
        status: 'error',
        data: { message: `未找到 Agent: ${agentId}` },
      });
    }

    // 扫描 Agent 的 tools/ 目录
    const agentsDir = getGlobalConfig().agentsDir;
    const toolsDir = path.join(agentsDir, agentId, 'tools');

    let discovered: Map<string, Tool>;
    try {
      discovered = discoverTools(toolsDir);
    } catch (err: any) {
      return JSON.stringify({
        status: 'error',
        data: { message: `扫描工具目录失败: ${err.message}` },
      });
    }

    // 对比当前已注册的工具，找出新增的
    const currentNames = new Set(agent.getToolNames?.() ?? []);
    const newTools: string[] = [];
    const updatedTools: string[] = [];

    for (const [name, tool] of discovered) {
      if (currentNames.has(name)) {
        updatedTools.push(name);
      } else {
        newTools.push(name);
      }
      // 注册/覆盖工具（loadModule 已清除 require.cache，会加载最新代码）
      agent.registerTool(tool);
    }

    logger.info(
      `[reload_self_tools] Agent "${agentId}": ` +
      `新增 ${newTools.length} 个工具 (${newTools.join(', ') || '无'}), ` +
      `更新 ${updatedTools.length} 个工具 (${updatedTools.join(', ') || '无'}), ` +
      `共 ${discovered.size} 个工具`
    );

    return JSON.stringify({
      status: 'ok',
      data: {
        agent_id: agentId,
        total: discovered.size,
        newly_loaded: newTools,
        updated: updatedTools,
        message: newTools.length > 0
          ? `已加载 ${newTools.length} 个新工具: ${newTools.join(', ')}。下一轮对话即可使用。`
          : updatedTools.length > 0
            ? `已更新 ${updatedTools.length} 个工具: ${updatedTools.join(', ')}。`
            : '未发现新工具或变更。',
      },
    });
  },
};
