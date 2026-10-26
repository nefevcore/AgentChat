// ============================================================
// ac-agents-core —— AgentConfig 契约 owning 纯库（R-6 直读）
//
// 职责（host-shell-row-manifest.md 纯库表）：AgentConfig 契约 owning +
// 词汇纯函数 + agents/<id>/ 树直读 + children 嵌套解析。消费面：壳 run
// 前重读（装配链/门/subagent）+ 宿主编辑面词汇共用。零 cordis 依赖。
// ============================================================

export const name = 'ac-agents-core';

export * from './config.ts';
export * from './tree.ts';
export * from './write.ts';
export * from './fixture.ts';
export * from './auth-shape.ts';
