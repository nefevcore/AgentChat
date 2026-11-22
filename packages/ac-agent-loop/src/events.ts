// ============================================================
// ac-agent-loop/src/events.ts —— 循环域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：loop/* 事件的分发方是本包的 AgentLoopService，
// 类型与 JSDoc 契约（@mode 分发模式 + 拦截姿势）随之住在本包。
// 消费方 `import type {} from 'ac-agent-loop'` 即获得类型增强。
// ============================================================
import type {} from '@agentchat/cordis';
import type { LlmMessage } from 'ac-llm';
import type {
  InjectMeta,
  LoopRunCall,
  LoopRunRequest,
  LoopRunResult,
  LoopRunTransform,
  LoopStepCall,
  LoopStepRecord,
  LoopStepTransform,
} from './contract.ts';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * Agent 循环启动前拦截（人格注入/预算控制/直接否决）。
     * @mode waterfall
     * @scope run
     * 【cr-881 三档退役】系统提示词装配**不再**走本事件——段贡献经
     * ctx.agentLoop.registerPromptSection 注册（SECTION_ORDER 具名位
     * 定序，run() 入口组装先于本链）。本事件保留为通用 run 边界 seam：
     * veto / 预算 / messages 改写 / 懒准备（mcp 连接、gate 缓存失效）。
     * `next()` 不携带参数，三种姿势：
     *   · 改写请求：`call.request = { ...call.request, system: '...' }` 后 `return next()`
     *     （system 已是段组装终值——拦截器改写即覆盖终值，向后兼容存量
     *      非段装配监听器）
     *   · veto：不调 `next`，自返回 LoopRunResult（finish:'veto'，LLM 不被调用）
     *   · 包裹观察：`const result = await next(); ...; return result`
     * 观察/标注型监听器必须调 `next()`（不调 = 静默吞下游默认行为）。
     */
    'loop/before-run'(
      call: LoopRunCall,
      next: () => Promise<LoopRunResult>,
    ): Promise<LoopRunResult>;

    /**
     * run 开始通知（before-run 通过后、首步之前；veto 不发）。
     * WS 广播 / UI Turn 分组的订阅面——纯观察，不能挂 before-run 决策链。
     * @mode emit
     * @scope run
     */
    'loop/run-started'(request: LoopRunRequest): void;

    /**
     * run 结束通知（持久化/审计/指标订阅；含 error 形态；
     * 通知的是 transform-run 之后的终值）。
     * @mode emit
     * @scope run
     */
    'loop/after-run'(request: LoopRunRequest, result: LoopRunResult): void;

    /**
     * run 收束清理 steer 队列时仍有未被消费的注入（before-run veto
     * 窗口的残余；收束判定后到达的注入已被 steer() 拒绝并回落
     * next-run，不出本事件）。载荷 dropped 的消息已经
     * conversation/steered 事件入账/进视图——下一条自然 run 的历史
     * 可见（自愈），订阅方只做观测/告警，**不得重投**（重投经
     * router/message-received 会二次入账）。
     * @mode emit
     * @scope run
     */
    'loop/steer-dropped'(
      agent: string | undefined,
      conversationId: string | undefined,
      handle: string,
      dropped: Array<{ message: LlmMessage; sender?: string; source?: string }>,
    ): void;

    /**
     * 注入消费点通知（cr-1251 统一事件——steer-consumed 的泛化退役）：
     * 注入消息实际进入模型消息数组的瞬间发射，四通道全覆盖——
     * steer 队列（步边界 splice）/ durable 队列（before-step 后本步消费）/
     * before-run 注入面（run 起始材料）/ run-idle 注入面（自然停点续走）。
     * 落账方（ac-ledger 订阅 → journalInject）据此在消费点落账——
     * 账本文件序 = 模型消息序（cr-971 原则对全部通道兑现）。观察通知：
     * 订阅方不得改写消息（waterfall 才有改写权）。
     * @mode emit
     * @scope run
     */
    'loop/inject-consumed'(
      agent: string | undefined,
      conversationId: string | undefined,
      runId: string | undefined,
      consumed: Array<{ message: LlmMessage; meta: InjectMeta; sender?: string }>,
    ): void;

    /**
     * 每步模型调用前拦截（可改写本步消息列表，如注入临时上下文）。
     * @mode waterfall
     * @scope run
     * 改写：`call.messages = [...call.messages, ...]` 后 `return next()`。
     * 注意：改写只影响本步；循环主历史不受影响。
     * call.agent = 发起 Agent id（M25 §3.1 补齐；宿主直调/子代理 = undefined）。
     */
    'loop/before-step'(
      call: LoopStepCall,
      next: () => Promise<LoopStepRecord>,
    ): Promise<LoopStepRecord>;

    /**
     * step 开始通知（before-step 通过后、llm.chat 之前；载荷 = 实际送入
     * 模型的消息，含已消费的 steer 注入）。UI 步级流水的订阅面。
     * envelope（M13 载荷增强 / M19 加 source）：request 的信封子集
     * {conversationId, sender, source}——WS 桥接按它过滤后台会话
     * （source='event'）；sender 是端点 id（M19 身份/拓扑分离）。
     * @mode emit
     * @scope run
     */
    'loop/step-started'(
      agent: string | undefined,
      index: number,
      messages: LlmMessage[],
      envelope?: { conversationId?: string; sender?: string; source?: string },
    ): void;

    /**
     * 步记录变换（本步已收束，入档/通知之前）。
     * @mode waterfall
     * @scope run
     * 安全审查/脱敏 seam（与 tool/transform-result 同款模式）：
     *   · 变换：`payload.step = { ...payload.step, text: masked }` 后 `return next()`
     *   · 替换短路：不调 `next`，自返回 LoopStepRecord
     *   · 纯观察：直接 `return next()`（勿改 payload.step）
     * after-step 通知的是变换后的终值。
     */
    'loop/transform-step'(
      payload: LoopStepTransform,
      next: () => Promise<LoopStepRecord>,
    ): Promise<LoopStepRecord>;

    /**
     * 每步完成通知（含工具调用与其执行结果；transform-step 之后的终值）。
     * envelope（M13 载荷增强 / M19 加 source）：同 step-started——WS 桥接
     * 过滤依据（source='event' 的后台 run 不广播）。
     * @mode emit
     * @scope run
     */
    'loop/after-step'(
      agent: string | undefined,
      step: LoopStepRecord,
      envelope?: { conversationId?: string; sender?: string; source?: string },
    ): void;

    /**
     * run 自然停点拦截（2026-02-00 ask 挂起重构）：模型本轮无工具调用且 steer
     * 队列已消费尽时，循环先不收束，把「是否有系统持有的待注入材料」交给
     * 领域行裁决——ask_questions 的答案等待（发起体即时返回，等待归 loop）
     * 即本事件的第一住户。
     * @mode waterfall
     * @scope run
     * 监听器两种姿势（cr-1251 注入面）：
     *   · 持有注入：等待材料就绪后经 `call.inject(msg, meta)` 注入（元数据
     *     随行——消费点统一落账）；返回空数组即可，循环按注入面有写入续走
     *     （同 run 续走，消息数组连续）；
     *   · 无事可做：`return next()`（透传下游）——全体空手 → 收束照旧。
     * 注意（注入位置与预算）：
     *   · 注入到 messages 尾部（2026-09-21 头部注入修正）：自然停点上
     *     工作数组尾是本轮 assistant 终文本——loop 先把它补进工作数组，
     *     注入材料追加其后（尾部追加对 provider 相邻性安全：idle 点尾部
     *     不悬空 tool_calls）。头部注入（splice 于 system 后）使 system
     *     之后的已缓存前缀整体后移（provider 前缀缓存 miss 扩大——实测
     *     ask_questions 会话三次调用 cacheHit 恒 5888、miss 30→425），且
     *     注入材料在位置上先于更早的用户消息、扰乱模型时序感知，已废弃；
     *   · idle 注入的续走步不占 maxSteps 预算（外部输入的接续，不是模型
     *     自主推理延长——上限只防后者）。
     */
    'loop/run-idle'(
      call: LoopRunCall,
      next: () => Promise<LlmMessage[]>,
    ): Promise<LlmMessage[]>;

    /**
     * 轮结果变换（run 已收束，返回调用方/通知之前）。
     * @mode waterfall
     * @scope run
     * 安全审查/脱敏 seam：router 回复文本、ac-session 入账均取变换后的值。
     *   · 变换：`payload.result = { ...payload.result, text: redacted }` 后 `return next()`
     *   · 替换短路：不调 `next`，自返回 LoopRunResult
     *   · 纯观察：直接 `return next()`
     * after-run 通知的是变换后的终值。
     */
    'loop/transform-run'(
      payload: LoopRunTransform,
      next: () => Promise<LoopRunResult>,
    ): Promise<LoopRunResult>;
  }
}
