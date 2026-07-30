// ============================================================
// AgentChat 核心 ReAct 引擎
// ============================================================

import { EventEmitter } from 'events';
import {
  AgentContext,
  AgentMessage,
  AgentMessageType,
  AgentResult,
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
  ToolInterceptor,
  ToolInterceptContext,
  TriggerOptions,
} from './types';
import { AgentConfig, LLMConfig } from '@discovery/config-types';
import { setCurrentAgentAllowedPaths, clearCurrentAgentAllowedPaths } from './config';
import { logger } from '../utils/logger';
import { AgentExecutionQueue } from './agent-queue';

// ============================================================
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
  private toolInterceptors: ToolInterceptor[] = [];
  private _cumulativeUsage: LLMUsage | undefined;
  /** 事件总线（由外部注入，如 Router），Agent 通过它发射实时事件 */
  private _eventBus?: EventEmitter;
  /** 当前运行的 correlation_id */
  private _cid?: string;
  /** 当前轮 thinking 开始时间（毫秒） */
  private _thinkingStartTime: number = 0;
  /** 转向消息队列：用户在 Agent 执行中途插入的新指令 */
  private _steeringQueue: Message[] = [];
  /** 当前对话对的 user_id（用于 DeepSeek 缓存隔离），格式: <sender>__<receiver> */
  private _conversationUserId: string = '';
  /** 当前对话的 sender（用于事件数据注入，供前端路由 trigger 消息） */
  private _conversationSender: string = '';

  // ============================================================

  /** 执行队列（串行化 receive/trigger） */
  private _execQueue!: AgentExecutionQueue;

  /** reload 后需重新 applyPreHooks + 注册 MCP（外层 run 循环检测） */
  private _needsReinit = false;

  constructor(config: AgentConfig) {
    this.config = config;
    this._execQueue = new AgentExecutionQueue(this.agentId, 32, {
      doReceive: (msg, sig) => this._doReceive(msg, sig),
      doTrigger: (opts, sig) => this._doTrigger(opts, sig),
    });
  }

  /** 注入转向消息：Agent 在下一轮 LLM 调用前将其作为用户消息注入上下文 */
  steer(message: Message): void {
    this._steeringQueue.push(message);
  }

  // ---- 配置 ----

  setLLM(llm: LLMProvider): this { this.llm = llm; return this; }

  /** 获取当前 LLM 提供者（供外部模块如 agent-memory 使用） */
  get llmProvider(): LLMProvider | null { return this.llm; }

  /**
   * 热重载 Agent 配置、工具、扩展。
   * 保留事件总线和会话数据，仅替换可热更的组件。
   * LLM 实例由调用方通过 setLLM() 单独替换。
   */
  reload(loaded: {
    config: AgentConfig;
    tools: Tool[];
    preHooks: PreProcessHook[];
    postHooks: PostProcessHook[];
    interceptors: ToolInterceptor[];
  }): void {
    // 清除新配置中不存在的旧顶层键（如 llm 被移除时需回退到全局配置）
    for (const key of Object.keys(this.config)) {
      if (!(key in (loaded.config as any))) {
        delete (this.config as any)[key];
      }
    }
    // 替换 config（用 Object.assign 保持引用稳定）
    Object.assign(this.config as any, loaded.config);

    // 替换工具（保留非 loaded.tools 来源的工具：MCP、autoInject 等）
    const loadedNames = new Set(loaded.tools.map(t => t.definition.function.name));
    const preservedTools = new Map<string, Tool>();
    for (const [name, tool] of this.tools) {
      if (!loadedNames.has(name)) {
        preservedTools.set(name, tool);
      }
    }
    this.tools.clear();
    for (const t of loaded.tools) this.tools.set(t.definition.function.name, t);
    // 恢复保留的工具（不覆盖同名静态工具）
    for (const [name, tool] of preservedTools) {
      if (!this.tools.has(name)) {
        this.tools.set(name, tool);
      }
    }
    // 标记需要在外层循环中重新 applyPreHooks + 注册 MCP
    this._needsReinit = true;

    // 替换钩子
    this.preHooks = [...loaded.preHooks];
    this.postHooks = [...loaded.postHooks];
    this.toolInterceptors = [...loaded.interceptors];

    logger.info(
      `[Agent] "${this.agentId}" 已热重载：` +
      `${loaded.tools.length} tools, ${loaded.preHooks.length} pre-hooks, ${loaded.postHooks.length} post-hooks`
    );
  }

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

  /** 获取当前已注册工具的名称列表（供 reload_self_tools 等工具使用） */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  usePreHook(hook: PreProcessHook): this { this.preHooks.push(hook); return this; }
  usePostHook(hook: PostProcessHook): this { this.postHooks.push(hook); return this; }
  useToolInterceptor(interceptor: ToolInterceptor): this { this.toolInterceptors.push(interceptor); return this; }

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
    options?: { deepThink?: boolean; maxTurns?: number },
    signal?: AbortSignal
  ): Promise<AgentResult> {
    if (!this.llm) throw new Error(`Agent "${this.agentId}" 未配置 LLM 提供者`);

    this._cid = `agent-${this.agentId}-${Date.now()}`;
    this._cumulativeUsage = undefined;
    this._conversationUserId = ctx.group_id
      ? `group__${ctx.group_id}__${ctx.receiver}`
      : `${ctx.sender}__${ctx.receiver}`;
    this._conversationSender = ctx.sender;
    this._emit('chat.start', '', {
      agent: this.agentId,
      sender: ctx.sender,
      hint: ctx.currentMessage?.content,
    });

    let content = '';
    let interrupted = false;
    let firstIteration = true;

    while (true) {
      // ---- 每轮重初始化（reload 后重新 applyPreHooks + 发现 MCP）----
      ctx.runtimeConfig = extractNamespaceConfig(this.config);
      ctx.agentConfig = this.config;
      ctx.availableTools = Array.from(this.tools.values()).map(t => ({
        name: t.definition.function.name,
        displayName: t.label,
        description: t.description ?? '',
      }));
      ctx.meta = {};

      const processedCtx = await this.applyPreHooks(ctx);

      // 注册 MCP 工具（agent-prompt 每次迭代重新发现，无需缓存）
      if (processedCtx.meta?.['mcp']) {
        const mcpMeta = processedCtx.meta['mcp'] as {
          toolMap: Record<string, { serverName: string; tool: { name: string; description?: string; inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] } } }>;
          manager: { getClient(name: string): { callTool(name: string, args: Record<string, unknown>): Promise<string> } | undefined };
        };
        for (const [toolName, meta] of Object.entries(mcpMeta.toolMap)) {
          if (this.tools.has(toolName)) continue;
          const mgr = mcpMeta.manager;
          this.tools.set(toolName, {
            definition: {
              type: 'function' as const,
              function: {
                name: toolName,
                description: meta.tool.description ?? `MCP 工具 (${meta.serverName})`,
                parameters: {
                  type: meta.tool.inputSchema.type,
                  properties: meta.tool.inputSchema.properties ?? {},
                  ...(meta.tool.inputSchema.required ? { required: meta.tool.inputSchema.required } : {}),
                },
              },
            },
            label: `[MCP:${meta.serverName}] ${toolName}`,
            name: toolName,
            ns: 'tool.' + toolName,
            description: meta.tool.description,
            execute: async (args: Record<string, any>) => {
              const client = mgr.getClient(meta.serverName);
              if (!client) return `MCP 服务器 "${meta.serverName}" 未连接`;
              return await client.callTool(toolName, args);
            },
          });
        }
      }

      const history = (processedCtx.history || []).filter(m => m.role !== 'error');
      const messages: Message[] = [{ role: 'system', content: processedCtx.systemPrompt }, ...history];
      if (firstIteration && processedCtx.currentMessage) {
        messages.push(processedCtx.currentMessage);
        firstIteration = false;
      }
      const loopMessages: Message[] = [];

      this._needsReinit = false;

      try {
        ({ content, interrupted } = await this.executeLoop(
          messages, loopMessages, options?.deepThink, signal, options?.maxTurns
        ));
      } catch (err: any) {
        content = `Agent 执行异常：${err.message}`;
        interrupted = false;
      }

      processedCtx.loopMessages = loopMessages;
      processedCtx.cumulativeUsage = this._cumulativeUsage;
      await this.applyPostHooks(processedCtx, content);

      if (!this._needsReinit) break;
      this._cumulativeUsage = undefined;
    }

    this._emit('chat.end', content, { interrupted });
    return { content, interrupted };
  }

  private async executeLoop(
    messages: Message[],
    loopMessages: Message[],
    deepThink: boolean | undefined,
    signal?: AbortSignal,
    maxTurns?: number,
  ): Promise<{ content: string; interrupted: boolean }> {
    if (signal?.aborted) return { content: '', interrupted: true };

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
      if (maxTurns && turn > maxTurns) {
        logger.info(
          `[Agent] "${this.agentId}" 自主推理达到最大轮次 ${maxTurns}，强制终止`
        );
        return {
          content: `达到最大推理轮次 (${maxTurns})，已自动终止。`,
          interrupted: true,
        };
      }
      // 注入待处理的转向消息（用户/其他 Agent 中途插入的指令）
      const steering = this._steeringQueue.splice(0);
      if (steering.length > 0) {
        for (const msg of steering) {
          messages.push(msg);
          loopMessages.push(msg);
        }
      }

      this._emit('chat.turn.start', '', { agent: this.agentId, sender: this._conversationSender });

      // 每轮从 this.tools 重新生成工具定义快照，支持运行时热注册新工具（如 reload_self_tools）
      const toolDefs: ToolDefinition[] = Array.from(this.tools.values()).map(t => t.definition);
      const req: LLMRequest = { messages, tools: toolDefs.length > 0 ? toolDefs : undefined, thinking: deepThink, userId: this._conversationUserId };
      let resp: LLMResponse;

      try {
        resp = await this.streamLLM(req, signal);
      } catch (llmErr: any) {
        const errMsg = llmErr.message || String(llmErr);
        logger.error(`[Agent] ${this.agentId} LLM 调用失败: ${errMsg}`);
        // 记录 error 消息到持久化存储
        const errorMessage: Message = { role: 'error', content: errMsg };
        messages.push(errorMessage);
        loopMessages.push(errorMessage);
        this._emit('chat.message.error', errMsg, { role: 'error', content: errMsg, sender: this._conversationSender });
        return { content: `LLM 错误: ${errMsg}`, interrupted: false };
      }



      const result = await this.processTurn(resp, messages, loopMessages, signal);

      this._emit('chat.turn.end', resp.content ?? '', {
        content: resp.content,
        reasoning: resp.reasoning,
        interrupted: result.interrupted ?? undefined,
        agent: this.agentId,
        sender: this._conversationSender,
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
        this._emit('chat.thinking.start', '', { label: '思考中...', sender: this._conversationSender });
      } else if (t === 'thinking_update') {
        this._emit('chat.thinking.update', token.delta ?? '', { delta: token.delta, sender: this._conversationSender });
      } else if (t === 'thinking_end') {
        this._emit('chat.thinking.end', '', { label: thinkingLabel(undefined, Date.now() - this._thinkingStartTime), sender: this._conversationSender });
      } else if (t === 'toolcall_start') {
        this._emit('chat.toolcall.start', '', { sender: this._conversationSender,
          index: token.toolCall?.index, name: token.toolCall?.name,
        });
      } else if (t === 'toolcall_update') {
        this._emit('chat.toolcall.update', token.delta ?? '', { sender: this._conversationSender,
          index: token.toolCall?.index, delta: token.delta,
        });
      } else if (t === 'toolcall_end') {
        this._emit('chat.toolcall.end', '', { sender: this._conversationSender,
          index: token.toolCall?.index, name: token.toolCall?.name,
          arguments: token.toolCall?.arguments,
        });
      } else if (t === 'error') {
        const errMsg = token.error ?? 'LLM 调用失败';
        logger.error(`[Agent] ${this.agentId} LLM 错误: ${errMsg}`);
        this._emit('chat.message.error', errMsg, { role: 'error', content: errMsg });
      } else if (t === 'message_start') {
        this._emit('chat.message.start', '', { sender: this._conversationSender });
      } else if (t === 'message_update') {
        this._emit('chat.message.update', token.delta ?? '', { delta: token.delta, sender: this._conversationSender });
      } else if (t === 'message_end') {
        this._emit('chat.message.end', token.partial.content, { sender: this._conversationSender });
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
    // 并行执行所有工具调用（LLM 在同一轮返回的 tool_calls 彼此独立）
    const results = await Promise.all(toolCalls.map(async (tc) => {
      if (signal?.aborted) return { tc, content: '', label: tc.name, tool: null as Tool | null };

      const tool = this.tools.get(tc.name);
      this._emit('chat.tool_execution.start', '', { sender: this._conversationSender, tool_name: tc.name, arguments: tc.arguments, tool_call_id: tc.id, label: tool ? toolLabel(tool, tc.arguments) : tc.name });

      let content = '';
      let details: any;

      try {
        if (!tool) {
          content = JSON.stringify({ status: 'error', data: { message: `未找到工具：${tc.name}` } });
        } else {
          // ---- Tool Interceptor 管道 ----
          let interceptCtx: ToolInterceptContext = {
            agentId: this.agentId,
            args: { ...tc.arguments } as Record<string, any>,
          };
          let intercepted = false;
          for (const interceptor of this.toolInterceptors) {
            const result = await interceptor(tc.name, interceptCtx);
            interceptCtx = { agentId: this.agentId, args: result.args };
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
            setCurrentAgentAllowedPaths(this.config.allowedPaths);
            try {
              let partial = '';
              const stream = {
                onChunk: (delta: string) => {
                  partial += delta;
                  this._emit('chat.tool_execution.update', delta, { sender: this._conversationSender, tool_call_id: tc.id, delta, partial });
                },
              };
              const raw = await tool.execute(interceptCtx.args, stream);
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
        content = JSON.stringify({ status: 'error', data: { message: err.message } });
      }

      return { tc, content, label: tool ? toolLabel(tool, tc.arguments) : tc.name, details };
    }));

    // 按原始顺序插入消息
    for (const { tc, content, label, details } of results) {
      const toolMsg: Message = {
        role: 'tool', content,
        // tc.id 由 SSE 解析器保证非空（缺失时使用 call_idx_N），
        // 与 assistant.tool_calls 来自同一源头，必定匹配。
        tool_call_id: tc.id || `call_idx_${tc.name || 'unknown'}`,
        name: tc.name,
        label,
      };
      messages.push(toolMsg);
      loopMessages.push(toolMsg);
      this._emit('chat.tool_execution.end', content, { sender: this._conversationSender, tool_call_id: tc.id, result: content, details });
    }

    return signal?.aborted ?? false;
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
    for (const hook of this.preHooks) {
      try {
        result = await hook(result);
      } catch (err: any) {
        // preHook 失败不应中断整个会话——例如 MCP 服务器不可达时
        // agent-prompt 扩展可能抛出未预期的异常，此处兜底保证 Agent 仍能正常推理
        logger.error(`[Agent] "${this.agentId}" preHook 执行异常，已跳过: ${err.message}`);
      }
    }
    return result;
  }

  private async applyPostHooks(ctx: AgentContext, response: string): Promise<void> {
    for (const hook of this.postHooks) {
      try {
        await hook(ctx, response);
      } catch (err: any) {
        logger.error(`[Agent] "${this.agentId}" postHook 执行异常，已跳过: ${err.message}`);
      }
    }
  }

  /**
   * 预览 System Prompt —— 组装当前 Agent 的系统提示词（不执行 ReAct 循环）。
   * 用于前端预览功能，方便用户检查和维护提示词配置。
   *
   * @param sender 发送方 ID（通常为 'user' 或 'preview'）
   * @returns 组装后的完整系统提示词文本
   */
  async assembleSystemPrompt(sender: string = 'preview'): Promise<string> {
    // 构造最小上下文，仅用于 pre-hooks 装配 system prompt
    const ctx: AgentContext = {
      sender,
      receiver: this.agentId,
      systemPrompt: '',
      history: [],
      currentMessage: undefined,
      agentConfig: this.config,
      runtimeConfig: extractNamespaceConfig(this.config),
      availableTools: Array.from(this.tools.values()).map(t => ({
        name: t.definition.function.name,
        displayName: t.label,
        description: t.description ?? '',
      })),
      meta: {},
    };

    const processedCtx = await this.applyPreHooks(ctx);
    return processedCtx.systemPrompt;
  }

  /**
   * 获取当前 Agent 的所有工具定义（用于前端预览）。
   * 返回 OpenAI function-calling 格式的 ToolDefinition 数组。
   */
  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
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
  private _accumulateUsage(usage: LLMUsage | undefined): void {
    if (!usage) return;
    if (!this._cumulativeUsage) {
      this._cumulativeUsage = {
        ...usage,
        accumulated_prompt_tokens: usage.prompt_tokens,
        accumulated_total_tokens: usage.total_tokens,
        react_turns: 1,
      };
      return;
    }
    const acc = this._cumulativeUsage;
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

  // ============================================================
  // ============================================================
  // 电话模式 / 自主推理入口（委托给执行队列）
  // ============================================================

  async receive(message: AgentMessage, signal?: AbortSignal): Promise<AgentResult> {
    return this._execQueue.receive(message, signal);
  }

  /** 执行具体的 receive 逻辑（原 receive 方法体） */
  private async _doReceive(message: AgentMessage, signal?: AbortSignal): Promise<AgentResult> {
    const ctx: AgentContext = {
      sender: message.from,
      receiver: this.agentId,
      systemPrompt: '',
      history: [],
      currentMessage: { role: 'user', content: message.payload },
      agentConfig: this.config,
      llm: this.llm ?? undefined,
      llmConfig: this.config.llm as LLMConfig | undefined,
      group_id: message.group_id,
    };
    return this.run(ctx, { deepThink: message.data?.deepThink }, signal);
  }

  async trigger(options?: TriggerOptions, signal?: AbortSignal): Promise<AgentResult> {
    return this._execQueue.trigger(options, signal);
  }

  /** 执行具体的 trigger 逻辑 */
  private async _doTrigger(
    options?: TriggerOptions,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    // sender 决定会话历史/记忆/缓存的加载路径（session 扩展以 sender 为对端）。
    // trigger 场景下 target 才是真正的会话对端，故优先使用 target；
    // 未设 target 时退化为自对话（Agent ↔ Agent），source 仅作日志标识。
    //
    // hint 通过 currentMessage 注入（而非 history），因为 session 扩展的 preHook
    // 会用文件历史覆盖 ctx.history。currentMessage 在 preHook 之后才拼入 messages，
    // 不会被覆盖。
    const ctx: AgentContext = {
      sender: options?.target ?? this.agentId,
      receiver: this.agentId,
      systemPrompt: '',
      history: [],
      currentMessage: options?.hint
        ? { role: 'user', content: `<trigger>${options.hint}</trigger>` }
        : undefined,
      agentConfig: this.config,
      llm: this.llm ?? undefined,
      llmConfig: this.config.llm as import('@discovery/config-types').LLMConfig | undefined,
      group_id: options?.group_id,
      target: options?.target,
    };

    return this.run(ctx, {
      deepThink: options?.deepThink,
      maxTurns: options?.maxTurns,
    }, signal);
  }

}
