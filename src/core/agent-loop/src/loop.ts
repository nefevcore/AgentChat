// ============================================================
// src/core/loop.ts —— ReAct 编排纯函数 run(ctx)
//
// 本模块只含编排逻辑，不持有状态/副作用：
//   · 确定性输入：ctx（context.ts 的 CurrentContext）
//   · 可变收集区：ctx.steer（转向消息队列，每轮消费）
//   · 注入副作用：ctx.emit（事件流）+ 五类钩子（turnStart/turnEnd/toolExecutionStart/toolExecutionEnd/fallback）
//
// 流程：装配初始消息 → 循环 [ 消费 steer → LLM 推理（流式）→ 工具调用 → 结束判定 ]。
// 输出 RunResult：最终内容 + 中断原因 + 本轮产生的完整消息（供调用方持久化）+ 累计用量。
//
// 装配层（L2+ / createLoop 工厂）负责接线 emit / 网络回调并调用 run(ctx)。
//
// 铁律：零外部依赖，仅引用 ./types ./interrupt ./logger ./context。
// ============================================================

import type {
  CoreEventType,
  RunResult,
  Tool,
} from './contracts';
import type { AgentMessage, LLMRequestMessage, ToolCall, ToolDefinition, ToolStream } from '@agentchat/types';
import type { LLMRequest, LLMResponse, LLMUsage } from '@agentchat/llm';
import { ToolInterrupt, isToolInterrupt, describeInterrupt } from './interrupt';
import type { InterruptReason } from './interrupt';
import { createLogger } from '@agentchat/util';
import type { CurrentContext, ToolExecutionOutcome, ToolExecutionStartResult, TurnOutcome } from './context';
import { drainSteer } from './context';
import { hashDialogId } from './hash';

const log = createLogger('[core:loop]');

// ============================================================
// 内部工具
// ============================================================

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

/**
 * 事件发射：统一附加 dialogId + agentId。
 * L5 WS 层经 makeAgentEvent 从 dialogId/agentId 关联事件归属 Agent
 * （1v1 排序共享会话键后 dialogId 无法反推 Agent，故显式传 agentId）。
 */
function emitLoop(ctx: CurrentContext, type: CoreEventType, payload: string, data: Record<string, unknown> = {}): void {
  ctx.emit?.(type, payload, { ...data, dialogId: ctx.dialogId, agentId: ctx.agentId });
}

// ============================================================
// 循环内部状态（可变收集区：用量 + thinking 计时）
// ============================================================

interface LoopState {
  /** 本轮累计 Token 用量 */
  usage?: LLMUsage;
  /** 本轮 thinking 开始时间（毫秒） */
  thinkingStartTime: number;
  /** 流式错误信息（error token 捕获，供 finishReason='error' 收尾用） */
  lastError?: string;
  /** chat.message.error 是否已随流式 error token 发射（避免 finishReason='error' 时重复发射） */
  errorEmitted?: boolean;
}

// ============================================================
// run —— ReAct 编排纯函数
// ============================================================

/**
 * ReAct 编排循环：消费 steer → LLM 推理（流式）→ 工具调用 → 结束判定。
 * 由装配层（Agent.run / §7.4 createLoop）委托调用（外层负责 pre/post hooks、
 * reload/restart 语义化中断）。
 *
 * ReAct 循环不设迭代上限（receive 模式）：中断仅由 AbortSignal 触发。
 * trigger 模式（maxTurns > 0）：设置上限防止无消息自主推理失控。
 *
 * 生命周期边界（run 级，与事件对齐）：
 *   chat.start → runStartHook → [多轮 ReAct：turnStart/turnEnd...] → runEndHook → chat.end
 */
