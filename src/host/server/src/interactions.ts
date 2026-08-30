// ============================================================
// 交互桥 —— 支持 Agent 在工具执行中等待用户响应（ask_questions）
//
// v0.7（durable-interaction 适配）：
//   ask_questions 工具执行时调用 askQuestions()
//     → 先经 DurableInteractionStore.open() 落盘 pending 意图（write-ahead）
//     → 再 WS 推前端（chat.interaction）→ 前端弹窗 → 用户选择
//     → respond() 先 store.reply() 落盘回答，再 resolve 内存 Promise
//
// 关键：
//   1. 每个 interaction 有唯一持久 id；回答幂等（duplicate 返回原答案）
//   2. 会话级并行后：interaction 绑定 convKey（sender__receiver），
//      前端回包带 interaction_id 精确定位，不串会话
//   3. abort 时先 close 持久记录再清理 pending + 抛 ToolInterrupt
//   4. 进程重启后：pending 记录从 store 恢复；前端重连时 WS 层
//      重推弹窗。原 run 的续跑由 agent-session 恢复调和（另见 step 持久化）
//
// 依赖方向：仅依赖 @agentchat/durable-interaction（通用）+ src/core + Node 内置 events。
// ============================================================

import { EventEmitter } from 'events';
import { ToolInterrupt } from '@agentchat/agent-loop';
import type { InterruptReason } from '@agentchat/agent-loop';
import { createLogger } from '@agentchat/util';
import {
  MemoryDurableInteractionStore,
  type DurableInteraction,
  type DurableInteractionFilter,
  type DurableInteractionInput,
  type JsonValue,
  type ReplyOutcome,
} from '@agentchat/durable-interaction';

const log = createLogger('[services:interaction]');

/** 桥接层所需的持久化能力（DurableInteractionService 结构上满足） */
export interface InteractionStoreLike {
  open(input: DurableInteractionInput): DurableInteraction;
  reply(id: string, answer: JsonValue): ReplyOutcome;
  close(id: string, reason?: string): boolean;
  listOpen(filter?: DurableInteractionFilter): DurableInteraction[];
}

export interface PendingInteraction {
  id: string;
  agentId: string;
  convKey: string;
  question: string;
  options: string[];
  allowCustom: boolean;
  timeoutMs: number;
  timer?: NodeJS.Timeout;
  resolve: (choice: string) => void;
  reject: (err: Error) => void;
  /** 外部 AbortSignal：abort 时 reject */
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface InteractionBridgeOptions {
  /** 回答在进程重启后到达（无 live waiter）时回调；用于唤醒/调和原会话 */
  onLateReply?: (record: DurableInteraction) => void;
}

export class InteractionBridge {
  private pending = new Map<string, PendingInteraction>();
  private eventBus: EventEmitter;
  private store: InteractionStoreLike;
  private readonly onLateReply?: InteractionBridgeOptions['onLateReply'];

  constructor(eventBus: EventEmitter, store?: InteractionStoreLike, options: InteractionBridgeOptions = {}) {
    this.eventBus = eventBus;
    this.store = store ?? new MemoryDurableInteractionStore();
    this.onLateReply = options.onLateReply;
    const restored = this.store.listOpen();
    if (restored.length > 0) {
      log.info(`恢复 ${restored.length} 条未答复交互（等待前端重连/用户回答）`);
    }
  }

  /** 是否还有 live pending（内存等待者；持久 pending 另见 listOpen） */
  get pendingCount(): number { return this.pending.size; }

  /** 持久化 store 中仍处于 pending 的交互（前端重连重推用） */
  listOpen(filter?: DurableInteractionFilter): DurableInteraction[] {
    return this.store.listOpen(filter);
  }

  /** 把持久记录转成前端 chat.interaction 载荷 */
  toWireMessage(record: DurableInteraction): Record<string, unknown> {
    const payload = (record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload))
      ? record.payload as Record<string, unknown>
      : {};
    const deadline = typeof record.deadline === 'number' ? record.deadline : undefined;
    return {
      interaction_id: record.id,
      agent_id: record.owner ?? '',
      question: typeof payload.question === 'string' ? payload.question : '',
      options: Array.isArray(payload.options) ? payload.options.map(String) : [],
      allow_custom: payload.allowCustom === true,
      timeout_ms: deadline === undefined ? 0 : Math.max(0, deadline - Date.now()),
      ...(record.correlationId !== undefined ? { correlation_id: record.correlationId } : {}),
    };
  }

  /**
   * 批量选择题（ask_questions questions 数组）：一次注册多题，
   * 前端左右切换逐题回答，全部答完一起 resolve。
   * @returns Promise<string[]> 每题的答案数组
   */
  askQuestions(opts: {
    agentId: string;
    convKey: string;
    questions: Array<{ question: string; options: string[] }>;
    allowCustom?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    correlationId?: string;
  }): Promise<string[]> {
    const answers: string[] = new Array(opts.questions.length).fill('');
    // 逐题串行询问（每题独立持久 pending，前端逐题切换）
    return (async () => {
      for (let i = 0; i < opts.questions.length; i++) {
        const q = opts.questions[i];
        const ans = await this.askUser({
          agentId: opts.agentId,
          convKey: opts.convKey,
          question: `[${i + 1}/${opts.questions.length}] ${q.question}`,
          options: q.options,
          allowCustom: opts.allowCustom,
          timeoutMs: opts.timeoutMs,
          signal: opts.signal,
          correlationId: opts.correlationId,
        });
        answers[i] = ans;
      }
      return answers;
    })();
  }

