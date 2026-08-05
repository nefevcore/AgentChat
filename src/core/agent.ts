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
  LLMRequestMessage,
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
import { setCurrentAgentAllowedPaths, clearCurrentAgentAllowedPaths, getGlobalConfig } from './config';
import { getAppState } from './app-state';
import { logger } from '../utils/logger';
import { AgentExecutionQueue } from './agent-queue';
import * as path from 'path';
import { discoverTools, reloadGlobalExtensions } from '@discovery/agent-loader';
import type { AgentRegistry } from '@routing/registry';
import {
  InterruptReason,
  ToolInterrupt,
  isToolInterrupt,
  describeInterrupt,
} from './interrupt';

// ============================================================
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
// 会话运行态（RunSession）—— 会话级并行改造（2026-08-05）
//
// 一个 Agent 实例可同时处理多个会话（1:1 不同对方 / 群聊）。
// 此前这些状态是实例级的（_conversationSender 等），导致串行队列阻塞：
//   一个 Agent 同一时刻只能处理一个会话，其他会话排队。
// 现在状态按会话隔离（Map<convKey, RunSession>），各会话独立执行、互不阻塞。
//
// convKey 标识会话：
//   1:1  → `${sender}__${agentId}`
//   群聊 → `group__${groupId}__${agentId}`
// ============================================================
interface RunSession {
  /** 会话键（唯一标识一个会话） */
  convKey: string;
  /** 当前会话对方（sender） */
  sender: string;
  /** DeepSeek 缓存隔离 user_id（格式 <sender>__<receiver>） */
  userId: string;
  /** 转向消息队列：用户/其他 Agent 中途插入的指令（按会话隔离） */
  steeringQueue: Message[];
  /** 本轮累计 Token 用量（per-session） */
  cumulativeUsage?: LLMUsage;
  /** 当前运行 AbortController（优雅关闭/重启时 abort） */
  abortController: AbortController | null;
  /** 当前轮事件关联 ID */
  cid: string;
  /** 本轮 thinking 开始时间（毫秒） */
  thinkingStartTime: number;
}

// ============================================================
// Agent
// ============================================================

export class Agent {
  readonly config: AgentConfig;

  get agentId(): string { return this.config.agent_id; }
  get name(): string { return this.config.name; }

  /** 获取当前 LLM 提供者（供 SubAgentManager 共享给子 Agent） */
  getLLM(): LLMProvider | null { return this.llm; }

  /** 获取全部已注册工具（供 SubAgentManager 筛选子 Agent 工具集） */
  getTools(): Map<string, Tool> { return this.tools; }

  private llm: LLMProvider | null = null;
  /** 展开后的 LLM 配置（bootstrap 注入，含 $ref 解析后的完整 provider/model） */
  private _llmConfig?: LLMConfig;
  private tools: Map<string, Tool> = new Map();
  private preHooks: PreProcessHook[] = [];
  private postHooks: PostProcessHook[] = [];
  private toolInterceptors: ToolInterceptor[] = [];
  /** 事件总线（由外部注入，如 Router），Agent 通过它发射实时事件 */
  private _eventBus?: EventEmitter;
  /**
   * 会话级运行态（v0.4.12 并行改造）：一个 Agent 可同时处理多个会话，
   * 各会话状态隔离（sender/userId/steering/usage/abort/cid 互不干扰）。
   */
  private _sessions = new Map<string, RunSession>();
  /** 每个会话独立执行队列（串行保证同会话顺序，跨会话并行） */
  private _sessionQueues = new Map<string, AgentExecutionQueue>();
  /** 当前正在执行的会话（仅 continueTurn 默认 target 用，并行时指向最近启动的会话） */
  private _activeSession: RunSession | null = null;

  // ============================================================

  /** 中止当前运行（供优雅关闭/重启调用）—— 并行后中止所有活跃会话 */
  abort(): void {
    for (const s of this._sessions.values()) s.abortController?.abort();
  }

