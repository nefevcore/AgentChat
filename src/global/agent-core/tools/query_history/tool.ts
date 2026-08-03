// ============================================================
// query_history 工具 —— 查询聊天历史记录
//
// 用途：
//   让 Agent 查询自己与其他 Agent（或用户）的聊天历史记录、
//   或在房间中的对话记录，方便定时任务/回忆过往对话上下文。
//
// 参数：
//   agent_id — 对方 Agent ID 或 "user"（与 group_id 二选一）
//   group_id  — 群组 ID（与 agent_id 二选一）
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
import { resolveGroupMessagePath } from '@routing/group-manager';
import { estimateTokens } from '@utils/tokens';

// ============================================================
// 工具结果预览截取（token 预算）
// ============================================================

/** 工具结果预览的 token 预算 —— 历史查询中工具调用结果通常没必要看全（2026-08-03） */
const TOOL_PREVIEW_TOKENS = 100;

/**
 * 按 token 预算截取文本。
 * keepTail=true：保留尾部 —— 工具结果的错误/关键输出通常在末尾，
 *   且开头多为 JSON 结构样板（如 {"status":"success","data":{...}），
 *   与 bash 工具"输出超限保留末尾（错误通常在尾部）"的既有惯例一致。
 * keepTail=false：保留头部（自然语言/思考过程）。
 * 超出预算时加省略标记（…）。
 */
export function clipByTokens(text: string, budgetTokens: number, keepTail: boolean): string {
  if (!text) return '';
  if (estimateTokens(text) <= budgetTokens) return text;

  const isCjk = (ch: string) => /[\u4e00-\u9fff]/.test(ch);
  let out = '';
  let tokens = 0;
  // 预留省略标记（…）自身的 token 空间，保证 content + 标记 不超预算
  const markerMargin = 1;

  if (keepTail) {
    // 从尾部累积到预算，保留末尾
    for (let i = text.length - 1; i >= 0; i--) {
      tokens += isCjk(text[i]) ? 0.6 : 0.3;
      if (tokens + markerMargin > budgetTokens) break;
      out = text[i] + out;
    }
    return `…${out}`;
  }
  // 保留头部
  for (const ch of text) {
    tokens += isCjk(ch) ? 0.6 : 0.3;
    if (tokens + markerMargin > budgetTokens) break;
    out += ch;
  }
  return `${out}…`;
}

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
    contentPreview = `[工具: ${toolName}] ${clipByTokens(msg.content || '', TOOL_PREVIEW_TOKENS, true)}`;
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
        '查询聊天历史。agent_id 与 group_id 二选一：前者查 1:1 对话，后者查群聊记录。' +
        '支持 keyword 过滤和 limit/offset 分页，默认最近 20 条。',
      parameters: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: '对方 Agent ID。',
          },
          group_id: {
            type: 'string',
            description: '群聊 ID。',
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
    if (args.group_id) return `群聊 ${args.group_id}`;
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
    const groupId = args.group_id as string | undefined;

    if (!selfId) {
      return `[query_history] 错误：无法确定当前 Agent ID。`;
    }

    if (!counterpart && !groupId) {
      return `[query_history] 错误：请提供 agent_id（对方 Agent ID 或 "user"）或 group_id（群聊 ID）。`;
    }

    const limit = Math.min(args.limit || 20, 100);
    const offset = args.offset || 0;
    const keyword = args.keyword as string | undefined;

    try {
      let messages: PersistedMessage[];

      if (groupId) {
        // ---- 房间历史 ----
        const groupMsgPath = resolveGroupMessagePath(groupId);
        if (!fs.existsSync(groupMsgPath)) {
          return `[query_history] 群聊 "${groupId}" 没有聊天记录。`;
        }

        const allLines = fs.readFileSync(groupMsgPath, 'utf-8').trim().split('\n').filter(Boolean);
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
          return `[query_history] 群聊 "${groupId}" 没有聊天记录${kwHint}。`;
        }

        const lines = [`群聊 "${groupId}" 的聊天记录${keyword ? `（关键词: "${keyword}"）` : ''}：`,
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

      messages = await messageQuery.query({ from: selfId, to: counterpart!, limit, offset });
      const total = messages.filter(m => m.role !== 'tool').length;


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
