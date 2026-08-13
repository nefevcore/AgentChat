// ============================================================
// edit-diff.ts —— edit 工具算法统一出口（barrel）
//
// 2026-08-12 重构：原 God file（~1190 行）按职责拆分为
//   types / line-ending / fuzzy-match / diff / apply，
// 本文件保留全部导出（向后兼容：既有 import 与测试零改动）。
//
// 依赖方向：本文件仅 re-export，不承载任何实现。
// ============================================================

export * from './types';
export * from './line-ending';
export * from './fuzzy-match';
export * from './diff';
export * from './apply';
