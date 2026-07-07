// ============================================================
// AgentChat 核心 ReAct 引擎
// ============================================================

import { EventEmitter } from 'events';
import {
  AgentContext,
  AgentMessage,
  AgentMessageType,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMUsage,
  Message,
  PreProcessHook,
  PostProcessHook,
  RuntimeConfig,
  Tool,
  ToolCall,
  ToolDefinition,
} from './types';
import { AgentConfig } from '../discovery/config-types';

const DEFAULT_MAX_ITERATIONS = 15;

// ============================================================
// 公开类型
// ============================================================

export interface AgentResult {
  content: string;
  interrupted: boolean;
}

// ============================================================
// 内部工具
// ============================================================

function toolLabel(tool: Tool, args: Record<string, unknown>): string {
  const label = tool.displayName || tool.definition.function.name;
  const detail = tool.extractLabel ? tool.extractLabel(args as Record<string, any>) : '';
  const short = detail.slice(0, 60);
  return short ? `${label} ${short}` : label;
}

function thinkingLabel(reasoning?: string, elapsedMs?: number): string | undefined {
  if (!reasoning?.trim()) return undefined;
  if (elapsedMs !== undefined && elapsedMs > 0) {
    const elapsed = (elapsedMs / 1000).toFixed(1);
    return `已思考（用时 ${elapsed} 秒）`;
  }
  return '已深度思考';
}

// ============================================================
// Agent
// ============================================================

export class Agent {
  readonly config: AgentConfig;

  get agentId(): string { return this.config.agent_id; }
  get name(): string { return this.config.name; }
  get systemPrompt(): string { return this.config.system_prompt; }

  private llm: LLMProvider | null = null;
  private tools: Map<string, Tool> = new Map();
  private preHooks: PreProcessHook[] = [];
  private postHooks: PostProcessHook[] = [];
  private maxIterations: number;
  private runtimeConfig: RuntimeConfig | undefined;
  /** 本轮 run() 累计 Token 用量（ReAct 循环中逐次累加） */
  private _cumulativeUsage: LLMUsage | undefined;
  /** 事件总线（由外部注入，如 Router），Agent 通过它发射实时事件 */
  private _eventBus?: EventEmitter;
  /** 当前运行的 correlation_id */
  private _cid?: string;
  /** 当前轮 thinking 开始时间（毫秒） */
  private _thinkingStartTime: number = 0;

  constructor(config: AgentConfig) {
    this.config = config;
    this.maxIterations = config.max_iterations ?? DEFAULT_MAX_ITERATIONS;
    this.runtimeConfig = config.runtime as RuntimeConfig | undefined;
  }

  // ---- 配置 ----

  setLLM(llm: LLMProvider): this { this.llm = llm; return this; }
  /** 注入事件总线，Agent 通过它向外发射流式事件（chunk / thinking / tool） */
  setEventBus(bus: EventEmitter): this { this._eventBus = bus; return this; }

  registerTool(tool: Tool): this {
    this.tools.set(tool.definition.function.name, tool);
    return this;
  }

  registerTools(tools: Tool[]): this {
    for (const t of tools) this.tools.set(t.definition.function.name, t);
    return this;
  }

  usePreHook(hook: PreProcessHook): this { this.preHooks.push(hook); return this; }
  usePostHook(hook: PostProcessHook): this { this.postHooks.push(hook); return this; }
  setMaxIterations(n: number): this { this.maxIterations = n; return this; }

  // ---- 内部事件发射 ----

  /** 将事件包装为 AgentMessage 并通过事件总线发射 */
  private _emit(type: AgentMessageType, payload: string, data?: Record<string, any>): void {
    if (!this._eventBus) return;
    const msg: AgentMessage = {
      from: this.agentId,
      to: 'user',
      type,
      payload,
      correlation_id: this._cid,
      data,
    };
    this._eventBus.emit('message', msg);
  }

  // ============================================================
  // ReAct 循环
  // ============================================================

  async run(
    ctx: AgentContext,
    options?: { deepThink?: boolean },
    signal?: AbortSignal
  ): Promise<AgentResult> {
    if (!this.llm) throw new Error(`Agent "${this.agentId}" 未配置 LLM 提供者`);

    this._cid = `agent-${this.agentId}-${Date.now()}`;
    this._cumulativeUsage = undefined;

    const processedCtx = await this.applyPreHooks(ctx);
    const messages: Message[] = [{ role: 'system', content: processedCtx.systemPrompt }, ...processedCtx.history];
    if (processedCtx.currentMessage) messages.push(processedCtx.currentMessage);
    const loopMessages: Message[] = [];
    const toolDefs: ToolDefinition[] = Array.from(this.tools.values()).map(t => t.definition);

    let content: string;
    let interrupted: boolean;

    try {
      ({ content, interrupted } = await this.executeLoop(
        messages, loopMessages, toolDefs, options?.deepThink, signal
      ));
    } catch (err: any) {
      content = `Agent 执行异常：${err.message}`;
      interrupted = false;
    }

    processedCtx.loopMessages = loopMessages;
    processedCtx.cumulativeUsage = this._cumulativeUsage;
    await this.applyPostHooks(processedCtx, content);
    return { content, interrupted };
  }

