// ============================================================
// src/core/context.ts —— L1 数据流统一上下文 CurrentContext
//
// 整个 L1 层的数据流转只用一个 context（CurrentContext）：
//   · 确定性输入：llm / systemPrompt / history / currentMessage / tools / 参数
//   · 可变收集区：steer（转向消息队列，loop 每轮消费）
//   · 注入副作用：emit（事件流）+ 五类钩子
//
// 钩子与事件对齐：
//   turnStartHook          ↔ chat.turn.start（可修改 ctx 与实时消息）
//   turnEndHook            ↔ chat.turn.end
//   toolExecutionStartHook ↔ chat.tool_execution.start（可拦截/改写参数）
//   toolExecutionEndHook   ↔ chat.tool_execution.end
//   fallbackHook           = 失败路径兜底（网络/重启等），保证 loop 走完整个流程
//
// 持久化旗标、身份、网络模式等上层扩展后续（L2~L5）以 CurrentContext 为基础逐步加回。
//
// 装配层（L2+ / createLoop 工厂）负责组装 ctx 并调用 loop.run(ctx)。
// loop 保持执行逻辑纯净：不触碰 Agent 实例 / 全局状态，只消费本快照。
//
// 铁律：零外部依赖，仅引用 ./types 与 ./interrupt 的类型。
// ============================================================

import type {
  CoreEventType,
  LLMProvider,
  LLMRequestMessage,
  Message,
  RunResult,
  Tool,
} from './types';
import type { InterruptReason, ReloadScope } from './interrupt';

// ============================================================
// 生命周期钩子契约
// ============================================================

/** 工具执行前钩子结果：可拦截（allow=false）或改写参数（承接原 interceptor 职责） */
export interface ToolExecutionStartResult {
  /** false = 拦截工具执行，reason 返回给 LLM */
  allow: boolean;
  /** 拦截原因（allow=false 时） */
  reason?: string;
  /** 改写后的参数（allow=true 时生效） */
  args?: Record<string, any>;
}

/** 工具执行结果（供 toolExecutionEndHook 观察） */
export interface ToolExecutionOutcome {
  /** 工具名 */
  toolName: string;
  /** 执行参数（钩子改写后的） */
  args: Record<string, any>;
  /** 执行结果（成功时：string 或 { content, details }） */
  result?: string | { content: string; details?: any };
  /** 执行异常（非中断错误） */
  error?: Error;
  /** 是否被语义化中断（reload/restart/工具中止） */
  interrupted?: boolean;
  /** 耗时（毫秒） */
  durationMs?: number;
}

/** 本轮处理结果（供 turnEndHook 观察） */
export interface TurnOutcome {
  /** 是否本轮结束（整个 run 结束） */
  done: boolean;
  /** 是否被中断 */
  interrupted: boolean;
  /** 最终内容（done=true 时） */
  final?: string;
  /** 语义化中断原因 */
  interruptReason?: InterruptReason;
}

/** 回合开始钩子（对齐 chat.turn.start）：可修改 ctx 与实时消息数组（注入记忆/压缩历史） */
export type TurnStartHook = (ctx: CurrentContext, messages: LLMRequestMessage[]) => Promise<void>;
/** 回合结束钩子（对齐 chat.turn.end）：观察本轮结果与本轮产出消息 */
export type TurnEndHook = (ctx: CurrentContext, outcome: TurnOutcome, loopMessages: Message[]) => Promise<void>;
/** 整次执行开始钩子（对齐 chat.start）：run 生命周期边界，可修改 ctx（早于首个 turnStart） */
export type RunStartHook = (ctx: CurrentContext) => Promise<void>;
/** 整次执行结束钩子（对齐 chat.end）：观察整次结果（含兜底路径，保证流程闭合） */
export type RunEndHook = (ctx: CurrentContext, result: RunResult) => Promise<void>;
/** 工具执行前钩子（对齐 chat.tool_execution.start）：可拦截（allow=false）/ 改写参数 */
export type ToolExecutionStartHook = (toolName: string, args: Record<string, any>) => Promise<ToolExecutionStartResult>;
/** 工具执行后钩子（对齐 chat.tool_execution.end）：观察结果 */
export type ToolExecutionEndHook = (outcome: ToolExecutionOutcome) => Promise<void>;
/** 兜底钩子：网络/重启等失败路径触发，保证 loop 走完整个流程（不抛给调用方） */
export type FallbackHook = (ctx: CurrentContext, err: unknown) => Promise<void>;

