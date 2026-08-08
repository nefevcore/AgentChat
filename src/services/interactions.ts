// ============================================================
// 交互桥 —— 支持 Agent 在工具执行中等待用户响应（ask_questions）
//
// 设计（2026-08-05，决策工具 #4）：
//   ask_questions 工具执行时调用 askQuestions() → 注册 pending interaction
//   → WS 推前端（chat.interaction）→ 前端弹窗 → 用户选择
//   → WS 回 CHAT_INTERACT_RESPOND → 这里 resolve → 工具继续
//
// 关键：
//   1. 每个 interaction 有唯一 id + 超时（默认 120s）
//   2. 会话级并行后：interaction 绑定 convKey（sender__receiver），
//      前端回包带 interaction_id 精确定位，不串会话
//   3. abort 时清理 pending + 抛 ToolInterrupt（语义化中断）
//
// 适配新架构：
//   · ToolInterrupt/InterruptReason ← @core/interrupt
//   · logger ← @core/logger
//   · ask_questions 精简（L3）：移除 allowCustom 单选输入，只留 questions 批量选择题
//     （L3 PluginServices.interaction.askQuestions 契约对齐；allowCustom 保留可选参数默认 false）
//
// 依赖方向：仅依赖 src/core + Node 内置 events。
// ============================================================

import { EventEmitter } from 'events';
import { ToolInterrupt, InterruptReason } from '@core/interrupt';
import { createLogger } from '@core/logger';

const log = createLogger('[services:interaction]');

export interface PendingInteraction {
  id: string;
  agentId: string;
  convKey: string;
  question: string;
  options: string[];
  allowCustom: boolean;
  timeoutMs: number;
  timer: NodeJS.Timeout;
  resolve: (choice: string) => void;
  reject: (err: Error) => void;
  /** 外部 AbortSignal：abort 时 reject */
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class InteractionBridge {
  private pending = new Map<string, PendingInteraction>();
  private eventBus: EventEmitter;

  constructor(eventBus: EventEmitter) {
    this.eventBus = eventBus;
  }

  /** 是否还有 pending（供前端查询/调试） */
  get pendingCount(): number { return this.pending.size; }

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
  }): Promise<string[]> {
    const answers: string[] = new Array(opts.questions.length).fill('');
    // 逐题串行询问（每题独立 pending，前端逐题切换）
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
        });
        answers[i] = ans;
      }
      return answers;
    })();
  }

  /**
   * 发起一次用户交互（ask_questions 工具调用）。
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
  }): Promise<string> {
    return new Promise((resolve, reject) => {
      const id = `interact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timeoutMs = opts.timeoutMs ?? 120_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`交互超时（${Math.round(timeoutMs / 1000)}s 无响应）`));
      }, timeoutMs);

      const entry: PendingInteraction = {
        id,
        agentId: opts.agentId,
        convKey: opts.convKey,
        question: opts.question,
        options: opts.options,
        allowCustom: opts.allowCustom ?? false,
        timeoutMs,
        timer,
        resolve: (choice: string) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(choice);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        },
        signal: opts.signal,
      };

      // 外部 abort → reject（工具中断）
      if (opts.signal) {
        const onAbort = () => {
          this.pending.delete(id);
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

      // 推 WS 前端
      this.eventBus.emit('chat.interaction', {
        interaction_id: id,
        agent_id: opts.agentId,
        question: opts.question,
        options: opts.options,
        allow_custom: opts.allowCustom,
        timeout_ms: timeoutMs,
      });

      log.info(`发起: ${id} (${opts.agentId}) → "${opts.question.slice(0, 40)}"`);
    });
  }

  /** 响应用户选择（WS CHAT_INTERACT_RESPOND 调用） */
  respond(interactionId: string, choice: string): { ok: boolean; error?: string } {
    const entry = this.pending.get(interactionId);
    if (!entry) {
      return { ok: false, error: `交互 ${interactionId} 不存在或已超时` };
    }
    // 清理 signal 监听
    if (entry.onAbort && entry.signal) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
    entry.resolve(choice);
    log.info(`响应: ${interactionId} → "${choice.slice(0, 40)}"`);
    return { ok: true };
  }

  /** 中止某 Agent 的所有 pending（优雅关闭/重启时） */
  abortAgent(agentId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.agentId === agentId) {
        entry.reject(new ToolInterrupt({ type: 'user-abort' } as InterruptReason));
        this.pending.delete(id);
      }
    }
  }

  /** 中止所有 pending（进程关闭） */
  abortAll(): void {
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
