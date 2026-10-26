// ============================================================
// ac-snapshot-core —— 快照链纯库（R-8 + D6 快照原子；M6.1）
//
// 职责（host-shell-row-manifest.md R4 归并表：snapshot-chain →
// backup 行内）：快照点 = last known good（只在验证过健康的状态拍）；
// 保留 = GFS 分代（非均匀轮转——连续同向跑偏收敛保证）；回滚目标
// = R-7 三元组 (根, 快照时间, 健康证据)。零 cordis 依赖。
// ============================================================

export const name = 'ac-snapshot-core';

export * from './chain.ts';
