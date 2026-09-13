// ============================================================
// ac-durable-interaction/src/index.ts —— 插件行 + ask_questions 工具
//
// src durable-interaction（Service + store + 三事件）直接平移 +
// ask_questions 工具行（src interaction/interaction 的 preview 形态）：
//   · write-ahead：durableInteraction.open 先落盘（jsonl 后端）再通知
//   · correlationId = toolCallId（执行身份——恢复对账用）
//   · 会话键 = call.conversationId（执行身份；缺省 agentId 1v1）
//   · 等待 = 订阅 durable-interaction/replied（id 匹配）+ deadline/signal
//   · late-reply 唤醒（2026-09-12 补齐）：工具等待中的 run 已收束
//     （后端重启 / 进程中断——步级部分行残留在会话流，工具永不回填）
//     时，用户作答（replied 事件）经 conversation.deliver 以 sender:'event'
//     信封回投答案通知 → 新 run 醒来，历史 partial 行 + 通知文本共同
//     恢复决策上下文（与 ac-job-wakeup 同构的机制唤醒形态）。
//     活跃 run 等待中（正常路径，工具自身的事件驱动半边会拿到答案）
//     不打扰——listRunning 探测判定，避免双消费。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import { DurableInteractionService, type DurableInteractionConfig } from './service.ts';
import type { DurableInteraction } from './types.ts';

export interface DurableInteractionRowOptions extends DurableInteractionConfig {}

/** 等待轮询间隔（replied 事件驱动之外的双保险——store 可能被外部进程回复） */
const WAIT_POLL_MS = 150;

export const name = 'ac-durable-interaction';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'durable-interaction',
  label: '人工确认交互',
  description: 'ask_questions 工具 + 持久化挂起/恢复（durable-interaction/opened 事件）',
};

export const inject = ['tools'];

/** conversation 可选能力面（行未装 = 无唤醒，作答只落记录不回投——组合可选惯例） */
interface ConversationLike {
  listRunning(): Array<{ agentId: string; conversationId: string }>;
  deliver(agentId: string, message: string | Record<string, unknown>, options?: {
    sender?: string; source?: string; conversationId?: string;
    elevation?: 'sandbox-access' | 'full-access';
  }): Promise<unknown>;
}

/** ask_questions 应答通知正文：answers 与工具结果同形（Agent 醒来即可继续决策） */
function lateReplyNotice(record: DurableInteraction): string {
  const payload = record.payload as { questions?: Array<{ question?: string }> } | null;
  const qs = Array.isArray(payload?.questions) ? payload!.questions! : [];
  const answer = record.answer as { answers?: Array<string | null> } | null;
  const answers = Array.isArray(answer?.answers) ? answer!.answers! : [];
  const lines = qs.map((q, i) => {
    const label = q?.question ? `「${q.question}」` : `第 ${i + 1} 题`;
    return `- ${label}: ${answers[i] ?? '(跳过)'}`;
  });
  return `[系统通知] 你此前发起的提问（interaction ${record.id}）已收到用户回答：\n${lines.join('\n')}\n请基于以上回答继续之前的任务。`;
}

