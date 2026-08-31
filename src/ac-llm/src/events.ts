// ============================================================
// ac-llm/src/events.ts —— LLM 域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：llm/* 事件的分发方是本包的 LlmService，
// 类型与 JSDoc 契约（@mode 分发模式 + 拦截姿势）随之住在 本包。
// 消费方 `import type {} from 'ac-llm'` 即获得类型增强。
//
// 流式细分事件（llm/delta-*）：UI 可视化的前置。LlmService.stream
// 在产出 chunk 的同时 emit——谁流谁发，loop 不重发。
// ============================================================
import type {} from '@agentchat/cordis';
import type { LlmChatCall, LlmChatInput, LlmStreamChunk, LlmStreamMeta } from './contract.ts';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * LLM 调用前拦截。
     * @mode waterfall
     * @scope run
     * 本 cordis 的 `next()` 不携带参数，三种姿势：
     *   · 改写输入：`call.input = { ...call.input, model: '...' }` 后
     *     `return next()`（路由发生在拦截之后，改写 model 即改写路由）
     *   · 短路（缓存回放/降级/拒绝）：不调 `next`，自返回 AsyncIterable
     *   · 组装结果：`const it = await next(); ...包装/变换后返回`
     * 抛错 = 拒绝本次调用。
     */
    'llm/before-chat'(
      call: LlmChatCall,
      next: () => AsyncIterable<LlmStreamChunk>,
    ): AsyncIterable<LlmStreamChunk>;

    /**
     * LLM 调用失败通知（监控/降级/重试策略订阅）。
     * @mode emit
     * @scope run
     */
    'llm/chat-error'(input: LlmChatInput, error: unknown): void;

    /**
     * 流式开始（一次 stream 调用的边界；UI 打开气泡/思考指示）。
     * @mode emit
     * @scope run
     */
    'llm/delta-start'(input: LlmChatInput, meta?: LlmStreamMeta): void;

    /**
     * 内容增量（正文/推理/工具调用分片均经此发射，UI 按 kind 分流）。
     * meta（M13 载荷增强）：input.meta 的透传——agent/conversationId/sender
     * 信封子集，WS 桥接按它过滤后台会话（sender='event'）。
     * @mode emit
     * @scope run
     */
    'llm/delta'(input: LlmChatInput, chunk: LlmStreamChunk, meta?: LlmStreamMeta): void;

    /**
     * 流式结束（finish/usage 已随末个 chunk 发射；UI 收气泡）。
     * @mode emit
     * @scope run
     */
    'llm/delta-end'(input: LlmChatInput, meta?: LlmStreamMeta): void;
  }
}
