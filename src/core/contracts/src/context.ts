// ============================================================
// @agentchat/contracts/src/context.ts —— L1 数据流统一上下文契约
//
// 迁移自 @agentchat/agent-loop/src/context.ts 的类型部分。
// CurrentContext / 七类钩子 / 中断策略 / trigger 事件元数据归契约包；
// createContext/pushSteer/drainSteer 等运行时助手保留在 agent-loop。
//
// 整个 L1 层的数据流转只用一个 context（CurrentContext）：
//   · 确定性输入：llm / systemPrompt / history / currentMessage / tools / 参数
//   · 可变收集区：inbox（next-turn 由 router 消费 / next-step 每步消费）
//   · 注入副作用：emit（事件流）+ 七类钩子 + 中断处理器
//
// run 投递元数据（hint/source）经 meta['chat.start'] 命名空间传递：
// loop 只展开该键到 chat.start 事件，不解释 meta 的其余键。
// 来源语义由消费方用 isBackgroundRunSource(MessageSource) 分类，loop 不判断 trigger。
// ============================================================

import type {
  CoreEventType,
  RunResult,
  Tool,
} from './engine';
import type { InterruptReason } from './interrupt';
import type { AgentMessage, DeliveryLane, LLMRequestMessage, MessageSource } from '@agentchat/types';
import type { LLMProvider } from '@agentchat/llm';

// ============================================================
// 消息 inbox（next-turn / next-step 双队列）
// ============================================================

/** inbox 投递目标（= DeliveryLane）：next-turn = 独立后续 run；next-step = 当前 run 下一 ReAct step */
export type InboxTarget = DeliveryLane;

/** 跨 run 存活的待处理入站消息队列（router 持有并注入 ctx） */
export interface MessageInbox {
  /** 普通后续轮次 FIFO：当前 run 结束后由 router 取一条作为新 run 的 currentMessage */
  nextTurn: AgentMessage[];
  /** steering / 注入上下文：loop 每个 step 开始前消费全部；自然结束时若非空则继续 */
  nextStep: AgentMessage[];
}

// ============================================================
// chat.start 的 trigger 元数据（meta 命名空间键）
// ============================================================

/** CurrentContext.meta 中承载 chat.start 事件载荷的命名空间键 */
export const CHAT_START_META_KEY = 'chat.start';

/**
 * CurrentContext.meta 中承载群聊读取锚点的命名空间键（单通道化，run 作用域）。
 * runStart 加载群历史时初始化（= 已进入本 run 上下文的最后一条群消息）；
 * busy 注入（GroupFeed.readSince）后推进。纯内存、随 run 生灭——每个 idle run
 * 全量重读历史尾部自动重新确立，无需持久化消费账本。
 */
export const GROUP_SYNC_META_KEY = 'group.sync';

/** chat.start 事件可携带的 trigger 投递元数据（仅事件载荷，不参与推理） */
export interface RunStartMeta {
  /** trigger 模式提示全文（前端据此渲染 event 分隔符） */
  hint?: string;
  /** trigger 来源元数据（前端/日志/持久化共用） */
  source?: MessageSource;
}

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

/** 工具执行结果（供 toolExecutionEndHook 观察/变换） */
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

/**
 * 工具执行后钩子返回：观察者返回 void；变换器可返回 string（整体替换 content）
 * 或 { content?, details? }（局部替换）。loop 在写入 tool 消息与发射
 * chat.tool_execution.end 前按顺序应用。
 */
export type ToolExecutionEndResult = string | { content?: string; details?: any } | void;

/** 本步处理结果（供 stepEndHook 观察） */
export interface StepOutcome {
  /** 是否本步结束（整个 run 结束） */
  done: boolean;
  /** 是否被中断 */
  interrupted: boolean;
  /** 最终内容（done=true 时） */
  final?: string;
  /** 语义化中断原因 */
  interruptReason?: InterruptReason;
}

/** 工具执行前钩子执行上下文（含已产出的 assistant/tool_calls 消息，供持久化 checkpoint） */
export interface ToolExecutionStartContext {
  /** 稳定工具调用 id（assistant.tool_calls[].id） */
  toolCallId: string;
  /** 会话键 */
  dialogId?: string;
  /** 当前 Agent ID */
  agentId?: string;
  /** 当前执行上下文（meta/abort 等持久化判定用） */
  context: CurrentContext;
  /** 截止本工具执行前已产出的完整消息序列（persist 前镜像） */
  messages: AgentMessage[];
}

