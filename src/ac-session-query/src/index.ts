// ============================================================
// ac-session-query/src/index.ts —— 会话查询门面工具行
// （grep_history / read_history）
//
// src session-tools 平移（实际工具 grep_history/read_history——query_history
// 已拆分、inspect_session 已移除，地图审查修正）。复用 ctx.session 的
// history() 回放（含概要头部）；执行身份 call.conversationId 定会话，
// 缺省 1v1（= agentId）。
// ============================================================
import type { Context } from '@agentchat/cordis';

/** read_history 单页上限 */
const HISTORY_PAGE_MAX = 500;

export const name = 'ac-session-query';

export const inject = ['tools', 'session'];

export function apply(ctx: Context) {
  /** 解析目标会话：call.conversationId 正典；缺省回退 call.agentId（1v1） */
  function conversationOf(call: { conversationId?: string; agentId?: string }): string | undefined {
    const id = call.conversationId ?? call.agentId;
    return typeof id === 'string' && id ? id : undefined;
  }

  // ---- grep_history：按正则检索会话历史 ----
  ctx.tools.register({
    name: 'grep_history',
    description: '按正则表达式检索当前会话的历史消息（回放层查询，含概要）。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式（JS RegExp 语法）' },
        conversation_id: { type: 'string', description: '会话键（缺省 = 当前会话）' },
        limit: { type: 'number', description: '返回条数上限（默认 50，最大 250）', minimum: 1, maximum: 250 },
      },
      required: ['pattern'],
    },
    async execute(args, call) {
      // 工具体抛错由 ac-tools 统一收敛为 { ok:false, error }——不整体 try/catch
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
        return { ok: false, error: `无效的正则表达式 "${pattern}": ${String(err)}` };
      }
      // viewer=执行 Agent（M21/D1）：回放按读者投影——自己的话 assistant
      const history = await ctx.session.history(conversationId, {
        ...(call.agentId ? { viewer: call.agentId } : {}),
      });
      const limit = Math.min(250, Math.max(1, Number(args.limit) || 50));
      const matches: Array<{ index: number; role: string; name?: string; content: string }> = [];
      for (let i = 0; i < history.length && matches.length < limit; i++) {
        const msg = history[i];
        if (regex.test(msg.content)) {
          matches.push({
            index: i + 1,
            role: msg.role,
            ...(msg.name !== undefined ? { name: msg.name } : {}),
            content:
              msg.content.length > 500 ? msg.content.slice(0, 500) + '…(truncated)' : msg.content,
          });
        }
      }
      return {
        ok: true,
        output: {
          conversation_id: conversationId,
          total: history.length,
          count: matches.length,
          ...(matches.length >= limit ? { note: `已达返回上限 ${limit} 条（收窄 pattern）` } : {}),
          matches,
        },
      };
    },
  });

  // ---- read_history：分页回放会话历史 ----
  ctx.tools.register({
    name: 'read_history',
    description: '分页读取当前会话的历史消息（回放层，含概要头部）。',
    parameters: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: '会话键（缺省 = 当前会话）' },
        offset: { type: 'number', description: '起始序号（1 基，默认 1）', minimum: 1 },
        limit: { type: 'number', description: `返回条数（默认 100，最大 ${HISTORY_PAGE_MAX}）`, minimum: 1, maximum: HISTORY_PAGE_MAX },
      },
    },
    async execute(args, call) {
      // 工具体抛错由 ac-tools 统一收敛为 { ok:false, error }——不整体 try/catch
      const conversationId = (args.conversation_id as string | undefined) ?? conversationOf(call);
      if (!conversationId) {
        return { ok: false, error: '缺少会话上下文（conversation_id 参数或当前会话身份）' };
      }
      // viewer=执行 Agent（M21/D1）：回放按读者投影——自己的话 assistant
      const history = await ctx.session.history(conversationId, {
        ...(call.agentId ? { viewer: call.agentId } : {}),
      });
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
          messages: slice.map((m, i) => ({
            index: start + i,
            role: m.role,
            ...(m.name !== undefined ? { name: m.name } : {}),
            content: m.content,
          })),
          ...(truncated ? { truncated: true, next_offset: start + limit } : {}),
        },
      };
    },
  });
}