  /**
   * 自我继续：触发自己基于当前会话上下文进行下一轮推理（自我 steer）。
   * 调用后当前 turn 结束即自动开始下一轮（trigger 入队），不阻塞当前执行。
   * @param counterpart 会话对方（缺省用当前对话的 sender）
   * @param hint 可选提示（注入为触发消息，引导下一轮方向）
   */
  continueTurn(counterpart?: string, hint?: string): void {
    try {
      const state = getAppState();
      const router = (state as any).router as { trigger: (id: string, opts?: Record<string, unknown>) => Promise<string> } | undefined;
      if (!router) {
        logger.warn(`[Agent] "${this.agentId}" continueTurn 失败：Router 未注册`);
        return;
      }
      const target = counterpart || this._activeSession?.sender || 'user';
      const opts: Record<string, unknown> = {
        target,
        source: `continue:${this.agentId}`,
        maxTurns: 0,
        selfContinue: true,
      };
      if (hint) opts.hint = hint;
      // 异步触发：当前 turn 结束后队列自动执行下一轮
      void router.trigger(this.agentId, opts);
      logger.info(`[Agent] "${this.agentId}" 自我继续（target=${target}${hint ? `, hint=${hint}` : ''}）`);
    } catch (err: any) {
      logger.warn(`[Agent] "${this.agentId}" continueTurn 异常: ${err.message}`);
    }
  }

  /** 会话级执行队列（每会话独立，见 _queueFor） */

  /** reload 后需重新 applyPreHooks + 注册 MCP（外层 run 循环检测） */
  private _needsReinit = false;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /** 注入转向消息：Agent 在下一轮 LLM 调用前将其作为用户消息注入上下文（按会话路由） */
  steer(message: Message, convKey?: string): void {
    // 无显式 convKey 时从 message.agent_id 推导（WebUI 转向恒为 viewerId → Agent）
    const key = convKey || this._convKeyFor(message.agent_id || 'user');
    const session = this._getOrCreateSession(key, message.agent_id || 'user');
    session.steeringQueue.push(message);
  }

  /** 会话键：1:1 `${sender}__${agentId}`；群聊 `group__${gid}__${agentId}` */
  private _convKeyFor(sender: string, groupId?: string): string {
    return groupId ? `group__${groupId}__${this.agentId}` : `${sender}__${this.agentId}`;
  }

  /** 获取/创建会话运行态 */
  private _getOrCreateSession(convKey: string, sender: string): RunSession {
    let s = this._sessions.get(convKey);
    if (!s) {
      s = {
        convKey,
        sender,
        userId: '',
        steeringQueue: [],
        cumulativeUsage: undefined,
        abortController: null,
        cid: '',
        thinkingStartTime: 0,
      };
      this._sessions.set(convKey, s);
    } else {
      s.sender = sender;
    }
    return s;
  }

  /** 获取/创建会话级执行队列（每会话独立串行，跨会话并行） */
  private _queueFor(convKey: string): AgentExecutionQueue {
    let q = this._sessionQueues.get(convKey);
    if (!q) {
      q = new AgentExecutionQueue(this.agentId, 32, {
        doReceive: (msg, sig) => this._doReceive(msg, sig),
        doTrigger: (opts, sig) => this._doTrigger(opts, sig),
      });
      this._sessionQueues.set(convKey, q);
    }
    return q;
  }

  // ---- 配置 ----

  setLLM(llm: LLMProvider): this { this.llm = llm; return this; }

  /** 注入展开后的 LLM 配置（含池 $ref 解析结果），供扩展读取 provider/model */
  setLLMConfig(config?: LLMConfig): this { this._llmConfig = config; return this; }

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

