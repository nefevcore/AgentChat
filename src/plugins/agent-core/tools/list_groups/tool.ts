// ============================================================
// list_groups 工具 —— 获取群聊清单
//
// 设计原则：
//   1. 无参数调用，返回所有群聊信息
//   2. 标注当前 Agent 参与的/未参与的群聊
//   3. 通过 getAppState().router 获取 GroupManager
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getAppState } from '@core/app-state';
import type { AgentRouter } from '@routing/router';

// ---- 工具定义 ----

export const tool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_groups',
      description:
        '列出所有群聊，含 ID、名称、参与者，并标注当前 Agent 是否在其中。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  ...meta,

  execute: async (args: Record<string, any>) => {
    const state = getAppState();
    const router = state.router;
    if (!router) {
      return `[list_groups] 错误：AgentRouter 未注册到 AppState。`;
    }
    const r = router as AgentRouter;

    const GroupManager = r.getGroupManager();
    if (!GroupManager) {
      return `[list_groups] 错误：GroupManager 未初始化。`;
    }

    const from = args.from as string; // 由 interceptor 注入
    const allGroups = GroupManager.listGroups();

    if (allGroups.length === 0) {
      return '当前没有任何群聊。';
    }

    const myGroups = GroupManager.listGroupsForAgent(from);
    const otherGroups = allGroups.filter(r => !myGroups.includes(r));

    let result = `共 ${allGroups.length} 个群聊（你参与了 ${myGroups.length} 个）：\n\n`;

    if (myGroups.length > 0) {
      result += '【我的群聊】\n';
      for (const group of myGroups) {
        const others = group.participants.filter(p => p !== from);
        result += `  - ${group.group_id}: ${group.name}\n`;
        result += `    参与者：${group.participants.join(', ')}\n`;
        if (group.description) {
          result += `    描述：${group.description}\n`;
        }
      }
    }

    if (otherGroups.length > 0) {
      result += '\n【其他群聊】\n';
      for (const group of otherGroups) {
        result += `  - ${group.group_id}: ${group.name} (${group.participants.length} 人)\n`;
      }
    }

    return result;
  },
};
