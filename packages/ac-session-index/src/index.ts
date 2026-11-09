// ============================================================
// index.ts —— ac-session-index 出口（cr-973 Phase 1，2026-11-09）
//
// 两半面分文件（照 ac-ledger 布局）：core.ts = 纯库（零 cordis——
// 指针索引算法可独立单测）；service.ts = cordis 服务行面（ctx.sessionIndex）。
// ============================================================
export * from './core.ts';
export * from './service.ts';
