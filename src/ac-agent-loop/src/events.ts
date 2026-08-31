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
     * `next()` 不携带参数，三种姿势：
     *   · 改写请求：`call.request = { ...call.request, system: '...' }` 后 `return next()`
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
     * 每步模型调用前拦截（可改写本步消息列表，如注入临时上下文）。
     * @mode waterfall
     * @scope run
     * 改写：`call.messages = [...call.messages, ...]` 后 `return next()`。
     * 注意：改写只影响本步；循环主历史不受影响。
     * call.agent = 发起 Agent id（M25 §3.1 补齐；宿主直调/子代理 =
     * undefined）——门控用 agentOfStepCall 读取器（ac-agent-loop 导出）。
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
