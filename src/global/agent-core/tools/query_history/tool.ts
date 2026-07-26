// ============================================================
// query_history 工具 —— 查询聊天历史记录
//
// 用途：
//   让 Agent 查询自己与其他 Agent（或用户）的聊天历史记录、
//   或在群聊房间中的对话记录，方便定时任务/回忆过往对话上下文。
//
// 参数：
//   agent_id — 对方 Agent ID 或 "user"（与 room_id 二选一）
//   room_id  — 群聊房间 ID（与 agent_id 二选一）
//   keyword  — 可选关键词过滤
//   limit    — 返回上限，默认 20，最大 100
//   offset   — 分页偏移，默认 0
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getAppState } from '@core/app-state';
import { IMessageQuery } from '@routing/message-query';
import type { PersistedMessage } from '@global/agent-core/extensions/agent-session/types';
import type { AgentRegistry } from '@routing/registry';
import * as fs from 'fs';
import { resolveRoomMessagePath } from '@routing/room-manager';

// ============================================================
// 格式化单条消息为一行摘要
// ============================================================

function formatMessage(msg: PersistedMessage, selfId: string): string {
  const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleString('zh-CN') : '未知时间';
  const roleLabel = msg.agent_id === 'user' ? '👤用户'
    : msg.agent_id === selfId ? '🤖自己'
    : `🤖${msg.agent_id || '?'}`;

  let contentPreview = '';
  if (msg.role === 'tool') {
    const toolName = msg.name || '工具';
    contentPreview = `[工具: ${toolName}] ${(msg.content || '').slice(0, 150)}`;
  } else if (msg.tool_calls && msg.tool_calls.length > 0) {
    const toolNames = msg.tool_calls.map(tc => tc.function.name).join(', ');
    contentPreview = `[调用工具: ${toolNames}]`;
    if (msg.content) contentPreview += ' ' + msg.content.slice(0, 100);
  } else {
    contentPreview = (msg.content || '').slice(0, 200);
    if ((msg.content || '').length > 200) contentPreview += '...';
  }

  const label = msg.label ? ` [${msg.label}]` : '';
  return `[${ts}] ${roleLabel}${label}: ${contentPreview}`;
}

// ============================================================
// 工具定义
// ============================================================

export const tool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'query_history',
      description:
        '查询聊天历史。agent_id 与 room_id 二选一：前者查 1:1 对话，后者查群聊记录。' +
        '支持 keyword 过滤和 limit/offset 分页，默认最近 20 条。',
      parameters: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: '对方 Agent ID。',
          },
          room_id: {
            type: 'string',
            description: '群聊房间 ID。',
          },
          keyword: {
            type: 'string',
            description: '关键词过滤（可选）。',
          },
          limit: {
            type: 'number',
            description: '返回上限，默认 20，最大 100。',
          },
          offset: {
            type: 'number',
            description: '分页偏移，默认 0（最新）。',
          },
        },
        required: [],
      },
    },
  },
  ...meta,

  extractLabel: (args: Record<string, any>) => {
    if (args.room_id) return `房间 ${args.room_id}`;
    const id = args.agent_id as string | undefined;
    if (!id) return '查询聊天历史';
    // 通过 registry 解析 Agent 友好名称（含 user 等虚拟 Agent）
    try {
      const registry = getAppState().registry as AgentRegistry | undefined;
      if (registry?.has(id)) {
        const name = registry.getAgentName(id);
        return `与 ${name} 的聊天记录`;
      }
    } catch { /* registry 不可用时回退到原始 ID */ }
    return `与 ${id} 的聊天记录`;
  },

  execute: async (args: Record<string, any>) => {
    const selfId = args.from as string;
    const counterpart = args.agent_id as string | undefined;
    const roomId = args.room_id as string | undefined;

    if (!selfId) {
      return `[query_history] 错误：无法确定当前 Agent ID。`;
    }

    if (!counterpart && !roomId) {
      return `[query_history] 错误：请提供 agent_id（对方 Agent ID 或 "user"）或 room_id（群聊房间 ID）。`;
    }

    const limit = Math.min(args.limit || 20, 100);
    const offset = args.offset || 0;
    const keyword = args.keyword as string | undefined;

    try {
      let messages: PersistedMessage[];

      if (roomId) {
        // ---- 群聊房间历史 ----
        const roomMsgPath = resolveRoomMessagePath(roomId);
        if (!fs.existsSync(roomMsgPath)) {
          return `[query_history] 房间 "${roomId}" 没有聊天记录。`;
        }

        const allLines = fs.readFileSync(roomMsgPath, 'utf-8').trim().split('\n').filter(Boolean);
        messages = allLines.map(line => {
          try { return JSON.parse(line) as PersistedMessage; } catch { return null; }
        }).filter(Boolean) as PersistedMessage[];

        // 倒序 → 分页 → 过滤
        messages.reverse();
        const total = messages.length;
        messages = messages.slice(offset, offset + limit);
        if (keyword) {
          const kw = keyword.toLowerCase();
          messages = messages.filter(m => (m.content || '').toLowerCase().includes(kw));
        }
        messages.reverse(); // 恢复正序展示

        if (messages.length === 0) {
          const kwHint = keyword ? `（含关键词 "${keyword}"）` : '';
          return `[query_history] 房间 "${roomId}" 没有聊天记录${kwHint}。`;
        }

        const lines = [`群聊房间 "${roomId}" 的聊天记录${keyword ? `（关键词: "${keyword}"）` : ''}：`,
          `共 ${total} 条，当前第 ${offset + 1}~${Math.min(offset + messages.length, total)} 条：`, ''];
        for (const msg of messages) lines.push(formatMessage(msg, selfId));
        if (total > offset + limit) {
          lines.push(`\n（还有 ${total - offset - limit} 条更早的消息，使用 offset=${offset + limit} 继续查询）`);
        }
        return lines.join('\n');
      }

      // ---- 1:1 对话历史 ----
      const state = getAppState();
      const messageQuery = state.messageQuery as IMessageQuery | undefined;
      if (!messageQuery) {
        return `[query_history] 错误：MessageQuery 未注册。可用键：${Object.keys(state).join(', ') || '(无)'}`;
      }

      messages = await messageQuery.query({ from: selfId, to: counterpart!, limit: limit + offset, offset: 0 });
      const total = messages.length;
      messages = messages.slice(offset, offset + limit);

      if (keyword) {
        const kw = keyword.toLowerCase();
        messages = messages.filter(m => (m.content || '').toLowerCase().includes(kw));
      }

      if (messages.length === 0) {
        const kwHint = keyword ? `（含关键词 "${keyword}"）` : '';
        return `[query_history] 与 "${counterpart}" 没有聊天记录${kwHint}。`;
      }

      const label = counterpart === 'user' ? '人类用户' : counterpart;
      const lines = [`与 ${label} 的聊天记录${keyword ? `（关键词: "${keyword}"）` : ''}：`,
        `共 ${total} 条，当前第 ${offset + 1}~${Math.min(offset + messages.length, total)} 条：`, ''];
      for (const msg of messages) lines.push(formatMessage(msg, selfId));
      if (total > offset + limit) {
        lines.push(`\n（还有 ${total - offset - limit} 条更早的消息，使用 offset=${offset + limit} 继续查询）`);
      }
      return lines.join('\n');
    } catch (err: any) {
      return `[query_history] 查询失败：${err.message}`;
    }
  },
};
