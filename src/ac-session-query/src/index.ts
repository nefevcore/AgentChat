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
import { widenToolsForGating } from 'ac-agents';

/** read_history 单页上限 */
const HISTORY_PAGE_MAX = 500;

export const name = 'ac-session-query';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'session-query',
  label: '会话查询',
  description: '会话查询门面工具行（grep_history / read_history）',
};

export const inject = ['tools', 'session'];

/** # 会话引用指引：owner 行条件注入（历史工具在场教 conversation_id，
 *  不在场教磁盘回退——# 引用的分析不绑定特定工具）。sid 由发送侧内联
 *  （Agent 无枚举会话的工具，纯标题不可解析）；只依赖工具集 → KV 前缀稳定。 */
const SESSION_MENTION_GUIDE =
  '[引用约定] 用户消息中的 #<标题>(<会话 id>) 是用户引用的历史会话：括号内即 conversation_id，'
  + '是分析该会话的线索。可用 read_history / grep_history（conversation_id 参数）直接读取；'
  + '这两个工具不可用时，会话数据以 JSONL 落盘在 home 数据根的 sessions/<conversation_id>/messages.jsonl'
  + '（独立会话在 singles/），可用文件工具（read/grep/pwsh）读取分析。';

export function apply(ctx: Context) {
  // ---- # 会话引用指引（owner 行条件注入：历史工具或文件读取能力在场其一）----
  ctx.on('loop/before-run', (call, next) => {
    // PTC 门控面（widenToolsForGating 单源）：程序化 run 的 request.tools
    // 已收窄成 ['run_code']——按能力面展开判文件读取能力在场，否则 #
    // 会话引用约定整段丢失
    const names = new Set(widenToolsForGating(ctx, call.request.agent, call.request.conversationId, call.request.tools));
    const historyCap = names.has('read_history') || names.has('grep_history');
    const fileCap = names.has('read') || names.has('grep') || names.has('pwsh') || names.has('bash');
    if (historyCap || fileCap) {
      call.request = {
        ...call.request,
        system: call.request.system ? `${call.request.system}\n${SESSION_MENTION_GUIDE}` : SESSION_MENTION_GUIDE,
      };
    }
    return next();
  }, { description: '注入 # 会话引用指引（历史工具或文件读取能力在场时）' });

  /** 解析目标会话：call.conversationId 正典；缺省回退 call.agentId（1v1） */
  function conversationOf(call: { conversationId?: string; agentId?: string }): string | undefined {
    const id = call.conversationId ?? call.agentId;
    return typeof id === 'string' && id ? id : undefined;
  }

  /**
   * 回放视角（M21/D1 §2.4）：读当前会话 = 执行者本人；跨会话读取（用户
   * #<标题>(<会话 id>) 引用）= 目标会话属主视角——被引用会话里属主的
   * 回复按 assistant 原貌呈现（否则全投影成 user，问答关系丢失）。
   * singles 属主解析不到（1v1 对桶/行未装）回落执行者视角。
   */
  function viewerOf(target: string, call: { conversationId?: string; agentId?: string }): string | undefined {
    const current = call.conversationId ?? call.agentId;
    if (current !== undefined && target === current) return call.agentId;
    const singles = ctx.get('singles', false) as
      | { get(sid: string): { agentId?: string } | null }
      | undefined;
    return singles?.get(target)?.agentId || call.agentId;
  }

  // ---- grep_history：按正则检索会话历史（含跨会话查询——# 引用后端能力） ----
  // history 标签（2026-09-17 自 infra 拆出）：会话回放门面自立族——标准
  // 预设精简协作面时连带出局（infra 保留提问/待办等单 Agent 刚需）
  ctx.tools.register({
    name: 'grep_history',
    requiredTags: ['history'],
    description:
      '按正则表达式检索会话历史消息（回放层查询，含概要）。缺省查当前会话；'
      + '传 conversation_id 可查任意其他会话（如用户 #<标题>(<会话 id>) 引用里括号内的 id）。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式（JS RegExp 语法）' },
        conversation_id: { type: 'string', description: '目标会话键（缺省 = 当前会话；跨会话查询传用户 # 引用里括号内的 id）' },
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
      const viewer = viewerOf(conversationId, call);
      const history = await ctx.session.history(conversationId, {
        ...(viewer ? { viewer } : {}),
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

  // ---- read_history：分页回放会话历史（含跨会话读取——# 引用后端能力） ----
  ctx.tools.register({
    name: 'read_history',
    requiredTags: ['history'],
    description:
      '分页读取会话历史消息（回放层，含概要头部）。缺省读当前会话；'
      + '传 conversation_id 可读任意其他会话（如用户 #<标题>(<会话 id>) 引用里括号内的 id）。',
    parameters: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: '目标会话键（缺省 = 当前会话；跨会话读取传用户 # 引用里括号内的 id）' },
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
      //（跨会话读取 = 目标属主视角，见 viewerOf）
      const viewer = viewerOf(conversationId, call);
      const history = await ctx.session.history(conversationId, {
        ...(viewer ? { viewer } : {}),
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
