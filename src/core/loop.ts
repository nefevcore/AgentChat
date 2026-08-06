// ============================================================
// AgentChat 核心 ReAct 编排纯函数（§5.1）
//
// 本模块只含编排逻辑，不持有状态/副作用：
//   - LoopContext = 确定性输入（llm/tools/config/toolInterceptors/messages）
//     + 可变收集区（session.steeringQueue=steer、累计用量、abort）
//     + 注入副作用（emit 事件流 / onNetworkRecover / onNetworkError）
//   - runLoop(ctx) 纯函数：消费 steer → LLM 推理（流式）→ 工具调用 → 结束判定
// 装配层（agent.ts 的 Agent.run / 未来 §7.4 createLoop）负责接线。
// ============================================================

import {
  AgentMessageType,
  LLMProvider,
  LLMRequest,
  LLMRequestMessage,
  LLMResponse,
  LLMUsage,
  Message,
  Tool,
  ToolCall,
  ToolDefinition,
  ToolInterceptor,
  ToolInterceptContext,
} from './types';
import { AgentConfig } from '@core/types';
import { setCurrentAgentAllowedPaths, clearCurrentAgentAllowedPaths } from './config';
import { logger } from '@utils/logger';
import type { RunSession } from './context';
import {
  InterruptReason,
  ToolInterrupt,
  isToolInterrupt,
  describeInterrupt,
} from './interrupt';

// ============================================================
// 内部工具
// ============================================================

/**
 * 判定 LLM 调用错误是否为网络类（断网/超时/连接重置）。
 * 用于 Router 网络失效模式：连续网络类错误才进入 down，429/4xx/5xx 不算。
 */
function isNetworkError(err: any): boolean {
  const msg = (err?.message || String(err || '')).toLowerCase();
  const code = err?.code || err?.cause?.code || '';
  // 用户主动中断不是网络错误（steer/打断走语义化信号，abort 是正常操作）
  if (err?.name === 'AbortError' || msg.includes('aborted') || msg.includes('user aborted')) return false;
  // 网络层错误特征
  if (['econnrefused', 'enotfound', 'etimedout', 'eai_again', 'econnreset', 'socket hang up', 'network', 'fetch failed'].some(k => msg.includes(k) || String(code).toLowerCase().includes(k))) return true;
  // 请求超时（非中断的超时视为网络问题）
  if (msg.includes('timeout') || msg.includes('timed out')) return true;
  return false;
}

function toolLabel(tool: Tool, args: Record<string, unknown>): string {
  const label = tool.label || tool.definition.function.name;
  const detail = tool.extractLabel ? tool.extractLabel(args as Record<string, any>) : '';
  const short = detail.slice(0, 60);
  return short ? `${label} ${short}` : label;
}

function thinkingLabel(reasoning?: string, elapsedMs?: number): string | undefined {
  if (elapsedMs !== undefined && elapsedMs > 0) {
    const elapsed = (elapsedMs / 1000).toFixed(1);
    return `已思考（用时 ${elapsed} 秒）`;
  }
  if (!reasoning?.trim()) return undefined;
  return '已深度思考';
}

// ============================================================
// §5.1 runLoop —— ReAct 编排纯函数（本次重构重点）
//
// 输入 ctx：确定性输入（llm / tools / config / toolInterceptors / 初始 messages）
//          + 可变收集区（session.steeringQueue = steer、累计用量、abort）
//          + 注入副作用（emit 事件流 / onNetworkRecover / onNetworkError）
// 输出：本轮结果 { content, interrupted, interruptReason }
// 纯函数性质：不直接触碰 Agent 实例 / AppState / 全局配置；
//           steer 消费、事件、网络通知均为注入的回调，由装配层接线。
// ============================================================