  private async executeLoop(
    messages: Message[],
    loopMessages: Message[],
    toolDefs: ToolDefinition[],
    deepThink: boolean | undefined,
    signal?: AbortSignal
  ): Promise<{ content: string; interrupted: boolean }> {
    if (signal?.aborted) return { content: '', interrupted: true };

    for (let i = 0; i < this.maxIterations; i++) {
      if (signal?.aborted) {
        this._emit('chat.interrupted', '', { reason: 'user_interrupt' });
        return { content: '', interrupted: true };
      }

      const req: LLMRequest = { messages, tools: toolDefs.length > 0 ? toolDefs : undefined, thinking: deepThink };
      const resp = await this.invokeLLM(req, signal);
      const result = await this.handleResponse(resp, messages, loopMessages, i, signal);

      if (result.done) {
        return {
          content: result.interrupted
            ? (result.partialContent || result.final || '')
            : (result.final ?? ''),
          interrupted: result.interrupted ?? false,
        };
      }
    }

    return { content: '', interrupted: true };
  }

  private async handleResponse(
    resp: LLMResponse,
    messages: Message[],
    loopMessages: Message[],
    index: number,
    signal?: AbortSignal
  ): Promise<{ done: boolean; interrupted?: boolean; final?: string; partialContent?: string }> {
    if (signal?.aborted && (resp.content || resp.reasoning)) {
      this.pushPartial(resp, messages, loopMessages);
      this._emit('chat.interrupted', '', { reason: 'user_interrupt' });
      return { done: true, interrupted: true, partialContent: resp.content || '' };
    }

    if (resp.toolCalls.length === 0 || resp.finishReason === 'stop') {
      this.pushAssistant(resp, messages, loopMessages);
      this._emit('chat.response.done', resp.content ?? '', { content: resp.content, reasoning: resp.reasoning });
      return { done: true, final: resp.content ?? '' };
    }

    this.pushAssistant(resp, messages, loopMessages);
    this._emit('chat.response.done', resp.content ?? '', { content: resp.content, tool_calls: resp.toolCalls, reasoning: resp.reasoning });

    // 最后一轮 → 软结束
    if (index === this.maxIterations - 1) {
      const blockMsg = '已达到工具调用次数上限。请基于当前已有的信息和工具执行结果，直接给用户一个完整、有帮助的回复，不要再尝试调用任何工具。';
      await this.executeToolCalls(resp.toolCalls, messages, loopMessages, blockMsg, signal);
      const final = await this.finalLLMCall(messages, loopMessages, blockMsg, signal);
      return { done: true, final };
    }

    const interrupted = await this.executeToolCalls(
      resp.toolCalls, messages, loopMessages, null, signal
    );
    return interrupted ? { done: true, interrupted: true } : { done: false };
  }

  // ---- LLM 调用 ----

  private async invokeLLM(
    req: LLMRequest,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    try {
      // 有事件总线 → 流式；无 → 非流式
      if (!this._eventBus) {
        const resp = await this.llm!.chat(req, signal);
        this._accumulateUsage(resp.usage);
        return resp;
      }

      this._emit('chat.response.start', '');

      let thinkingActive = false;
      this._thinkingStartTime = 0;

      const onChunk = (delta: string) => {
        if (thinkingActive) {
          this._emit('chat.thinking.done', '', { label: thinkingLabel(undefined, Date.now() - this._thinkingStartTime) });
        }
        thinkingActive = false;
        this._emit('chat.response.chunk', delta, { delta });
      };
      const onThinking = (delta: string) => {
        if (!thinkingActive) {
          this._thinkingStartTime = Date.now();
          this._emit('chat.thinking.start', '', { label: '思考中...' });
          thinkingActive = true;
        }
        this._emit('chat.thinking.chunk', delta, { delta });
      };

      const resp = await this.llm!.chat(req, signal, onChunk, onThinking);
      this._accumulateUsage(resp.usage);

      if (thinkingActive) {
        this._emit('chat.thinking.done', '', { label: thinkingLabel(undefined, Date.now() - this._thinkingStartTime) });
      }
      return resp;
    } catch (err: unknown) {
      return {
        content: `LLM 调用失败：${err instanceof Error ? err.message : String(err)}`,
        toolCalls: [],
        finishReason: 'error',
      };
    }
  }

  // ---- 工具执行 ----