/**
 * L1 数据流统一上下文 —— 单次执行输入快照。
 *
 * 纯函数性质：不直接触碰 Agent 实例 / AppState / 全局配置；
 * steer 消费、事件、钩子均为注入的回调，由装配层接线。
 */
export interface CurrentContext {
  /** 推理引擎（实现 LLMProvider 接口） */
  llm: LLMProvider;
  /** 系统提示词 */
  systemPrompt: string;
  /** 对话历史（不含 system 与 currentMessage，装配层加载） */
  history: LLMRequestMessage[];
  /** 当前用户消息（receive 模式；trigger 模式省略） */
  currentMessage?: Message;
  /** 工具集（name → Tool，每轮生成定义快照，支持运行时热注册） */
  tools: Map<string, Tool>;
  /** 转向消息队列（steer）—— 循环每轮消费，调用方可中途 push */
  steer: Message[];
  /** 是否启用深度思考（DeepSeek thinking），默认 true */
  deepThink?: boolean;
  /** 最大 ReAct 轮次（trigger 模式防失控；0/undefined = 不限制） */
  maxTurns?: number;
  /** 中止信号（用户取消 / 优雅关闭） */
  signal?: AbortSignal;
  /** 对话对标识（DeepSeek 缓存隔离 user_id；1v1 chat~<lo>~<hi> / 群组 group~<gid>~<aid>） */
  dialogId?: string;
  /** 当前执行 Agent ID（1v1 排序共享会话键后无法从 dialogId 反推，显式注入） */
  agentId?: string;
  /** 归档整理轮标志（agent-session archive 编排：runEnd 不落盘，仅写 done 标记） */
  archiveReview?: boolean;
  /**
   * 热重载执行体（reload-requested 中断时由 loop 调用；L5 装配注入）。
   * 对齐旧架构 performReload：执行重载后 loop 继续推理（reinit），而非结束 run。
   */
  performReload?: (scope: ReloadScope) => void | Promise<void>;
  /** 事件发射（缺省 → 非流式 fast-path） */
  emit?: (type: CoreEventType, payload: string, data?: Record<string, unknown>) => void;
  /** 整次执行开始钩子（对齐 chat.start）：run 生命周期边界 */
  runStartHook?: RunStartHook[];
  /** 整次执行结束钩子（对齐 chat.end）：观察整次结果（含兜底） */
  runEndHook?: RunEndHook[];
  /** 回合开始钩子（对齐 chat.turn.start）：可修改 ctx 与实时消息数组 */
  turnStartHook?: TurnStartHook[];
  /** 回合结束钩子（对齐 chat.turn.end）：观察本轮结果与本轮产出 */
  turnEndHook?: TurnEndHook[];
  /** 工具执行前钩子（对齐 chat.tool_execution.start）：可拦截 / 改写参数 */
  toolExecutionStartHook?: ToolExecutionStartHook[];
  /** 工具执行后钩子（对齐 chat.tool_execution.end）：观察结果 */
  toolExecutionEndHook?: ToolExecutionEndHook[];
  /** 兜底钩子：失败路径触发，保证 loop 走完整个流程 */
  fallbackHook?: FallbackHook[];
}

/** 创建执行快照（steer 缺省为空队列） */
export function createContext(
  input: Omit<CurrentContext, 'steer'> & { steer?: Message[] },
): CurrentContext {
  return { steer: [], ...input };
}

/** 注入转向消息（用户/其他 Agent 中途插入的指令，按会话隔离） */
export function pushSteer(ctx: CurrentContext, message: Message): void {
  ctx.steer.push(message);
}

/** 消费全部转向消息（loop 每轮调用，返回并清空队列） */
export function drainSteer(ctx: CurrentContext): Message[] {
  return ctx.steer.splice(0);
}