export interface LoopContext {
  agentId: string;
  llm: LLMProvider;
  config: AgentConfig;
  tools: Map<string, Tool>;
  toolInterceptors: ToolInterceptor[];
  /** 会话运行态（steer 收集区 + abort + usage 累计） */
  session: RunSession;
  /** 初始 LLM 请求消息（system + history + currentMessage 已装配，循环内原地追加） */
  messages: LLMRequestMessage[];
  /** 本轮产出消息（供 postHook 持久化，循环内原地追加） */
  loopMessages: Message[];
  deepThink?: boolean;
  maxTurns?: number;
  signal?: AbortSignal;
  /** 事件发射（缺省则走非流式 fast-path） */
  emit?: (type: AgentMessageType, payload: string, data?: Record<string, any>) => void;
  /** 网络调用成功回调（Router 退出 down 模式） */
  onNetworkRecover?: () => void;
  /** 网络类错误回调（Router 进入 down 模式） */
  onNetworkError?: () => void;
}

/**
 * ReAct 编排循环：消费 steer → LLM 推理（流式）→ 工具调用 → 结束判定。
 * 由装配层（Agent.run / §7.4 createLoop）委托调用（外层负责 pre/post hooks、
 * reload/restart 语义化中断）。
 */
export async function runLoop(
  ctx: LoopContext
): Promise<{ content: string; interrupted: boolean; interruptReason?: InterruptReason }> {
  const { session, signal } = ctx;
  if (signal?.aborted) return { content: '', interrupted: true, interruptReason: { type: 'user-abort' } };

  // ReAct 循环不设迭代上限（receive 模式）：
  //   1. 达到上限的情况极其罕见
  //   2. 硬中断会截断思考链，导致回复质量严重下降
  // 中断仅由 AbortSignal（用户取消）触发
  //
  // trigger 模式（maxTurns > 0）：设置上限防止无消息自主推理失控。
  let turn = 0;
  while (true) {
    turn++;

    // 自主推理轮次保护（仅 trigger 模式生效）
    if (ctx.maxTurns && turn > ctx.maxTurns) {
      logger.info(
        `[Agent] "${ctx.agentId}" 自主推理达到最大轮次 ${ctx.maxTurns}，强制终止`
      );
      return {
        content: `达到最大推理轮次 (${ctx.maxTurns})，已自动终止。`,
        interrupted: true,
        interruptReason: { type: 'max-turns' },
      };
    }
    // 注入待处理的转向消息（用户/其他 Agent 中途插入的指令，按会话隔离）
    const steering = session.steeringQueue.splice(0);
    if (steering.length > 0) {
      for (const msg of steering) {
        ctx.messages.push(msg);
        ctx.loopMessages.push(msg);
      }
    }

    ctx.emit?.('chat.turn.start', '', { agent: ctx.agentId, sender: session.sender });

    // 每轮从 ctx.tools 重新生成工具定义快照，支持运行时热注册新工具（如 reload）
    const toolDefs: ToolDefinition[] = Array.from(ctx.tools.values()).map(t => t.definition);
    // viewer=当前视角 Agent ID（self）：provider 依据它把持久化格式消息（role='agent'）
    // 做视角转换（agent_id===viewer → assistant；≠viewer → user）
    const req: LLMRequest = {
      messages: ctx.messages, tools: toolDefs.length > 0 ? toolDefs : undefined,
      thinking: ctx.deepThink,
      userId: session.userId, viewer: ctx.agentId,
    };
    let resp: LLMResponse;

    try {
      resp = await streamLLM(ctx, req, signal);
      // 网络调用成功：通知恢复（若在 down 模式，会重投入队消息）
      try { ctx.onNetworkRecover?.(); } catch { /* 通知失败不影响主流程 */ }
    } catch (llmErr: any) {
      const errMsg = llmErr.message || String(llmErr);
      logger.error(`[Agent] ${ctx.agentId} LLM 调用失败: ${errMsg}`);
      // 网络类错误 → 通知 Router 进入网络失效模式（连续多次才生效）
      if (isNetworkError(llmErr)) {
        try { ctx.onNetworkError?.(); } catch { /* 通知失败不影响主流程 */ }
      }
      // 记录 error 消息到持久化存储
      const errorMessage: Message = { role: 'error', content: errMsg };
      ctx.messages.push(errorMessage);
      ctx.loopMessages.push(errorMessage);
      ctx.emit?.('chat.message.error', errMsg, { role: 'error', content: errMsg, sender: session.sender });
      return { content: `LLM 错误: ${errMsg}`, interrupted: false };
    }

    const result = await processTurn(ctx, resp, signal);

    ctx.emit?.('chat.turn.end', resp.content ?? '', {
      content: resp.content,
      reasoning: resp.reasoning,
      interrupted: result.interrupted ?? undefined,
      interruptReason: result.interruptReason,
      agent: ctx.agentId,
      sender: session.sender,
    });

    if (result.done) {
      return { content: result.final ?? '', interrupted: result.interrupted ?? false, interruptReason: result.interruptReason };
    }
  }
}

