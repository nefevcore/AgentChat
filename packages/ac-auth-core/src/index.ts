// ============================================================
// ac-auth-core —— 授权投影纯库（授权草稿 C 节）
//
// 职责：授权投影算法（全局层 ∩ per-agent 层 ∩ 行集，墓碑与 InlineAsset）
// + 两层直读 + B3 指纹。消费面：壳 tools 门（每 run 前重读现算，A14）。
// ============================================================

export const name = 'ac-auth-core';

export * from './auth.ts';
export * from './disk.ts';
export * from './write.ts';
export * from './mcp.ts';
