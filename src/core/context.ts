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
import { AgentExecutionQueue } from './queue';
import type { AgentMessage, AgentResult, TriggerOptions } from '@core/types';

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
// 会话运行态存储 + 每会话执行队列 + 活跃会话跟踪。
// loop 通过 SessionManager 管理多会话并行状态，自身保持执行逻辑纯净。
// ============================================================

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
