// ============================================================
// @agentchat/session-tools —— 会话历史工具（grep_history / read_history）
//
// 2026-08-20 调整：
//   · query_history 拆为 grep_history（关键词检索）+ read_history（分页读取）
// 2026-08-22 修复：长消息预览截断不可知——截断时标注全文长度；read_history 新增 full=true 读全文
//   · inspect_session 已移除：真实使用（近 7 天 46 次）主要是"看会话尾部"，
//     由 read_history 覆盖；诊断场景（byRole/dupCount）用 bash+grep 承担
// 领域独立，可脱离 AgentChat 复用。
// ============================================================
import * as fs from 'fs';
import { defineTool, safeTruncate, chatSessionFile, groupSessionFile } from '@agentchat/toolkit';
import { CAPABILITY_BASE, type AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { ToolContext } from '@agentchat/tools';

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

/** 预览文本：超出上限时截断并标注全文长度（提示用 read_history full=true 读全文） */
function previewText(text: string, maxLen: number, full = false): string {
  if (full || text.length <= maxLen) return text;
  return `${safeTruncate(text, maxLen)}... [已截断，全文 ${text.length} 字符，read_history full=true 可读完整内容]`;
}

/**
 * 格式化单条消息为一行摘要。
 * full=true 时正文原样全文输出（不截断）。
 */
function formatMessage(msg: Record<string, any>, selfId: string, full = false): string {
  const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleString('zh-CN') : '未知时间';
  const roleLabel = msg.role === 'event'
    ? `[事件:${msg.source?.kind ?? 'system'}]`
    : msg.agent_id === 'user' ? '用户'
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
    if (msg.content) contentPreview += ' ' + previewText(msg.content, 100, full);
  } else {
    contentPreview = previewText(msg.content || '', 200, full);
  }

  const label = msg.label ? ` [${msg.label}]` : '';
  return `[${ts}] ${roleLabel}${label}: ${contentPreview}`;
}

// ============================================================
// 会话文件定位（agent_id → 1:1；group_id → 群聊；二选一）
// ============================================================

interface SessionTarget {
  file: string | null;
  /** 显示名（1:1 对端名或群名） */
  label: string;
  /** 错误信息（缺参数/二选一冲突） */
  error?: string;
}

function resolveTarget(config: AgentConfig, args: Record<string, any>): SessionTarget {
  const selfId = config.agent_id;
  const counterpart = args.agent_id != null ? String(args.agent_id) : undefined;
  const groupId = args.group_id != null ? String(args.group_id) : undefined;

  if (counterpart && groupId) {
    return { file: null, label: '', error: 'agent_id 与 group_id 只能二选一。' };
  }
  if (!counterpart && !groupId) {
    return { file: null, label: '', error: '请提供 agent_id（对方 Agent ID 或 "user"）或 group_id（群聊 ID）。' };
  }
  if (groupId) {
    return { file: groupSessionFile(groupId), label: `群聊 "${groupId}"` };
  }
  // 1:1 对话：读本 Agent 视角会话文件（<from>__<to>）
  return {
    file: chatSessionFile(selfId, counterpart!),
    label: counterpart === 'user' ? '人类用户' : counterpart!,
  };
}

/** 载入会话消息（群聊按时间正序；1:1 平铺保持落盘顺序） */
function loadMessages(target: SessionTarget): Record<string, any>[] | null {
  if (!target.file || !fs.existsSync(target.file)) return null;
  const messages = readJsonl(target.file);
  if (target.label.startsWith('群聊')) {
    messages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  }
  return messages;
}

// ============================================================
// grep_history —— 关键词检索聊天历史
// ============================================================

