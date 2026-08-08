// ============================================================
// src/agents/index.ts —— L2 装配层统一出口
//
// L2（调度/多 Agent 协作，纯运行时）。上层仅从本出口导入，
// 不直接深入内部文件，保证依赖方向单向（上层 → agents → core）。
// ============================================================

export * from './config';
export * from './registry';
export * from './router';
export * from './group';
export * from './virtual-agent';
export * from './config-diff';
export * from './credential-store';