export async function run(ctx: CurrentContext): Promise<RunResult> {
  // 整次执行边界：chat.start（run 拥有完整 ReAct 生命周期）
  emitLoop(ctx, 'chat.start', '');
  for (const hook of ctx.runStartHook ?? []) {
    try { await hook(ctx); }
    catch (err: any) { log.error(`runStartHook 失败: ${err?.message || String(err)}`); }
  }

  let result: RunResult;
  try {
    result = await runLoop(ctx);
  } catch (err: any) {
    result = await handleFatal(ctx, err);
  }

  // 整次执行结束钩子（对齐 chat.end）：观察整次结果（含致命兜底路径）
  for (const hook of ctx.runEndHook ?? []) {
    try { await hook(ctx, result); }
    catch (err: any) { log.error(`runEndHook 失败: ${err?.message || String(err)}`); }
  }

  // 整次执行边界：chat.end（含致命兜底路径，保证事件流始终闭合）
  emitLoop(ctx, 'chat.end', result.content, {
    content: result.content,
    interrupted: result.interrupted,
    interruptReason: result.interruptReason,
  });
  return result;
}

/** 执行兜底钩子（保证兜底自身不抛） */
async function runFallbackHooks(ctx: CurrentContext, err: unknown): Promise<void> {
  for (const hook of ctx.fallbackHook ?? []) {
    try { await hook(ctx, err); }
    catch (e: any) { log.error(`fallbackHook 失败: ${e?.message || String(e)}`); }
  }
}

/** 致命兜底：未捕获异常时以受控 RunResult 收尾（网络/重启等失败路径的保险） */
async function handleFatal(ctx: CurrentContext, err: any): Promise<RunResult> {
  const errMsg = err?.message || String(err);
  log.error(`run() 未捕获异常: ${errMsg}`);
  await runFallbackHooks(ctx, err);
  const errorMessage: AgentMessage = { role: 'error', content: errMsg };
  return { content: `执行异常: ${errMsg}`, interrupted: false, messages: [errorMessage], usage: undefined };
}

