// ============================================================
// ac-ledger —— per-agent 账本行（M3.3；D4 语义）
//
// 账本身份键恒端点（A5）：壳 = 临时容器与写者执行体——壳不拥有账本、
// 壳死账本在。行协议平移 ac-session v1 中性格式；writer 机制照搬
//（串行队列 / append+fsync / settlement 两阶段）。
// M8.2：service.ts = cordis 行装配面（ctx.ledger——writer 注册表 +
// journal 步行接线）；纯库面保持零 cordis。
// ============================================================

export const name = 'ac-ledger';

export * from './records.ts';
export * from './writer.ts';
export * from './reader.ts';
export * from './archive.ts';
export * from './user.ts';
export * from './usage.ts';
export * from './manage.ts';
export * from './service.ts';
