// ============================================================
// @agentchat/agent-loop —— ReAct 引擎（迁移自 src/core）
//   · loop.ts      ReAct 编排纯函数 run(ctx)
//   · context.ts   单次执行输入快照 CurrentContext + steer 收集区
//   · interrupt.ts 语义化中断（InterruptReason 5 类 + ToolInterrupt）
//   · hash.ts      会话键哈希（dialogId → 目录安全名）
//   · contracts.ts 引擎域契约（RunResult/Tool/CoreEventType，复用 @agentchat/llm）
// ============================================================

export * from './contracts';
export * from './interrupt';
export * from './context';
export * from './loop';
export * from './service';
export { hashDialogId } from './hash';