async function runLoop(ctx: CurrentContext): Promise<RunResult> {
  const { signal } = ctx;
  if (signal?.aborted) {
    return { content: '', interrupted: true, interruptReason: { type: 'user-abort' }, messages: [], usage: undefined };
  }

  // ---- 初始消息装配：system + history + currentMessage ----
  // 持久化格式（role='agent'）由 provider 的 toProviderMessages 依据 viewer 做视角转换。
  const messages: LLMRequestMessage[] = [{ role: 'system', content: ctx.systemPrompt }, ...ctx.history];
  const loopMessages: AgentMessage[] = [];
  if (ctx.currentMessage) {
    // 用户提问必须同时进入 loopMessages（result.messages 是 saveSession 落盘依据），
    // 否则提问不落盘，刷新后从磁盘恢复历史时丢失（steer 转向消息已双写，此处对齐）。
    const userMsg: AgentMessage = {
      role: 'user',
      content: ctx.currentMessage.content,
      ...(ctx.currentMessage.agent_id ? { agent_id: ctx.currentMessage.agent_id } : {}),
    };
    messages.push(userMsg);
    loopMessages.push(userMsg);
  }
  const state: LoopState = { usage: undefined, thinkingStartTime: 0 };

  let turn = 0;
  while (true) {
    turn++;

    // 自主推理轮次保护（仅 trigger 模式生效）
    if (ctx.maxTurns && turn > ctx.maxTurns) {
      log.info(`达到最大推理轮次 ${ctx.maxTurns}，强制终止`);
      return {
        content: `达到最大推理轮次 (${ctx.maxTurns})，已自动终止。`,
        interrupted: true,
        interruptReason: { type: 'max-turns' },
        messages: loopMessages,
        usage: state.usage,
      };
    }

    // 注入待处理的转向消息（用户/其他 Agent 中途插入的指令，按会话隔离）
    const steering = drainSteer(ctx);
    for (const msg of steering) {
      messages.push(msg);
      loopMessages.push(msg);
    }

    emitLoop(ctx, 'chat.turn.start', '');

    // 回合开始钩子（对齐 chat.turn.start）：可修改 ctx / 实时消息数组
    for (const hook of ctx.turnStartHook ?? []) {
      try { await hook(ctx, messages); }
      catch (err: any) { log.error(`turnStartHook 失败: ${err?.message || String(err)}`); }
    }

    // 每轮从 ctx.tools 重新生成工具定义快照，支持运行时热注册新工具（如 reload）
    const toolDefs: ToolDefinition[] = Array.from(ctx.tools.values()).map(t => t.definition);
    const req: LLMRequest = {
      messages,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      thinking: ctx.deepThink,
      userId: ctx.dialogId ? hashDialogId(ctx.dialogId) : undefined,
    };

    // 虚拟 Agent 的空 LLM 返回空响应：streamLLM 无 token 流、processTurn 空回复
    // 不 recordAssistant（见 processTurn），loop 照常闭合事件流，无需特判。

    let resp: LLMResponse;
    try {
      resp = await streamLLM(ctx, req, signal, state);
    } catch (llmErr: any) {
      // 主动打断（chat.interrupt / 优雅关闭 / 转向消息注入前的中断）：LLM abort 是
      // 正常打断而非故障——按中断收尾，不触发 fallbackHook、不落盘 error 消息、
      // 不显示"LLM 错误"（前端已由打断操作反馈）。
      if (signal?.aborted) {
        return { content: '', interrupted: true, interruptReason: { type: 'user-abort' }, messages: loopMessages, usage: state.usage };
      }
      const errMsg = llmErr?.message || String(llmErr);
      log.error(`LLM 调用失败: ${errMsg}`);
      // 兜底钩子：通知上层失败（网络等），保证流程受控结束
      await runFallbackHooks(ctx, llmErr);
      // 记录 error 消息到输出
      const errorMessage: AgentMessage = { role: 'error', content: errMsg };
      messages.push(errorMessage);
      loopMessages.push(errorMessage);
      emitLoop(ctx, 'chat.message.error', errMsg, { role: 'error', content: errMsg });
      return { content: `LLM 错误: ${errMsg}`, interrupted: false, messages: loopMessages, usage: state.usage };
    }

    // 流式错误路径（B1）：错误经流协议传递（cs.error → finishReason='error'），
    // 非抛异常，需在此显式收尾——触发 fallbackHook + 产出 error 消息，
    // 而不是被 processTurn 当作正常 stop 处理（done:true + 空 final）。
    if (resp.finishReason === 'error') {
      // 主动打断（chat.interrupt / 优雅关闭）：LLM abort 非失败，按中断收尾——
      // 不触发 fallbackHook、不落盘 error 消息；若 LLM 已有部分输出则保留（半截回复）。
      if (signal?.aborted) {
        if (resp.content || resp.reasoning) {
          recordAssistant(ctx, resp, messages, loopMessages, state, true);
        }
        return { content: resp.content ?? '', interrupted: true, interruptReason: { type: 'user-abort' }, messages: loopMessages, usage: state.usage };
      }
      const errMsg = state.lastError ?? resp.content ?? 'LLM 调用失败';
      log.error(`LLM 错误: ${errMsg}`);
      await runFallbackHooks(ctx, new Error(errMsg));
      const errorMessage: AgentMessage = { role: 'error', content: errMsg };
      messages.push(errorMessage);
      loopMessages.push(errorMessage);
      // 流式路径已在 error token 时发射过 chat.message.error；这里只补发无 error token 的路径，
      // 避免前端出现两条相同的 API Key 错误（持久化一直只有一条）。
      if (!state.errorEmitted) {
        emitLoop(ctx, 'chat.message.error', errMsg, { role: 'error', content: errMsg });
      }
      return { content: `LLM 错误: ${errMsg}`, interrupted: false, messages: loopMessages, usage: state.usage };
    }

    const result = await processTurn(ctx, resp, signal, messages, loopMessages, state);

    emitLoop(ctx, 'chat.turn.end', resp.content ?? '', {
      content: resp.content,
      reasoning: resp.reasoning,
      interrupted: result.interrupted ?? undefined,
      interruptReason: result.interruptReason,
    });

    // 回合结束钩子（对齐 chat.turn.end）：观察本轮结果与本轮产出
    const outcome: TurnOutcome = {
      done: result.done ?? false,
      interrupted: result.interrupted ?? false,
      final: result.final,
      interruptReason: result.interruptReason,
    };
    for (const hook of ctx.turnEndHook ?? []) {
      try { await hook(ctx, outcome, loopMessages); }
      catch (err: any) { log.error(`turnEndHook 失败: ${err?.message || String(err)}`); }
    }

    if (result.done) {
      // reload 语义化中断：执行热重载后继续本轮推理（对齐旧架构 performReload + reinit 继续），
      // 而非结束 run——Agent 用新装配继续输出（上下文经 messages/loopMessages 累积保持）。
      // 仅在装配了 performReload 时继续（避免最小装配下 LLM 反复 reload 死循环）。
      if (result.interruptReason?.type === 'reload-requested' && ctx.performReload) {
        try { await ctx.performReload(result.interruptReason.scope); }
        catch (err: any) { log.error(`performReload 失败: ${err?.message || String(err)}`); }
        continue;
      }
      return {
        content: result.final ?? '',
        interrupted: result.interrupted ?? false,
        interruptReason: result.interruptReason,
        messages: loopMessages,
        usage: state.usage,
      };
    }
  }
}

