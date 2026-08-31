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
//   通知通道 —— router/message-received、router/reply-completed 事件
//     （历史持久化/WS 广播/审计等订阅方【零注入 router】）
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { LlmMessage } from 'ac-llm';
import type { LoopRunResult, LoopSource } from 'ac-agent-loop';
import { pairKey } from 'ac-agent-loop';
import { filterLlmParams, resolveToolNames } from 'ac-agents';

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
   * model（provider 等其余配置跟随 Agent）。缺省 = Agent 原配置。
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

export class RouterService extends Service {
  /** 服务级依赖声明（M12 铁律 1：服务体内访问 ctx 依赖须显式声明） */
  static inject = ['agents', 'agentLoop', 'tools'];

  constructor(ctx: Context) {
    super(ctx, 'router');
  }

  /**
   * 纯转发：解析 Agent（ctx.agents）→ 构建信封（LoopRunRequest）→
   * 投递 ctx.agentLoop.run。双侧事件通知（message-received 先于 loop，
   * reply-completed 后于 loop）→ 返回 run 结果。
   *
   * virtual Agent（M12）：只发 router/message-received（入站照常入账），
   * 不投 loop、不发 reply-completed——返回零步合成结果。
   */
  async send(agentId: string, inbound: RouterInbound, options: RouterSendOptions = {}): Promise<LoopRunResult> {
    const agent = this.ctx.agents.require(agentId);
    const message: LlmMessage =
      typeof inbound === 'string' ? { role: 'user', content: inbound } : inbound;
    const sender = options.sender ?? 'user';
    const source = options.source ?? 'user';
    // 对桶缺省（M19）：直答 = pairKey(sender, agentId)——user 只是端点之一，
    // 无专属路径；群/独立/委托路径由调用方显式传键。
    const conversationId = options.conversationId ?? pairKey(sender, agentId);
    this.ctx.emit('router/message-received', agentId, message, conversationId, sender, source, options.meta);

    if (agent.virtual) {
      return {
        steps: [],
        text: '',
        finish: 'stop',
        usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
      };
    }
    if (!agent.model && !options.model) {
      throw new Error(`agent "${agentId}" 缺少 model 配置（非 virtual Agent 必须声明模型）`);
    }

    // 信封 = AgentConfig（agents 注册中心解析）+ 完整消息列表 + 拓扑（sender/source/conversationId）
    // 注意：AgentConfig.settings[具名] 不进信封——扩展插件经 request.agent 自行查询。
    // tools 对象形态（include/exclude）与 llmParams 采样参数在此解析/过滤（M15）。
    const allToolNames = this.ctx.tools.list().map((t) => t.name);
    const tools = resolveToolNames(agent.tools, allToolNames);
    const llmParams = filterLlmParams(agent.llmParams);
    this.ctx.logger.info(
      '[router] → loop %C（model=%C provider=%C conv=%C sender=%C/%C tools=%C）',
      agentId,
      options.model ?? agent.model ?? '',
      agent.provider ?? '(auto)',
      conversationId,
      sender,
      source,
      // tools=undefined = 未配置过滤 → 全部已注册工具（附注册总数，免歧义）；
      // 数值 = include/exclude 解析后的生效工具数
      tools === undefined ? `全部(${allToolNames.length})` : String(tools.length),
    );
    const run = await this.ctx.agentLoop.run({
      agent: agentId,
      // 会话级模型覆盖（singles 引用语义）：覆盖优先，回落 Agent 原配置
      model: options.model ?? agent.model ?? '',
      ...(agent.provider ? { provider: agent.provider } : {}),
      ...(agent.system ? { system: agent.system } : {}),
      ...(tools ? { tools } : {}),
      // 步数上限：run 级覆盖（M20 归档整理硬闸①）> Agent 原配置
      ...((options.maxSteps ?? agent.maxSteps) != null ? { maxSteps: options.maxSteps ?? agent.maxSteps } : {}),
      ...(Object.keys(llmParams).length > 0 ? { llmParams } : {}),
      sender,
      source,
      conversationId,
      ...(options.meta ? { meta: options.meta } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      messages: [...(options.history ?? []), message],
    });

    const reply = run.finish === 'error' ? `[error] ${run.error ?? '循环失败'}` : run.text;
    this.ctx.emit('router/reply-completed', agentId, reply, run, conversationId, sender, source, options.meta);
    return run;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 消息路由服务（ac-router 提供；纯转发，零会话状态） */
    router: RouterService;
  }
}