async function processTurn(
  ctx: LoopContext,
  resp: LLMResponse,
  signal?: AbortSignal
): Promise<{ done: boolean; interrupted?: boolean; final?: string; interruptReason?: InterruptReason }> {
  if (signal?.aborted && (resp.content || resp.reasoning)) {
    recordAssistant(ctx, resp, true);
    return { done: true, interrupted: true, final: resp.content || '', interruptReason: { type: 'user-abort' } };
  }

  if (resp.toolCalls.length === 0 || resp.finishReason === 'stop') {
    recordAssistant(ctx, resp);
    return { done: true, final: resp.content ?? '' };
  }

  recordAssistant(ctx, resp);

  const { interrupted, interruptReason } = await runTools(ctx, resp.toolCalls, signal);
  return interrupted
    ? {
        done: true,
        interrupted: true,
        interruptReason: interruptReason ?? { type: 'user-abort' },
        // 中断描述已写入 tool 消息，final 保持 LLM 真实产出（通常为空），
        // 不覆盖 Agent 回复
        final: resp.content ?? '',
      }
    : { done: false };
}

// ---- LLM 流式调用 ----

async function streamLLM(
  ctx: LoopContext,
  req: LLMRequest,
  signal?: AbortSignal
): Promise<LLMResponse> {
  const { session } = ctx;
  // 无 emit（事件总线）→ 非流式，只取结果
  if (!ctx.emit) {
    const resp = await ctx.llm.chat(req, signal);
    accumulateUsage(session, resp.usage);
    return resp;
  }

  session.thinkingStartTime = 0;
  const stream = ctx.llm.stream(req, signal);
  for await (const token of stream) {
    const t = token.type;
    if (t === 'thinking_start') {
      session.thinkingStartTime = Date.now();
      ctx.emit('chat.thinking.start', '', { label: '思考中...', sender: session.sender });
    } else if (t === 'thinking_update') {
      ctx.emit('chat.thinking.update', token.delta ?? '', { delta: token.delta, sender: session.sender });
    } else if (t === 'thinking_end') {
      ctx.emit('chat.thinking.end', '', { label: thinkingLabel(undefined, Date.now() - session.thinkingStartTime), sender: session.sender });
    } else if (t === 'toolcall_start') {
      ctx.emit('chat.toolcall.start', '', { sender: session.sender,
        index: token.toolCall?.index, name: token.toolCall?.name,
      });
    } else if (t === 'toolcall_update') {
      ctx.emit('chat.toolcall.update', token.delta ?? '', { sender: session.sender,
        index: token.toolCall?.index, delta: token.delta,
      });
    } else if (t === 'toolcall_end') {
      ctx.emit('chat.toolcall.end', '', { sender: session.sender,
        index: token.toolCall?.index, name: token.toolCall?.name,
        arguments: token.toolCall?.arguments,
      });
    } else if (t === 'error') {
      const errMsg = token.error ?? 'LLM 调用失败';
      logger.error(`[Agent] ${ctx.agentId} LLM 错误: ${errMsg}`);
      ctx.emit('chat.message.error', errMsg, { role: 'error', content: errMsg });
    } else if (t === 'message_start') {
      ctx.emit('chat.message.start', '', { sender: session.sender });
    } else if (t === 'message_update') {
      ctx.emit('chat.message.update', token.delta ?? '', { delta: token.delta, sender: session.sender });
    } else if (t === 'message_end') {
      ctx.emit('chat.message.end', token.partial.content, { sender: session.sender });
    }
  }

  // 错误已通过流协议传递，result() 返回的 LLMResponse 已包含 finishReason。
  // provider 遵守"错误进流"契约 → 此处不需要 try-catch。
  const resp = await stream.result();
  accumulateUsage(session, resp.usage);
  return resp;
}

