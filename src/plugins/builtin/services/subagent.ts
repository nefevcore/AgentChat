// ============================================================
// src/plugins/builtin/services/subagent.ts —— 子 Agent 生命周期管理（照搬旧 mod src/sub-agent）
//
// 设计原则（照搬旧）：
//   子 Agent = 无 hooks 的独立执行：
//     · 不注册 turnStart/turnEnd → 无会话持久化、无记忆注入
//     · 独立上下文（只含任务 + 上下文），不背父 Agent 的中间产物
//     · 受控工具集（从父 Agent 的工具中按名筛选）
//     · 共享父 Agent 的 LLM 实例（LLMProvider 无状态，安全复用）
//     · 独立 AbortController（超时/父 kill 可中断）
//
// 适配新架构：旧 Agent 类 → src/core/loop.run(createContext(...))。
// 生命周期：spawn → running → done/error/timeout/killed → 自动回收
//   · 完成后 handle 保留结果，供父 Agent awaitResult 读取
//   · 超时/kill 后自动清理，释放引用
//
// 依赖方向：仅依赖 src/core + Node 内置。
// ============================================================

import { createContext } from '@core/context';
import { run } from '@core/loop';
import { createLogger } from '@core/logger';
import type { LLMProvider, Message, Tool } from '@core/types';
import { EventEmitter } from 'events';

const logger = createLogger('[SubAgent]');

// ============================================================
// 类型
// ============================================================

export type SubAgentStatus = 'running' | 'done' | 'error' | 'timeout' | 'killed';

export interface SubAgentHandle {
  id: string;
  parentId: string;
  name: string;
  status: SubAgentStatus;
  task: string;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
}

export interface SpawnSubAgentOptions {
  parentId: string;
  name?: string;
  task: string;
  context?: string;
  toolNames?: string[];
  maxTurns?: number;
  timeoutMs?: number;
}

interface SubEntry {
  handle: SubAgentHandle;
  controller: AbortController;
  promise: Promise<void>;
}

// ============================================================
// SubAgentManager
// ============================================================

export class SubAgentManager {
  private subs = new Map<string, SubEntry>();
  /** 已完成的 handle 缓存（上限 50） */
  private completed = new Map<string, SubAgentHandle>();
  private _eventBus?: EventEmitter;
  private static readonly DEFAULT_TIMEOUT_MS = 5 * 60_000;

  /** 由 bootstrap 注入事件总线（Router） */
  setEventBus(bus: EventEmitter): this { this._eventBus = bus; return this; }

  /**
   * 创建并启动子 Agent。
   * 返回 handle（含 id），异步执行不阻塞。
   */
  async spawn(
    opts: SpawnSubAgentOptions,
    llm: LLMProvider,
    parentTools: Map<string, Tool>,
    onEvent?: (type: string, payload: string, data?: Record<string, unknown>) => void,
  ): Promise<SubAgentHandle> {
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const name = opts.name || `子任务`;

    // 受控工具集：从父 Agent 工具按名筛选（子 Agent 不可能比父更强）
    const toolNames = opts.toolNames?.length ? opts.toolNames : [];
    const tools = new Map<string, Tool>();
    if (toolNames.length > 0) {
      for (const n of toolNames) {
        const t = parentTools.get(n);
        if (t) tools.set(n, t);
      }
    }

    const handle: SubAgentHandle = {
      id, parentId: opts.parentId, name, status: 'running',
      task: opts.task, startedAt: Date.now(),
    };

    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? SubAgentManager.DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      logger.warn(`"${id}" 超时（${Math.round(timeoutMs / 1000)}s），强制终止`);
      controller.abort();
    }, timeoutMs);

    // 组装任务 prompt：独立上下文，不背父 Agent 历史（照搬旧）
    const parts = [
      `[子任务] 请作为独立子 Agent 完成以下任务。`,
      ``,
      `任务：${opts.task}`,
    ];
    if (opts.context?.trim()) {
      parts.push(``, `[上下文]`, opts.context.trim());
    }
    parts.push(``, `要求：独立思考并执行，完成后只返回最终结论。你的思考过程与工具调用不会写入任何会话记录。`);
    const payload = parts.join('\n');

    const msg: Message = {
      role: 'user',
      content: payload,
      agent_id: opts.parentId,
    };

    const promise = (async () => {
      try {
        // 子 Agent 无 hooks/无持久化/无历史：最小上下文装配
        const ctx = createContext({
          llm,
          systemPrompt: '',
          history: [],
          currentMessage: msg,
          tools,
          maxTurns: opts.maxTurns,
          signal: controller.signal,
          emit: onEvent,
        });
        const result = await run(ctx);
        clearTimeout(timer);
        if (controller.signal.aborted) {
          handle.status = handle.status === 'running' ? 'timeout' : handle.status;
        } else {
          handle.status = 'done';
          handle.result = result.content;
        }
        handle.finishedAt = Date.now();
        logger.info(`"${id}" 完成（status=${handle.status}, ${handle.finishedAt - handle.startedAt}ms）`);
      } catch (err: any) {
        clearTimeout(timer);
        handle.status = controller.signal.aborted ? 'timeout' : 'error';
        handle.error = err?.message ?? String(err);
        handle.finishedAt = Date.now();
        logger.warn(`"${id}" 异常（${handle.status}）: ${handle.error}`);
      } finally {
        // 回收：从活跃表移除，handle 移入 completed 缓存供 awaitResult 查询
        this.subs.delete(id);
        this.completed.set(id, handle);
        if (this.completed.size > 50) {
          const oldest = this.completed.keys().next().value;
          if (oldest) this.completed.delete(oldest);
        }
        logger.info(`"${id}" 已回收，活跃 ${this.subs.size}，完成缓存 ${this.completed.size}`);
      }
    })();

    this.subs.set(id, { handle, controller, promise });
    logger.info(`"${id}" 已创建（父=${opts.parentId}, tools=${toolNames.length}, timeout=${Math.round(timeoutMs / 1000)}s）`);
    return handle;
  }

  /**
   * 等待子 Agent 完成（可带额外等待超时，避免主 Agent 无限等待）。
   * 返回最终 handle（含 result/error）。
   */
  async awaitResult(id: string, waitMs?: number): Promise<SubAgentHandle | null> {
    const done = this.completed.get(id);
    if (done) return done;

    const entry = this.subs.get(id);
    if (!entry) return null;
    if (waitMs && waitMs > 0) {
      const timer = setTimeout(() => {
        logger.info(`"${id}" await 超时（${waitMs}ms），任务仍在后台运行`);
      }, waitMs);
      await entry.promise;
      clearTimeout(timer);
    } else {
      await entry.promise;
    }
    return entry.handle;
  }

  /** 中断并回收子 Agent */
  kill(id: string): boolean {
    const entry = this.subs.get(id);
    if (!entry) return false;
    entry.handle.status = 'killed';
    entry.handle.finishedAt = Date.now();
    entry.controller.abort();
    logger.info(`"${id}" 已被 kill`);
    return true;
  }

  /** 列出所有活跃子 Agent */
  list(): SubAgentHandle[] {
    return [...this.subs.values()].map(e => e.handle);
  }

  /** 获取单个子 Agent 状态（活跃或已完成的缓存） */
  get(id: string): SubAgentHandle | undefined {
    return this.subs.get(id)?.handle ?? this.completed.get(id);
  }

  /** 活跃数量 */
  get size(): number { return this.subs.size; }
}
