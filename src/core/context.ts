// ============================================================
// Context —— 会话运行态与上下文管理（v0.5.0 P1 无状态化）
//
// 目标架构（architecture-target-20260805）：
//   单次执行输入快照 ctx{ llm, systemPrompt, history, currentMessage, tools, steer }。
//   本文件聚合了会话运行态（RunSession）+ 会话管理器（SessionManager），
//   是 loop 纯函数的"可变收集区（steer）"载体。
//
// convKey 标识会话：
//   1:1  → `${sender}__${agentId}`
//   群聊 → `group__${groupId}__${agentId}`
// ============================================================

import type { Message } from '@core/types';
import type { LLMUsage } from '@core/types';
import type { AgentMessage, AgentResult, TriggerOptions } from '@core/types';
import { logger } from '@utils/logger';

// ============================================================
// RunSession —— 会话运行态（per-session 可变状态）
// ============================================================

export interface RunSession {
  /** 会话键（唯一标识一个会话） */
  convKey: string;
  /** 当前会话对方（sender） */
  sender: string;
  /** DeepSeek 缓存隔离 user_id（格式 <sender>__<receiver>） */
  userId: string;
  /** 转向消息队列（steer）：用户/其他 Agent 中途插入的指令（按会话隔离） */
  steeringQueue: Message[];
  /** 本轮累计 Token 用量（per-session） */
  cumulativeUsage?: LLMUsage;
  /** 当前运行 AbortController（优雅关闭/重启时 abort） */
  abortController: AbortController | null;
  /** 当前轮事件关联 ID */
  cid: string;
  /** 本轮 thinking 开始时间（毫秒） */
  thinkingStartTime: number;
}

/** 创建新会话运行态 */
export function createRunSession(convKey: string, sender: string): RunSession {
  return {
    convKey,
    sender,
    userId: '',
    steeringQueue: [],
    cumulativeUsage: undefined,
    abortController: null,
    cid: '',
    thinkingStartTime: 0,
  };
}

// ============================================================
// SessionManager —— 会话状态管理
//
// 会话运行态存储 + per-conv 执行控制（§5.2 队列内化）+ 活跃会话跟踪。
//
// §5.2 内化（queue 不再独立成模块）：
//   原 AgentExecutionQueue（core/queue.ts）的串行化语义并入本管理器：
//   · running  Set    —— per-conv 运行标记（runningMap：会话占位）
//   · steeringQueue（RunSession）—— steer 收集区（loop 每轮消费）
//   · pending  Map    —— 忙时入队（同会话串行，跨会话并行）
// loop 通过 SessionManager 管理多会话并行状态，自身保持执行逻辑纯净。
// ============================================================

/** 会话键：1:1 `${sender}__${agentId}`；群聊 `group__${gid}__${agentId}` */
export function convKeyFor(agentId: string, sender: string, groupId?: string): string {
  return groupId ? `group__${groupId}__${agentId}` : `${sender}__${agentId}`;
}

/** 待处理条目（内化队列，语义与旧 AgentExecutionQueue 等价） */
interface PendingEntry {
  message?: AgentMessage;
  triggerOptions?: TriggerOptions;
  signal?: AbortSignal;
  resolve: (result: AgentResult) => void;
  reject: (err: Error) => void;
  onAbort?: () => void;
}

export class SessionManager {
  private sessions = new Map<string, RunSession>();
  /** per-conv 待处理条目（原 AgentExecutionQueue，§5.2 内化） */
  private pending = new Map<string, PendingEntry[]>();
  /** per-conv 运行标记（runningMap：会话占位与 steer 收集载体） */
  private running = new Set<string>();
  /** 当前正在执行的会话（continueTurn 默认 target，并行时指向最近启动） */
  private activeSession: RunSession | null = null;
  private static readonly MAX_PENDING = 32;