  /**
   * 发起一次用户交互（ask_questions 工具调用）。
   * 先落盘 pending 意图，再弹窗并 await。
   * @returns Promise<string> 用户的选择（resolve）
   */
  askUser(opts: {
    agentId: string;
    convKey: string;
    question: string;
    options: string[];
    allowCustom?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    correlationId?: string;
  }): Promise<string> {
    return new Promise((resolve, reject) => {
      // 缺省永久等待（0）；仅显式传入 timeoutMs 才有时限（工具层同口径）
      const timeoutMs = opts.timeoutMs ?? 0;
      // timeout_ms <= 0：永久等待（跨重启由持久记录恢复）
      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;

      let record: DurableInteraction;
      try {
        record = this.store.open({
          key: opts.convKey,
          kind: 'ask_questions',
          owner: opts.agentId,
          payload: {
            question: opts.question,
            options: opts.options,
            allowCustom: opts.allowCustom ?? false,
          },
          ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
          ...(deadline !== undefined ? { deadline } : {}),
        });
      } catch (err: any) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const id = record.id;

      const finish = (choice: string) => {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.onAbort && entry.signal) {
          entry.signal.removeEventListener('abort', entry.onAbort);
        }
        this.pending.delete(id);
        resolve(choice);
      };

      const entry: PendingInteraction = {
        id,
        agentId: opts.agentId,
        convKey: opts.convKey,
        question: opts.question,
        options: opts.options,
        allowCustom: opts.allowCustom ?? false,
        timeoutMs,
        ...(timeoutMs > 0 ? {
          timer: setTimeout(() => {
            this.pending.delete(id);
            try {
              this.store.close(id, 'timeout');
            } catch { /* 持久关闭失败不覆盖超时语义 */ }
            reject(new Error(`交互超时（${Math.round(timeoutMs / 1000)}s 无响应）`));
          }, timeoutMs),
        } : {}),
        resolve: finish,
        reject: (err) => {
          if (entry.timer) clearTimeout(entry.timer);
          if (entry.onAbort && entry.signal) {
            entry.signal.removeEventListener('abort', entry.onAbort);
          }
          this.pending.delete(id);
          reject(err);
        },
        signal: opts.signal,
      };

      // 外部 abort → 关闭持久记录 + reject（工具中断）
      if (opts.signal) {
        const onAbort = () => {
          this.pending.delete(id);
          try {
            this.store.close(id, 'aborted');
          } catch { /* ignore */ }
          reject(new ToolInterrupt({ type: 'user-abort' } as InterruptReason));
        };
        entry.onAbort = onAbort;
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(id, entry);

      // 落盘成功后推 WS 前端（顺序保证：弹窗出现 = 问题已持久）
      this.eventBus.emit('chat.interaction', this.toWireMessage(record));

      log.info(`发起: ${id} (${opts.agentId}) → "${opts.question.slice(0, 40)}"`);
    });
  }

  /** 响应用户选择（WS CHAT_INTERACT_RESPOND 调用）：先落盘回答，再 resolve 内存等待者 */
  respond(interactionId: string, choice: string): { ok: boolean; error?: string } {
    const outcome = this.store.reply(interactionId, choice);
    if (outcome.status === 'not-found') {
      return { ok: false, error: `交互 ${interactionId} 不存在或已超时` };
    }
    if (outcome.status === 'closed') {
      return { ok: false, error: `交互 ${interactionId} 已关闭（${outcome.interaction?.closedReason ?? 'closed'}）` };
    }

    const entry = this.pending.get(interactionId);
    if (outcome.status === 'duplicate') {
      // 回答已持久：若 live waiter 尚在（极端重入），用它解决；否则幂等成功
      if (entry) {
        entry.resolve(typeof outcome.answer === 'string' ? outcome.answer : choice);
      } else {
        log.info(`重复响应（幂等）: ${interactionId} → "${choice.slice(0, 40)}"`);
      }
      return { ok: true };
    }

    if (entry) {
      entry.resolve(choice);
    } else {
      // 进程重启后回答恢复：答案已持久化，唤醒/调和原会话继续
      log.info(`响应: ${interactionId} → "${choice.slice(0, 40)}"（live waiter 不存在，已持久化待调和）`);
      if (outcome.interaction) this.onLateReply?.(outcome.interaction);
    }
    return { ok: true };
  }

  /** 中止某 Agent 的所有 pending（优雅关闭/重启时）：关闭持久记录 + reject live waiter */
  abortAgent(agentId: string): void {
    for (const record of this.store.listOpen({ owner: agentId })) {
      this.store.close(record.id, 'aborted');
    }
    for (const [id, entry] of this.pending) {
      if (entry.agentId === agentId) {
        entry.reject(new ToolInterrupt({ type: 'user-abort' } as InterruptReason));
        this.pending.delete(id);
      }
    }
  }

  /** 中止所有 pending（进程关闭） */
  abortAll(): void {
    for (const record of this.store.listOpen()) {
      this.store.close(record.id, 'aborted');
    }
    for (const [id, entry] of this.pending) {
      entry.reject(new ToolInterrupt({ type: 'user-abort' } as InterruptReason));
      this.pending.delete(id);
    }
  }
}

/** 全局单例（由 bootstrap 创建并注入；插件经 PluginServices.interaction 获取） */
let _bridge: InteractionBridge | null = null;
export function getInteractionBridge(): InteractionBridge | null { return _bridge; }
export function setInteractionBridge(b: InteractionBridge | null): void { _bridge = b; }
