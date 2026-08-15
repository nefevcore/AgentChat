// ============================================================
// @agentchat/session-tools —— 会话工具（query_history/continue_turn/inspect_session）
// 领域独立，可脱离 AgentChat 复用。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { defineTool, workspaceRoot, safeTruncate, chatSessionFile, groupSessionFile } from '@agentchat/toolkit';
import type { AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { ToolContext } from '@agentchat/tools';

function sessionFile(from: string, to: string): string {
  return chatSessionFile(from, to);
}

/** 读 JSONL 文件（忽略损坏行） */
function readJsonl(filePath: string): Record<string, any>[] {
  if (!fs.existsSync(filePath)) return [];
  const out: Record<string, any>[] = [];
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

// ============================================================
// query_history —— 查询聊天历史
// ============================================================

/** 格式化单条消息为一行摘要（照搬旧 formatMessage） */
function formatMessage(msg: Record<string, any>, selfId: string): string {
  const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleString('zh-CN') : '未知时间';
  const roleLabel = msg.agent_id === 'user' ? '用户'
    : msg.agent_id === selfId ? '自己'
    : `${msg.agent_id || '?'}`;

  let contentPreview = '';
  if (msg.role === 'tool') {
    // 工具结果不展示内容（查询历史只需知道调用了哪个工具）
    const toolName = msg.name || '工具';
    contentPreview = `[调用工具: ${toolName}]`;
  } else if (msg.tool_calls && msg.tool_calls.length > 0) {
    const toolNames = msg.tool_calls.map((tc: any) => tc.function?.name).join(', ');
    contentPreview = `[调用工具: ${toolNames}]`;
    if (msg.content) contentPreview += ' ' + safeTruncate(msg.content, 100);
  } else {
    contentPreview = safeTruncate(msg.content || '', 200);
    if ((msg.content || '').length > 200) contentPreview += '...';
  }

  const label = msg.label ? ` [${msg.label}]` : '';
  return `[${ts}] ${roleLabel}${label}: ${contentPreview}`;
}

/** query_history 工具（照搬旧逻辑，适配新存储：方向敏感 dialogId） */
export function makeQueryHistoryTool(config: AgentConfig, services: ToolContext): Tool {
  const selfId = config.agent_id;
  return defineTool({
    name: 'query_history', label: '查询聊天历史', requires: ['agent'],
    description: '查询聊天历史。agent_id 与 group_id 二选一：前者查 1:1 对话，后者查群聊记录。支持 keyword 过滤和 limit/offset 分页，默认最近 20 条。',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: '对方 Agent ID（与 group_id 二选一）' },
        group_id: { type: 'string', description: '群聊 ID（与 agent_id 二选一）' },
        keyword: { type: 'string', description: '关键词过滤（可选）' },
        limit: { type: 'number', description: '返回上限，默认 20，最大 100' },
        offset: { type: 'number', description: '分页偏移，默认 0（最新）' },
      },
    },
    extractLabel: (args) => {
      if (args.group_id) return `群聊 ${args.group_id}`;
      const id = args.agent_id as string | undefined;
      if (!id) return '查询聊天历史';
      const registry = services.router?.getRegistry();
      try {
        if (registry?.has(id)) return `与 ${registry.getAgentName(id)} 的聊天记录`;
      } catch { /* 回退 */ }
      return `与 ${id} 的聊天记录`;
    },
    execute: async (args) => {
      const counterpart = args.agent_id as string | undefined;
      const groupId = args.group_id as string | undefined;

      if (!counterpart && !groupId) {
        return '[query_history] 错误：请提供 agent_id（对方 Agent ID 或 "user"）或 group_id（群聊 ID）。';
      }

      // 默认条数读全局配置 messageQueryDefaultLimit（缺省 20）
      const limit = Math.min(args.limit || config.messageQueryDefaultLimit || 20, 100);
      const offset = args.offset || 0;
      const keyword = args.keyword as string | undefined;

      try {
        let messages: Record<string, any>[];

        if (groupId) {
          // ---- 群聊历史：读群聊本体（sessions/group~<gid>/messages.jsonl，回话，无思考/工具）----
          const file = groupSessionFile(groupId);
          if (!fs.existsSync(file)) {
            return `[query_history] 群聊 "${groupId}" 没有聊天记录。`;
          }
          messages = readJsonl(file);
          messages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
          // 先关键词过滤，再分页（keyword 应检索全量历史，而非仅最新一页）
          if (keyword) {
            const kw = keyword.toLowerCase();
            messages = messages.filter(m => (m.content || '').toLowerCase().includes(kw));
          }
          const total = messages.filter(m => m.role !== 'tool').length;
          messages.reverse(); // 倒序 → 取最新一页
          messages = messages.slice(offset, offset + limit);
          messages.reverse(); // 恢复正序
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

        // ---- 1:1 对话历史：读本 Agent 视角会话文件（<from>__<to>） ----
        const file = sessionFile(selfId, counterpart!);
        messages = readJsonl(file);
        // 先关键词过滤，再分页（keyword 应检索全量历史，而非仅最新一页）
        if (keyword) {
          const kw = keyword.toLowerCase();
          messages = messages.filter(m => (m.content || '').toLowerCase().includes(kw));
        }
        const total = messages.filter(m => m.role !== 'tool').length;

        // 倒序 → 取最新一页（按消息条数；旧实现按 user 链，新存储平铺，取最近 N 条）
        messages.reverse();
        messages = messages.slice(offset, offset + limit);
        messages.reverse();

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
        return `[query_history] 查询失败：${err?.message ?? String(err)}`;
      }
    },
  });
}

