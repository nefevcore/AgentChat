// ============================================================
// usage.ts —— usage 事件信消费面（cr-538）
//
// payload schema owning 归 ac-envelope-core（usage-report.ts——receipt
// 同构位）；本模块 re-export + ledger 侧计量词汇（RunUsage 与
// UsageRunMeter 同形——主线 LoopRunUsage 形状）。
// ============================================================
export { usageStreamKey, makeUsageEnvelope, validateUsagePayload, isUsageReport } from 'ac-envelope-core';
export type { UsageReportPayload, UsageRunMeter } from 'ac-envelope-core';