export function makeGrepHistoryTool(config: AgentConfig): Tool {
  const selfId = config.agent_id;
  return defineTool({
    name: 'grep_history', label: '检索聊天历史', requires: [CAPABILITY_BASE],
    description: '按关键词检索聊天记录（自己和任何 Agent 的对话、或任何群聊）。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '关键词（不区分大小写）' },
        agent_id: { type: 'string', description: '检索与该 Agent 的对话（"user" = 与用户的对话；与 group_id 二选一）' },
        group_id: { type: 'string', description: '检索该群聊（与 agent_id 二选一）' },
      },
      required: ['pattern'],
      oneOf: [
        { required: ['agent_id'] },
        { required: ['group_id'] },
      ],
    },
    extractLabel: (args) => {
      const scope = args.group_id ? `群聊 ${args.group_id}` : (args.agent_id ? `与 ${args.agent_id}` : '');
      return `${scope} 搜 "${String(args.pattern ?? '').slice(0, 20)}"`.trim();
    },
    execute: async (args) => {
      const target = resolveTarget(config, args);
      if (target.error) return `[grep_history] 错误：${target.error}`;
      const pattern = String(args.pattern ?? '').trim();
      if (!pattern) return '[grep_history] 错误：请提供 pattern（关键词）。';

      const messages = loadMessages(target);
      if (!messages) return `[grep_history] ${target.label} 没有聊天记录。`;

      const kw = pattern.toLowerCase();
      const hits = messages.filter(m => typeof m.content === 'string' && m.content.toLowerCase().includes(kw));
      if (hits.length === 0) {
        return `[grep_history] 在与 ${target.label} 的聊天记录中未找到含 "${pattern}" 的消息。`;
      }
      const shown = hits.slice(-50); // 上限 50 条，超出提示收窄
      const lines = [`与 ${target.label} 的聊天记录中含 "${pattern}" 的消息（共 ${hits.length} 条${hits.length > shown.length ? `，仅显示最近 ${shown.length} 条` : ''}）：`, ''];
      const hasClipped = shown.some(m => String(m.content || '').length > 200);
      for (const msg of shown) lines.push(formatMessage(msg, selfId));
      if (hasClipped) lines.push('', '(以上为摘要预览；标有「已截断」的长消息可用 read_history + full=true 读取全文)');
      return lines.join('\n');
    },
  });
}

// ============================================================
// read_history —— 分页读取聊天历史
// ============================================================

export function makeReadHistoryTool(config: AgentConfig): Tool {
  const selfId = config.agent_id;
  return defineTool({
    name: 'read_history', label: '读取聊天历史', requires: [CAPABILITY_BASE],
    description: '翻阅聊天记录（自己和任何 Agent 的对话、或任何群聊），返回最近的消息；full=true 输出完整内容（默认 200 字符预览）。',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: '读取与该 Agent 的对话（"user" = 与用户的对话；与 group_id 二选一）' },
        group_id: { type: 'string', description: '读取该群聊（与 agent_id 二选一）' },
        limit: { type: 'number', description: '返回条数（默认 20，最大 100）', minimum: 1, maximum: 100 },
        offset: { type: 'number', description: '分页偏移（默认 0 = 从最新往前）', minimum: 0 },
        full: { type: 'boolean', description: 'true = 输出每条消息完整内容（不截断预览），适合读取被截断的长消息' },
      },
      oneOf: [
        { required: ['agent_id'] },
        { required: ['group_id'] },
      ],
    },
    extractLabel: (args) => {
      if (args.group_id) return `群聊 ${args.group_id}`;
      const id = args.agent_id as string | undefined;
      return id ? `与 ${id} 的聊天记录` : '读取聊天历史';
    },
    execute: async (args) => {
      const target = resolveTarget(config, args);
      if (target.error) return `[read_history] 错误：${target.error}`;

      // 默认条数读全局配置 messageQueryDefaultLimit（缺省 20）
      const limit = Math.min(args.limit || config.messageQueryDefaultLimit || 20, 100);
      const offset = args.offset || 0;

      const messages = loadMessages(target);
      if (!messages) return `[read_history] ${target.label} 没有聊天记录。`;

      const total = messages.filter(m => m.role !== 'tool').length;
      // 倒序 → 取最新一页 → 恢复正序
      const reversed = [...messages].reverse();
      const page = reversed.slice(offset, offset + limit).reverse();

      if (page.length === 0) {
        return `[read_history] 与 ${target.label} 没有更多聊天记录（offset=${offset} 已超出范围）。`;
      }
      const full = args.full === true;
      const lines = [`与 ${target.label} 的聊天记录（共 ${total} 条，当前第 ${offset + 1}~${Math.min(offset + page.length, total)} 条${full ? '，全文模式' : ''}）：`, ''];
      for (const msg of page) lines.push(formatMessage(msg, selfId, full));
      if (total > offset + limit) {
        lines.push(`\n（还有 ${total - offset - limit} 条更早的消息，使用 offset=${offset + limit} 继续读取）`);
      }
      return lines.join('\n');
    },
  });
}

/** 会话历史工具工厂 */
export function makeSessionTools(config: AgentConfig, services: ToolContext): Tool[] {
  void services; // 预留（历史恢复/registry 显示名）
  return [
    makeGrepHistoryTool(config),
    makeReadHistoryTool(config),
  ];
}
