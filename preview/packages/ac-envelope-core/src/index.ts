// ============================================================
// ac-envelope-core —— 信封协议纯库（协议规格 A/B2）
//
// 职责（host-shell-row-manifest.md 纯库表）：信封 schema（uuid/requestId/
// sender/to/kind/budget）+ requestId 幂等准入（cr-250 语义）+ budget 语义
//（user 直发重置满额、每自动唤醒 -1、0=只落账）+ 确认状态机（落账即确认）
// + ipc 长度前缀帧（B2——帧层在 frame.ts，M1.2）。
// 零 cordis 依赖。
// ============================================================

export const name = 'ac-envelope-core';

export * from './envelope.ts';
export * from './issue.ts';
export * from './receipt.ts';
export * from './usage-report.ts';
export * from './grant.ts';
export * from './plugin-request.ts';
export * from './admission.ts';
export * from './budget.ts';
export * from './confirm.ts';
export * from './frame.ts';
export * from './stream.ts';
export * from './socket.ts';
export * from './lock.ts';
