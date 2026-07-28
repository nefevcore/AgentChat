// ============================================================
// VirtualAgent —— 虚拟 Agent（无 LLM 推理，仅走 Hook 管道）
//
// 设计意图：
//   虚拟 Agent（如 user）没有 LLM，不进行 ReAct 推理循环。
//   但它仍然需要走 preHook → 确认 → postHook 管道，以确保
//   agent-session 等扩展的 postHook 能正常持久化收到的消息。
//
//   与 Agent 的区别：
//     - 无 LLM 实例，不调用任何模型
//     - 无工具、无拦截器
//     - receive() 仅构造上下文、调用 preHook、确认消息、调用 postHook
//     - trigger() 同理（但虚拟 Agent 通常不触发自主推理）
// ============================================================

import { EventEmitter } from 'events';
import {
  AgentContext,
  AgentMessage,
  Message,
  PreProcessHook,
  PostProcessHook,
  TriggerOptions,
} from './types';
import { AgentConfig } from '@discovery/config-types';
import { logger } from '../utils/logger';
import { genMessageId, deferMessage } from '@global/agent-core/extensions/agent-session/history';

// ============================================================
// AgentResult（与 Agent 保持一致）
// ============================================================

export interface AgentResult {
  content: string;
  interrupted: boolean;
}

// ============================================================
// VirtualAgent
// ============================================================

export class VirtualAgent {
  readonly config: AgentConfig;

  get agentId(): string { return this.config.agent_id; }
  get name(): string { return this.config.name; }

  private preHooks: PreProcessHook[] = [];
  private postHooks: PostProcessHook[] = [];
  private _eventBus?: EventEmitter;

  // ---- 执行队列（与 Agent 的串行化机制一致） ----

  private _isExecuting = false;

  private _executionQueue: Array<{
    message?: AgentMessage;
    triggerOptions?: TriggerOptions;
    signal?: AbortSignal;
    resolve: (result: AgentResult) => void;
    reject: (err: Error) => void;
    onAbort?: () => void;
  }> = [];

  private static readonly MAX_QUEUE_SIZE = 32;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  // ---- 配置 ----

  setEventBus(bus: EventEmitter): this { this._eventBus = bus; return this; }

  usePreHook(hook: PreProcessHook): this { this.preHooks.push(hook); return this; }
  usePostHook(hook: PostProcessHook): this { this.postHooks.push(hook); return this; }

  // ---- 内部事件发射 ----

  private _emit(type: string, payload: string, data?: Record<string, any>): void {
    if (!this._eventBus) return;
    const msg: AgentMessage = {
      from: this.agentId,
      to: 'user',
      type: type as any,
      payload,
      data,
    };
    this._eventBus.emit('message', msg);
  }

  // ---- Hook 管道 ----

  private async _applyPreHooks(ctx: AgentContext): Promise<AgentContext> {
    let result: AgentContext = { ...ctx };
    for (const hook of this.preHooks) {
      try {
        result = await hook(result);
      } catch (err: any) {
        logger.error(`[VirtualAgent] "${this.agentId}" preHook 执行异常，已跳过: ${err.message}`);
      }
    }
    return result;
  }

  private async _applyPostHooks(ctx: AgentContext, response: string): Promise<void> {
    for (const hook of this.postHooks) {
      try {
        await hook(ctx, response);
      } catch (err: any) {
        logger.error(`[VirtualAgent] "${this.agentId}" postHook 执行异常，已跳过: ${err.message}`);
      }
    }
  }

  // ============================================================
  // receive() —— 接收消息并走 Hook 管道
  // ============================================================

