// ============================================================
// send_group 工具 —— 向群聊发送消息
//
// 设计原则：
//   1. 无状态设计：每次调用独立投递
//   2. 投递即返回：不等待其他 Agent 回复
//   3. 消息持久化到群聊共享日志
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
      name: 'send_group',
      description:
        '向群聊发送消息，投递后立即返回，不等待回复。',
      parameters: {
        type: 'object',
        properties: {
          group_id: {
            type: 'string',
            description: '目标群聊 ID（通过 list_groups 获取）',
          },
          message: {
            type: 'string',
            description: '消息内容',
          },
        },
        required: ['group_id', 'message'],
      },
    },
  },
  ...meta,

  extractLabel: (args: Record<string, any>) => {
    return `→ group:${args.group_id || '?'}`;
  },

  execute: async (args: Record<string, any>) => {
    const state = getAppState();
    const router = state.router;
    if (!router) {
      return `[send_group] 错误：AgentRouter 未注册到 AppState。`;
    }
    const r = router as AgentRouter;

    const GroupManager = r.getGroupManager();
    if (!GroupManager) {
      return `[send_group] 错误：GroupManager 未初始化。`;
    }

    const groupId = args.group_id as string;
    const { message } = args;
    const from = args.from as string; // 由 interceptor 注入

    const group = GroupManager.getGroup(groupId);
    if (!room) {
      const rooms = GroupManager.listGroups();
      const roomList = rooms.length > 0
        ? rooms.map(r => `  - ${r.room_id}: ${r.name} (${r.participants.join(', ')})`).join('\n')
        : '  当前无可用群聊';
      return `[send_group] 错误：群聊 "${groupId}" 不存在。\n\n可用群聊：\n${roomList}`;
    }

    if (!GroupManager.isParticipant(groupId, from)) {
      return `[send_group] 错误：你不在群聊 "${groupId}" 中。当前参与者：${group.participants.join(', ')}`;
    }

    const correlationId = `room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const result = GroupManager.deliverGroupMessage({
        from,
        to: '*', // 群聊投递不使用 to 字段
        type: 'group.message',
        payload: message,
        correlation_id: correlationId,
        room_id: groupId,
        data: { content: message },
      });

      return `消息已投递到群聊 "${group.name}" (${groupId})，` +
        `已触发 ${result.triggered.length} 个参与者：${result.triggered.join(', ') || '(无)'}`;
    } catch (err: any) {
      return `[send_group] 投递失败：${err.message}`;
    }
  },
};