/** 步骤开始钩子（对齐 chat.step.start）：可修改 ctx 与实时消息数组（注入记忆/压缩历史） */
export type StepStartHook = (ctx: CurrentContext, messages: LLMRequestMessage[]) => Promise<void>;
/** 步骤结束钩子（对齐 chat.step.end）：观察本步结果与本步产出消息 */
export type StepEndHook = (ctx: CurrentContext, outcome: StepOutcome, loopMessages: AgentMessage[]) => Promise<void>;
/** 整次执行开始钩子（对齐 chat.start）：run 生命周期边界，可修改 ctx（早于首个 stepStart） */
export type RunStartHook = (ctx: CurrentContext) => Promise<void>;
/** 整次执行结束钩子（对齐 chat.end）：观察整次结果（含兜底路径，保证流程闭合） */
export type RunEndHook = (ctx: CurrentContext, result: RunResult) => Promise<void>;
/** 工具执行前钩子（对齐 chat.tool_execution.start）：可拦截（allow=false）/ 改写参数；第三个参数为持久化/对账上下文 */
export type ToolExecutionStartHook = (toolName: string, args: Record<string, any>, execution: ToolExecutionStartContext) => Promise<ToolExecutionStartResult>;
/** 工具执行后钩子（对齐 chat.tool_execution.end）：观察结果；可返回替换内容做变换 */
export type ToolExecutionEndHook = (outcome: ToolExecutionOutcome) => Promise<ToolExecutionEndResult>;
/** 兜底钩子：网络/重启等失败路径触发，保证 loop 走完整个流程（不抛给调用方） */
export type FallbackHook = (ctx: CurrentContext, err: unknown) => Promise<void>;

// ============================================================
// 中断策略（替代旧 performReload）
// ============================================================

/** 中断处理决议：continue = 应用补丁后继续本 run；end = 按中断收尾 */
export type InterruptResolution =
  | { action: 'continue'; patch?: Partial<CurrentContext> }
  | { action: 'end' };

/**
 * 中断处理器：由装配层注入，决定语义化中断是否继续推理。
 * 例如 reload-requested → 重读配置并返回 { action:'continue', patch:{ tools, systemPrompt } }。
 * 未装配处理器或返回 end/void 时，loop 保持默认中断收尾。
 */
export type InterruptHandler = (
  ctx: CurrentContext,
  reason: InterruptReason,
) => Promise<InterruptResolution | void>;

// ============================================================
// CurrentContext —— 单次执行输入快照
// ============================================================

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
  currentMessage?: AgentMessage;
  /** 工具集（name → Tool，每步生成定义快照，支持运行时热注册） */
  tools: Map<string, Tool>;
  /** 待处理输入双队列（router 持有、跨 run 存活；loop 只消费 next-step） */
  inbox: MessageInbox;
  /** 是否启用深度思考（DeepSeek thinking），默认 true */
  deepThink?: boolean;
  /** 按请求覆写思考强度（low/high/max；缺省 = 模型配置 reasoning_effort） */
  reasoningEffort?: 'low' | 'high' | 'max';
  /** 最大 ReAct 步数（trigger 模式防失控；0/undefined = 不限制） */
  maxSteps?: number;
  /** 中止信号（用户取消 / 优雅关闭） */
  signal?: AbortSignal;
  /** 对话对标识（DeepSeek 缓存隔离 user_id；1v1 chat~<lo>~<hi> / 群组 group~<gid>~<aid>） */
  dialogId?: string;
  /** 当前执行 Agent ID（1v1 排序共享会话键后无法从 dialogId 反推，显式注入） */
  agentId?: string;
  /** trigger 关联 ID（router 透传，WS 层 correlation_id 使用） */
  correlationId?: string;
  /**
   * 执行扩展元数据（上层约定的语义化键 → 任意载荷）。
   * L1 只解释 CHAT_START_META_KEY（chat.start 事件载荷），其余键原样透传、不解释。
   */
  meta?: Record<string, unknown>;
  /** 事件发射（缺省 → 非流式 fast-path） */
  emit?: (type: CoreEventType, payload: string, data?: Record<string, unknown>) => void;
  /** 整次执行开始钩子（对齐 chat.start）：run 生命周期边界 */
  runStartHook?: RunStartHook[];
  /** 整次执行结束钩子（对齐 chat.end）：观察整次结果（含兜底） */
  runEndHook?: RunEndHook[];
  /** 步骤开始钩子（对齐 chat.step.start）：可修改 ctx 与实时消息数组 */
  stepStartHook?: StepStartHook[];
  /** 步骤结束钩子（对齐 chat.step.end）：观察本步结果与本步产出 */
  stepEndHook?: StepEndHook[];
  /** 工具执行前钩子（对齐 chat.tool_execution.start）：可拦截 / 改写参数 */
  toolExecutionStartHook?: ToolExecutionStartHook[];
  /** 工具执行后钩子（对齐 chat.tool_execution.end）：观察结果，可返回替换内容做变换 */
  toolExecutionEndHook?: ToolExecutionEndHook[];
  /** 兜底钩子：失败路径触发，保证 loop 走完整个流程 */
  fallbackHook?: FallbackHook[];
  /** 语义化中断处理器（替代 performReload）：装配层注入，loop 按决议继续或收尾 */
  interruptHandlers?: InterruptHandler[];
}
