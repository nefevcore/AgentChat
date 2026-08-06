// ============================================================
// AgentChat Agent 装配类（§5.1：仅装配，不编排）
//
// Agent 持有可热更组件（llm/tools/hooks/interceptors/事件总线）与会话管理；
// run() 只做装配（pre/post hooks、reload/restart 语义化中断），
// ReAct 编排委托给 ./loop 的纯函数 runLoop(ctx)。
// ============================================================

import { EventEmitter } from 'events';
import {
  AgentContext,
  AgentMessage,
  AgentMessageType,
  AgentResult,
  LLMProvider,
  LLMRequestMessage,
  Message,
  PreProcessHook,
  PostProcessHook,
  Tool,
  ToolDefinition,
  ToolInterceptor,
  TriggerOptions,
  PluginManager,
} from './types';
import { AgentConfig, LLMConfig } from '@core/types';
import { getGlobalConfig } from './config';
import { getAppState } from './app-state';
import { logger } from '@utils/logger';
import { SessionManager, convKeyFor } from './context';
import * as path from 'path';
import { InterruptReason } from './interrupt';
import { runLoop } from './loop';

/**
 * AgentRegistry 最小结构（core 仅做类型收窄，避免依赖 agents 层）。
 * performReload 经 AppState 取 registry 后只调用 getAgent(id)。
 */
interface AgentRegistryLike {
  getAgent(id: string): unknown;
}

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

// ============================================================
// Agent
// ============================================================

// 会话运行态（RunSession）与状态管理已抽出至 ./session（v0.5.0 P1 无状态化）
//  - run-session.ts: RunSession 接口 + createRunSession
//  - session-manager.ts: SessionManager（sessions/queues/active 管理）

const _agentSessionManager = Symbol('agentSessionManager');

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
   * 会话级运行态（v0.5.0 P1 无状态化）：状态管理抽至 SessionManager，
   * Agent 只持有 manager 引用，自身不维护会话状态细节。
   */
  private _sessionManager: SessionManager | null = null;

  private _getSessionManager(): SessionManager {
    if (!this._sessionManager) {
      this._sessionManager = new SessionManager(this.agentId, {
        doReceive: (msg, sig) => this._doReceive(msg, sig),
        doTrigger: (opts, sig) => this._doTrigger(opts, sig),
      });
    }
    return this._sessionManager;
  }

  // ============================================================

  /** 中止当前运行（供优雅关闭/重启调用）—— 并行后中止所有活跃会话 */
  abort(): void {
    this._getSessionManager().abortAll();
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
      const target = counterpart || this._getSessionManager().active?.sender || 'user';
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
    const key = convKey || convKeyFor(this.agentId, message.agent_id || 'user');
    const session = this._getSessionManager().getOrCreate(key, message.agent_id || 'user');
    session.steeringQueue.push(message);
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
    const registry = state.registry as AgentRegistryLike | undefined;

    if (scope === 'self' || scope === 'all') {
      // ---- self：重载自己的 tools/ ----
      try {
        const agent = registry?.getAgent(this.agentId) as Agent | undefined;
        const toolsDir = path.join(getGlobalConfig().agentsDir, this.agentId, 'tools');
        // 插件发现经 AppState 注入的 PluginLoader（v0.5.0：core 只依赖 PluginManager 接口）
        const pluginLoader = (state as any).pluginLoader as PluginManager | undefined;
        const discovered = pluginLoader?.discoverTools?.(toolsDir) ?? new Map<string, Tool>();
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
        // 插件发现经 AppState 注入的 PluginLoader（内部定位 srcRoot/plugins，
        // v0.5.0：修复旧 'srcRoot/global' 路径在改名 plugins 后失效的问题）
        const pluginLoader = (state as any).pluginLoader as PluginManager | undefined;
        const reloaded = pluginLoader?.reloadGlobalExtensions?.();
        const extensions: Map<string, { preHook?: any; postHook?: any }> = reloaded?.extensions ?? new Map();
        const interceptors: ToolInterceptor[] = reloaded?.interceptors ?? [];
        const tools: Map<string, Tool> = reloaded?.tools ?? new Map();

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
      correlation_id: this._getSessionManager().active?.cid,
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
    const convKey = convKeyFor(this.agentId, ctx.sender, ctx.group_id);
    const sm = this._getSessionManager();
    const session = sm.getOrCreate(convKey, ctx.sender);
    session.userId = ctx.group_id
      ? `group__${ctx.group_id}__${ctx.receiver}`
      : `${ctx.sender}__${ctx.receiver}`;
    session.cid = `agent-${this.agentId}-${Date.now()}`;
    session.cumulativeUsage = undefined;
    session.thinkingStartTime = 0;
    sm.setActive(session);

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
        // §5.1：ReAct 编排交给纯函数 runLoop(ctx)（装配层注入 emit / 网络回调）
        ({ content, interrupted, interruptReason } = await runLoop({
          agentId: this.agentId,
          llm: this.llm,
          config: this.config,
          tools: this.tools,
          toolInterceptors: this.toolInterceptors,
          session,
          messages,
          loopMessages,
          deepThink: options?.deepThink,
          maxTurns: options?.maxTurns,
          signal: runSignal,
          emit: this._eventBus ? (type, payload, data) => this._emit(type, payload, data) : undefined,
          onNetworkRecover: () => {
            const router = (getAppState() as any).router as { notifyNetworkRecover?: () => Promise<number> } | undefined;
            if (router?.notifyNetworkRecover) void router.notifyNetworkRecover();
          },
          onNetworkError: () => {
            const router = (getAppState() as any).router as { notifyNetworkError?: () => void } | undefined;
            router?.notifyNetworkError?.();
          },
        }));
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
            // requestRestart 经 AppState 依赖注入（bootstrap 注入，避免 core 动态 import @app/shutdown）
            const restartFn = (getAppState() as any).requestRestart as ((reason?: string) => void) | undefined;
            if (restartFn) {
              restartFn(interruptReason.reason ?? `agent-${this.agentId}-restart`);
            } else {
              logger.warn(`[Agent] "${this.agentId}" 请求重启但 requestRestart 未注入（bootstrap 缺失）`);
            }
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

  // ============================================================
  // ============================================================
  // 电话模式 / 自主推理入口（委托给执行队列）
  // ============================================================

  async receive(message: AgentMessage, signal?: AbortSignal): Promise<AgentResult> {
    // 会话级并行：按会话路由到独立队列（同会话串行，跨会话并行）
    const convKey = convKeyFor(this.agentId, message.from, message.group_id);
    return this._getSessionManager().queueFor(convKey).receive(message, signal);
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
    const convKey = convKeyFor(this.agentId, sender, options?.group_id);
    return this._getSessionManager().queueFor(convKey).trigger(options, signal);
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
      llmConfig: this._llmConfig ?? this.config.llm as import('@core/types').LLMConfig | undefined,
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