// ---- 工具执行 ----

async function runTools(
  ctx: LoopContext,
  toolCalls: ToolCall[],
  signal?: AbortSignal
): Promise<{ interrupted: boolean; interruptReason?: InterruptReason }> {
  const { session } = ctx;
  // 并行执行所有工具调用（LLM 在同一轮返回的 tool_calls 彼此独立）
  const results = await Promise.all(toolCalls.map(async (tc) => {
    if (signal?.aborted) return { tc, content: '', label: tc.name, tool: null as Tool | null, interrupt: { type: 'user-abort' } as InterruptReason };

    const tool = ctx.tools.get(tc.name);
    ctx.emit?.('chat.tool_execution.start', '', { sender: session.sender, tool_name: tc.name, arguments: tc.arguments, tool_call_id: tc.id, label: tool ? toolLabel(tool, tc.arguments) : tc.name });

    let content = '';
    let details: any;
    let interrupt: InterruptReason | undefined;

    try {
      if (!tool) {
        content = JSON.stringify({ status: 'error', data: { message: `未找到工具：${tc.name}` } });
      } else {
        // ---- Tool Interceptor 管道 ----
        let interceptCtx: ToolInterceptContext = {
          agentId: ctx.agentId,
          sender: session.sender || undefined,
          args: { ...tc.arguments } as Record<string, any>,
        };
        let intercepted = false;
        for (const interceptor of ctx.toolInterceptors) {
          const result = await interceptor(tc.name, interceptCtx);
          interceptCtx = { agentId: ctx.agentId, args: result.args };
          if (!result.allow) {
            content = JSON.stringify({
              status: 'error',
              data: { message: result.reason || `工具 ${tc.name} 被拦截` },
            });
            intercepted = true;
            break;
          }
        }
        if (!intercepted) {
          // 设置当前 Agent 的路径穿透白名单（工具执行期间有效）
          setCurrentAgentAllowedPaths(ctx.config.allowedPaths);
          try {
            let partial = '';
            const stream = {
              onChunk: (delta: string) => {
                partial += delta;
                ctx.emit?.('chat.tool_execution.update', delta, { sender: session.sender, tool_call_id: tc.id, delta, partial });
              },
            };
            const raw = await tool.execute(interceptCtx.args, stream, signal);
            if (typeof raw === 'string') {
              content = raw;
            } else {
              content = raw.content;
              details = raw.details;
            }
          } finally {
            clearCurrentAgentAllowedPaths();
          }
        }
      }
    } catch (err: any) {
      if (isToolInterrupt(err)) {
        // 语义化中断（reload/restart/工具被中止）—— 不是错误，不写入 error tool 消息
        interrupt = err.reason;
        content = '';
        logger.info(`[Agent] "${ctx.agentId}" 工具 ${tc.name} 发出中断请求: ${err.reason.type}`);
      } else {
        content = JSON.stringify({ status: 'error', data: { message: err.message } });
      }
    }

    return { tc, content, label: tool ? toolLabel(tool, tc.arguments) : tc.name, details, interrupt };
  }));

  // 按原始顺序插入消息（中断的工具也生成 tool 响应，保持 assistant.tool_calls → tool 配对）
  let interruptReason: InterruptReason | undefined;
  for (const { tc, content, label, details, interrupt } of results) {
    if (interrupt) {
      interruptReason ??= interrupt;
      // 中断的工具生成 tool 响应消息（描述中断原因），不修改 assistant 消息
      const interruptContent = `(工具中断) ${describeInterrupt(interrupt)}`;
      const interruptMsg: Message = {
        role: 'tool',
        content: interruptContent,
        tool_call_id: tc.id || `call_idx_${tc.name || 'unknown'}`,
        name: tc.name,
        label,
      };
      ctx.messages.push(interruptMsg);
      ctx.loopMessages.push(interruptMsg);
      ctx.emit?.('chat.tool_execution.end', interruptContent, { sender: session.sender, tool_call_id: tc.id, result: interruptContent, details });
      continue;
    }
    const toolMsg: Message = {
      role: 'tool', content,
      // tc.id 由 SSE 解析器保证非空（缺失时使用 call_idx_N），
      // 与 assistant.tool_calls 来自同一源头，必定匹配。
      tool_call_id: tc.id || `call_idx_${tc.name || 'unknown'}`,
      name: tc.name,
      label,
    };
    ctx.messages.push(toolMsg);
    ctx.loopMessages.push(toolMsg);
    ctx.emit?.('chat.tool_execution.end', content, { sender: session.sender, tool_call_id: tc.id, result: content, details });
  }

  const aborted = signal?.aborted ?? false;
  return {
    interrupted: interruptReason !== undefined || aborted,
    interruptReason: interruptReason ?? (aborted ? { type: 'user-abort' } : undefined),
  };
}

