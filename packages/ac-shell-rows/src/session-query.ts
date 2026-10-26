// ============================================================
// session-query.ts —— 会话查询工具行（cr-544；行集清单 R2 工具面
// 「会话查询」改造落地：D10 收敛为 agent 只搜自己）
//
// D10 裁决（2026-10-19，用户裁决，cr-544）：跨 agent 查询收敛为
// **agent 只搜自己**——本行只读本 agent 域账本
// （agents/<id>/sessions/<uuid>/，影子 = 物化域），不碰任何其他 agent
// 或 user 账本（D4：读面也不越域，写权=所有权在读取面的对称句）。
//
// 树归属：host → shell（R0a 判据 1）。理由：grep_history / read_history
// 是**工具**，工具只能由壳内 agent-loop 执行——宿主进程无 loop，注册的
// ctx.tools 永不被调用（旧 R1 记「数据服务·多根只读搜索」与判据 1 冲突，
// 本批按判据收口：行集总数 81 不变，宿主 47→46 / 壳 34→35）。
//
// 投影语义与主线 session.history 恒等（replay 面）：
//   · summary.md 概要头部以 system 消息置首（主线同款——历史工具可见概要）
//   · viewer 投影：agent_id === 本 agent → assistant，其余 → user
//     （对端行带 name = 对端端点 id，人际身份可见；只搜自己 ≠ 只见自己
//      的发言——本域账本里对端的话也是本会话事实）
//   · context/event 机制行不入回放（账本台账面，非会话发言）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context, Plugin } from '@agentchat/cordis';
import { readLedger } from 'ac-ledger';
import { safeClipByTokens } from 'ac-text-budget';

/** read_history 单页上限（主线同值） */
const HISTORY_PAGE_MAX = 500;
/** grep_history 命中上限（主线同值） */
const GREP_LIMIT_MAX = 250;
/** 单条命中截断预算（主线同值：166 tokens ≈ 原实字 500，UTF-16 安全截断） */
const GREP_CLIP_TOKENS = 166;

/** 行配置：本 agent 账本域（只读面单源）+ 投影身份 */
export interface SessionQueryRowOptions {
  /** 账本域根（agents/<id>/ 或影子物化域 children/<cid>/） */
  agentDir: string;
  /** 投影身份（viewer——账本行的 agent_id 判定基准） */
  agentId: string;
}

/** 会话键词法闸（对桶键 a~b / uuid / 群 gid；禁路径分隔与遍历） */
const CONVERSATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

/** 回放消息（本行对外形状——index 1 基，与工具返回恒等） */
interface ReplayLine {
  index: number;
  role: 'system' | 'assistant' | 'user';
  name?: string;
  content: string;
}

/**
 * 本 agent 会话回放（只读直读本域——D4 空间不变式：读面不越域）。
 * 目录/文件缺席 → undefined（调用方转 fail-loud 工具错误）。
 */
export function replayConversation(
  agentDir: string,
  agentId: string,
  conversationId: string,
): ReplayLine[] | undefined {
  const dir = path.join(agentDir, 'sessions', conversationId);
  if (!fs.existsSync(path.join(dir, 'messages.jsonl'))) return undefined;
  const lines: ReplayLine[] = [];
  const summaryFile = path.join(dir, 'summary.md');
  if (fs.existsSync(summaryFile)) {
    const summary = fs.readFileSync(summaryFile, 'utf-8').trim();
    if (summary !== '') lines.push({ index: 1, role: 'system', content: summary });
  }
  for (const row of readLedger(dir).rows) {
    // 机制材料（context/event）是台账面——回放只取真实发言（主线 history 同义）
    if (row.role !== 'agent') continue;
    const mine = row.agent_id === agentId;
    lines.push({
      index: lines.length + 1,
      role: mine ? 'assistant' : 'user',
      ...(mine ? {} : { name: row.agent_id }),
      content: row.content,
    });
  }
  return lines;
}

/** 截断（UTF-16 安全——lone surrogate 防线，cr-415 同族） */
function clip(content: string): string {
  const clipped = safeClipByTokens(content, GREP_CLIP_TOKENS, false);
  return clipped === content ? content : clipped + '…(truncated)';
}

/**
 * 会话查询工具行（inject ['tools']——工具基座行在集才激活；
 * requires 闭包在目录层保证）。
 */
