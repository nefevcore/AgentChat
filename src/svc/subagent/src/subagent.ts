// ============================================================
// src/plugins/builtin/services/subagent.ts —— 子 Agent 生命周期管理（照搬旧 mod src/sub-agent）
//
// 设计原则（照搬旧）：
//   子 Agent = 无 hooks 的独立执行：
//     · 不注册 stepStart/stepEnd → 无会话持久化、无记忆注入
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

import type { AgentLoopEngine, Tool } from '@agentchat/agent-loop';
import type { AgentMessage } from '@agentchat/types';
import { createLogger } from '@agentchat/util';
import type { LLMProvider } from '@agentchat/llm';
import type { JobService } from '@agentchat/jobs';
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
  maxSteps?: number;
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
  /** ReAct 引擎入口（ctx.agentLoop 注入；契约化后不直接 import 引擎） */
  private engine: AgentLoopEngine;
  /** 通用后台任务注册表（ctx.jobs；接入统一任务词汇/完成通知，可缺省） */
  private jobs?: JobService;
  private static readonly DEFAULT_TIMEOUT_MS = 5 * 60_000;

  constructor(engine: AgentLoopEngine) {
    this.engine = engine;
  }

  /** 由 bootstrap 注入事件总线（Router） */
  setEventBus(bus: EventEmitter): this { this._eventBus = bus; return this; }

  /** 注入通用后台任务注册表（ctx.jobs；spawn 时登记 kind=subagent 任务） */
  setJobs(jobs?: JobService): this { this.jobs = jobs; return this; }

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

    const msg: AgentMessage = {
      role: 'user',
      content: payload,
      agent_id: opts.parentId,
    };

    const promise = (async () => {
      try {
        // 子 Agent 无 hooks/无持久化/无历史：最小上下文装配
        const ctx = this.engine.createContext({
          llm,
          systemPrompt: '',
          history: [],
          currentMessage: msg,
          tools,
          maxSteps: opts.maxSteps,
          signal: controller.signal,
          emit: onEvent,
        });
        const result = await this.engine.run(ctx);
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

    // 接入通用后台任务注册表（ctx.jobs）：kind=subagent，与 bash background
    // 同一任务词汇/owner 分桶/完成通知；job 工具可统一 list/kill。
    // 映射：subagent done→completed / error→failed / timeout|killed→killed。
    if (this.jobs) {
      try {
        this.jobs.start({
          kind: 'subagent',
          label: opts.task.slice(0, 80),
          ownerAgentId: opts.parentId,
          meta: { subagentId: id, name, parentId: opts.parentId },
          run: () => ({
            cancel: () => { this.kill(id); },
            done: promise.then(() => {
              switch (handle.status) {
                case 'done': return { status: 'completed' as const, detail: 'exit ok', output: handle.result ?? '' };
                case 'error': return { status: 'failed' as const, detail: handle.error ?? 'error' };
                case 'timeout': return { status: 'killed' as const, detail: 'timeout' };
                default: return { status: 'killed' as const, detail: 'killed by parent' };
              }
            }),
            readOutput: () => handle.result ?? handle.error ?? '',
          }),
        });
      } catch (err: any) {
        logger.warn(`"${id}" 登记 ctx.jobs 失败（不影响执行）: ${err?.message ?? String(err)}`);
      }
    }

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

  /**
   * 运行跟踪快照：活跃 + 最近完成（completed 缓存，finishedAt 降序）。
   * Agent 运行跟踪页 SubAgent 页签消费；只读拷贝，不暴露内部 Map。
   */
  listAll(): { active: SubAgentHandle[]; completed: SubAgentHandle[] } {
    const completed = [...this.completed.values()]
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    return { active: this.list(), completed };
  }

  /** 获取单个子 Agent 状态（活跃或已完成的缓存） */
  get(id: string): SubAgentHandle | undefined {
    return this.subs.get(id)?.handle ?? this.completed.get(id);
  }

  /** 活跃数量 */
  get size(): number { return this.subs.size; }
}