  private async executeToolCalls(
    toolCalls: ToolCall[],
    messages: Message[],
    loopMessages: Message[],
    blockMsg: string | null,
    signal?: AbortSignal
  ): Promise<boolean> {
    for (const tc of toolCalls) {
      if (signal?.aborted) {
        this._emit('chat.interrupted', '', { reason: 'user_interrupt' });
        return true;
      }

      const tool = this.tools.get(tc.name);
      this._emit('chat.tool.start', '', { tool_name: tc.name, arguments: tc.arguments, tool_call_id: tc.id, label: tool ? toolLabel(tool, tc.arguments) : tc.name });

      let result: string;
      if (blockMsg) {
        result = JSON.stringify({ status: 'blocked', data: { message: blockMsg } });
      } else if (!tool) {
        result = JSON.stringify({ status: 'error', data: { message: `未找到工具：${tc.name}` } });
      } else {
        try {
          result = await tool.execute(tc.arguments as any);
        } catch (err: any) {
          result = JSON.stringify({ status: 'error', data: { message: err.message } });
        }
      }

      const toolMsg: Message = {
        role: 'tool', content: result,
        tool_call_id: tc.id, name: tc.name,
        label: tool ? toolLabel(tool, tc.arguments) : tc.name,
      };
      messages.push(toolMsg);
      loopMessages.push(toolMsg);
      this._emit('chat.tool.done', result, { tool_call_id: tc.id, result });
    }
    return false;
  }

  // ---- 辅助 ----

  private pushAssistant(resp: LLMResponse, messages: Message[], loopMessages: Message[]): void {
    const msg: Message = {
      role: 'assistant', content: resp.content ?? '',
      tool_calls: resp.toolCalls.length > 0 ? resp.toolCalls : undefined,
      reasoning_content: resp.reasoning,
      label: thinkingLabel(resp.reasoning, this._thinkingStartTime ? Date.now() - this._thinkingStartTime : undefined),
    };
    messages.push(msg);
    loopMessages.push(msg);
  }

  private pushPartial(resp: LLMResponse, messages: Message[], loopMessages: Message[]): void {
    const msg: Message = {
      role: 'assistant',
      content: resp.content || '(已被中断)',
      reasoning_content: resp.reasoning || undefined,
      label: thinkingLabel(resp.reasoning, this._thinkingStartTime ? Date.now() - this._thinkingStartTime : undefined),
    };
    messages.push(msg);
    loopMessages.push(msg);
  }

  private async applyPreHooks(ctx: AgentContext): Promise<AgentContext> {
    let result: AgentContext = { ...ctx, llm: this.llm ?? undefined };
    for (const hook of this.preHooks) result = await hook(result);
    return result;
  }

  private async applyPostHooks(ctx: AgentContext, response: string): Promise<void> {
    for (const hook of this.postHooks) await hook(ctx, response);
  }

  /** 累加单次 LLM 调用产生的 Token 用量到本轮累计 */
  private _accumulateUsage(usage: LLMUsage | undefined): void {
    if (!usage) return;
    if (!this._cumulativeUsage) {
      this._cumulativeUsage = { ...usage };
      return;
    }
    const acc = this._cumulativeUsage;
    acc.prompt_tokens += usage.prompt_tokens;
    acc.completion_tokens += usage.completion_tokens;
    acc.total_tokens += usage.total_tokens;
    if (usage.prompt_cache_hit_tokens !== undefined) {
      acc.prompt_cache_hit_tokens = (acc.prompt_cache_hit_tokens ?? 0) + usage.prompt_cache_hit_tokens;
    }
    if (usage.prompt_cache_miss_tokens !== undefined) {
      acc.prompt_cache_miss_tokens = (acc.prompt_cache_miss_tokens ?? 0) + usage.prompt_cache_miss_tokens;
    }
  }

  private async finalLLMCall(
    messages: Message[],
    loopMessages: Message[],
    fallbackContent: string,
    signal?: AbortSignal
  ): Promise<string> {
    this._emit('chat.response.start', '');

    const req: LLMRequest = { messages };
    const resp = await this.invokeLLM(req, signal);

    const content = resp.content ?? fallbackContent;
    const msg: Message = { role: 'assistant', content, reasoning_content: resp.reasoning, label: thinkingLabel(resp.reasoning) };
    messages.push(msg);
    loopMessages.push(msg);
    this._emit('chat.response.done', content, { content });
    return content;
  }

  // ============================================================
  // 电话模式入口
  // ============================================================

  async receive(message: AgentMessage, signal?: AbortSignal): Promise<AgentResult> {
    const ctx: AgentContext = {
      sender: message.from,
      receiver: this.agentId,
      systemPrompt: this.systemPrompt,
      history: [],
      currentMessage: { role: 'user', content: message.payload },
      runtimeConfig: this.runtimeConfig,
      llm: this.llm ?? undefined,
      llmConfig: this.config.llm,
    };
    return this.run(ctx, { deepThink: message.data?.deepThink }, signal);
  }
}
