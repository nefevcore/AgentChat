// ============================================================
// ac-conversation —— 会话状态机（M3.4；preview 侧改造行）
//
// 串行化门 + inbox 双队列（next-step/next-turn）+ 防自激 budget
//（信封携带）+ user 端点桩（激活仪式化 R-2）。纯状态机——cordis
// 服务装配随壳行接线（M3.5）。
// M8.2：service.ts = 行装配面（ctx.conversation——信封入站 → ledger
// 落账 → ConversationMachine 决策 → ctx.agentLoop.run 全量真身）。
// ============================================================

export const name = 'ac-shell-conversation';

export * from './state.ts';
export * from './service.ts';
