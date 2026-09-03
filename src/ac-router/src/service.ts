// ============================================================
// ac-router/src/service.ts —— 消息路由服务（cordis Service）
//
// 本包同时是路由域契约的 owning package：RouterInbound /
// RouterSendOptions 定义在本文件，router/* 事件目录见 ./events.ts
// （谁 emit 谁声明）；跨域词汇 type-import 自 owning 包。
//
// 纯转发/中转（零会话状态）：
//   send() = ctx.agents.require(id) 解析 AgentConfig
//           → 构建信封（LoopRunRequest：agent 配置 + 完整消息列表）
//           → ctx.agentLoop.run(envelope)（能力通道，必达、有返回值）
//   会话历史不归本服务：调用方经 options.history 提供此前消息；
//   跨插件的历史积累走 router/* 事件（将来的 ac-session）。
//
// 双通道（能力/通知分离）：
//   能力通道 —— send()（见上）
//   决策通道 —— router/before-deliver（waterfall：投递边界 seam——
//     委托权限闸门/投递审计/内容过滤的预留落点；无监听器零开销直通）
//   通知通道 —— router/message-received、router/reply-completed 事件
//     （历史持久化/WS 广播/审计等订阅方【零注入 router】）
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { splitModelRef } from 'ac-llm';
import type { LlmMessage } from 'ac-llm';
import type { LoopRunResult, LoopSource } from 'ac-agent-loop';
import { pairKey } from 'ac-agent-loop';
import { capabilitySetOf, filterLlmParams, resolveToolNames, toolAllowedFor } from 'ac-agents';
import { defaultPoolConnection } from 'ac-llm-pool';

/** 路由入站消息（string 糖衣 → { role:'user', content }） */
export type RouterInbound = string | LlmMessage;

/** 投递选项：此前会话由调用方提供（router 零会话状态） */
export interface RouterSendOptions {
  /** 此前会话消息（不含本次入站）；ac-session 经事件积累后回放 */
  history?: LlmMessage[];
  /**
   * 发送方端点 id（信封身份，M19）：用户直答 = viewer 虚拟 Agent id、
   * 委托 = 发起 Agent id、机制触发 = 目标自身。缺省 'user'（单 viewer）。
   */
  sender?: string;
  /**
   * 发送方拓扑类（信封 source，M19）：'user' 直答 / 'agent' 委托
   * （agent⇄agent）/ 'event' 触发（定时/系统事件）。缺省 'user'。
   */
  source?: LoopSource;
  /**
   * 会话归属键：对桶 = pairKey(a, b)（M19 缺省 = pairKey(sender, agentId)
   * 即直答对桶）；group 传组 id、独立会话传 sid——多 agent 共享同一会话流
   * （ac-session 按 conversationId 分桶）。
   */
  conversationId?: string;
  /**
   * 会话级模型覆盖（singles 引用语义）：给定则取代 Agent 原配置的
   * model（provider 等其余配置跟随 Agent）。缺省 = Agent 原配置；
   * Agent 也未声明 model（UI「默认」= 存 null）→ 回落默认池连接
   * （全局默认模型，provider 随归属连接）。
   * 值可为 `name@model` 引用（llm-provider-model-plan P4——左段为已注册
   * provider 名时拆分出 provider，跨 provider 覆盖；裸名维持旧路由）。
   */
  model?: string;
  /**
   * run 级步数上限覆盖（M20）：给定则取代 Agent 原配置的 maxSteps
   * （0/缺省 = Agent 原配置语义）。归档整理 run 的失控防线①经它注入。
   */
  maxSteps?: number;
  /**
   * 机制标记透明通道（M20）：原样进信封 LoopRunRequest.meta 并随
   * message-received / reply-completed 事件尾参广播。携带
   * ARCHIVE_REVIEW_META（ac-agent-loop 导出）时 ac-session / ac-usage
   * 跳过入账/记账——"机制 run 不落盘"由绕开通道改为显式标记跳过。
   */
  meta?: Record<string, unknown>;
  /**
   * 本轮 run 的外部中止信号（透传进信封；loop 在 step 边界检查 →
   * finish='interrupted'，ADR-2）。ac-conversation 的串行化门用它实现 abort。
   */
  signal?: AbortSignal;
}

/**
 * 投递载体（router/before-deliver waterfall 的事实对象）。
 * 信封拓扑全部字段可变异（改写后照常投递）；conversationId 不随
 * agentId/sender 改写自动重派生——监听器需要时应一并改写。
 * 投递边界的决策 seam（预留）：当前无内置消费者——委托权限闸门
 * （agent⇄agent 特权流仲裁）、投递审计、内容过滤等治理行的落点。
 */