export function makeSessionQueryRow(options: SessionQueryRowOptions): Plugin {
  const agentDir = path.resolve(options.agentDir);
  return {
    name: 'ac-shell-rows/session-query',
    inject: ['tools'],
    apply(ctx: Context) {
      /** 目标会话解析：call.conversationId 正典；缺省回退 call.agentId（1v1 对角） */
      const conversationOf = (call: { conversationId?: string; agentId?: string }): string | undefined => {
        const id = call.conversationId ?? call.agentId;
        return typeof id === 'string' && id !== '' ? id : undefined;
      };

      /** 读本域账本（越界/缺席 = fail-loud 工具错误，不静默空集） */
      const readOf = (conversationId: string): ReplayLine[] | { error: string } => {
        if (!CONVERSATION_KEY.test(conversationId)) {
          return { error: '会话键非法：' + JSON.stringify(conversationId) };
        }
        const lines = replayConversation(agentDir, options.agentId, conversationId);
        if (lines === undefined) {
          return {
            error: '本 agent 账本无该会话：' + conversationId
              + '（本行只搜自己——跨 agent 账本不在读取面，D10 收敛）',
          };
        }
        return lines;
      };

      // ---- grep_history：本会话/本 agent 名下其他会话的正则检索 ----
      ctx.tools.register({
        name: 'grep_history',
        description:
          '按正则表达式检索本 agent 自己的会话历史（回放层，含概要）。缺省查当前会话；'
          + '传 conversation_id 可查本 agent 名下的其他会话。只读本 agent 账本——'
          + '其他 agent / user 的账本不在能力面（跨 Agent 历史请直接读文件）。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '正则表达式（JS RegExp 语法）' },
            conversation_id: { type: 'string', description: '目标会话键（缺省 = 当前会话；须在本 agent 账本内）' },
            limit: { type: 'number', description: '返回条数上限（默认 50，最大 250）', minimum: 1, maximum: 250 },
          },
          required: ['pattern'],
        },
        async execute(args, call) {
          const conversationId = (args.conversation_id as string | undefined) ?? conversationOf(call);
          if (!conversationId) {
            return { ok: false, error: '缺少会话上下文（conversation_id 参数或当前会话身份）' };
          }
          const pattern = String(args.pattern ?? '');
          if (!pattern.trim()) return { ok: false, error: '缺少 pattern 参数（不能为空）' };
          let regex: RegExp;
          try {
            regex = new RegExp(pattern);
          } catch (err: unknown) {
            return { ok: false, error: '无效的正则表达式 "' + pattern + '": ' + String(err) };
          }
          const history = readOf(conversationId);
          if (!Array.isArray(history)) return { ok: false, error: history.error };
          const limit = Math.min(GREP_LIMIT_MAX, Math.max(1, Number(args.limit) || 50));
          const matches: Array<{ index: number; role: string; name?: string; content: string }> = [];
          for (const line of history) {
            if (matches.length >= limit) break;
            if (!regex.test(line.content)) continue;
            matches.push({
              index: line.index,
              role: line.role,
              ...(line.name !== undefined ? { name: line.name } : {}),
              content: clip(line.content),
            });
          }
          return {
            ok: true,
            output: {
              conversation_id: conversationId,
              total: history.length,
              count: matches.length,
              ...(matches.length >= limit ? { note: '已达返回上限 ' + limit + ' 条（收窄 pattern）' } : {}),
              matches,
            },
          };
        },
      });

      // ---- read_history：本会话分页回放 ----
      ctx.tools.register({
        name: 'read_history',
        description:
          '分页读取本 agent 自己的会话历史（回放层，含概要头部）。缺省读当前会话；'
          + '传 conversation_id 可读本 agent 名下的其他会话（#<标题>(<会话 id>) 引用里括号内的 id）。'
          + '只读本 agent 账本——其他 agent / user 的账本不在能力面。',
        parameters: {
          type: 'object',
          properties: {
            conversation_id: { type: 'string', description: '目标会话键（缺省 = 当前会话；须在本 agent 账本内）' },
            offset: { type: 'number', description: '起始序号（1 基，默认 1）', minimum: 1 },
            limit: {
              type: 'number',
              description: '返回条数（默认 100，最大 ' + HISTORY_PAGE_MAX + '）',
              minimum: 1,
              maximum: HISTORY_PAGE_MAX,
            },
          },
        },
        async execute(args, call) {
          const conversationId = (args.conversation_id as string | undefined) ?? conversationOf(call);
          if (!conversationId) {
            return { ok: false, error: '缺少会话上下文（conversation_id 参数或当前会话身份）' };
          }
          const history = readOf(conversationId);
          if (!Array.isArray(history)) return { ok: false, error: history.error };
          const start = Math.max(1, Math.floor(Number(args.offset) || 1));
          const limit = Math.min(HISTORY_PAGE_MAX, Math.max(1, Math.floor(Number(args.limit) || 100)));
          const slice = history.slice(start - 1, start - 1 + limit);
          const truncated = start - 1 + limit < history.length;
          return {
            ok: true,
            output: {
              conversation_id: conversationId,
              total: history.length,
              count: slice.length,
              messages: slice.map((line) => ({
                index: line.index,
                role: line.role,
                ...(line.name !== undefined ? { name: line.name } : {}),
                content: line.content,
              })),
              ...(truncated ? { truncated: true, next_offset: start + limit } : {}),
            },
          };
        },
      });
    },
  };
}
