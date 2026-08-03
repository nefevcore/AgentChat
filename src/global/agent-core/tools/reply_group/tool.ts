// ============================================================
// reply_group 工具 —— 回复群聊消息（语义聚焦"回复"）
//
// 背景（2026-08-03）：send_group 语义是"向群聊发送消息"（主动发起），
// Agent 收到群聊 trigger 后常不调用它——因为 trigger 是"别人发来的消息"，
// 需要的是"回复"而非"发送"。reply_group 语义明确：回复群聊中的消息。
//
// 实现：与 send_group 完全相同的投递逻辑（deliverGroupMessage），
// 仅工具名/描述强调"回复"场景，引导 Agent 在收到群聊消息时使用。
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
      name: 'reply_group',
      description:
        '回复群聊中的消息：把回复发送到指定群聊，其他参与者会看到并可能继续讨论。' +
        '当你收到群聊消息（<msg group=...>）想回应时，用本工具发回群聊。' +
        '投递后立即返回，不等待其他 Agent 回复。',
      parameters: {
        type: 'object',
        properties: {
          group_id: {
            type: 'string',
            description: '目标群聊 ID（来自收到的群聊消息 group 属性，或 list_groups 获取）',
          },
          message: {
            type: 'string',
            description: '回复内容（只写你自己的话，不要复制收到的 <msg> 标签）',
          },
        },
        required: ['group_id', 'message'],
      },
    },
  },
  ...meta,

  extractLabel: (args: Record<string, any>) => {
    return `↩ group:${args.group_id || '?'}`;
  },

  execute: async (args: Record<string, any>) => {
    const state = getAppState();
    const router = state.router;
    if (!router) {
      return `[reply_group] 错误：AgentRouter 未注册到 AppState。`;
    }
    const r = router as AgentRouter;

    const GroupManager = r.getGroupManager();
    if (!GroupManager) {
      return `[reply_group] 错误：GroupManager 未初始化。`;
    }

    const groupId = args.group_id as string;
    const { message } = args;
    const from = args.from as string; // 由 interceptor 注入

    const group = GroupManager.getGroup(groupId);
    if (!group) {
      const groups = GroupManager.listGroups();
      const groupList = groups.length > 0
        ? groups.map(g => `  - ${g.group_id}: ${g.name} (${g.participants.join(', ')})`).join('\n')
        : '  当前无可用群聊';
      return `[reply_group] 错误：群聊 "${groupId}" 不存在。\n\n可用群聊：\n${groupList}`;
    }

    if (!GroupManager.isParticipant(groupId, from)) {
      return `[reply_group] 错误：你不在群聊 "${groupId}" 中。当前参与者：${group.participants.join(', ')}`;
    }

    const correlationId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const result = await GroupManager.deliverGroupMessage({
        from,
        to: '*', // 群聊投递不使用 to 字段
        type: 'group.message',
        payload: message,
        correlation_id: correlationId,
        group_id: groupId,
        data: { content: message },
      });

      return `回复已发送到群聊 "${group.name}" (${groupId})，` +
        `已触发 ${result.triggered.length} 个参与者：${result.triggered.join(', ') || '(无)'}`;
    } catch (err: any) {
      return `[reply_group] 投递失败：${err.message}`;
    }
  },
};
