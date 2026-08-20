// ============================================================
// @agentchat/server/src/singles-title.ts —— 独立会话自动标题钩子
//
// 需求：独立会话（single~<sid>）首个推理步结束时，自动生成会话标题
// （LLM 一句话概括，失败回落首条用户消息截断），写入 session.json 并
// 经 router 'singles.updated' 事件广播前端刷新列表。
//
// 设计要点：
//   · stepEnd 钩子（automatic，无 owner = 不受 config.hooks 清单控制）：
//     幂等守卫 = session.json 尚无 title（生成一次后永不再触发）；
//     首个机会自然落在「step 1 结束」（新会话首轮第一步）。
//   · LLM 调用 fire-and-forget：标题生成不阻塞主对话流（失败仅记日志，
//     回落截断标题保证会话一定有名字）。
//   · 使用 ctx.llm（本 run 的 provider，含会话级模型覆盖），
//     thinking: false 关闭思考——标题是轻量任务，不值得推理开销。
// ============================================================
import type { StepEndHook, CurrentContext } from '@agentchat/contracts';
import type { LLMProvider } from '@agentchat/llm';
import type { SinglesService } from './singles';
import { createLogger } from '@agentchat/util';

const log = createLogger('[server:singles-title]');

const SINGLE_PREFIX = 'single~';
/** 标题长度上限（字符） */
const TITLE_MAX_LEN = 24;

/** 标题生成提示词：短、无引号、无解释 */
const TITLE_PROMPT = (userText: string): string =>
  `根据下面的用户消息，为这段对话生成一个简短的中文标题（不超过${TITLE_MAX_LEN}字）。\n`
  + `要求：直接输出标题本身；不要引号、句号、解释或前后缀；概括意图而非复述原文。\n\n`
  + `用户消息：\n${userText.slice(0, 600)}`;

/** 清洗模型输出：去引号/换行/首尾空白，超长截断 */
function cleanTitle(raw: string): string {
  const t = raw.trim().replace(/^["'「『《]+|["'」』》]+$/g, '').split('\n')[0]?.trim() ?? '';
  return t.length > TITLE_MAX_LEN ? t.slice(0, TITLE_MAX_LEN) : t;
}

/** 回落标题：首条用户消息截断（LLM 失败/空回复时保底） */
function fallbackTitle(userText: string): string {
  const firstLine = userText.trim().split('\n')[0] ?? '';
  return firstLine.length > TITLE_MAX_LEN ? `${firstLine.slice(0, TITLE_MAX_LEN)}…` : firstLine;
}

/** 从 run 上下文提取首条用户消息（currentMessage 优先，其次历史首条 user） */
function firstUserText(ctx: CurrentContext): string {
  const cur = ctx.currentMessage?.content;
  if (typeof cur === 'string' && cur.trim()) return cur;
  const hist = ctx.history.find(m => m.role === 'user');
  return typeof hist?.content === 'string' ? hist.content : '';
}

/** 用本 run 的 LLM 生成标题（thinking 关闭；失败抛错由调用方回落） */
async function generateTitle(llm: LLMProvider, userText: string): Promise<string> {
  const resp = await llm.chat({
    messages: [{ role: 'user', content: TITLE_PROMPT(userText) }],
    thinking: false,
  });
  const content = typeof resp.content === 'string' ? resp.content : '';
  const title = cleanTitle(content);
  if (!title) throw new Error('模型返回空标题');
  return title;
}

/** 生成中守卫（同会话并发 stepEnd 只触发一次） */
const inFlight = new Set<string>();

export type SinglesUpdatedEmitter = (session: unknown) => void;

/**
 * 工厂：独立会话自动标题 stepEnd 钩子。
 * onUpdated —— 标题落盘后的通知回调（service-plugin 接 router 事件广播）。
 */
export function makeSingleTitleHook(
  singles: SinglesService,
  onUpdated?: SinglesUpdatedEmitter,
): StepEndHook {
  return async (ctx) => {
    const dialogId = ctx.dialogId;
    if (!dialogId?.startsWith(SINGLE_PREFIX)) return;
    const sessionId = dialogId.slice(SINGLE_PREFIX.length);

    // 幂等：已有标题 / 生成中 / 无首条用户消息 → 跳过
    const record = singles.getRecord(sessionId);
    if (!record || record.title || inFlight.has(sessionId)) return;
    const userText = firstUserText(ctx);
    if (!userText.trim()) return;

    inFlight.add(sessionId);
    // fire-and-forget：不阻塞主对话流
    void (async () => {
      try {
        let title: string;
        try {
          title = await generateTitle(ctx.llm, userText);
        } catch (err: any) {
          log.warn(`LLM 标题生成失败（回落截断标题）: ${err?.message ?? String(err)}`);
          title = fallbackTitle(userText);
        }
        if (!title.trim()) return;
        // 再查一次：期间用户可能手动改过标题，不覆盖
        const latest = singles.getRecord(sessionId);
        if (!latest || latest.title) return;
        const session = singles.rename(sessionId, title);
        log.info(`独立会话 ${sessionId.slice(0, 8)}… 已生成标题「${title}」`);
        onUpdated?.(session);
      } finally {
        inFlight.delete(sessionId);
      }
    })().catch((err: any) => log.error(`标题生成任务异常: ${err?.message ?? String(err)}`));
  };
}
