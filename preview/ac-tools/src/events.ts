// ============================================================
// ac-tools/src/events.ts —— 工具域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：tool/* 事件的分发方是本包的 ToolsService，
// 类型与 JSDoc 契约（@mode 分发模式 + 拦截姿势）随之住在本包。
// 消费方 `import type {} from 'ac-tools'` 即获得类型增强。
// ============================================================
import type {} from '@agentchat/cordis';
import type { ToolCall, ToolExecution, ToolResult, ToolTransform } from './contract.ts';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 工具执行前拦截（安全策略/审计/参数改写）。
     * @mode waterfall
     * @scope run
     * `next()` 不携带参数，两种姿势：
     *   · veto：不调 `next`，自返回 ToolResult（如 `{ ok: false, error: 'blocked' }`），
     *     工具体不会执行
     *   · 改写：`execution.call = { ...call, args: {...} }` 后 `return next()`
     *     （改写须保留执行身份 agentId/conversationId/toolCallId——
     *     ac-security 沙箱与 ac-session 定向 checkpoint 依赖它们）
     * 观察/标注型监听器必须调 `next()`（不调 = 静默吞下游默认行为）。
     */
    'tool/before-execute'(
      execution: ToolExecution,
      next: () => Promise<ToolResult>,
    ): Promise<ToolResult> | ToolResult;

    /**
     * 工具结果变换（工具体已执行完毕，结果回填消息/通知之前）。
     * @mode waterfall
     * @scope run
     * src 轨道 toolExecutionEndHook 的变换语义。载体携带执行现场
     * （call/durationMs/error），`result` 字段即最终回填值：
     *   · 变换：`payload.result = { ok: true, output: masked }` 后 `return next()`
     *   · 替换短路：不调 `next`，自返回 ToolResult（下游变换器不再执行）
     *   · 纯观察：直接 `return next()`（勿改 payload.result）
     */
    'tool/transform-result'(
      payload: ToolTransform,
      next: () => Promise<ToolResult>,
    ): Promise<ToolResult> | ToolResult;

    /**
     * 工具执行后通知（审计/持久化/WS 广播订阅；error 非空表示工具体抛错）。
     * 通知的是**变换后**的最终结果（transform-result 之后的值）。
     * @mode emit
     * @scope run
     */
    'tool/after-execute'(call: ToolCall, result: ToolResult, error?: unknown): void;

    /**
     * 工具流式进度增量（M7 WebUI；src chat.tool_execution.update 的
     * preview 形态）。工具体调 `call.onProgress(chunk)` 时由本服务
     * （ToolsService.execute 的中央接线）逐片 emit——call 携带执行身份
     * （agentId/conversationId/toolCallId），订阅方（WS 桥接）据此做
     * 后台过滤；调用方自挂的 onProgress 回调照常被调用（先 emit 后委托）。
     * @mode emit
     * @scope run
     */
    'tool/progress'(call: ToolCall, chunk: string): void;
  }
}