// ============================================================
// inspect_session —— 会话数据检查
// ============================================================

/** inspect_session 工具（照搬旧逻辑，适配新存储：方向敏感 dialogId） */
export function makeInspectSessionTool(): Tool {
  return defineTool({
    name: 'inspect_session', label: '检查会话', requires: ['dev'],
    description: '检查会话 messages.jsonl 文件：统计、过滤、尾部消息、重复检测。用于调试持久化问题。',
    parameters: {
      type: 'object',
      properties: {
        agentA: { type: 'string', description: '会话一方 Agent ID（如 user / news）' },
        agentB: { type: 'string', description: '会话另一方 Agent ID' },
        path: { type: 'string', description: '直接指定 messages.jsonl 路径（覆盖 agentA/agentB）' },
        limit: { type: 'number', description: '尾部返回条数（默认 10，最大 50）' },
        filterRole: { type: 'string', description: '按 role 过滤（agent/tool/trigger）' },
        filterAgent: { type: 'string', description: '按 agent_id 过滤' },
        dupCheck: { type: 'boolean', description: '检查完全重复 content（默认 true）' },
        includeArchive: { type: 'boolean', description: '是否合并归档文件（默认 false）' },
      },
    },
    execute: async (args) => {
      try {
        // ---- 解析文件路径 ----
        let filePath: string | null = null;
        if (args.path) {
          filePath = String(args.path);
        } else if (args.agentA && args.agentB) {
          filePath = sessionFile(String(args.agentA), String(args.agentB));
        } else {
          return JSON.stringify({ status: 'error', data: { message: '需要 agentA+agentB 或 path' } });
        }

        let msgs = readJsonl(filePath);
        const archiveDir = filePath.replace(/messages\.jsonl$/, 'archive');

        // 合并归档（可选）
        if (args.includeArchive && fs.existsSync(archiveDir)) {
          for (const f of fs.readdirSync(archiveDir).filter(f => f.endsWith('.jsonl')).sort()) {
            msgs = [...msgs, ...readJsonl(path.join(archiveDir, f))];
          }
        }

        const total = msgs.length;
        if (total === 0) {
          return JSON.stringify({ status: 'ok', data: { total: 0, message: '文件不存在或为空', path: filePath } });
        }

        // ---- 统计 ----
        const byRole: Record<string, number> = {};
        const byAgent: Record<string, number> = {};
        for (const m of msgs) {
          byRole[m.role ?? '?'] = (byRole[m.role ?? '?'] ?? 0) + 1;
          byAgent[m.agent_id ?? '?'] = (byAgent[m.agent_id ?? '?'] ?? 0) + 1;
        }

        // ---- 过滤 ----
        let filtered = msgs;
        if (args.filterRole) filtered = filtered.filter(m => m.role === args.filterRole);
        if (args.filterAgent) filtered = filtered.filter(m => m.agent_id === args.filterAgent);

        // ---- 重复检测（完全重复 content） ----
        const dupCheck = args.dupCheck !== false;
        const dupCount = dupCheck
          ? msgs.length - new Set(msgs.map(m => JSON.stringify({ role: m.role, content: m.content, agent_id: m.agent_id }))).size
          : -1;

        // ---- 尾部消息 ----
        const limit = Math.min(args.limit || 10, 50);
        const tail = filtered.slice(-limit);

        return JSON.stringify({
          status: 'ok',
          data: {
            path: filePath,
            total,
            byRole,
            byAgent,
            filtered: filtered.length,
            dupCount: dupCheck ? dupCount : undefined,
            tail: tail.map(m => ({
              ts: m.timestamp,
              role: m.role,
              agent_id: m.agent_id,
              content: safeTruncate(m.content || '', 120),
            })),
          },
        });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', data: { message: `检查失败: ${err?.message ?? String(err)}` } });
      }
    },
    extractLabel: (args) => args.path ? args.path : `${args.agentA || '?'} <-> ${args.agentB || '?'}`,
  });
}