// ============================================================
// 单轮处理
// ============================================================

async function processTurn(
  ctx: CurrentContext,
  resp: LLMResponse,
  signal: AbortSignal | undefined,
  messages: LLMRequestMessage[],
  loopMessages: AgentMessage[],
  state: LoopState,
): Promise<{ done: boolean; interrupted?: boolean; final?: string; interruptReason?: InterruptReason }> {
  if (signal?.aborted && (resp.content || resp.reasoning)) {
    recordAssistant(ctx, resp, messages, loopMessages, state, true);
    return { done: true, interrupted: true, final: resp.content || '', interruptReason: { type: 'user-abort' } };
  }

  // 无工具调用（或 LLM 显式 stop）→ 直接结束
  if (resp.toolCalls.length === 0 || resp.finishReason === 'stop') {
    // 空回复（无内容/无推理/无工具调用，如虚拟 Agent 装配的空 LLM）不记录，
    // 避免空 assistant 消息污染会话文件（真实 Agent 空回复同理无意义）。
    if (resp.content || resp.reasoning || resp.toolCalls.length > 0) {
      recordAssistant(ctx, resp, messages, loopMessages, state);
    }
    return { done: true, final: resp.content ?? '' };
  }

  recordAssistant(ctx, resp, messages, loopMessages, state);

  const { interrupted, interruptReason } = await runTools(ctx, resp.toolCalls, messages, loopMessages, signal);
  return interrupted
    ? {
        done: true,
        interrupted: true,
        interruptReason: interruptReason ?? { type: 'user-abort' },
        // 中断描述已写入 tool 消息，final 保持 LLM 真实产出（通常为空），不覆盖 Agent 回复
        final: resp.content ?? '',
      }
    : { done: false };
}

// ============================================================
// LLM 流式调用
// ============================================================

