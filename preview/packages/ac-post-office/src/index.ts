// ============================================================
// ac-post-office —— 邮局行（M4.1；宿主树新增行）
//
// 投递路由 + uuid 登记校验（R-1）+ 群播扇出（群拓扑执行面）+
// ipc 帧监听（B1/B2）。发件箱滞留（outbox/）随 M4.2 接线。
// ============================================================

export const name = 'ac-post-office';

export * from './registry.ts';
export * from './router.ts';
export * from './ipc.ts';
export * from './outbox.ts';
export * from './post-office.ts';
export * from './stream.ts';
export * from './stream-bridge.ts';
