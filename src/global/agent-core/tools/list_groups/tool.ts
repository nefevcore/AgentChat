// ============================================================
// list_groups 工具 —— 获取群聊清单
//
// 设计原则：
//   1. 无参数调用，返回所有群聊信息
//   2. 标注当前 Agent 参与的/未参与的群聊
//   3. 通过 getAppState().router 获取 RoomManager
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

    const roomManager = r.getRoomManager();
    if (!roomManager) {
      return `[list_groups] 错误：RoomManager 未初始化。`;
    }

    const from = args.from as string; // 由 interceptor 注入
    const allRooms = roomManager.listRooms();

    if (allRooms.length === 0) {
      return '当前没有任何群聊。';
    }

    const myRooms = roomManager.listRoomsForAgent(from);
    const otherRooms = allRooms.filter(r => !myRooms.includes(r));

    let result = `共 ${allRooms.length} 个群聊（你参与了 ${myRooms.length} 个）：\n\n`;

    if (myRooms.length > 0) {
      result += '【我的群聊】\n';
      for (const room of myRooms) {
        const others = room.participants.filter(p => p !== from);
        result += `  - ${room.room_id}: ${room.name}\n`;
        result += `    参与者：${room.participants.join(', ')}\n`;
        if (room.description) {
          result += `    描述：${room.description}\n`;
        }
      }
    }

    if (otherRooms.length > 0) {
      result += '\n【其他群聊】\n';
      for (const room of otherRooms) {
        result += `  - ${room.room_id}: ${room.name} (${room.participants.length} 人)\n`;
      }
    }

    return result;
  },
};
