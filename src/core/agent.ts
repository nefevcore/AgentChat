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
  ToolInterceptor,
  ToolInterceptContext,
  TriggerOptions,
} from './types';
import { AgentConfig, LLMConfig } from '@discovery/config-types';
import { setCurrentAgentAllowedPaths, clearCurrentAgentAllowedPaths } from './config';
import { logger } from '../utils/logger';

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
  // 执行队列 —— 保证 receive() 调用串行化
  // ============================================================
  /**
   * 是否正在执行 run()。同一时刻只允许一个 ReAct 循环运行。
   * 后续到达的 receive() 请求会被自动排队。
   */
  private _isExecuting = false;

  /** 待执行的消息队列。每个元素包含消息、信号以及等待方的 resolve/reject。 */
  private _executionQueue: Array<{
    /** receive() 的消息（receive 模式时使用） */
    message?: AgentMessage;
    /** trigger() 的选项（trigger 模式时使用） */
    triggerOptions?: TriggerOptions;
    signal?: AbortSignal;
    resolve: (result: AgentResult) => void;
    reject: (err: Error) => void;
    /** AbortSignal 的 abort 监听器引用，用于出队时清理 */
    onAbort?: () => void;
  }> = [];

  /** 执行队列最大长度，超过后拒绝新消息。防止内存无限增长。 */
  private static readonly MAX_QUEUE_SIZE = 32;

  /**
   * MCP 工具注册表缓存。
   *
   * 存储最近一次 run() 中发现的 MCP 工具元数据（serverName → { toolName, description, inputSchema }）。
   * reload() 会清除 this.tools（包括动态注册的 MCP 工具），因此需要此缓存来重建 MCP 工具，
   * 防止 reload() 并发执行时工具查找失败（"未找到工具：xxx"）。
   */
  private _mcpRegistry: Map<string, { serverName: string; tool: { name: string; description?: string; inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] } } }> = new Map();
  /**
   * 当前 MCP 发现管理器引用。
   * 由 run() 在发现 MCP 工具时注入，供 _rebuildMcpTools() 在 reload() 后重建工具时使用。
   */
  private _mcpManager: { getClient(name: string): { callTool(name: string, args: Record<string, unknown>): Promise<string> } | undefined } | null = null;

  constructor(config: AgentConfig) {
    this.config = config;
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
    // 如果 _mcpRegistry 有更新的元数据，用最新的管理器重建 MCP 工具
    if (this._mcpRegistry.size > 0) {
      this._rebuildMcpTools();
    }

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
    // 基于对话上下文计算 user_id，用于 DeepSeek 缓存隔离。
    //
    // 群聊模式：使用 room_id 作为缓存键，因为所有房间消息共享同一份历史
    //   (rooms/<room_id>/messages.jsonl)，按 room 隔离可最大化缓存命中率。
    //   格式：room__<room_id>__<receiver>
    //
    // 1:1 模式：使用 sender/receiver 对作为缓存键，每个对话对独立命名空间，
    //   避免多 Agent 场景下缓存互相污染。格式：<sender>__<receiver>
    //
    // __ 分隔符：满足 API 正则 [a-zA-Z0-9\-_]+ 且极少与 agent ID 冲突。
    this._conversationUserId = ctx.room_id
      ? `room__${ctx.room_id}__${ctx.receiver}`
      : `${ctx.sender}__${ctx.receiver}`;
    this._conversationSender = ctx.sender;
    this._emit('chat.start', '', {
      agent: this.agentId,
      sender: ctx.sender,
      hint: ctx.currentMessage?.content,  // trigger 场景：<trigger>hint</trigger>，供前端渲染系统消息
    });

    // 注入 Agent 级运行时配置覆盖（提取命名空间键）
    ctx.runtimeConfig = extractNamespaceConfig(this.config);
    ctx.agentConfig = this.config;

    // 注入可用工具概览（供 agent-prompt 等 PreHook 使用）
    ctx.availableTools = Array.from(this.tools.values()).map(t => ({
      name: t.definition.function.name,
      displayName: t.label,
      description: t.description ?? '',
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
      // 持久化元数据和管理器引用，供 reload() 时重建 MCP 工具
      this._mcpRegistry.clear();
      for (const [toolName, meta] of Object.entries(mcpMeta.toolMap)) {
        this._mcpRegistry.set(toolName, { serverName: meta.serverName, tool: meta.tool });
      }
      this._mcpManager = mcpMeta.manager;
      // 注册 MCP 工具为可执行 Tool
      this._rebuildMcpTools();
    }

    // 过滤 error 消息（不传给 LLM）
    const history = (processedCtx.history || []).filter(m => m.role !== 'error');
    const messages: Message[] = [{ role: 'system', content: processedCtx.systemPrompt }, ...history];
    if (processedCtx.currentMessage) messages.push(processedCtx.currentMessage);
    const loopMessages: Message[] = [];
    const toolDefs: ToolDefinition[] = Array.from(this.tools.values()).map(t => t.definition);

    let content: string;
    let interrupted: boolean;

    try {
      ({ content, interrupted } = await this.executeLoop(
        messages, loopMessages, toolDefs, options?.deepThink, signal, options?.maxTurns
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
        this._emit('chat.message.error', errMsg, { role: 'error', content: errMsg });
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
        const errMsg = token.error ?? 'LLM 调用失败';
        logger.error(`[Agent] ${this.agentId} LLM 错误: ${errMsg}`);
        this._emit('chat.message.error', errMsg, { role: 'error', content: errMsg });
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
                  this._emit('chat.tool_execution.update', delta, { tool_call_id: tc.id, delta, partial });
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

      const toolMsg: Message = {
        role: 'tool', content,
        // tc.id 由 SSE 解析器保证非空（缺失时使用 call_idx_N），
        // 与 assistant.tool_calls 来自同一源头，必定匹配。
        tool_call_id: tc.id || `call_idx_${tc.name || 'unknown'}`,
        name: tc.name,
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

  /**
   * 从 _mcpRegistry 重建 MCP 工具到 this.tools。
   *
   * 调用场景：
   *   1. run() 中首次注册 MCP 工具
   *   2. reload() 后恢复被 clear() 清除的 MCP 工具
   *
   * MCP 工具的 execute 闭包通过 this._mcpManager 动态获取当前管理器，
   * 而非捕获构造时的管理器引用，确保 reload() 重建管理器后工具仍可正常调用。
   */
  private _rebuildMcpTools(): void {
    if (!this._mcpManager || this._mcpRegistry.size === 0) return;

    for (const [toolName, { serverName, tool: mcpTool }] of this._mcpRegistry) {
      if (this.tools.has(toolName)) continue; // 不覆盖已有同名工具（如静态工具）

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
        label: `[MCP:${serverName}] ${toolName}`,
        name: toolName, ns: 'tool.' + toolName,
        description: mcpTool.description,
        execute: async (args: Record<string, any>) => {
          // 动态获取当前 MCP 管理器（reload() 可能已更新管理器实例）
          const mgr = this._mcpManager;
          if (!mgr) {
            return `MCP 管理器未初始化`;
          }
          const client = mgr.getClient(serverName);
          if (!client) {
            return `MCP 服务器 "${serverName}" 未连接`;
          }
          return await client.callTool(toolName, args);
        },
      };
      this.tools.set(toolName, mcpToolObj);
    }

    logger.info(`[Agent] 已注册 ${this._mcpRegistry.size} 个 MCP 工具`);
  }

  // ============================================================
  // 电话模式入口
  // ============================================================

  /**
   * 接收消息并返回 Agent 响应。
   *
   * 串行化保证：同一时刻只允许一个 ReAct 循环运行。
   * 如果 Agent 正在执行，消息会被放入队列，按 FIFO 顺序依次处理。
   * 调用方会被阻塞（await）直到轮到该消息执行。
   *
   * 队列满时返回错误而非无限排队，防止内存泄漏。
   */
  async receive(message: AgentMessage, signal?: AbortSignal): Promise<AgentResult> {
    // 已在执行中 → 入队等待（房间消息/用户消息）
    if (this._isExecuting) {
      // ---- 死锁防护：send_agent 调用（type='request'）目标忙时立即拒绝 ----
      // send_agent 是 await 阻塞调用，如果 A 和 B 互相 send_agent，双方都会
      // 排队等待对方响应，形成循环等待死锁。直接拒绝让调用方的 LLM 看到错误
      // 后自行决定重试或换策略。
      if (message.type === 'request') {
        logger.info(
          `[Agent] "${this.agentId}" 正忙，拒绝 send_agent 请求 (from: ${message.from})`
        );
        return {
          content: `[Agent] "${this.agentId}" 当前正忙，无法处理来自 "${message.from}" 的 send_agent 请求。请稍后重试，或改用 send_to_room 在群聊中沟通。`,
          interrupted: false,
        };
      }

      if (this._executionQueue.length >= Agent.MAX_QUEUE_SIZE) {
        logger.warn(
          `[Agent] "${this.agentId}" 执行队列已满 (${Agent.MAX_QUEUE_SIZE})，` +
          `拒绝新消息 (from: ${message.from}, type: ${message.type})`
        );
        return {
          content: `[Agent] "${this.agentId}" 正忙，执行队列已满。请稍后重试。`,
          interrupted: false,
        };
      }

      logger.info(
        `[Agent] "${this.agentId}" 正忙，消息入队 (from: ${message.from})，` +
        `队列深度: ${this._executionQueue.length + 1}`
      );

      return new Promise<AgentResult>((resolve, reject) => {
        // 支持 signal 提前取消排队。
        // 先入队再检查 abort 状态：确保 onAbort 回调触发时条目一定已在队列中。
        let onAbort: (() => void) | undefined;

        const entry = { message, signal, resolve, reject, onAbort: undefined as (() => void) | undefined };
        this._executionQueue.push(entry);

        if (signal) {
          onAbort = () => {
            const idx = this._executionQueue.indexOf(entry);
            if (idx !== -1) {
              this._executionQueue.splice(idx, 1);
              logger.info(
                `[Agent] "${this.agentId}" 队列消息已取消 (from: ${message.from})，` +
                `剩余: ${this._executionQueue.length}`
              );
              reject(new Error('已取消'));
            }
          };
          entry.onAbort = onAbort;

          if (signal.aborted) {
            // 信号已触发 → 直接从队列移除并拒绝
            const idx = this._executionQueue.indexOf(entry);
            if (idx !== -1) this._executionQueue.splice(idx, 1);
            reject(new Error('已取消'));
            return;
          }

          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }

    // 空闲 → 直接执行
    this._isExecuting = true;
    try {
      const result = await this._doReceive(message, signal);
      return result;
    } finally {
      this._isExecuting = false;
      // 当前执行完毕后，处理队列中的下一条消息
      this._processNextInQueue();
    }
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
      room_id: message.room_id,
    };
    return this.run(ctx, { deepThink: message.data?.deepThink }, signal);
  }

  // ============================================================
  // 自主推理入口（无 currentMessage）
  // ============================================================

  /**
   * 触发 Agent 在无 incoming 用户消息的情况下进行自主推理。
   *
   * 与 receive() 的区别：
   *   - 不构造 currentMessage，Agent 仅基于 system prompt + history 推理
   *   - 默认启用 maxTurns=8 防止无限循环
   *   - 不经过 send_agent 死锁保护（type 不为 'request'）
   *
   * 适用场景：定时任务、文件监听回调、Agent 自省、观察者模式。
   */
  async trigger(options?: TriggerOptions, signal?: AbortSignal): Promise<AgentResult> {
    // 已在执行中 → 入队等待
    if (this._isExecuting) {
      // ---- 队列去重：同 source 只保留最新一条 ----
      // 运行中的 trigger 不受影响；队列中已有同 source 的则替换为新条目。
      const source = options?.source;
      if (source) {
        this._coalesceQueuedTrigger(source);
      }

      if (this._executionQueue.length >= Agent.MAX_QUEUE_SIZE) {
        logger.warn(
          `[Agent] "${this.agentId}" 执行队列已满 (${Agent.MAX_QUEUE_SIZE})，` +
          `拒绝 trigger (source: ${options?.source ?? 'unknown'})`
        );
        return {
          content: `[Agent] "${this.agentId}" 正忙，执行队列已满。请稍后重试。`,
          interrupted: false,
        };
      }

      logger.info(
        `[Agent] "${this.agentId}" 正忙，trigger 入队 (source: ${options?.source ?? 'unknown'})，` +
        `队列深度: ${this._executionQueue.length + 1}`
      );

      return new Promise<AgentResult>((resolve, reject) => {
        let onAbort: (() => void) | undefined;

        const entry = {
          triggerOptions: options,
          signal,
          resolve,
          reject,
          onAbort: undefined as (() => void) | undefined,
        };
        this._executionQueue.push(entry);

        if (signal) {
          onAbort = () => {
            const idx = this._executionQueue.indexOf(entry);
            if (idx !== -1) {
              this._executionQueue.splice(idx, 1);
              logger.info(
                `[Agent] "${this.agentId}" 队列 trigger 已取消 (source: ${options?.source ?? 'unknown'})，` +
                `剩余: ${this._executionQueue.length}`
              );
              reject(new Error('已取消'));
            }
          };
          entry.onAbort = onAbort;

          if (signal.aborted) {
            const idx = this._executionQueue.indexOf(entry);
            if (idx !== -1) this._executionQueue.splice(idx, 1);
            reject(new Error('已取消'));
            return;
          }

          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }

    // 空闲 → 直接执行
    this._isExecuting = true;
    try {
      const result = await this._doTrigger(options, signal);
      return result;
    } finally {
      this._isExecuting = false;
      this._processNextInQueue();
    }
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
      target: options?.target,
    };

    return this.run(ctx, {
      deepThink: options?.deepThink,
      maxTurns: options?.maxTurns ?? 8,
    }, signal);
  }

  /**
   * 队列 trigger 去重：移除队列中同 source 的旧条目，只保留即将入队的最新一条。
   *
   * 运行中的 trigger 不受影响，仅清理尚未执行的排队条目。
   * 被替换的旧条目会以空结果 resolve，避免调用方无限等待。
   */
  private _coalesceQueuedTrigger(source: string): void {
    for (let i = this._executionQueue.length - 1; i >= 0; i--) {
      const entry = this._executionQueue[i];
      if (entry.triggerOptions?.source === source) {
        // 清理旧条目的 signal 监听器，防止内存泄漏
        if (entry.onAbort && entry.signal) {
          entry.signal.removeEventListener('abort', entry.onAbort);
        }
        entry.resolve({ content: '', interrupted: false });
        this._executionQueue.splice(i, 1);
        logger.info(
          `[Agent] "${this.agentId}" 队列 trigger 合并 (source: ${source})，` +
          `队列剩余: ${this._executionQueue.length}`
        );
      }
    }
  }

  /** 处理队列中的下一条消息 */
  private _processNextInQueue(): void {
    // 跳过已取消的条目（清理残留的 signal 监听器）
    while (this._executionQueue.length > 0) {
      const next = this._executionQueue.shift()!;

      // 清理 AbortSignal 监听器，防止内存泄漏
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener('abort', next.onAbort);
      }

      // 如果 signal 已触发 abort → 跳过此条目
      if (next.signal?.aborted) {
        next.reject(new Error('已取消'));
        continue;
      }

      // 正常执行：根据条目类型分发
      this._isExecuting = true;

      if (next.triggerOptions) {
        // ---- trigger 模式 ----
        logger.info(
          `[Agent] "${this.agentId}" 从队列取出 trigger (source: ${next.triggerOptions.source ?? 'unknown'})，` +
          `队列剩余: ${this._executionQueue.length}`
        );
        this._doTrigger(next.triggerOptions, next.signal)
          .then(next.resolve)
          .catch(next.reject)
          .finally(() => {
            this._isExecuting = false;
            this._processNextInQueue();
          });
      } else if (next.message) {
        // ---- receive 模式 ----
        logger.info(
          `[Agent] "${this.agentId}" 从队列取出消息 (from: ${next.message.from})，` +
          `队列剩余: ${this._executionQueue.length}`
        );
        this._doReceive(next.message, next.signal)
          .then(next.resolve)
          .catch(next.reject)
          .finally(() => {
            this._isExecuting = false;
            this._processNextInQueue();
          });
      } else {
        // 无效条目（既非 receive 也非 trigger）
        next.reject(new Error('队列条目缺少 message 或 triggerOptions'));
        this._isExecuting = false;
        continue;
      }
      return;
    }
    // 队列为空 → 回到空闲状态
  }
}
