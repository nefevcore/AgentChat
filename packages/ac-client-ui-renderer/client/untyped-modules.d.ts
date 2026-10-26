// ============================================================
// client/untyped-modules.d.ts —— 无类型声明的第三方依赖垫片
//
// markdown-it-texmath 不发 d.ts（package.json 无 types 入口）；本包在
// noImplicitAny 下动态 import 它（useMarkdown 的 KaTeX 懒路径）需本地
// 环境声明，否则 TS7016。声明面只到「模块存在」，用法侧已显式窄化
// （getMarkdownInstance().use(texmath as never, ...)）。
// ============================================================
declare module 'markdown-it-texmath';
