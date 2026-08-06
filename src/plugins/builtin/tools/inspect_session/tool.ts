// ============================================================
// inspect_session 工具 —— 会话数据检查
//
// 用途：
//   读取 sessions/<lo>/<hi>/messages.jsonl（含 archive/），
//   提供：总量统计、按 role/agent_id 分布、尾部消息查看、
//   重复内容检测（辅助排查双持久化 bug）。
//
// 参数：
//   agentA / agentB – 会话双方（如 agentA=user agentB=news），二选一或都传
//   path           – 直接指定 messages.jsonl 路径（覆盖 agentA/agentB）
//   limit          – 尾部返回条数（默认 10，最大 50）
//   filterRole     – 按 role 过滤（agent/tool/trigger）
//   filterAgent    – 按 agent_id 过滤
//   dupCheck       – 是否检查完全重复 content（默认 true）
//   includeArchive – 是否合并归档文件（默认 false）
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getGlobalConfig } from '@core/config';
import * as fs from 'fs';
import * as path from 'path';

interface Msg {
  role?: string;
  agent_id?: string;
  content?: string;
  timestamp?: string;
  message_id?: string;
}

function readJsonl(filePath: string): Msg[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean);
  const msgs: Msg[] = [];
  for (const line of lines) {
    try { msgs.push(JSON.parse(line) as Msg); } catch { /* skip malformed */ }
  }
  return msgs;
}

export const tool: Tool = {
  ...meta,
  definition: {
    type: 'function',
    function: {
      name: 'inspect_session',
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
    },
  },

  execute: async (args) => {
    try {
      // ── 解析文件路径 ──
      let filePath: string | null = null;
      if (args.path) {
        filePath = String(args.path);
      } else if (args.agentA && args.agentB) {
        const [lo, hi] = [String(args.agentA), String(args.agentB)].sort();
        filePath = path.join(getGlobalConfig().sessionsDir, lo, hi, 'messages.jsonl');
      } else {
        return JSON.stringify({ status: 'error', data: { message: '需要 agentA+agentB 或 path' } });
      }

      let msgs = readJsonl(filePath);
      const archiveDir = filePath.replace('messages.jsonl', 'archive');

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

      // ── 统计 ──
      const byRole: Record<string, number> = {};
      const byAgent: Record<string, number> = {};
      for (const m of msgs) {
        byRole[m.role ?? '?'] = (byRole[m.role ?? '?'] ?? 0) + 1;
        byAgent[m.agent_id ?? '?'] = (byAgent[m.agent_id ?? '?'] ?? 0) + 1;
      }

      // ── 重复检测（同 role+agent_id+content 完全一致）──
      let dups: Array<{ first: number; second: number; content: string }> = [];
      if (args.dupCheck !== false) {
        const seen = new Map<string, number>();
        msgs.forEach((m, i) => {
          const key = `${m.role}|${m.agent_id}|${m.content ?? ''}`;
          if (seen.has(key)) {
            if (dups.length < 10) dups.push({ first: seen.get(key)!, second: i, content: (m.content ?? '').slice(0, 80) });
          } else {
            seen.set(key, i);
          }
        });
      }

      // ── 过滤 ──
      let filtered = msgs;
      if (args.filterRole) filtered = filtered.filter(m => m.role === args.filterRole);
      if (args.filterAgent) filtered = filtered.filter(m => m.agent_id === args.filterAgent);

      // ── 尾部消息 ──
      const limit = Math.min(50, Number(args.limit) || 10);
      const tail = filtered.slice(-limit).map(m => ({
        idx: msgs.indexOf(m),
        role: m.role,
        agent_id: m.agent_id,
        content: (m.content ?? '').slice(0, 100),
        ts: m.timestamp,
      }));

      return JSON.stringify({
        status: 'ok',
        data: {
          path: filePath,
          total,
          byRole,
          byAgent,
          dupCount: dups.length,
          dups: dups.slice(0, 10),
          tail,
          hasArchive: fs.existsSync(archiveDir),
        },
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', data: { message: err.message } });
    }
  },
};
