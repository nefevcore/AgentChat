// ============================================================
// ac-fingerprint-core —— 内容指纹纯库（R-7）
//
// 职责（host-shell-row-manifest.md 纯库表）：Merkle 内容树 + 规范化 +
// 子指纹——两形态同根断言的物理载体。消费面：宿主 guardian verify 节拍
// + 壳 boot stdout 自报（两侧同算法）。零 cordis 依赖。
// ============================================================

export const name = 'ac-fingerprint-core';

export * from './merkle.ts';
export * from './disk.ts';
export * from './subject.ts';
