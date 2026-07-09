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
  Tool,
  ToolCall,
  ToolDefinition,
} from './types';
import { AgentConfig } from '../discovery/config-types';

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

/**
 * 从 AgentConfig 中提取命名空间配置。
 * 键名包含 "." 的即为命名空间键（如 "tool.bash"、"extension.agent_session"）。
 */
function extractNamespaceConfig(config: AgentConfig): Record<string, Record<string, unknown>> {
  const ns: Record<string, Record<string, unknown>> = {};
  for (const key of Object.keys(config)) {
    if (key.includes('.') && typeof config[key] === 'object' && config[key] !== null) {
      ns[key] = config[key] as Record<string, unknown>;
    }
  }
  return ns;
}

function toolLabel(tool: Tool, args: Record<string, unknown>): string {
  const label = tool.displayName || tool.definition.function.name;
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
// Agent
// ============================================================

export class Agent {
  readonly config: AgentConfig;

  get agentId(): string { return this.config.agent_id; }
  get name(): string { return this.config.name; }

  private llm: LLMProvider | null = null;
  private tools: Map<string, Tool> = new Map();
  private preHooks: PreProcessHook[] = [];
  private postHooks: PostProcessHook[] = [];
  private _cumulativeUsage: LLMUsage | undefined;
  /** 事件总线（由外部注入，如 Router），Agent 通过它发射实时事件 */
  private _eventBus?: EventEmitter;
  /** 当前运行的 correlation_id */
  private _cid?: string;
  /** 当前轮 thinking 开始时间（毫秒） */
  private _thinkingStartTime: number = 0;

  constructor(config: AgentConfig) {
    this.config = config;
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
    this._emit('chat.start', '', { agent: this.agentId });

    // 注入 Agent 级运行时配置覆盖（提取命名空间键）
    ctx.runtimeConfig = extractNamespaceConfig(this.config);
    ctx.agentConfig = this.config;

    // 注入可用工具概览（供 agent-prompt 等 PreHook 使用）
    ctx.availableTools = Array.from(this.tools.values()).map(t => ({
      name: t.definition.function.name,
      displayName: t.displayName,
      description: t.description ?? t.definition.function.description,
    }));

    // 初始化扩展间共享元数据
    ctx.meta = {};

    const processedCtx = await this.applyPreHooks(ctx);

    // 注册 MCP 工具（agent-prompt 扩展发现并存入 ctx.meta）
    if (processedCtx.meta?.['mcp']) {
      const mcpMeta = processedCtx.meta['mcp'] as {
        toolMap: Record<string, { serverName: string; tool: { name: string; description?: string; inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] } } }>;
        manager: { getClient(name: string): { callTool(name: string, args: Record<string, unknown>): Promise<string> } | undefined };
      };
      for (const [toolName, { serverName, tool: mcpTool }] of Object.entries(mcpMeta.toolMap)) {
        if (this.tools.has(toolName)) continue; // 不覆盖已有同名工具
        const mcpToolObj: Tool = {
          definition: {
            type: 'function',
            function: {
              name: toolName,
              description: mcpTool.description ?? `MCP 工具 (${serverName})`,
              parameters: {
                type: mcpTool.inputSchema.type,
                properties: mcpTool.inputSchema.properties ?? {},
                ...(mcpTool.inputSchema.required ? { required: mcpTool.inputSchema.required } : {}),
              },
            },
          },
          displayName: `[MCP:${serverName}] ${toolName}`,
          description: mcpTool.description,
          execute: async (args: Record<string, any>) => {
            const client = mcpMeta.manager.getClient(serverName);
            if (!client) {
              return `MCP 服务器 "${serverName}" 未连接`;
            }
            return await client.callTool(toolName, args);
          },
        };
        this.tools.set(toolName, mcpToolObj);
      }
      console.log(`[Agent] 已注册 ${Object.keys(mcpMeta.toolMap).length} 个 MCP 工具`);
    }

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
    this._emit('chat.end', content, { interrupted });
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

    // ReAct 循环不设迭代上限：
    //   1. 达到上限的情况极其罕见
    //   2. 硬中断会截断思考链，导致回复质量严重下降
    // 中断仅由 AbortSignal（用户取消）触发
    while (true) {
      this._emit('chat.turn.start', '');

      const req: LLMRequest = { messages, tools: toolDefs.length > 0 ? toolDefs : undefined, thinking: deepThink, userId: this.agentId };
      const resp = await this.streamLLM(req, signal);
      const result = await this.processTurn(resp, messages, loopMessages, signal);

      this._emit('chat.turn.end', resp.content ?? '', {
        content: resp.content,
        reasoning: resp.reasoning,
        interrupted: result.interrupted ?? undefined,
      });

      if (result.done) {
        return { content: result.final ?? '', interrupted: result.interrupted ?? false };
      }
    }
  }

  private async processTurn(
    resp: LLMResponse,
    messages: Message[],
    loopMessages: Message[],
    signal?: AbortSignal
  ): Promise<{ done: boolean; interrupted?: boolean; final?: string }> {
    if (signal?.aborted && (resp.content || resp.reasoning)) {
      this.recordAssistant(resp, messages, loopMessages, true);
      return { done: true, interrupted: true, final: resp.content || '' };
    }

    if (resp.toolCalls.length === 0 || resp.finishReason === 'stop') {
      this.recordAssistant(resp, messages, loopMessages);
      return { done: true, final: resp.content ?? '' };
    }

    this.recordAssistant(resp, messages, loopMessages);

    const interrupted = await this.runTools(
      resp.toolCalls, messages, loopMessages, signal
    );
    return interrupted ? { done: true, interrupted: true } : { done: false };
  }

  // ---- LLM 流式调用 ----

  private async streamLLM(
    req: LLMRequest,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    // 无事件总线 → 非流式，只取结果
    if (!this._eventBus) {
      const resp = await this.llm!.chat(req, signal);
      this._accumulateUsage(resp.usage);
      return resp;
    }

    this._thinkingStartTime = 0;

    const stream = this.llm!.stream(req, signal);
    for await (const token of stream) {
      const t = token.type;
      if (t === 'thinking_start') {
        this._thinkingStartTime = Date.now();
        this._emit('chat.thinking.start', '', { label: '思考中...' });
      } else if (t === 'thinking_update') {
        this._emit('chat.thinking.update', token.delta ?? '', { delta: token.delta });
      } else if (t === 'thinking_end') {
        this._emit('chat.thinking.end', '', { label: thinkingLabel(undefined, Date.now() - this._thinkingStartTime) });
      } else if (t === 'toolcall_start') {
        this._emit('chat.toolcall.start', '', {
          index: token.toolCall?.index, name: token.toolCall?.name,
        });
      } else if (t === 'toolcall_update') {
        this._emit('chat.toolcall.update', token.delta ?? '', {
          index: token.toolCall?.index, delta: token.delta,
        });
      } else if (t === 'toolcall_end') {
        this._emit('chat.toolcall.end', '', {
          index: token.toolCall?.index, name: token.toolCall?.name,
          arguments: token.toolCall?.arguments,
        });
      } else if (t === 'error') {
        this._emit('chat.message.end', token.error ?? 'LLM 调用失败');
      } else if (t === 'message_start') {
        this._emit('chat.message.start', '');
      } else if (t === 'message_update') {
        this._emit('chat.message.update', token.delta ?? '', { delta: token.delta });
      } else if (t === 'message_end') {
        this._emit('chat.message.end', token.partial.content);
      }
    }

    // 错误已通过流协议传递，result() 返回的 LLMResponse 已包含 finishReason。
    // provider 遵守"错误进流"契约 → 此处不需要 try-catch。
    const resp = await stream.result();
    this._accumulateUsage(resp.usage);
    return resp;
  }

  // ---- 工具执行 ----

  private async runTools(
    toolCalls: ToolCall[],
    messages: Message[],
    loopMessages: Message[],
    signal?: AbortSignal
  ): Promise<boolean> {
    for (const tc of toolCalls) {
      if (signal?.aborted) return true;

      const tool = this.tools.get(tc.name);
      this._emit('chat.tool_execution.start', '', { tool_name: tc.name, arguments: tc.arguments, tool_call_id: tc.id, label: tool ? toolLabel(tool, tc.arguments) : tc.name });

      let content: string;
      let details: any;
      if (!tool) {
        content = JSON.stringify({ status: 'error', data: { message: `未找到工具：${tc.name}` } });
      } else {
        try {
          let partial = '';
          const stream = {
            onChunk: (delta: string) => {
              partial += delta;
              this._emit('chat.tool_execution.update', delta, { tool_call_id: tc.id, delta, partial });
            },
          };
          const raw = await tool.execute(tc.arguments as any, stream);
          if (typeof raw === 'string') {
            content = raw;
          } else {
            content = raw.content;
            details = raw.details;
          }
        } catch (err: any) {
          content = JSON.stringify({ status: 'error', data: { message: err.message } });
        }
      }

      const toolMsg: Message = {
        role: 'tool', content,
        tool_call_id: tc.id, name: tc.name,
        label: tool ? toolLabel(tool, tc.arguments) : tc.name,
      };
      messages.push(toolMsg);
      loopMessages.push(toolMsg);
      this._emit('chat.tool_execution.end', content, { tool_call_id: tc.id, result: content, details });
    }
    return false;
  }

  // ---- 消息记录 ----

  private recordAssistant(resp: LLMResponse, messages: Message[], loopMessages: Message[], interrupted = false): void {
    const msg: Message = {
      role: 'assistant',
      content: interrupted ? (resp.content || '(已被中断)') : (resp.content ?? ''),
      tool_calls: interrupted ? undefined : (resp.toolCalls.length > 0 ? resp.toolCalls : undefined),
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

  // ============================================================
  // 电话模式入口
  // ============================================================

  async receive(message: AgentMessage, signal?: AbortSignal): Promise<AgentResult> {
    const ctx: AgentContext = {
      sender: message.from,
      receiver: this.agentId,
      systemPrompt: '',
      history: [],
      currentMessage: { role: 'user', content: message.payload },
      agentConfig: this.config,
      llm: this.llm ?? undefined,
      llmConfig: this.config.llm,
    };
    return this.run(ctx, { deepThink: message.data?.deepThink }, signal);
  }
}