  async receive(message: AgentMessage, signal?: AbortSignal): Promise<AgentResult> {
    if (this._isExecuting) {
      if (this._executionQueue.length >= VirtualAgent.MAX_QUEUE_SIZE) {
        logger.warn(
          `[VirtualAgent] "${this.agentId}" 执行队列已满，拒绝新消息`
        );
        return {
          content: `[VirtualAgent] "${this.agentId}" 正忙，队列已满。请稍后重试。`,
          interrupted: false,
        };
      }

      logger.info(
        `[VirtualAgent] "${this.agentId}" 正忙，消息入队，` +
        `队列深度: ${this._executionQueue.length + 1}`
      );

      return new Promise<AgentResult>((resolve, reject) => {
        let onAbort: (() => void) | undefined;

        const entry = { message, signal, resolve, reject, onAbort: undefined as (() => void) | undefined };
        this._executionQueue.push(entry);

        if (signal) {
          onAbort = () => {
            const idx = this._executionQueue.indexOf(entry);
            if (idx !== -1) {
              this._executionQueue.splice(idx, 1);
              reject(new Error('已取消'));
            }
          };
          entry.onAbort = onAbort;

          if (signal.aborted) {
            const idx = this._executionQueue.indexOf(entry);
            if (idx !== -1) this._executionQueue.splice(idx, 1);
            reject(new Error('已取消'));
            return;
          }

          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }

    this._isExecuting = true;
    try {
      return await this._doReceive(message, signal);
    } finally {
      this._isExecuting = false;
      this._processNextInQueue();
    }
  }

  private async _doReceive(message: AgentMessage, signal?: AbortSignal): Promise<AgentResult> {
    // 构造 AgentContext（与 Agent._doReceive 保持一致）
    const ctx: AgentContext = {
      sender: message.from,
      receiver: this.agentId,
      systemPrompt: '',
      history: [],
      currentMessage: { role: 'user', content: message.payload },
      agentConfig: this.config,
      group_id: message.group_id,
    };

    // ---- preHook：加载历史、压缩上下文等 ----
    const processedCtx = await this._applyPreHooks(ctx);

    // ---- 延迟持久化（不立即写文件） ----
    // VirtualAgent 在 send_agent 工具执行期间被同步调用。若此处直接
    // appendJSONL，消息会插入到发送方 Agent 的工具调用/回复之前，打乱
    // 消息流。因此将消息加入延迟缓冲区，由发送方 Agent 的 postHook
    // （agent-session 扩展）在完成自身消息持久化后调用 flushDeferredMessages
    // 统一刷入，确保顺序正确。
    const now = new Date().toISOString();

    // 发送方发来的消息
    deferMessage(message.from, this.agentId, {
      role: 'agent',
      content: message.payload,
      agent_id: message.from,
      message_id: genMessageId(),
      label: `发送消息 → ${this.agentId}`,
      timestamp: now,
    });

    // 不虚构 assistant 回复 —— 发送方 Agent 通过工具返回值确认投递成功即可
    const response = `[VirtualAgent] "${this.agentId}" 已收到来自 "${message.from}" 的消息`;
    return { content: response, interrupted: false };
  }

  // ============================================================
  // trigger() —— 自主推理入口（虚拟 Agent 通常不触发）
  // ============================================================

  async trigger(options?: TriggerOptions, signal?: AbortSignal): Promise<AgentResult> {
    // 虚拟 Agent 不支持自主推理，直接返回
    logger.info(`[VirtualAgent] "${this.agentId}" trigger 被调用，虚拟 Agent 不支持自主推理`);
    return {
      content: `[VirtualAgent] "${this.agentId}" 是虚拟 Agent，不支持自主推理。`,
      interrupted: false,
    };
  }

  // ---- 队列处理 ----

  private _processNextInQueue(): void {
    if (this._executionQueue.length === 0) return;

    const entry = this._executionQueue.shift()!;
    // 清理 AbortSignal 监听器
    if (entry.onAbort && entry.signal) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }

    this._isExecuting = true;

    const promise = entry.message
      ? this._doReceive(entry.message, entry.signal)
      : this.trigger(entry.triggerOptions, entry.signal);

    promise
      .then(result => {
        this._isExecuting = false;
        entry.resolve(result);
        this._processNextInQueue();
      })
      .catch(err => {
        this._isExecuting = false;
        entry.reject(err);
        this._processNextInQueue();
      });
  }
}