// ============================================================
// continue_turn —— 自我 steer：触发自己继续下一轮推理
// ============================================================

/** continue_turn 工具（照搬旧逻辑：router.trigger 自我继续） */
export function makeContinueTurnTool(config: AgentConfig, services: ToolContext): Tool {
  const from = config.agent_id;
  return defineTool({
    name: 'continue_turn', label: '继续推理', requires: ['agent'],
    description: '在当前会话中继续自己的下一轮推理（自我 steer）。用于回复被截断、需要深入推理、或想主动开始下一轮推理而无需等待用户输入时。当前回合结束后，自动以同一会话上下文开始下一轮。',
    parameters: {
      type: 'object',
      properties: {
        hint: { type: 'string', description: '下一轮的可选引导（作为 trigger 消息注入）。例如"从第 3 步继续分析"、"总结已发现的内容"。' },
        counterpart: { type: 'string', description: '会话对方 Agent ID（默认 user）' },
      },
    },
    extractLabel: () => '继续推理',
    execute: async (args) => {
      const router = services.router;
      if (!router) {
        return JSON.stringify({ status: 'error', data: { message: 'AgentRouter 未注入 ToolContext' } });
      }
      try {
        const hint = typeof args.hint === 'string' && args.hint ? args.hint : undefined;
        const counterpart = typeof args.counterpart === 'string' && args.counterpart ? args.counterpart : 'user';
        // 触发自我继续：当前 turn 结束后队列自动执行下一轮（与 chat.continue 同路径）
        void router.trigger(from, {
          target: counterpart,
          source: `continue:${from}`,
          maxTurns: 0,
          ...(hint ? { hint } : {}),
        });
        return JSON.stringify({
          status: 'ok',
          data: { message: '已触发自我继续，当前回合结束后将自动开始下一轮推理。', hint: hint ?? undefined, counterpart },
        });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', data: { message: `触发继续失败: ${err?.message ?? String(err)}` } });
      }
    },
  });
}

/** 会话类工具工厂 */
export function makeSessionTools(config: AgentConfig, services: ToolContext): Tool[] {
  return [
    makeQueryHistoryTool(config, services),
    makeInspectSessionTool(),
    makeContinueTurnTool(config, services),
  ];
}

