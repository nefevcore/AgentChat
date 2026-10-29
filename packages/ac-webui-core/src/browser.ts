// ============================================================
// browser.ts —— 浏览器安全子入口（cr-750）
//
// 主入口 barrel 含 Node-only 模块（history/manifest——node:fs/
// node:path 直读）；浏览器侧值导入走主入口会把它们外部化告警拖进
// vite 模块图。本子入口只 re-export 零 Node 依赖的纯函数面——
// 浏览器代码（apps/ui client 半边）一律从这里导入。
// ============================================================

export * from './token-vocab.ts';
export * from './isolated-policy.ts';