  constructor(
    private agentId: string,
    private handlers: {
      doReceive: (msg: AgentMessage, sig?: AbortSignal) => Promise<AgentResult>;
      doTrigger: (opts: TriggerOptions | undefined, sig?: AbortSignal) => Promise<AgentResult>;
    },
  ) {}

  /** 获取/创建会话运行态 */
  getOrCreate(convKey: string, sender: string): RunSession {
    let s = this.sessions.get(convKey);
    if (!s) {
      s = createRunSession(convKey, sender);
      this.sessions.set(convKey, s);
    } else {
      s.sender = sender;
    }
    return s;
  }

  // ===========================================
  // 执行入口（内化队列）
  // ===========================================

  /** receive：会话忙 → 入队；空闲 → 立即执行 */
  async receive(convKey: string, message: AgentMessage, signal?: AbortSignal): Promise<AgentResult> {
    if (this.running.has(convKey)) {
      return this._enqueue(convKey, { message, signal }, `消息 (from: ${message.from})`);
    }
    return this._executeNow(convKey, 'receive', message, signal);
  }

  /** trigger：会话忙 → 同 source 合并后入队；空闲 → 立即执行 */
  async trigger(convKey: string, options?: TriggerOptions, signal?: AbortSignal): Promise<AgentResult> {
    if (this.running.has(convKey)) {
      const source = options?.source;
      if (source) this._coalesce(convKey, source);
      return this._enqueue(convKey, { triggerOptions: options, signal }, `trigger (source: ${source ?? 'unknown'})`);
    }
    return this._executeNow(convKey, 'trigger', options, signal);
  }

  // ===========================================
  // 直接执行
  // ===========================================

  private async _executeNow(
    convKey: string,
    mode: 'receive' | 'trigger',
    arg: any,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    this.running.add(convKey);
    try {
      return mode === 'receive'
        ? await this.handlers.doReceive(arg, signal)
        : await this.handlers.doTrigger(arg, signal);
    } finally {
      this.running.delete(convKey);
      this._processNext(convKey);
    }
  }

  // ===========================================
  // 入队
  // ===========================================

