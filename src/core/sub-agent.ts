// ============================================================
// SubAgentManager —— 子 Agent 生命周期管理（v0.4.0 里程碑）
//
// 设计原则：
//   子 Agent = 无 hooks 的独立 Agent 实例：
//     · 不注册 preHook/postHook → 无 agent-session 持久化、无记忆注入
//     · 独立上下文（只含任务 + 上下文），不背父 Agent 的中间产物
//     · 受控工具集（从父 Agent 的工具中按名筛选）
//     · 共享父 Agent 的 LLM 实例（LLMProvider 无状态，安全复用）
//     · 独立 AbortController（超时/父 kill 可中断）
//
// 生命周期：spawn → running → done/error/timeout/killed → 自动回收
//   · 完成后 handle 保留结果，供父 Agent awaitResult 读取
//   · 超时/kill 后自动清理，释放引用
//
// 与主 Agent 的隔离：
//   · 子 Agent ID 为 sub_xxx，不在 registry 中 → send_agent 校验失败
//     （子 Agent 无法对外发消息，无副作用泄漏）
//   · 事件经 router 广播，但 agentId=sub_xxx ≠ 活跃 Agent → 前端忽略
// ============================================================

import { Agent } from './agent';
import { AgentMessage, LLMProvider } from './types';
import { AgentConfig } from '@discovery/config-types';
import { Tool } from '@core/types';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

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
  /** 完成时的最终结论（status=done） */
  result?: string;
  /** 错误信息（status=error） */
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
  agent: Agent;
  controller: AbortController;
  promise: Promise<void>;
}

// ============================================================
// SubAgentManager
// ============================================================

export class SubAgentManager {
  private subs = new Map<string, SubEntry>();
  private _eventBus?: EventEmitter;
  private static readonly DEFAULT_TIMEOUT_MS = 5 * 60_000;

  /** 由 bootstrap 注入事件总线（Router） */
  setEventBus(bus: EventEmitter): this { this._eventBus = bus; return this; }

  /**
   * 创建并启动子 Agent。
   * 返回 handle（含 id），异步执行不阻塞。
   */
  async spawn(opts: SpawnSubAgentOptions, llm: LLMProvider, parentTools: Map<string, Tool>): Promise<SubAgentHandle> {
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const name = opts.name || `子任务`;

    const config: AgentConfig = {
      agent_id: id,
      name,
      // 子 Agent 无扩展/无持久化，仅继承父 Agent 的 LLM 引用
      llm: {},
    };

    const agent = new Agent(config);
    if (this._eventBus) agent.setEventBus(this._eventBus);
    agent.setLLM(llm);

    // 受控工具集：从父 Agent 工具按名筛选（子 Agent 不可能比父更强）
    const toolNames = opts.toolNames?.length ? opts.toolNames : [];
    if (toolNames.length > 0) {
      const selected: Tool[] = [];
      for (const name of toolNames) {
        const t = parentTools.get(name);
        if (t) selected.push(t);
      }
      if (selected.length > 0) agent.registerTools(selected);
    }

    const handle: SubAgentHandle = {
      id, parentId: opts.parentId, name, status: 'running',
      task: opts.task, startedAt: Date.now(),
    };

    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? SubAgentManager.DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      logger.warn(`[SubAgent] "${id}" 超时（${Math.round(timeoutMs / 1000)}s），强制终止`);
      controller.abort();
    }, timeoutMs);

    // 组装任务 prompt：独立上下文，不背父 Agent 历史
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

    const msg: AgentMessage = {
      from: opts.parentId,
      to: id,
      type: 'chat.send',
      payload,
    };

    const promise = agent.receive(msg, controller.signal)
      .then((result) => {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          handle.status = handle.status === 'running' ? 'timeout' : handle.status;
        } else {
          handle.status = 'done';
          handle.result = result.content;
        }
        handle.finishedAt = Date.now();
        logger.info(`[SubAgent] "${id}" 完成（status=${handle.status}, ${handle.finishedAt - handle.startedAt}ms）`);
      })
      .catch((err: any) => {
        clearTimeout(timer);
        handle.status = controller.signal.aborted ? 'timeout' : 'error';
        handle.error = err?.message ?? String(err);
        handle.finishedAt = Date.now();
        logger.warn(`[SubAgent] "${id}" 异常（${handle.status}）: ${handle.error}`);
      })
      .finally(() => {
        // 自动回收：从活跃表中移除（handle 仍被外部引用可读结果）
        this.subs.delete(id);
        logger.info(`[SubAgent] "${id}" 已回收，剩余 ${this.subs.size} 个活跃子 Agent`);
      });

    this.subs.set(id, { handle, agent, controller, promise });
    logger.info(`[SubAgent] "${id}" 已创建（父=${opts.parentId}, tools=${toolNames.length}, timeout=${Math.round(timeoutMs / 1000)}s）`);
    return handle;
  }

  /**
   * 等待子 Agent 完成（可带额外等待超时，避免主 Agent 无限等待）。
   * 返回最终 handle（含 result/error）。
   */
  async awaitResult(id: string, waitMs?: number): Promise<SubAgentHandle | null> {
    const entry = this.subs.get(id);
    if (!entry) {
      // 可能已完成并回收 → 返回 null（调用方通过 list/get 查结果）
      return null;
    }
    if (waitMs && waitMs > 0) {
      const timer = setTimeout(() => {
        // 等待超时不 kill，仅放弃等待；主 Agent 可再次 await
        logger.info(`[SubAgent] "${id}" await 超时（${waitMs}ms），任务仍在后台运行`);
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
    logger.info(`[SubAgent] "${id}" 已被 kill`);
    return true;
  }

  /** 列出所有活跃子 Agent */
  list(): SubAgentHandle[] {
    return [...this.subs.values()].map(e => e.handle);
  }

  /** 获取单个子 Agent 状态 */
  get(id: string): SubAgentHandle | undefined {
    return this.subs.get(id)?.handle;
  }

  /** 活跃数量 */
  get size(): number { return this.subs.size; }
}

/** 全局单例（由 bootstrap 初始化） */
let _manager: SubAgentManager | null = null;

export function getSubAgentManager(): SubAgentManager {
  if (!_manager) {
    _manager = new SubAgentManager();
  }
  return _manager;
}

export function setSubAgentManager(m: SubAgentManager): void { _manager = m; }
