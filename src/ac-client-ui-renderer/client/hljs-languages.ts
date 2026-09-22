// ============================================================
// client/hljs-languages.ts —— highlight.js 按需注册中心
//
// 背景（前端性能分析 2026-01）：useMarkdown 曾 `import hljs from
// 'highlight.js'`（全量 ~190 语言）——渲染管线随之膨胀到 1570KB /
// gzip 519KB 的 markdown chunk，且该 chunk 因 AssistantMessage 静态
// 导入而落在首屏关键路径。LLM 输出与文件预览的语言分布高度集中：
// 高频集合同步注册（体积小 × 频率高），其余按需动态 import（独立
// 小 chunk，用过即缓存，多数会话永不加载）。
//
// 对外形状与全量 hljs 兼容：highlight()/getLanguage() 一致。冷门
// 语言首用未命中同步回落转义纯文本（与全量版未知语言同款），异步
// 注册完成后 hljsLanguageVersion 递增 → 消费方重渲染补齐高亮——即
// 「先出内容，后补颜色」，不引入持久视觉差异。
//
// 语言模块可用性以 highlight.js 11.12 实际条目为准（toml 不存在，
// hljs 用 ini 覆盖；abap 由本包 abap-hljs.ts 自研注册，不走本表）。
// ============================================================
import { ref } from 'vue';
import hljs from 'highlight.js/lib/core';

// ── 同步注册集合（高频：体积小 × 出现频率高）──
// 别名（ts/py/html/yml…）由 registerLanguage 依据语言定义内的 aliases
// 自动注册——无需逐一登记（实测 getLanguage('ts'/'py'/'html') 均命中）。
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';
import ini from 'highlight.js/lib/languages/ini';
import plaintext from 'highlight.js/lib/languages/plaintext';

// ── 冷门语言 → 动态 import 映射（按需拉取）──
// key = hljs 语言名；value = 动态 import 工厂（vite 拆为独立 chunk）。
// 刻意收窄：不收录 190+ 全集，只保留工程/脚本中实际会出现的。缺失
// 语言走 hljs 原生「未注册」路径（转义纯文本），行为与全量版一致。
const DYNAMIC_LANGUAGES: Record<string, () => Promise<unknown>> = {
  rust: () => import('highlight.js/lib/languages/rust'),
  go: () => import('highlight.js/lib/languages/go'),
  java: () => import('highlight.js/lib/languages/java'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  php: () => import('highlight.js/lib/languages/php'),
  swift: () => import('highlight.js/lib/languages/swift'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  scala: () => import('highlight.js/lib/languages/scala'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  dart: () => import('highlight.js/lib/languages/dart'),
  lua: () => import('highlight.js/lib/languages/lua'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  cmake: () => import('highlight.js/lib/languages/cmake'),
  groovy: () => import('highlight.js/lib/languages/groovy'),
  scss: () => import('highlight.js/lib/languages/scss'),
  less: () => import('highlight.js/lib/languages/less'),
  shell: () => import('highlight.js/lib/languages/shell'),
};

/**
 * 方言/短码 → 应加载的规范语言名。
 * 消费面传来的常是扩展名或短码（如 rs / rb / kt / ps1），而模块名是
 * 规范名——别名在对应语言注册后由 hljs 自动建立，此处只负责把
 * 「首次请求」路由到正确的模块。
 */
const DYNAMIC_ALIASES: Record<string, string> = {
  rs: 'rust',
  rb: 'ruby',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  cxx: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  ps1: 'powershell',
  docker: 'dockerfile',
  mk: 'makefile',
  gql: 'graphql',
  golang: 'go',
  zsh: 'bash',
  console: 'shell',
  sass: 'scss',
};

/** 语言注册版本号：任何动态语言注册成功即递增（消费方据此重渲染补齐高亮） */
export const hljsLanguageVersion = ref(0);

/** 最近一次注册可用的语言名集合（规范名 + 别名；重渲染相关性判定用） */
export const hljsLastRegistered = ref<readonly string[]>([]);

/** 已请求过的名字（无论成败不重试——失败=网络断/版本变更，重试无益） */
const requested = new Set<string>();

/**
 * 确保语言已注册（异步预热，幂等）。已知映射但尚未注册的语言动态
 * 拉取并注册；未收录语言静默返回（hljs 转义纯文本路径）。渲染路径
 * 可无脑调用——已注册/已请求过的名字零开销返回。
 */
export function ensureHljsLanguage(lang: string): Promise<void> {
  if (!lang || hljs.getLanguage(lang) || requested.has(lang)) return Promise.resolve();
  const canonical = DYNAMIC_ALIASES[lang] ?? lang;
  const loader = DYNAMIC_LANGUAGES[canonical];
  if (!loader) return Promise.resolve();
  requested.add(lang);
  return loader()
    .then((mod) => {
      const def = (mod as { default?: unknown }).default ?? mod;
      if (!def || hljs.getLanguage(canonical)) return;
      hljs.registerLanguage(canonical, def as Parameters<typeof hljs.registerLanguage>[1]);
      hljsLastRegistered.value = [canonical, ...(hljs.getLanguage(canonical)?.aliases ?? [])];
      hljsLanguageVersion.value++;
    })
    .catch(() => undefined); // 拉取失败保持未注册（渲染回落纯文本）
}

// 同步注册高频语言（幂等；模块首次导入时执行一次）
(() => {
  if (hljs.getLanguage('typescript')) return; // 已初始化（HMR/多入口/测试重复导入）
  hljs.registerLanguage('typescript', typescript);
  hljs.registerLanguage('javascript', javascript);
  hljs.registerLanguage('xml', xml);
  hljs.registerLanguage('css', css);
  hljs.registerLanguage('json', json);
  hljs.registerLanguage('python', python);
  hljs.registerLanguage('bash', bash);
  hljs.registerLanguage('yaml', yaml);
  hljs.registerLanguage('sql', sql);
  hljs.registerLanguage('markdown', markdown);
  hljs.registerLanguage('diff', diff);
  hljs.registerLanguage('ini', ini);
  hljs.registerLanguage('plaintext', plaintext);
})();

export { hljs };