// ---- 消息记录 ----

function recordAssistant(ctx: LoopContext, resp: LLMResponse, interrupted = false): void {
  const msg: Message = {
    role: 'assistant',
    content: interrupted ? (resp.content || '(已被中断)') : (resp.content ?? ''),
    tool_calls: interrupted ? undefined : (resp.toolCalls.length > 0 ? resp.toolCalls : undefined),
    reasoning_content: resp.reasoning || undefined,
    label: thinkingLabel(resp.reasoning, ctx.session.thinkingStartTime ? Date.now() - ctx.session.thinkingStartTime : undefined),
  };
  ctx.messages.push(msg);
  ctx.loopMessages.push(msg);
}

/**
 * 合并单次 LLM 调用的 Token 用量到本轮统计。
 *
 * 字段语义（双轨制）：
 *   prompt_tokens / total_tokens → 覆盖为最新值（表示当次上下文大小，
 *     供 archive 阈值判断使用，累加会把各 turn 上下文之和误判为单次大小）
 *   accumulated_prompt_tokens / accumulated_total_tokens → 累加（展示总用量）
 *   completion_tokens / cache_hit / cache_miss → 累加（跨 turn 计量有意义）
 *   react_turns → 每次调用 +1
 */
function accumulateUsage(session: RunSession, usage: LLMUsage | undefined): void {
  if (!usage) return;
  if (!session.cumulativeUsage) {
    session.cumulativeUsage = {
      ...usage,
      accumulated_prompt_tokens: usage.prompt_tokens,
      accumulated_total_tokens: usage.total_tokens,
      react_turns: 1,
    };
    return;
  }
  const acc = session.cumulativeUsage;
  // 本次上下文大小 → 覆盖（供 archive 判断）
  acc.prompt_tokens = usage.prompt_tokens;
  acc.total_tokens = usage.total_tokens;
  // 累计值 → 累加（供日志展示）
  acc.accumulated_prompt_tokens = (acc.accumulated_prompt_tokens ?? 0) + usage.prompt_tokens;
  acc.accumulated_total_tokens = (acc.accumulated_total_tokens ?? 0) + usage.total_tokens;
  acc.completion_tokens += usage.completion_tokens;
  acc.react_turns = (acc.react_turns ?? 0) + 1;
  if (usage.prompt_cache_hit_tokens !== undefined) {
    acc.prompt_cache_hit_tokens = (acc.prompt_cache_hit_tokens ?? 0) + usage.prompt_cache_hit_tokens;
  }
  if (usage.prompt_cache_miss_tokens !== undefined) {
    acc.prompt_cache_miss_tokens = (acc.prompt_cache_miss_tokens ?? 0) + usage.prompt_cache_miss_tokens;
  }
}