  /** 获取当前已注册工具的名称列表 */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * 执行热重载（reload-requested 中断的实际执行体）。
   * 在 run() 的 postHook 之后调用：消息已落盘，重载 preHooks/tools 安全。
   */
  async performReload(scope: 'self' | 'global' | 'all'): Promise<void> {
    const state = getAppState();
    const registry = state.registry as AgentRegistry | undefined;

    if (scope === 'self' || scope === 'all') {
      // ---- self：重载自己的 tools/ ----
      try {
        const agent = registry?.getAgent(this.agentId) as Agent | undefined;
        const toolsDir = path.join(getGlobalConfig().agentsDir, this.agentId, 'tools');
        const discovered = discoverTools(toolsDir);
        const currentNames = new Set(this.getToolNames());
        const newTools: string[] = [];
        const updatedTools: string[] = [];
        for (const [name, t] of discovered) {
          if (currentNames.has(name)) updatedTools.push(name);
          else newTools.push(name);
          this.registerTool(t);
        }
        logger.info(`[reload] self ${this.agentId}: +${newTools.length} new, ~${updatedTools.length} updated`);
      } catch (err: any) {
        logger.error(`[reload] self ${this.agentId} 失败: ${err.message}`);
      }

      // ---- self：重装装配清单（config.tools 按角色过滤）----
      // 使 update_agent_profile 修改 tools/tags 后 reload(self) 立即生效。
      // 复用 AgentLoader.loadOne 的装配逻辑（按 requires 匹配 tags 注入）。
      try {
        const loader = (state as any).loader as { loadOne?: (dir: string) => any } | undefined;
        const agentsDir = getGlobalConfig().agentsDir;
        const loaded = loader?.loadOne?.(path.join(agentsDir, this.agentId));
        if (loaded) {
          this.reload({
            config: loaded.config,
            tools: loaded.tools,
            preHooks: loaded.preHooks,
            postHooks: loaded.postHooks,
            interceptors: loaded.interceptors,
          });
          // 精确替换装配清单：移除 config.tools 中已删除的工具（update_agent_profile 场景）。
          // v0.4.10：无 autoInject 工具，全部工具由 loadOne 按 requires 匹配 tags 注入，直接替换。
          const loadedNames = new Set(
            (loaded.tools as Array<{ definition: { function: { name: string } } }>).map(
              (t) => t.definition.function.name
            )
          );
          for (const name of [...this.getToolNames()]) {
            if (!loadedNames.has(name)) {
              this.tools.delete(name);
            }
          }
          logger.info(`[reload] self ${this.agentId} 装配清单重装完成：${loaded.tools.length} tools`);
        }
      } catch (err: any) {
        logger.error(`[reload] self ${this.agentId} 装配清单重装失败: ${err.message}`);
      }
    }

    if (scope === 'global' || scope === 'all') {
      // ---- global：重载全局扩展 + 工具 ----
      try {
        const agentMap = state.agentMap as Map<string, Agent> | undefined;
        const srcRoot = state.srcRoot as string | undefined;
        if (!agentMap || agentMap.size === 0 || !srcRoot) {
          throw new Error('没有运行中的 Agent 或 srcRoot，无法热加载');
        }
        const globalDir = path.join(srcRoot, 'global');
        const { extensions, interceptors, tools } = reloadGlobalExtensions(globalDir);

        for (const [agentId, agent] of agentMap) {
          const config = (agent as any).config;
          if (!config) continue;
          const preHookNames: string[] = config.pre_hooks ?? [];
          const postHookNames: string[] = config.post_hooks ?? [];
          const newPreHooks = preHookNames
            .map((name: string) => extensions.get(name)?.preHook)
            .filter((h): h is NonNullable<typeof h> => h != null);
          const newPostHooks = postHookNames
            .map((name: string) => extensions.get(name)?.postHook)
            .filter((h): h is NonNullable<typeof h> => h != null);
          const currentToolNames = agent.getToolNames();
          const allNewTools: any[] = [];
          const currentToolsMap: Map<string, any> = (agent as any).tools;
          for (const name of currentToolNames) {
            const newTool = tools.get(name);
            if (newTool) allNewTools.push(newTool);
            else {
              const oldTool = currentToolsMap?.get(name);
              if (oldTool) allNewTools.push(oldTool);
            }
          }
          agent.reload({ config, tools: allNewTools, preHooks: newPreHooks, postHooks: newPostHooks, interceptors });
        }
        logger.info(`[reload] global: ${agentMap.size} agents, ${tools.size} tools, ${extensions.size} ext`);
      } catch (err: any) {
        logger.error(`[reload] global 失败: ${err.message}`);
      }
    }
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
      correlation_id: this._activeSession?.cid,
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

    // ---- 会话级并行：创建/获取本会话运行态，所有状态按会话隔离 ----
    const convKey = this._convKeyFor(ctx.sender, ctx.group_id);
    const session = this._getOrCreateSession(convKey, ctx.sender);
    session.userId = ctx.group_id
      ? `group__${ctx.group_id}__${ctx.receiver}`
      : `${ctx.sender}__${ctx.receiver}`;
    session.cid = `agent-${this.agentId}-${Date.now()}`;
    session.cumulativeUsage = undefined;
    session.thinkingStartTime = 0;
    this._activeSession = session;

    // 记录当前运行的 AbortController（供优雅关闭 abort()），并合并外部 signal
    const ctrl = new AbortController();
    if (signal) {
      const ext = signal;
      // 外部 abort → 同步中止内部 controller。try-catch 防止 abort 链上的
      // 监听器异常（如 LLM reader.cancel）逃逸为 uncaught 崩溃进程。
      const onAbort = () => { try { ctrl.abort(); } catch { /* abort 链异常吞掉 */ } };
      if (ext.aborted) onAbort();
      else ext.addEventListener('abort', onAbort, { once: true });
    }
    session.abortController = ctrl;
    const runSignal = ctrl.signal;
    this._emit('chat.start', '', {
      agent: this.agentId,
      sender: ctx.sender,
      hint: ctx.currentMessage?.content,
      // C1：显式下发 trigger 标记（前端不再用正文 <trigger> 嗅探判定）
      isTrigger: ctx.currentMessage?.role === 'trigger',
    });

    let content = '';
    let interrupted = false;
    let interruptReason: InterruptReason | undefined;
    let firstIteration = true;

    try {
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
      ctx.registerTool = (tool) => { if (!this.tools.has(tool.name)) this.tools.set(tool.name, tool); };

      const processedCtx = await this.applyPreHooks(ctx);


      const history = (processedCtx.history || []).filter(m => m.role !== 'error');
      // LLM 请求消息：持久化格式（role='agent'）+ 内存格式（user/assistant/trigger 等）混合，
      // 由 provider 的 toProviderMessages 依据 assistant=self 统一解析
      const messages: LLMRequestMessage[] = [{ role: 'system', content: processedCtx.systemPrompt }, ...history];
      if (firstIteration && processedCtx.currentMessage) {
        messages.push(processedCtx.currentMessage);
        firstIteration = false;
      }
      const loopMessages: Message[] = [];

      this._needsReinit = false;

      try {
        ({ content, interrupted, interruptReason } = await this.executeLoop(
          session, messages, loopMessages, options?.deepThink, runSignal, options?.maxTurns
        ));
      } catch (err: any) {
        content = `Agent 执行异常：${err.message}`;
        interrupted = false;
        interruptReason = undefined;
      }

      processedCtx.loopMessages = loopMessages;
      processedCtx.cumulativeUsage = session.cumulativeUsage;
      await this.applyPostHooks(processedCtx, content);

      // ---- 响应语义化中断（postHook 之后，保证消息先落盘）----
      // 1. reload：执行重载后 reinit 继续（Agent 用新工具继续推理），
      //    同时清空 currentMessage —— 下一轮 postHook 不再重复存档 user 消息（空=不存档）
      // 2. restart：postHook 已落盘，安全退出进程
      // 3. 其余中断：结束本轮
      if (interruptReason) {
        switch (interruptReason.type) {
          case 'reload-requested': {
            await this.performReload(interruptReason.scope);
            logger.info(`[Agent] "${this.agentId}" reload 完成（${interruptReason.scope}），reinit 继续`);
            // 关键：user 消息已由本轮 postHook 存档，清空防下轮重复持久化
            ctx.currentMessage = undefined;
            this._needsReinit = true;
            break;
          }
          case 'restart-requested': {
            logger.notice(`[Agent] "${this.agentId}" 请求重启（${interruptReason.reason ?? 'tool-restart'}），postHook 已落盘`);
            // 先通知路由进入重启模式：新消息入队 pending（落盘），
            // 重启后 flushPendingMessages 重投 —— 重启期间不丢消息，会话立即恢复
            try {
              const state = getAppState();
              const router = (state as any).router;
              if (router?.enterRestartMode) {
                router.enterRestartMode();
                logger.info(`[Agent] "${this.agentId}" 已通知 Router 进入重启模式，重启期间消息入队 pending`);
              }
              // 塞一条"继续会话"trigger：重启后 flush 重投 → Agent 自动继续对话
              // from 用当前会话对象（ctx.sender），保证重启后会话上下文正确（sender=对方）
              if (router?.enqueuePending && ctx.sender) {
                router.enqueuePending({
                  from: ctx.sender,
                  to: this.agentId,
                  type: 'trigger' as any,
                  payload: `系统已重启完成。请基于对话历史继续（重启前你请求了重启${interruptReason.reason ? `：${interruptReason.reason}` : ''}）。`,
                  correlation_id: `restart-continue-${Date.now()}`,
                });
                logger.info(`[Agent] "${this.agentId}" 已入队"继续会话"消息（from=${ctx.sender}），重启后自动恢复`);
              }
            } catch (err: any) {
              logger.warn(`[Agent] 通知 Router 进入重启模式失败: ${err.message}`);
            }
            const { requestRestart } = await import('./shutdown.js');
            requestRestart(interruptReason.reason ?? `agent-${this.agentId}-restart`);
            break;
          }
          default:
            break;
        }
        // reload 走 reinit 继续；其余中断结束本轮
        if (interruptReason.type !== 'reload-requested') break;
      }

      if (!this._needsReinit) break;
      session.cumulativeUsage = undefined;
    }
    } finally {
      // 清空未消费的转向消息：会话结束（含 abort/异常）后，残留的 steer
      // 消息属于已终止的上下文，若不清理会在下次 run 时重复注入，导致
      // 用户看到旧指令被再次处理、消息重复持久化。
      session.abortController = null;
      if (session.steeringQueue.length > 0) {
        logger.info(`[Agent] "${this.agentId}" 会话结束，丢弃 ${session.steeringQueue.length} 条未消费转向消息`);
        session.steeringQueue = [];
      }
    }

