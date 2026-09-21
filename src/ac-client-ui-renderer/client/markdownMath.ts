// ============================================================
// client/markdownMath.ts —— KaTeX 懒装配的就绪信号
//
// 与 hljs-languages 的 hljsLanguageVersion 同款「懒装配补齐」机制：
// 数学引擎装配完成即递增，消费方（computed / useChunkedMarkdown 的
// 重渲染钩子）据此把公式从原文补齐为渲染结果。
//
// 独立成模块的理由：useMarkdown 顶层有 DOM 访问（高亮主题初始化读
// document.documentElement），而分块渲染 composable 要在无 DOM 的
// node 测试环境导入本信号——若信号寄居 useMarkdown，该导入链会把
// DOM 依赖一并带进测试进程。
// ============================================================
import { ref } from 'vue';

/** KaTeX 就绪版本号（0 = 尚未装配；>0 = 已装配，值随每次装配递增） */
export const katexVersion = ref(0);
