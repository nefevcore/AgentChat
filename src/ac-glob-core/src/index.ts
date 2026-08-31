// ============================================================
// ac-glob-core —— glob/regex 检索纯库（零 cordis 依赖）
//
// src fs-search 的 glob-regex + walk 原样平移（参数化脱 AgentConfig）：
//   · globToRegExp / normalizeGlobPattern —— glob → RegExp
//     （** 跨层级 / * ? 单段 / {a,b} 交替 / [...] 字符类）
//   · walkFiles —— 有界递归收集（SKIP_DIRS/黑名单回调/mtime；口径统一）
// ac-fs-search 行消费。
// ============================================================
export { globToRegExp, normalizeGlobPattern } from './glob-regex.ts';
export { walkFiles, toPosix, SKIP_DIRS, MAX_SCAN_FILES } from './walk.ts';
export type { WalkEntry, WalkOptions } from './walk.ts';