  private _enqueue(convKey: string, partial: Partial<PendingEntry>, label: string): Promise<AgentResult> {
    let list = this.pending.get(convKey);
    if (!list) {
      list = [];
      this.pending.set(convKey, list);
    }
    if (list.length >= SessionManager.MAX_PENDING) {
      logger.warn(`[Agent] "${this.agentId}" 执行队列已满 (${SessionManager.MAX_PENDING})，拒绝${label}`);
      return Promise.resolve({
        content: `[Agent] "${this.agentId}" 正忙，执行队列已满。请稍后重试。`,
        interrupted: false,
      });
    }
    logger.info(`[Agent] "${this.agentId}" 正忙，${label}入队，队列深度: ${list.length + 1}`);

    return new Promise<AgentResult>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const entry: PendingEntry = { ...partial, resolve, reject, onAbort: undefined } as PendingEntry;
      list.push(entry);

      if (entry.signal) {
        onAbort = () => {
          const idx = list.indexOf(entry);
          if (idx !== -1) {
            list.splice(idx, 1);
            logger.info(`[Agent] "${this.agentId}" 队列${label}已取消，剩余: ${list.length}`);
            reject(new Error('已取消'));
          }
        };
        entry.onAbort = onAbort;

        if (entry.signal.aborted) {
          const idx = list.indexOf(entry);
          if (idx !== -1) list.splice(idx, 1);
          reject(new Error('已取消'));
          return;
        }
        entry.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  // ===========================================
  // trigger 去重
  // ===========================================

  /** 移除 pending 中同 source 的旧条目，只保留最新一条 */
  private _coalesce(convKey: string, source: string): void {
    const list = this.pending.get(convKey);
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (entry.triggerOptions?.source === source) {
        if (entry.onAbort && entry.signal) {
          entry.signal.removeEventListener('abort', entry.onAbort);
        }
        entry.resolve({ content: '', interrupted: false });
        list.splice(i, 1);
        logger.info(`[Agent] "${this.agentId}" 队列 trigger 合并 (source: ${source})，队列剩余: ${list.length}`);
      }
    }
  }

  // ===========================================
  // 出队处理
  // ===========================================

  private _processNext(convKey: string): void {
    const list = this.pending.get(convKey);
    if (!list || list.length === 0) return;
    while (list.length > 0) {
      const next = list.shift()!;

      // 清理 signal 监听器
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      // 已取消 → 跳过
      if (next.signal?.aborted) {
        next.reject(new Error('已取消'));
        continue;
      }

      this.running.add(convKey);
      const done = () => { this.running.delete(convKey); this._processNext(convKey); };

      if (next.triggerOptions) {
        logger.info(`[Agent] "${this.agentId}" 从队列取出 trigger (source: ${next.triggerOptions.source ?? 'unknown'})，队列剩余: ${list.length}`);
        this.handlers.doTrigger(next.triggerOptions, next.signal).then(next.resolve).catch(next.reject).finally(done);
      } else if (next.message) {
        // ---- 批量合并：拉取队列中同发送方的连续消息，一并处理 ----
        const merged = this._collectConsecutiveMessages(list, next);
        const count = merged.messages.length;
        if (count > 1) {
          logger.info(`[Agent] "${this.agentId}" 批量合并 ${count} 条消息 (from: ${next.message.from})，队列剩余: ${list.length}`);
        } else {
          logger.info(`[Agent] "${this.agentId}" 从队列取出消息 (from: ${next.message.from})，队列剩余: ${list.length}`);
        }
        // 所有被合并的条目共享同一个 resolve/reject
        this.handlers.doReceive(merged.combinedMessage, next.signal)
          .then(result => {
            next.resolve(result);
            for (const m of merged.messages.slice(1)) m.resolve(result);
          })
          .catch(err => {
            next.reject(err);
            for (const m of merged.messages.slice(1)) m.reject(err);
          })
          .finally(done);
      } else {
        next.reject(new Error('队列条目缺少 message 或 triggerOptions'));
        this.running.delete(convKey);
        continue;
      }
      return;
    }
  }

  /** 批量合并：收集 pending 中与首条消息同发送方的连续消息（语义与旧队列等价） */
  private _collectConsecutiveMessages(list: PendingEntry[], first: PendingEntry): {
    combinedMessage: AgentMessage;
    messages: PendingEntry[];
  } {
    const from = first.message!.from;
    const entries: PendingEntry[] = [first];

    while (list.length > 0 && list[0].message?.from === from) {
      const next = list.shift()!;
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      if (next.signal?.aborted) {
        next.reject(new Error('已取消'));
        continue;
      }
      entries.push(next);
    }

    if (entries.length === 1) {
      return { combinedMessage: first.message!, messages: entries };
    }

    const payloads = entries.map((e, i) => `--- 消息 ${i + 1} ---\n${e.message!.payload}`);
    const mergedPayload = `[合并消息] 来自 ${from} 的 ${entries.length} 条消息：\n\n${payloads.join('\n\n')}`;

    const combinedMessage: AgentMessage = {
      ...first.message!,
      payload: mergedPayload,
      data: {
        ...first.message!.data,
        _merged_count: entries.length,
        _merged_from: from,
      },
    };

    return { combinedMessage, messages: entries };
  }

  /** 标记活跃会话（continueTurn 默认 target） */
  setActive(session: RunSession): void {
    this.activeSession = session;
  }

  /** 最近活跃会话（无则 null） */
  get active(): RunSession | null {
    return this.activeSession;
  }

  /** 所有会话（中止全部时用） */
  all(): RunSession[] {
    return [...this.sessions.values()];
  }

  /** 中止所有活跃会话（优雅关闭/重启） */
  abortAll(): void {
    for (const s of this.sessions.values()) s.abortController?.abort();
  }
}
