// ============================================================
// token-vocab.ts —— 令牌词汇契约（B2 主题包通道，cr-693）
//
// ui-tree §2 theme 骨架裁决：令牌词汇住 webui-kit（tokens.css 是
// 词汇定义源）+ 极性归属（暗极/亮极双块）+ 完备性规则——主题包须
// 全量覆盖词汇，缺项回落缺省（CSS 级聞性质，不拒载）。
// 本模块把「词汇表」从 CSS 文本提升为可编程面：主题包审计纯函数
// （服务端 graph 组装与浏览器装载器共用——零 cordis 依赖纯库）。
//
// 词形口径：CUSTOM_PROP 集合 = tokens.css 主题块内定义的 --x 自定义
// 属性名全集（nebula/aurora 块）。:root 主题无关块（几何/字体/动效）
// 不在词汇面——主题只换色，不动版式。
// ============================================================

/**
 * 极性令牌词汇表（tokens.css 双主题块提取）。两极集合恒等（contrast
// 契约测试锁）——主题包同形要求：每个词汇两极各给一值或全缺（缺项
// 回落缺省，CSS 级联语义）。
 */
export const TOKEN_VOCAB: ReadonlySet<string> = new Set([
  'bg-base', 'bg-surface', 'bg-raised', 'bg-hover', 'bg-inset', 'bg-nav', 'bg-glow',
  'elev-hairline',
  'primary', 'primary-strong', 'primary-strong-rgb', 'primary-tint', 'primary-light',
  'primary-tint-strong', 'primary-border-soft', 'primary-border', 'primary-rgb', 'on-primary',
  'text-1', 'text-2', 'text-3', 'text-1-rgb', 'text-2-rgb', 'text-3-rgb',
  'line', 'line-strong',
  'ok', 'warn', 'err', 'ok-status', 'warn-status', 'err-status', 'star',
  'ok-rgb', 'warn-rgb', 'err-rgb',
  'code-bg', 'code-text',
  'shadow-panel', 'shadow-pop', 'shadow-input', 'shadow-dock',
  // shadow-primary-hover 仅 aurora 块内定义（nebula 取 :root 缺省）——词汇口径 = 两极并集
  'shadow-primary-hover',
  'input-border', 'input-focus',
  'scroll-thumb', 'scroll-thumb-hover',
  'role-hover-bg', 'role-hover-text', 'role-selected-bg', 'role-selected-text', 'role-active-bg',
]);

/**
 * 从主题包 CSS 文本提取令牌词集（按极性块锚点切分）。
 * 块锚点 = 主题包约定词形：html[data-theme='<id>']（暗极）与
 * html.light[data-theme='<id>']（亮极）。未匹配锚点 = 空集（调用方
 * 报「缺极性块」）。
 */
export function extractThemeTokens(css: string, id: string): { dark: Set<string>; light: Set<string> } {
  const dark = new Set<string>();
  const light = new Set<string>();
  // 块提取：从锚点起到配对闭括号（支持嵌套 @media）
  const blockOf = (anchor: string): string => {
    const start = css.indexOf(anchor);
    if (start < 0) return '';
    const open = css.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') { depth--; if (depth === 0) return css.slice(open + 1, i); }
    }
    return css.slice(open + 1);
  };
  for (const m of blockOf(`html[data-theme='${id}']`).matchAll(/--([\w-]+)\s*:/g)) dark.add(m[1]!);
  for (const m of blockOf(`html.light[data-theme='${id}']`).matchAll(/--([\w-]+)\s*:/g)) light.add(m[1]!);
  return { dark, light };
}

/** 主题包词汇审计结果 */
export interface ThemeTokenAudit {
  /** 覆盖词汇数 / 词汇总数（按极性分别计） */
  coverage: { dark: number; light: number; total: number };
  /** 词汇表内但主题包未给的词（回落缺省——完备性缺口，warning 不拒载） */
  missing: { dark: string[]; light: string[] };
  /** 主题包给了但不在词汇表的词（未知词——第三方自用变量，warning） */
  unknown: { dark: string[]; light: string[] };
}

/**
 * 主题包词汇完备性审计（纯函数）。设计裁决：缺项回落缺省而非拒载
// ——完备性是 warning 面（诊断 + 装配面板可见），不是装载闸。
 */
export function auditThemeTokens(css: string, id: string): ThemeTokenAudit {
  const { dark, light } = extractThemeTokens(css, id);
  const missing = { dark: [], light: [] } as ThemeTokenAudit['missing'];
  const unknown = { dark: [], light: [] } as ThemeTokenAudit['unknown'];
  for (const t of TOKEN_VOCAB) {
    if (!dark.has(t)) missing.dark.push(t);
    if (!light.has(t)) missing.light.push(t);
  }
  for (const t of dark) if (!TOKEN_VOCAB.has(t)) unknown.dark.push(t);
  for (const t of light) if (!TOKEN_VOCAB.has(t)) unknown.light.push(t);
  return {
    coverage: {
      dark: TOKEN_VOCAB.size - missing.dark.length,
      light: TOKEN_VOCAB.size - missing.light.length,
      total: TOKEN_VOCAB.size,
    },
    missing, unknown,
  };
}
