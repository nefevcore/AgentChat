// ============================================================
// core/extensions/p5.5-policy.ts —— P5.5 纯策略函数（可单测）
//
// 1. rewriteGlobalStyle：global-style slot 的 CSS 消毒/前缀重写
//    · 只允许普通规则 + :root CSS 变量块；拒绝 at-rule / url() 外链
//    · 每个选择器强制加 `.ui-plugin-<scope>` 前缀
// 2. isolated request 白名单：iframe 隔离档只能请求只读 UI/版本/插件目录端点
// 3. isolated event 白名单：只转发插件生命周期事件，不转发聊天/文件内容
// ============================================================

export interface GlobalStyleDef {
  /** 作用域 class（缺省插件名）；最终前缀 = .ui-plugin-<scope> */
  scope?: string;
  /** 只允许 scoped CSS / CSS 变量（:root） */
  css: string;
}

const SAFE_SCOPE_RE = /^[a-zA-Z0-9_-]+$/;
const UNSAFE_PATTERNS = [
  /@import/i,
  /url\s*\(/i,
  /expression\s*\(/i,
  /javascript\s*:/i,
  /<\s*\/?\s*style/i,
];

/** 从 css 中去掉注释，保留字符串内容 */
function stripComments(css: string): string {
  let out = '';
  let i = 0;
  let quote: '"' | "'" | null = null;
  let comment = false;
  while (i < css.length) {
    const ch = css[i];
    const next = css[i + 1];
    if (comment) {
      if (ch === '*' && next === '/') {
        comment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      comment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    out += ch;
    i++;
  }
  return out;
}

/** 按顶层 '}' 切分规则；忽略字符串/括号内的 '}' */
function splitRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  let quote: '"' | "'" | null = null;
  let depth = 0;
  let current = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += css[i + 1] ?? '';
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '{') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth < 0) {
        // 孤立右括号 → 拒绝
        throw new Error('CSS 括号不匹配');
      }
      current += ch;
      if (depth === 0) {
        const open = current.indexOf('{');
        const selector = current.slice(0, open).trim();
        const body = current.slice(open + 1, current.length - 1).trim();
        if (selector && body) rules.push({ selector, body });
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    throw new Error('CSS 存在未闭合规则');
  }
  if (depth !== 0) throw new Error('CSS 括号不匹配');
  return rules;
}

/** 单选择器安全校验（允许普通选择器；禁分号/花括号/反斜杠） */
function assertSelector(selector: string): void {
  if (!selector || selector.includes(';') || selector.includes('{') || selector.includes('}')) {
    throw new Error(`非法选择器: ${selector}`);
  }
}

function rewriteRule(scope: string, selector: string, body: string): string {
  const scopeClass = `.ui-plugin-${scope}`;
  const parts = selector.split(',').map((part) => {
    const sel = part.trim();
    if (!sel) throw new Error('选择器为空');
    assertSelector(sel);

    // :root 规则承载 CSS 变量覆盖（不做前缀重写；变量命名冲突由插件命名规范约束）
    if (sel === ':root') return sel;

    // 已带本插件作用域前缀的选择器不重复加前缀
    if (sel.startsWith(`${scopeClass} `) || sel === scopeClass) return sel;
    if (sel.startsWith(`.${scope}-`) || sel.startsWith(`.${scope} `)) return `${scopeClass} ${sel}`;

    return `${scopeClass} ${sel}`;
  });
  return `${parts.join(',\n')} {\n  ${body}\n}`;
}

/** global-style 消毒 + 前缀重写；任何不满足约束直接抛错（插件加载失败隔离） */
export function rewriteGlobalStyle(pluginName: string, def: GlobalStyleDef): string {
  const scope = def.scope?.trim() || pluginName;
  if (!SAFE_SCOPE_RE.test(scope)) {
    throw new Error(`global-style scope 非法: ${scope}（仅允许字母/数字/下划线/连字符）`);
  }
  if (typeof def.css !== 'string' || def.css.trim() === '') {
    throw new Error('global-style css 不能为空');
  }

  for (const pattern of UNSAFE_PATTERNS) {
    if (pattern.test(def.css)) {
      throw new Error(`global-style 含被禁止的内容: ${pattern.source}`);
    }
  }

  const cleaned = stripComments(def.css);
  const rules = splitRules(cleaned);
  return rules.map(({ selector, body }) => {
    if (selector.startsWith('@')) {
      throw new Error(`global-style 不允许 at-rule: ${selector}`);
    }
    return rewriteRule(scope, selector, body);
  }).join('\n');
}

// ============================================================
// iframe isolated 档 —— 白名单（父窗口执行校验，iframe 无法绕过）
// ============================================================

const ISOLATED_REQUEST_ALLOWLIST: Array<{ method: 'GET'; path: RegExp }> = [
  { method: 'GET', path: /^\/api\/ui\/extensions$/ },
  { method: 'GET', path: /^\/api\/ui\/slots$/ },
  { method: 'GET', path: /^\/api\/config$/ },
  { method: 'GET', path: /^\/api\/version$/ },
  { method: 'GET', path: /^\/api\/plugins\/catalog$/ },
  { method: 'GET', path: /^\/api\/plugins\/permissions$/ },
  { method: 'GET', path: /^\/api\/plugins\/library$/ },
  { method: 'GET', path: /^\/api\/plugins\/assembly\/[a-z0-9_-]+$/ },
];

export function isAllowedIsolatedRequest(method: string, path: string): boolean {
  const normalizedPath = path.split('?')[0] ?? '';
  return ISOLATED_REQUEST_ALLOWLIST.some((entry) => {
    return entry.method === method && entry.path.test(normalizedPath);
  });
}

const ISOLATED_EVENT_ALLOWLIST = new Set([
  'ui.extensions.changed',
  'plugin.catalog.changed',
  'plugin.reload',
  'agent.assembly.changed',
]);

export function isAllowedIsolatedEvent(type: string): boolean {
  return ISOLATED_EVENT_ALLOWLIST.has(type);
}