export interface RouterDeliverCall {
  /** 目标 Agent id（可变异：改写 = 重定向投递） */
  agentId: string;
  /** 入站消息（可变异：改写内容/脱敏后照常投递） */
  message: LlmMessage;
  /** 发送方端点 id（M19 信封身份；可变异） */
  sender: string;
  /** 发送方拓扑类（'user' 直答 / 'agent' 委托 / 'event' 触发；可变异） */
  source: LoopSource;
  /** 会话归属键（对桶/群/独立；可变异） */
  conversationId: string;
  /** 机制标记透明通道（M20；可变异——原样进信封与通知事件） */
  meta?: Record<string, unknown>;
}

export class RouterService extends Service {
  /** 服务级依赖声明（M12 铁律 1：服务体内访问 ctx 依赖须显式声明） */
  static inject = ['agents', 'agentLoop', 'tools'];

  constructor(ctx: Context) {
    super(ctx, 'router');
  }

  /**
   * 纯转发：信封缺省派生 → router/before-deliver（waterfall 决策 seam）
   * → dispatch（解析 Agent → 构建信封 → 投递 loop → 双侧事件通知）
   * → 返回 run 结果。
   *
   * before-deliver 监听器可改写信封拓扑（agentId/message/sender/source/
   * conversationId/meta）或 veto（不调 next 自返回 LoopRunResult——
   * message-received 不发、loop 不启动）；无监听器零开销直通。
   *
   * virtual Agent（M12）：只发 router/message-received（入站照常入账），
   * 不投 loop、不发 reply-completed——返回零步合成结果。
   */
  async send(agentId: string, inbound: RouterInbound, options: RouterSendOptions = {}): Promise<LoopRunResult> {
    // 信封缺省（M19）派生先于 waterfall：监听器看到与投递完全一致的
    // 拓扑事实，改写后照常投递。
    const message: LlmMessage =
      typeof inbound === 'string' ? { role: 'user', content: inbound } : inbound;
    const sender = options.sender ?? 'user';
    const source = options.source ?? 'user';
    // 对桶缺省（M19）：直答 = pairKey(sender, agentId)——user 只是端点之一，
    // 无专属路径；群/独立/委托路径由调用方显式传键。
    const conversationId = options.conversationId ?? pairKey(sender, agentId);
    const call: RouterDeliverCall = {
      agentId,
      message,
      sender,
      source,
      conversationId,
      ...(options.meta ? { meta: options.meta } : {}),
    };
    return this.ctx.waterfall('router/before-deliver', call, () => this.dispatch(call, options));
  }

