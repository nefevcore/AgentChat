// ============================================================
// SessionManager —— 会话状态管理（v0.5.0 P1 无状态化）
//
// 从 core/agent.ts 抽出：会话运行态存储 + 每会话执行队列 + 活跃会话跟踪。
// Agent 实例通过 SessionManager 管理多会话并行状态，自身保持执行逻辑纯净。
// ============================================================

import { AgentExecutionQueue } from '../agent-queue';
import type { AgentMessage, AgentResult, TriggerOptions } from '@core/types';
import { createRunSession, type RunSession } from './run-session';

/** 会话键：1:1 `${sender}__${agentId}`；群聊 `group__${gid}__${agentId}` */
export function convKeyFor(agentId: string, sender: string, groupId?: string): string {
  return groupId ? `group__${groupId}__${agentId}` : `${sender}__${agentId}`;
}

export class SessionManager {
  private sessions = new Map<string, RunSession>();
  private queues = new Map<string, AgentExecutionQueue>();
  /** 当前正在执行的会话（continueTurn 默认 target，并行时指向最近启动） */
  private activeSession: RunSession | null = null;

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

  /** 获取/创建会话级执行队列（每会话独立串行，跨会话并行） */
  queueFor(convKey: string): AgentExecutionQueue {
    let q = this.queues.get(convKey);
    if (!q) {
      q = new AgentExecutionQueue(this.agentId, 32, {
        doReceive: (msg, sig) => this.handlers.doReceive(msg, sig),
        doTrigger: (opts, sig) => this.handlers.doTrigger(opts, sig),
      });
      this.queues.set(convKey, q);
    }
    return q;
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
