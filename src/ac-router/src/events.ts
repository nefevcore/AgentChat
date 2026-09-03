// ============================================================
// ac-router/src/events.ts —— 路由域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：router/* 事件的分发方是本包的 RouterService。
// 决策 seam + 纯通知双通道：router/before-deliver（waterfall——投递
// 边界预留决策口，当前无内置消费者）+ message-received/reply-completed
// （历史持久化/WS 广播/审计等订阅方【零注入 router】——与 router 的
// 唯一联系是本目录中的事件）。跨域载荷词汇（LlmMessage/LoopRunResult）
// type-import 自 owning 包。
// ============================================================
import type {} from '@agentchat/cordis';
import type { LlmMessage } from 'ac-llm';
import type { LoopRunResult, LoopSource } from 'ac-agent-loop';
import type { RouterDeliverCall } from './service.ts';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 投递边界决策（信封拓扑已解析；message-received 未发、loop 未启动）。
     * 委托权限闸门（agent⇄agent 特权流仲裁）/ 投递审计 / 内容过滤的
     * 预留 seam——当前无内置消费者，监听器为零时零开销直通。
     * @mode waterfall
     * @scope run
     * `next()` 不携带参数，三种姿势：
     *   · 改写信封：`call.sender = '...'` / `call.message = {...}` 后 `return next()`
     *     （conversationId 不随 agentId/sender 改写自动重派生——需要时一并改写）
     *   · veto：不调 `next`，自返回 LoopRunResult（如 finish:'veto'——
     *     message-received 不发、loop 不启动）
     *   · 包裹观察：`const result = await next(); ...; return result`
     * 观察/标注型监听器必须调 `next()`（不调 = 静默吞掉本次投递）。
     */
    'router/before-deliver'(
      call: RouterDeliverCall,
      next: () => Promise<LoopRunResult>,
    ): Promise<LoopRunResult>;

    /**
     * 路由收到入站消息（信封尚未投递，loop 未启动）。
     * 纯通知：历史持久化/WS 广播/审计等订阅方【零注入 router】。
     * conversationId = 会话归属键（M19：对桶 pairKey(a,b)；群 = 组 id）。
     * sender = 发送方端点 id（M19 身份：viewer 虚拟 Agent id / 委托 Agent id /
     * 机制触发 = 目标自身）；source = 拓扑类（'event' 触发的消息由
     * ac-session 落 role:'event' 行，UI 渲染为事件分隔符而非用户气泡）。
     * meta（M20 加位）：信封机制标记（ARCHIVE_REVIEW_META 等）——
     * ac-session 见标记跳过入账（机制 run 不落会话账）。
     * @mode emit
     * @scope run
     */
    'router/message-received'(agentId: string, message: LlmMessage, conversationId: string, sender?: string, source?: LoopSource, meta?: Record<string, unknown>): void;

    /**
     * 路由完成一轮投递（loop 已收束，send 返回前发出）。
     * conversationId 同 message-received（ac-session 按此分桶积累）。
     * sender/source 同 message-received（事件溯源/审计用）。
     * meta（M20 加位）：同 message-received——ac-session 见
     * ARCHIVE_REVIEW_META 标记跳过入账。
     * @mode emit
     * @scope run
     */
    'router/reply-completed'(agentId: string, text: string, result: LoopRunResult, conversationId: string, sender?: string, source?: LoopSource, meta?: Record<string, unknown>): void;
  }
}
