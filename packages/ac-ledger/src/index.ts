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
// cr-1245 B1：纯核（文法/解释/谓词）住 ac-ledger-core——此处经壳文件统一 re-export
export * from './writer.ts';
export * from './reader.ts';
export * from './events-v2.ts';
export * from './fold.ts';
export * from './replay.ts';
export * from './project.ts';
export * from './archive.ts';
export * from './user.ts';
// usage.ts 退役（cr-1175：壳侧改发 usage.report 服务帧——payload schema owning 归 ac-envelope-core）
export * from './manage.ts';
export * from './service.ts';
export * from './view.ts';
