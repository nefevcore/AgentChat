// ============================================================
// @agentchat/agent-loop/src/service.ts —— ReAct 引擎服务（cordis Service）
//
// 契约化阶段⑤（2026-08-14）：引擎从"库依赖"提升为"契约服务"——
// ctx.agentLoop 暴露引擎入口（run/createContext + inbox 投递原语），消费者
// （router/agents/subagent）经 AgentAssembly.engine / 构造器注入获得，
// 不再直接 import 引擎函数（包间以契约耦合，对齐 DSH agent-loop 行）。
//
// 类型/契约仍从本包 import type（Tool/CurrentContext/RunResult 等是引擎
// 契约的一部分，非运行期依赖）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { run } from './loop';
import {
  createContext,
  drainInbox,
  enqueue,
  followup,
  inject,
  pushSteer,
  steer,
} from './context';
import type { CurrentContext, InboxTarget } from './context';
import type { RunResult } from './contracts';
import type { AgentMessage } from '@agentchat/types';

/** 引擎契约（AgentAssembly.engine / SubAgentManager 构造器注入的类型面） */
export interface AgentLoopEngine {
  run(ctx: CurrentContext): Promise<RunResult>;
  createContext: typeof createContext;
  /** 按 lane 入队（底层原语） */
  enqueue(ctx: CurrentContext, message: AgentMessage, target: InboxTarget): void;
  /** next-turn：run 结束后作为独立轮次消费 */
  followup(ctx: CurrentContext, message: AgentMessage): void;
  /** next-step：当前 run 下一个 ReAct step 消费 */
  steer(ctx: CurrentContext, message: AgentMessage): void;
  /** next-step 但 idle 不唤醒（等待后续输入） */
  inject(ctx: CurrentContext, message: AgentMessage): void;
  /** 消费指定 lane 队列 */
  drainInbox(ctx: CurrentContext, target: InboxTarget): AgentMessage[];
  /** @deprecated 旧 API = steer（next-step） */
  pushSteer(ctx: CurrentContext, message: AgentMessage): void;
}

/** ctx.agentLoop：ReAct 引擎入口（run/createContext/inbox 原语） */
export class AgentLoopService extends Service implements AgentLoopEngine {
  constructor(ctx: Context) {
    super(ctx, 'agentLoop');
  }

  run = run;
  createContext = createContext;
  enqueue = enqueue;
  followup = followup;
  steer = steer;
  inject = inject;
  drainInbox = drainInbox;
  pushSteer = pushSteer;
}

declare module '@agentchat/cordis' {
  interface Context {
    /** ReAct 引擎入口（由 @agentchat/agent-loop 提供） */
    agentLoop: AgentLoopService;
  }
}