async function streamLLM(
  ctx: CurrentContext,
  req: LLMRequest,
  signal: AbortSignal | undefined,
  state: LoopState,
): Promise<LLMResponse> {
  // 无 emit（事件总线）→ 非流式 fast-path，只取结果
  if (!ctx.emit) {
    const resp = await ctx.llm.chat(req, signal);
    state.usage = accumulateUsage(state.usage, resp.usage);
    return resp;
  }

  state.thinkingStartTime = 0;
  const stream = ctx.llm.stream(req, signal);
  for await (const token of stream) {
    const t = token.type;
    if (t === 'thinking_start') {
      state.thinkingStartTime = Date.now();
      emitLoop(ctx, 'chat.thinking.start', '', { label: '思考中...' });
    } else if (t === 'thinking_update') {
      emitLoop(ctx, 'chat.thinking.update', token.delta ?? '', { delta: token.delta });
    } else if (t === 'thinking_end') {
      emitLoop(ctx, 'chat.thinking.end', '', { label: thinkingLabel(undefined, Date.now() - state.thinkingStartTime) });
    } else if (t === 'toolcall_start') {
      emitLoop(ctx, 'chat.toolcall.start', '', { index: token.toolCall?.index, name: token.toolCall?.name });
    } else if (t === 'toolcall_update') {
      emitLoop(ctx, 'chat.toolcall.update', token.delta ?? '', { index: token.toolCall?.index, delta: token.delta });
    } else if (t === 'toolcall_end') {
      emitLoop(ctx, 'chat.toolcall.end', '', { index: token.toolCall?.index, name: token.toolCall?.name, arguments: token.toolCall?.arguments });
    } else if (t === 'error') {
      const errMsg = token.error ?? 'LLM 调用失败';
      state.lastError = errMsg;
      // 主动打断（chat.interrupt/优雅关闭）：LLM abort 非失败，不推 chat.message.error
      // 事件（loop 层随后按中断收尾），避免前端出现"LLM 错误"红条。
      if (signal?.aborted) continue;
      log.error(`LLM 错误: ${errMsg}`);
      emitLoop(ctx, 'chat.message.error', errMsg, { role: 'error', content: errMsg });
      state.errorEmitted = true;
    } else if (t === 'message_start') {
      emitLoop(ctx, 'chat.message.start', '');
    } else if (t === 'message_update') {
      emitLoop(ctx, 'chat.message.update', token.delta ?? '', { delta: token.delta });
    } else if (t === 'message_end') {
      emitLoop(ctx, 'chat.message.end', token.partial.content, { content: token.partial.content, reasoning: token.partial.reasoning });
    }
  }

  // 错误已通过流协议传递（"错误进流"契约），result() 返回的 LLMResponse 已含 finishReason。
  const resp = await stream.result();
  state.usage = accumulateUsage(state.usage, resp.usage);
  return resp;
}

// ============================================================
// 工具执行
// ============================================================

