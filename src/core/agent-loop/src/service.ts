// ============================================================
// @agentchat/agent-loop/src/service.ts —— ReAct 引擎服务（cordis Service）
//
// 契约化阶段⑤（2026-08-14）：引擎从"库依赖"提升为"契约服务"——
// ctx.agentLoop 暴露引擎入口（run/createContext/pushSteer），消费者
// （router/agents/subagent）经 AgentAssembly.engine / 构造器注入获得，
// 不再直接 import 引擎函数（包间以契约耦合，对齐 DSH agent-loop 行）。
//
// 类型/契约仍从本包 import type（Tool/CurrentContext/RunResult 等是引擎
// 契约的一部分，非运行期依赖）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { run } from './loop';
import { createContext, pushSteer } from './context';
import type { CurrentContext } from './context';
import type { RunResult } from './contracts';
import type { AgentMessage } from '@agentchat/types';

/** 引擎契约（AgentAssembly.engine / SubAgentManager 构造器注入的类型面） */
export interface AgentLoopEngine {
  run(ctx: CurrentContext): Promise<RunResult>;
  createContext: typeof createContext;
  pushSteer(ctx: CurrentContext, message: AgentMessage): void;
}

/** ctx.agentLoop：ReAct 引擎入口（run/createContext/pushSteer） */
export class AgentLoopService extends Service implements AgentLoopEngine {
  constructor(ctx: Context) {
    super(ctx, 'agentLoop');
  }

  run = run;
  createContext = createContext;
  pushSteer = pushSteer;
}

declare module '@agentchat/cordis' {
  interface Context {
    /** ReAct 引擎入口（由 @agentchat/agent-loop 提供） */
    agentLoop: AgentLoopService;
  }
}
