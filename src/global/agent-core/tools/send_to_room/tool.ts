// ============================================================
// send_to_room 工具 —— 向群聊房间发送消息
//
// 设计原则：
//   1. 无状态设计：每次调用独立投递
//   2. 投递即返回：不等待其他 Agent 回复
//   3. 消息持久化到房间共享日志
//   4. 其他参与者异步接收通知
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
      name: 'send_to_room',
      description:
        '向群聊房间发送消息，投递后立即返回，不等待回复。',
      parameters: {
        type: 'object',
        properties: {
          room_id: {
            type: 'string',
            description: '目标房间 ID（通过 list_rooms 获取）',
          },
          message: {
            type: 'string',
            description: '消息内容',
          },
        },
        required: ['room_id', 'message'],
      },
    },
  },
  ...meta,

  extractLabel: (args: Record<string, any>) => {
    return `→ room:${args.room_id || '?'}`;
  },

  execute: async (args: Record<string, any>) => {
    const state = getAppState();
    const router = state.router;
    if (!router) {
      return `[send_to_room] 错误：AgentRouter 未注册到 AppState。`;
    }
    const r = router as AgentRouter;

    const roomManager = r.getRoomManager();
    if (!roomManager) {
      return `[send_to_room] 错误：RoomManager 未初始化。`;
    }

    const { room_id, message } = args;
    const from = args.from as string; // 由 interceptor 注入

    const room = roomManager.getRoom(room_id);
    if (!room) {
      const rooms = roomManager.listRooms();
      const roomList = rooms.length > 0
        ? rooms.map(r => `  - ${r.room_id}: ${r.name} (${r.participants.join(', ')})`).join('\n')
        : '  当前无可用房间';
      return `[send_to_room] 错误：房间 "${room_id}" 不存在。\n\n可用房间：\n${roomList}`;
    }

    if (!roomManager.isParticipant(room_id, from)) {
      return `[send_to_room] 错误：你不在房间 "${room_id}" 中。当前参与者：${room.participants.join(', ')}`;
    }

    const correlationId = `room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const result = roomManager.deliverRoomMessage({
        from,
        to: '*', // 房间投递不使用 to 字段
        type: 'room.message',
        payload: message,
        correlation_id: correlationId,
        room_id,
        data: { content: message },
      });

      return `消息已投递到房间 "${room.name}" (${room_id})，` +
        `已触发 ${result.triggered.length} 个参与者：${result.triggered.join(', ') || '(无)'}`;
    } catch (err: any) {
      return `[send_to_room] 投递失败：${err.message}`;
    }
  },
};