    this._emit('chat.end', content, { interrupted, interruptReason });
    return { content, interrupted, interruptReason };
  }

  private async executeLoop(
    session: RunSession,
    messages: LLMRequestMessage[],
    loopMessages: Message[],
    deepThink: boolean | undefined,
    signal?: AbortSignal,
    maxTurns?: number,
  ): Promise<{ content: string; interrupted: boolean; interruptReason?: InterruptReason }> {
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
      if (maxTurns && turn > maxTurns) {
        logger.info(
          `[Agent] "${this.agentId}" 自主推理达到最大轮次 ${maxTurns}，强制终止`
        );
        return {
          content: `达到最大推理轮次 (${maxTurns})，已自动终止。`,
          interrupted: true,
          interruptReason: { type: 'max-turns' },
        };
      }
      // 注入待处理的转向消息（用户/其他 Agent 中途插入的指令，按会话隔离）
      const steering = session.steeringQueue.splice(0);
      if (steering.length > 0) {
        for (const msg of steering) {
          messages.push(msg);
          loopMessages.push(msg);
        }
      }

      this._emit('chat.turn.start', '', { agent: this.agentId, sender: session.sender });

      // 每轮从 this.tools 重新生成工具定义快照，支持运行时热注册新工具（如 reload）
      const toolDefs: ToolDefinition[] = Array.from(this.tools.values()).map(t => t.definition);
      // viewer=当前视角 Agent ID（self）：provider 依据它把持久化格式消息（role='agent'）
      // 做视角转换（agent_id===viewer → assistant；≠viewer → user）
      const req: LLMRequest = {
        messages, tools: toolDefs.length > 0 ? toolDefs : undefined,
        thinking: deepThink,
        userId: session.userId, viewer: this.agentId,
      };
      let resp: LLMResponse;

      try {
        resp = await this.streamLLM(session, req, signal);
        // 网络调用成功：通知恢复（若在 down 模式，会重投入队消息）
        try {
          const state = getAppState();
          const router = (state as any).router as { notifyNetworkRecover?: () => Promise<number> } | undefined;
          if (router?.notifyNetworkRecover) void router.notifyNetworkRecover();
        } catch { /* 通知失败不影响主流程 */ }
      } catch (llmErr: any) {
        const errMsg = llmErr.message || String(llmErr);
        logger.error(`[Agent] ${this.agentId} LLM 调用失败: ${errMsg}`);
        // 网络类错误 → 通知 Router 进入网络失效模式（连续多次才生效）
        if (isNetworkError(llmErr)) {
          try {
            const state = getAppState();
            const router = (state as any).router as { notifyNetworkError?: () => void } | undefined;
            router?.notifyNetworkError?.();
          } catch { /* 通知失败不影响主流程 */ }
        }
        // 记录 error 消息到持久化存储
        const errorMessage: Message = { role: 'error', content: errMsg };
        messages.push(errorMessage);
        loopMessages.push(errorMessage);
        this._emit('chat.message.error', errMsg, { role: 'error', content: errMsg, sender: session.sender });
        return { content: `LLM 错误: ${errMsg}`, interrupted: false };
      }

      const result = await this.processTurn(session, resp, messages, loopMessages, signal);

      this._emit('chat.turn.end', resp.content ?? '', {
        content: resp.content,
        reasoning: resp.reasoning,
        interrupted: result.interrupted ?? undefined,
        interruptReason: result.interruptReason,
        agent: this.agentId,
        sender: session.sender,
      });

      if (result.done) {
        return { content: result.final ?? '', interrupted: result.interrupted ?? false, interruptReason: result.interruptReason };
      }
    }
  }

  private async processTurn(
    session: RunSession,
    resp: LLMResponse,
    messages: LLMRequestMessage[],
    loopMessages: Message[],
    signal?: AbortSignal
  ): Promise<{ done: boolean; interrupted?: boolean; final?: string; interruptReason?: InterruptReason }> {
    if (signal?.aborted && (resp.content || resp.reasoning)) {
      this.recordAssistant(session, resp, messages, loopMessages, true);
      return { done: true, interrupted: true, final: resp.content || '', interruptReason: { type: 'user-abort' } };
    }

    if (resp.toolCalls.length === 0 || resp.finishReason === 'stop') {
      this.recordAssistant(session, resp, messages, loopMessages);
      return { done: true, final: resp.content ?? '' };
    }

    this.recordAssistant(session, resp, messages, loopMessages);

    const { interrupted, interruptReason } = await this.runTools(
      session, resp.toolCalls, messages, loopMessages, signal
    );
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

  private async streamLLM(
    session: RunSession,
    req: LLMRequest,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    // 无事件总线 → 非流式，只取结果
    if (!this._eventBus) {
      const resp = await this.llm!.chat(req, signal);
      this._accumulateUsage(session, resp.usage);
      return resp;
    }

    session.thinkingStartTime = 0;
    const stream = this.llm!.stream(req, signal);
    for await (const token of stream) {
      const t = token.type;
      if (t === 'thinking_start') {
        session.thinkingStartTime = Date.now();
        this._emit('chat.thinking.start', '', { label: '思考中...', sender: session.sender });
      } else if (t === 'thinking_update') {
        this._emit('chat.thinking.update', token.delta ?? '', { delta: token.delta, sender: session.sender });
      } else if (t === 'thinking_end') {
        this._emit('chat.thinking.end', '', { label: thinkingLabel(undefined, Date.now() - session.thinkingStartTime), sender: session.sender });
      } else if (t === 'toolcall_start') {
        this._emit('chat.toolcall.start', '', { sender: session.sender,
          index: token.toolCall?.index, name: token.toolCall?.name,
        });
      } else if (t === 'toolcall_update') {
        this._emit('chat.toolcall.update', token.delta ?? '', { sender: session.sender,
          index: token.toolCall?.index, delta: token.delta,
        });
      } else if (t === 'toolcall_end') {
        this._emit('chat.toolcall.end', '', { sender: session.sender,
          index: token.toolCall?.index, name: token.toolCall?.name,
          arguments: token.toolCall?.arguments,
        });
      } else if (t === 'error') {
        const errMsg = token.error ?? 'LLM 调用失败';
        logger.error(`[Agent] ${this.agentId} LLM 错误: ${errMsg}`);
        this._emit('chat.message.error', errMsg, { role: 'error', content: errMsg });
      } else if (t === 'message_start') {
        this._emit('chat.message.start', '', { sender: session.sender });
      } else if (t === 'message_update') {
        this._emit('chat.message.update', token.delta ?? '', { delta: token.delta, sender: session.sender });
      } else if (t === 'message_end') {
        this._emit('chat.message.end', token.partial.content, { sender: session.sender });
      }
    }

    // 错误已通过流协议传递，result() 返回的 LLMResponse 已包含 finishReason。
    // provider 遵守"错误进流"契约 → 此处不需要 try-catch。
    const resp = await stream.result();
    this._accumulateUsage(session, resp.usage);
    return resp; 
  }

  // ---- 工具执行 ----

  private async runTools(
    session: RunSession,
    toolCalls: ToolCall[],
    messages: LLMRequestMessage[],
    loopMessages: Message[],
    signal?: AbortSignal
  ): Promise<{ interrupted: boolean; interruptReason?: InterruptReason }> {
    // 并行执行所有工具调用（LLM 在同一轮返回的 tool_calls 彼此独立）
    const results = await Promise.all(toolCalls.map(async (tc) => {
      if (signal?.aborted) return { tc, content: '', label: tc.name, tool: null as Tool | null, interrupt: { type: 'user-abort' } as InterruptReason };

      const tool = this.tools.get(tc.name);
      this._emit('chat.tool_execution.start', '', { sender: session.sender, tool_name: tc.name, arguments: tc.arguments, tool_call_id: tc.id, label: tool ? toolLabel(tool, tc.arguments) : tc.name });

      let content = '';
      let details: any;
      let interrupt: InterruptReason | undefined;

      try {
        if (!tool) {
          content = JSON.stringify({ status: 'error', data: { message: `未找到工具：${tc.name}` } });
        } else {
          // ---- Tool Interceptor 管道 ----
          let interceptCtx: ToolInterceptContext = {
            agentId: this.agentId,
            sender: session.sender || undefined,
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
                  this._emit('chat.tool_execution.update', delta, { sender: session.sender, tool_call_id: tc.id, delta, partial });
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
          logger.info(`[Agent] "${this.agentId}" 工具 ${tc.name} 发出中断请求: ${err.reason.type}`);
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
        messages.push(interruptMsg);
        loopMessages.push(interruptMsg);
        this._emit('chat.tool_execution.end', interruptContent, { sender: session.sender, tool_call_id: tc.id, result: interruptContent, details });
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
      messages.push(toolMsg);
      loopMessages.push(toolMsg);
      this._emit('chat.tool_execution.end', content, { sender: session.sender, tool_call_id: tc.id, result: content, details });
    }

    const aborted = signal?.aborted ?? false;
    return {
      interrupted: interruptReason !== undefined || aborted,
      interruptReason: interruptReason ?? (aborted ? { type: 'user-abort' } : undefined),
    };
  }

  // ---- 消息记录 ----

  private recordAssistant(session: RunSession, resp: LLMResponse, messages: LLMRequestMessage[], loopMessages: Message[], interrupted = false): void {
    const msg: Message = {
      role: 'assistant',
      content: interrupted ? (resp.content || '(已被中断)') : (resp.content ?? ''),
      tool_calls: interrupted ? undefined : (resp.toolCalls.length > 0 ? resp.toolCalls : undefined),
      reasoning_content: resp.reasoning || undefined,
      label: thinkingLabel(resp.reasoning, session.thinkingStartTime ? Date.now() - session.thinkingStartTime : undefined),
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
  private _accumulateUsage(session: RunSession, usage: LLMUsage | undefined): void {
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

  // ============================================================
  // ============================================================
  // 电话模式 / 自主推理入口（委托给执行队列）
  // ============================================================

  async receive(message: AgentMessage, signal?: AbortSignal): Promise<AgentResult> {
    // 会话级并行：按会话路由到独立队列（同会话串行，跨会话并行）
    const convKey = this._convKeyFor(message.from, message.group_id);
    return this._queueFor(convKey).receive(message, signal);
  }

  /** 执行具体的 receive 逻辑：统一委托给 trigger，receive 即带消息的 trigger */
  private async _doReceive(message: AgentMessage, signal?: AbortSignal): Promise<AgentResult> {
    return this._doTrigger({
      hint: message.payload,
      target: message.from,
      source: `receive:${message.from}`,
      group_id: message.group_id,
      deepThink: message.data?.deepThink,
      // receive 不设轮次上限（maxTurns=0 表示无限制）
      maxTurns: 0,
      // receive 消息不包裹 <trigger> 标签，避免 Agent 误以为是系统触发
      wrapHint: false,
    }, signal);
  }

  async trigger(options?: TriggerOptions, signal?: AbortSignal): Promise<AgentResult> {
    // 会话级并行：target 即会话对方（trigger 的 sender），按会话路由到独立队列
    const sender = options?.target ?? this.agentId;
    const convKey = this._convKeyFor(sender, options?.group_id);
    return this._queueFor(convKey).trigger(options, signal);
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
    const wrap = options?.wrapHint !== false; // 默认 true，receive 路径显式传 false
    const ctx: AgentContext = {
      sender: options?.target ?? this.agentId,
      receiver: this.agentId,
      systemPrompt: '',
      history: [],
      currentMessage: options?.hint
        ? {
            // 2026-08-02：trigger 成为一等内存角色（role='trigger'），
            // 由 LLM provider 的 toProviderMessages 映射为入站 user 提示；
            // 正文 <trigger>…</trigger> 仅为 LLM 渲染约定，不再用于角色判定。
            role: wrap ? 'trigger' : 'user',
            content: wrap ? `<trigger>${options.hint}</trigger>` : options.hint,
          }
        : undefined,
      agentConfig: this.config,
      llm: this.llm ?? undefined,
      llmConfig: this._llmConfig ?? this.config.llm as import('@discovery/config-types').LLMConfig | undefined,
      group_id: options?.group_id,
      target: options?.target,
      archiveReview: options?.archiveReview,
      selfContinue: options?.selfContinue,
    };

    return this.run(ctx, {
      deepThink: options?.deepThink,
      maxTurns: options?.maxTurns,
    }, signal);
  }

}
