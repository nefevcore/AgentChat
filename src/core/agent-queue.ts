// ============================================================
// Agent 执行队列 —— 保证 receive()/trigger() 调用串行化
// ============================================================

import { AgentMessage, AgentResult, TriggerOptions } from './types';
import { logger } from '../utils/logger';

// ---- 队列条目 ----

export interface QueueEntry {
  message?: AgentMessage;
  triggerOptions?: TriggerOptions;
  signal?: AbortSignal;
  resolve: (result: AgentResult) => void;
  reject: (err: Error) => void;
  onAbort?: () => void;
}

// ---- 执行回调 ----

export interface QueueExecutor {
  doReceive(msg: AgentMessage, signal?: AbortSignal): Promise<AgentResult>;
  doTrigger(opts?: TriggerOptions, signal?: AbortSignal): Promise<AgentResult>;
}

// ---- 队列 ----

export class AgentExecutionQueue {
  private queue: QueueEntry[] = [];
  private isExecuting = false;

  constructor(
    private agentId: string,
    private maxSize: number,
    private executor: QueueExecutor,
  ) {}

  // ===========================================
  // 公开入口
  // ===========================================

  async receive(message: AgentMessage, signal?: AbortSignal): Promise<AgentResult> {
    if (this.isExecuting) {
      return this._enqueueReceive(message, signal);
    }
    return this._executeNow('receive', message, signal);
  }

  async trigger(options?: TriggerOptions, signal?: AbortSignal): Promise<AgentResult> {
    if (this.isExecuting) {
      const source = options?.source;
      if (source) this._coalesce(source);
      return this._enqueueTrigger(source ?? 'unknown', options, signal);
    }
    return this._executeNow('trigger', options, signal);
  }

  // ===========================================
  // 直接执行
  // ===========================================

  private async _executeNow(
    mode: 'receive' | 'trigger',
    arg: any,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    this.isExecuting = true;
    try {
      return mode === 'receive'
        ? await this.executor.doReceive(arg, signal)
        : await this.executor.doTrigger(arg, signal);
    } finally {
      this.isExecuting = false;
      this._processNext();
    }
  }

  // ===========================================
  // 入队
  // ===========================================

  private _enqueueReceive(message: AgentMessage, signal?: AbortSignal): Promise<AgentResult> {
    // 死锁防护：send_agent（type='request'）目标忙时立即拒绝
    if (message.type === 'request') {
      logger.info(`[Agent] "${this.agentId}" 正忙，拒绝 send_agent 请求 (from: ${message.from})`);
      return Promise.resolve({
        content: `[Agent] "${this.agentId}" 当前正忙，无法处理来自 "${message.from}" 的 send_agent 请求。请稍后重试，或改用 send_group 在群聊中沟通。`,
        interrupted: false,
      });
    }

    if (this.queue.length >= this.maxSize) {
      logger.warn(`[Agent] "${this.agentId}" 执行队列已满 (${this.maxSize})，拒绝新消息 (from: ${message.from}, type: ${message.type})`);
      return Promise.resolve({
        content: `[Agent] "${this.agentId}" 正忙，执行队列已满。请稍后重试。`,
        interrupted: false,
      });
    }

    logger.info(`[Agent] "${this.agentId}" 正忙，消息入队 (from: ${message.from})，队列深度: ${this.queue.length + 1}`);
    return this._enqueue({ message, signal }, `消息 (from: ${message.from})`);
  }

  private _enqueueTrigger(source: string, options?: TriggerOptions, signal?: AbortSignal): Promise<AgentResult> {
    if (this.queue.length >= this.maxSize) {
      logger.warn(`[Agent] "${this.agentId}" 执行队列已满 (${this.maxSize})，拒绝 trigger (source: ${source})`);
      return Promise.resolve({
        content: `[Agent] "${this.agentId}" 正忙，执行队列已满。请稍后重试。`,
        interrupted: false,
      });
    }

    logger.info(`[Agent] "${this.agentId}" 正忙，trigger 入队 (source: ${source})，队列深度: ${this.queue.length + 1}`);
    return this._enqueue({ triggerOptions: options, signal }, `trigger (source: ${source})`);
  }

  private _enqueue(partial: Partial<QueueEntry>, label: string): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const entry: QueueEntry = { ...partial, resolve, reject, onAbort: undefined } as QueueEntry;
      this.queue.push(entry);

      if (entry.signal) {
        onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            logger.info(`[Agent] "${this.agentId}" 队列${label}已取消，剩余: ${this.queue.length}`);
            reject(new Error('已取消'));
          }
        };
        entry.onAbort = onAbort;

        if (entry.signal.aborted) {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) this.queue.splice(idx, 1);
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

  /** 移除队列中同 source 的旧条目，只保留即将入队的最新一条 */
  private _coalesce(source: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const entry = this.queue[i];
      if (entry.triggerOptions?.source === source) {
        if (entry.onAbort && entry.signal) {
          entry.signal.removeEventListener('abort', entry.onAbort);
        }
        entry.resolve({ content: '', interrupted: false });
        this.queue.splice(i, 1);
        logger.info(`[Agent] "${this.agentId}" 队列 trigger 合并 (source: ${source})，队列剩余: ${this.queue.length}`);
      }
    }
  }

  // ===========================================
  // 出队处理
  // ===========================================

  private _processNext(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;

      // 清理 signal 监听器
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      // 已取消 → 跳过
      if (next.signal?.aborted) {
        next.reject(new Error('已取消'));
        continue;
      }

      this.isExecuting = true;
      const done = () => { this.isExecuting = false; this._processNext(); };

      if (next.triggerOptions) {
        logger.info(`[Agent] "${this.agentId}" 从队列取出 trigger (source: ${next.triggerOptions.source ?? 'unknown'})，队列剩余: ${this.queue.length}`);
        this.executor.doTrigger(next.triggerOptions, next.signal).then(next.resolve).catch(next.reject).finally(done);
      } else if (next.message) {
        logger.info(`[Agent] "${this.agentId}" 从队列取出消息 (from: ${next.message.from})，队列剩余: ${this.queue.length}`);
        this.executor.doReceive(next.message, next.signal).then(next.resolve).catch(next.reject).finally(done);
      } else {
        next.reject(new Error('队列条目缺少 message 或 triggerOptions'));
        this.isExecuting = false;
        continue;
      }
      return;
    }
  }
}