export function apply(ctx: Context, options: DurableInteractionRowOptions = {}) {
  const service = new DurableInteractionService(ctx, options);

  // ---- late-reply 唤醒：answered 且原 run 已死 → 回投答案（重开 run 闭环） ----
  ctx.on('durable-interaction/replied', (record) => {
    if (record.kind !== 'ask_questions') return; // approval 等其他交互各有等待方
    const owner = record.owner;
    const convKey = record.key;
    if (!owner || !convKey) return; // 旧记录缺执行身份——无处回投
    const conversation = ctx.get('conversation', false) as ConversationLike | undefined;
    if (!conversation) return; // 会话行未装——作答只落记录（组合可选）
    // 正常路径（run 活着、工具在事件驱动等待）：不打扰——工具自身会拿到
    // 答案并回填消息流，此处回投会造成同一答案双消费（新 run 重复作答）。
    const running = conversation.listRunning().some((r) => r.agentId === owner && r.conversationId === convKey);
    if (running) return;
    // 提权继承走会话水位（2026-09-12 终版设计：ac-conversation deliver 边界
    // 对 source='event' 且未显式带档位时自动继承 conv-settings 水位）——
    // payload.elevation 留痕仅作诊断，不单独透传（防双路径漂移）。
    void conversation
      .deliver(owner, lateReplyNotice(record), {
        sender: owner,
        source: 'event',
        conversationId: convKey,
      })
      .catch((err: unknown) => {
        ctx.logger.warn(`[durable-interaction] late-reply 唤醒 ${owner}（${convKey}）失败: ${String(err)}`);
      });
  }, { description: 'late-reply 唤醒：run 已死时的作答回投（sender:event 信封）' });

  // ---- ask_questions：向用户批量提问等待决策（write-ahead + 事件等待） ----
  ctx.tools.register({
    name: 'ask_questions',
    description: '向用户提问并等待回答。用于需要用户决策或确认的场景（write-ahead：重启后可恢复对账）。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '问题' },
              options: { type: 'array', items: { type: 'string' }, description: '选项' },
            },
            required: ['question', 'options'],
          },
          description: '选择题列表（最多 5 题）',
        },
        timeout_ms: { type: 'number', description: '等待超时毫秒（不设 = 一直等）', minimum: 0 },
      },
      required: ['questions'],
    },
    async execute(args, call): Promise<ToolResult> {
      // 校验问题列表（每题 question + 至少一个 option；上限 5 题 6 选项）
      const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
      if (rawQuestions.length === 0) {
        return { ok: false, error: '缺少 questions 参数' };
      }
      const qs = rawQuestions
        .slice(0, 5)
        .map((q: Record<string, unknown>) => ({
          question: String(q?.question ?? ''),
          options: (Array.isArray(q?.options) ? q.options.map(String) : []).slice(0, 6),
        }))
        .filter((q) => q.question && q.options.length > 0);
      if (qs.length === 0) {
        return { ok: false, error: 'questions 无效：每题需 question + 至少一个 option' };
      }

      const conversationId = call.conversationId ?? call.agentId;
      if (!conversationId) {
        return { ok: false, error: '缺少会话上下文（ask_questions 需要会话归属键）' };
      }
      const rawTimeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 0;
      const timeoutMs = rawTimeout < 0 ? 0 : rawTimeout;

      // write-ahead：open 先落盘再通知（opened 事件随 open 发出）
      const record = service.open({
        key: String(conversationId),
        kind: 'ask_questions',
        payload: {
          questions: qs,
          // 原 run 提权档位留痕（2026-09-12 反馈：重启后 late-reply 唤醒的
          // 新 run 丢权限 → 逐工具审批疲劳）——回投时透传恢复原档位。
          // 放 payload（types 契约的展示/处理数据区，加字段免迁移）。
          ...(call.elevation ? { elevation: call.elevation } : {}),
        },
        ...(call.toolCallId !== undefined ? { correlationId: call.toolCallId } : {}),
        ...(call.agentId !== undefined ? { owner: call.agentId } : {}),
        ...(timeoutMs > 0 ? { deadline: Date.now() + timeoutMs } : {}),
      });

      // 等待：replied 事件（id 匹配）驱动 + 轮询双保险 + deadline/signal
      const settled = await new Promise<DurableInteraction | 'timeout' | 'aborted' | undefined>((resolve) => {
        let done = false;
        const finish = (v: DurableInteraction | 'timeout' | 'aborted') => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearTimeout(poller);
          disposeListener();
          call.signal?.removeEventListener('abort', onAbort);
          resolve(v);
        };
        // 事件驱动（同进程 reply）
        const disposeListener = ctx.on('durable-interaction/replied', (payload) => {
          if (payload.id === record.id) finish(payload);
        }, { description: 'ask_questions 应答等待（事件驱动半边）' });
        // 轮询双保险（跨进程 reply：jsonl 文件被外部回答）
        const poller = setInterval(() => {
          const cur = service.get(record.id);
          if (cur && cur.state !== 'pending') finish(cur);
        }, WAIT_POLL_MS);
        const timer =
          timeoutMs > 0
            ? setTimeout(() => finish('timeout'), timeoutMs)
            : setTimeout(() => {}, 2_147_483_000); // 永久等待（不设 deadline）
        const onAbort = () => finish('aborted');
        call.signal?.addEventListener('abort', onAbort, { once: true });
      });

      if (settled === 'timeout') {
        service.close(record.id, 'timeout');
        return { ok: false, error: `用户未响应（超时 ${timeoutMs}ms）`, output: { questions: qs, interaction_id: record.id } };
      }
      if (settled === 'aborted') {
        service.close(record.id, 'aborted');
        return { ok: false, error: '等待被中止（signal abort）', output: { questions: qs, interaction_id: record.id } };
      }
      if (!settled || settled.state === 'closed') {
        return {
          ok: false,
          error: `交互已关闭（${settled?.closedReason ?? 'unknown'}）`,
          output: { questions: qs, interaction_id: record.id },
        };
      }
      // answered：answers 期望为与 questions 对齐的数组（回复方约定）
      return {
        ok: true,
        output: { answers: settled.answer, questions: qs, interaction_id: record.id },
      };
    },
  });
}

// 契约出口：域类型 + 事件目录类型增强 + 服务类
export type {
  JsonValue,
  DurableInteractionState,
  DurableInteractionInput,
  DurableInteraction,
  DurableInteractionFilter,
  DurableInteractionStore,
  ReplyStatus,
  ReplyOutcome,
} from './types.ts';
export {
  DurableInteractionConflictError,
  DurableInteractionSerializationError,
  DurableInteractionCorruptionError,
} from './types.ts';
export { MemoryDurableInteractionStore, JsonlDurableInteractionStore } from './store.ts';
export type { JsonlDurableInteractionStoreOptions } from './store.ts';
export { DurableInteractionService } from './service.ts';
export type { DurableInteractionConfig } from './service.ts';