async function runTools(
  ctx: CurrentContext,
  toolCalls: ToolCall[],
  messages: LLMRequestMessage[],
  loopMessages: AgentMessage[],
  signal: AbortSignal | undefined,
): Promise<{ interrupted: boolean; interruptReason?: InterruptReason }> {
  // 并行执行所有工具调用（LLM 在同一轮返回的 tool_calls 彼此独立）
  const results = await Promise.all(toolCalls.map(async (tc) => {
    if (signal?.aborted) {
      return { tc, content: '', label: tc.name, tool: null as Tool | null, interrupt: { type: 'user-abort' } as InterruptReason };
    }

    const tool = ctx.tools.get(tc.name);
    emitLoop(ctx, 'chat.tool_execution.start', '', {
      tool_name: tc.name, arguments: tc.arguments, tool_call_id: tc.id,
      label: tool ? toolLabel(tool, tc.arguments) : tc.name,
    });

    let content = '';
    let details: any;
    let interrupt: InterruptReason | undefined;
    let execError: Error | undefined;
    let blocked: string | undefined;
    // 工具参数浅拷贝：防止工具原地修改 LLM 的 arguments（钩子可改写此副本）
    let args = { ...tc.arguments } as Record<string, any>;

    // 工具执行前钩子（对齐 chat.tool_execution.start）：可拦截（allow=false）/ 改写参数
    if (tool) {
      for (const hook of ctx.toolExecutionStartHook ?? []) {
        let res: ToolExecutionStartResult;
        try {
          res = await hook(tc.name, args);
        } catch (err: any) {
          log.error(`toolExecutionStartHook 失败: ${err?.message || String(err)}`);
          continue;
        }
        if (!res.allow) {
          blocked = res.reason || `工具 ${tc.name} 被拦截`;
          break;
        }
        if (res.args) args = res.args;
      }
    }

    const started = Date.now();
    try {
      if (!tool) {
        content = JSON.stringify({ status: 'error', data: { message: `未找到工具：${tc.name}` } });
      } else if (blocked) {
        content = JSON.stringify({ status: 'error', data: { message: blocked } });
      } else {
        let partial = '';
        const stream: ToolStream = {
          onChunk: (delta: string) => {
            partial += delta;
            emitLoop(ctx, 'chat.tool_execution.update', delta, { tool_call_id: tc.id, delta, partial });
          },
        };
        const raw = await tool.execute(args, stream, signal);
        if (typeof raw === 'string') {
          content = raw;
        } else {
          content = raw.content;
          details = raw.details;
        }
      }
    } catch (err: any) {
      if (isToolInterrupt(err)) {
        // 语义化中断（reload/restart/工具被中止）—— 不是错误，不写入 error tool 消息
        interrupt = err.reason;
        content = '';
        log.info(`工具 ${tc.name} 发出中断请求: ${err.reason.type}`);
      } else {
        execError = err instanceof Error ? err : new Error(String(err));
        content = JSON.stringify({ status: 'error', data: { message: err.message } });
      }
    }

    // 输出脱敏：装配注入的 redactor 把密钥/敏感值替换为掩码（纵深防御，覆盖成功与 error 分支）
    if (ctx.redactResult && content) {
      try {
        content = ctx.redactResult(content, tc.name);
      } catch (err: any) {
        log.error(`redactResult 失败: ${err?.message || String(err)}`);
      }
    }

    // 工具执行后钩子（对齐 chat.tool_execution.end）：观察结果/错误/中断
    const outcome: ToolExecutionOutcome = {
      toolName: tc.name,
      args,
      durationMs: Date.now() - started,
      ...(execError ? { error: execError } : {}),
      ...(interrupt ? { interrupted: true } : {}),
      ...(details !== undefined ? { result: { content, details } } : { result: content }),
    };
    for (const hook of ctx.toolExecutionEndHook ?? []) {
      try { await hook(outcome); }
      catch (err: any) { log.error(`toolExecutionEndHook 失败: ${err?.message || String(err)}`); }
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
      const interruptMsg: AgentMessage = {
        role: 'tool',
        content: interruptContent,
        tool_call_id: tc.id || `call_idx_${tc.name || 'unknown'}`,
        name: tc.name,
        label,
      };
      messages.push(interruptMsg);
      loopMessages.push(interruptMsg);
      emitLoop(ctx, 'chat.tool_execution.end', interruptContent, { tool_call_id: tc.id, result: interruptContent, details });
      continue;
    }
    const toolMsg: AgentMessage = {
      role: 'tool', content,
      // tc.id 由 SSE 解析器保证非空（缺失时使用 call_idx_N），
      // 与 assistant.tool_calls 来自同一源头，必定匹配。
      tool_call_id: tc.id || `call_idx_${tc.name || 'unknown'}`,
      name: tc.name,
      label,
    };
    messages.push(toolMsg);
    loopMessages.push(toolMsg);
    emitLoop(ctx, 'chat.tool_execution.end', content, { tool_call_id: tc.id, result: content, details });
  }

  const aborted = signal?.aborted ?? false;
  return {
    interrupted: interruptReason !== undefined || aborted,
    interruptReason: interruptReason ?? (aborted ? { type: 'user-abort' } : undefined),
  };
}

// ============================================================
// 消息记录
// ============================================================

function recordAssistant(
  ctx: CurrentContext,
  resp: LLMResponse,
  messages: LLMRequestMessage[],
  loopMessages: AgentMessage[],
  state: LoopState,
  interrupted = false,
): void {
  const msg: AgentMessage = {
    role: 'assistant',
    content: interrupted ? (resp.content || '(已被中断)') : (resp.content ?? ''),
    tool_calls: interrupted ? undefined : (resp.toolCalls.length > 0 ? resp.toolCalls : undefined),
    reasoning_content: resp.reasoning || undefined,
    label: thinkingLabel(resp.reasoning, state.thinkingStartTime ? Date.now() - state.thinkingStartTime : undefined),
  };
  messages.push(msg);
  loopMessages.push(msg);
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
function accumulateUsage(current: LLMUsage | undefined, usage: LLMUsage | undefined): LLMUsage | undefined {
  if (!usage) return current;
  if (!current) {
    return {
      ...usage,
      accumulated_prompt_tokens: usage.prompt_tokens,
      accumulated_total_tokens: usage.total_tokens,
      react_turns: 1,
    };
  }
  const acc = { ...current };
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
  return acc;
}
