// ============================================================
// ac-post-office —— 邮局行（M4.1；宿主树新增行）
//
// 投递路由 + uuid 登记校验（R-1）+ 群播扇出（群拓扑执行面）。
// ipc 传输（监听/客户端）cr-861 移入 ac-envelope-core/ipc.ts。
// ============================================================

export const name = 'ac-post-office';

export * from './registry.ts';
export * from './router.ts';
export * from './outbox.ts';
export * from './post-office.ts';
export * from './stream.ts';
export * from './stream-bridge.ts';