  /**
   * 实际投递（before-deliver 通过后）：解析最终目标 Agent → 通知通道
   * （message-received 先于 loop）→ 构建信封投递 loop → 通知
   * reply-completed → 返回 run 结果。
   */
  private async dispatch(call: RouterDeliverCall, options: RouterSendOptions): Promise<LoopRunResult> {
    const agent = this.ctx.agents.require(call.agentId);
    this.ctx.emit('router/message-received', call.agentId, call.message, call.conversationId, call.sender, call.source, call.meta);

    if (agent.virtual) {
      return {
        steps: [],
        text: '',
        finish: 'stop',
        usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
      };
    }
    // 模型引用：会话级覆盖 > Agent 原配置 > 默认池连接（Agent 面「默认」
    // 选项 = model 存 null，投递边界回落全局默认模型；引用形
    // `provider@model` 使 provider 随归属连接走——resolveModelRef 拆分
    // 优先于 agent.provider，跨 provider 的默认连接也能正确路由）。
    let modelRef = options.model ?? agent.model ?? '';
    if (!modelRef) {
      const def = this.defaultConnection();
      if (!def) {
        throw new Error(`agent "${call.agentId}" 缺少 model 配置（非 virtual Agent 必须声明模型；也未配置默认模型连接）`);
      }
      modelRef = `${def.provider}@${def.model}`;
    }

    // 信封 = AgentConfig（agents 注册中心解析）+ 完整消息列表 + 拓扑（sender/source/conversationId）
    // 注意：AgentConfig.settings[具名] 不进信封——扩展插件经 request.agent 自行查询。
    // tools 对象形态（include/exclude）与 llmParams 采样参数在此解析/过滤（M15）。
    // 模型引用拆分（P4）：modelRef 可为 `name@model`——左段为已注册 provider
    // 名则拆出 provider（跨 provider 覆盖，优先于 agent.provider）；否则整串
    // 按裸模型路由（防误伤含 @ 的模型 id）。
    // LoopRunRequest.model 恒为裸模型 id——usage 记账/delta 事件/前缀快照
    // 修订键不被引用语法污染。
    const { provider: refProvider, model: resolvedModel } = this.resolveModelRef(modelRef);
    // 工具可见面 = 注册面 ∩ 能力面（2026-09-02 反馈 #1）：requiredTags 缺标签
    // 的工具不出现在 Agent 的工具清单——此前只在执行时 veto，LLM 仍能看到
    // 并调用（浪费一轮 + 上报为"工具异常"）。能力集合成与 ac-security
    // 执行门禁同款单源（capabilitySetOf）；include 不可绕过语义保持（过滤
    // 先于 include/exclude 解析）。
    const caps = capabilitySetOf(this.ctx, call.agentId);
    const visibleTools = this.ctx.tools.list().filter((t) => toolAllowedFor(t, caps));
    const allToolNames = visibleTools.map((t) => t.name);
    // 未配置 include/exclude 时也**显式**传可见面全量：loop 的 tools 缺省
    // 语义是"全部已注册"——省略即绕过能力面（空集照传，loop 收敛为无工具）
    const tools = resolveToolNames(agent.tools, allToolNames) ?? allToolNames;
    const llmParams = filterLlmParams(agent.llmParams);
    const provider = refProvider ?? agent.provider;
    this.ctx.logger.info(
      '[router] → loop %C（model=%C provider=%C conv=%C sender=%C/%C tools=%C）',
      call.agentId,
      resolvedModel,
      provider ?? '(auto)',
      call.conversationId,
      call.sender,
      call.source,
      // 能力面过滤后的生效工具数（include/exclude 已解析；含未配置 = 可见面全量）
      `(${tools.length}/${this.ctx.tools.list().length})`,
    );
    const run = await this.ctx.agentLoop.run({
      agent: call.agentId,
      // 会话级模型覆盖（singles 引用语义）：覆盖优先，回落 Agent 原配置
      model: resolvedModel,
      ...(provider ? { provider } : {}),
      ...(agent.system ? { system: agent.system } : {}),
      ...(tools ? { tools } : {}),
      // 步数上限：run 级覆盖（M20 归档整理硬闸①）> Agent 原配置
      ...((options.maxSteps ?? agent.maxSteps) != null ? { maxSteps: options.maxSteps ?? agent.maxSteps } : {}),
      ...(Object.keys(llmParams).length > 0 ? { llmParams } : {}),
      sender: call.sender,
      source: call.source,
      conversationId: call.conversationId,
      ...(call.meta ? { meta: call.meta } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      messages: [...(options.history ?? []), call.message],
    });

    const reply = run.finish === 'error' ? `[error] ${run.error ?? '循环失败'}` : run.text;
    this.ctx.emit('router/reply-completed', call.agentId, reply, run, call.conversationId, call.sender, call.source, call.meta);
    return run;
  }

  /**
   * `name@model` 引用拆分（llm-provider-model-plan P4）：
   * 左段为已注册 provider 名 → { provider, model }；否则（含裸名/左段
   * 未知）整串按裸模型路由。llm 为可选能力（ctx.get 非 strict——组合
   * 缺 llm 行时照拆，最终由 LlmService 的 roster 报错兜底）。
   */
  private resolveModelRef(ref: string): { provider?: string; model: string } {
    const split = splitModelRef(ref);
    if (split.provider === undefined) return split;
    const llm = this.ctx.get('llm', false) as { providers(): string[] } | undefined;
    if (llm && !llm.providers().includes(split.provider)) return { model: ref };
    return split;
  }

  /**
   * 默认池连接（模型缺省回落；口径统一 = ac-llm-pool defaultPoolConnection：
   * `default:true` 条目优先，缺省首条）。config 为可选能力——行未装/无池/
   * 无具体模型 → undefined（调用方维持原 fail-closed 校验）。
   */
  private defaultConnection(): { provider: string; model: string } | undefined {
    const config = this.ctx.get('config') as
      | { get<T>(key: string): T | undefined }
      | undefined;
    return defaultPoolConnection(config?.get<Record<string, unknown>>('llmProviders'));
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 消息路由服务（ac-router 提供；纯转发，零会话状态） */
    router: RouterService;
  }
}
