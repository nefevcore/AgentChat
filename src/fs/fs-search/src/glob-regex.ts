// ============================================================
// @agentchat/fs-search/src/glob-regex.ts —— glob 模式 → RegExp
//
// 语义参考 DSH dsh-tool-fs-search（ripgrep --glob）：
//   · `**` 跨目录层级（`a/**/b` 也匹配 `a/b`；`src/**` 匹配 src 下任意深度）
//   · `*` 单段内任意字符（不含 /）；`?` 单个字符（不含 /）
//   · `{a,b}` 花括号交替（支持嵌套）；`[...]` 字符类原样传递（`[!...]` 取反）
//   · 其余正则元字符按字面量转义
// ============================================================

/** 按顶层（深度 0）逗号切分花括号体；嵌套花括号内的逗号不切 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '{') {
      depth++;
      current += ch;
    } else if (ch === '}') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** 编译 glob 片段为正则源（不锚定；递归处理花括号交替） */
function compileFragment(p: string): string {
  let re = '';
  let i = 0;
  const n = p.length;
  while (i < n) {
    const ch = p[i];
    if (ch === '*') {
      let j = i;
      while (j < n && p[j] === '*') j++;
      const stars = j - i;
      const prevIsSep = i === 0 || p[i - 1] === '/';
      const nextIsSep = p[j] === '/';
      const atEnd = j >= n;
      if (stars >= 2 && prevIsSep && nextIsSep) {
        // globstar 段：`**/` 匹配零个或多个完整路径段
        re += '(?:[^/]*/)*';
        i = j + 1;
      } else if (stars >= 2 && prevIsSep && atEnd) {
        // 尾部 `**`：匹配其余全部（含 /）
        re += '.*';
        i = j;
      } else if (stars >= 2) {
        // 段内 `**`（如 `a**b`）：宽松按任意字符处理
        re += '.*';
        i = j;
      } else {
        re += '[^/]*';
        i = j;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '[') {
      // 字符类：扫描到闭合 ]；`[!...]`/`[^...]` 取反；未闭合按字面量
      let j = i + 1;
      let cls = '';
      if (p[j] === '!' || p[j] === '^') {
        cls += '^';
        j++;
      }
      if (p[j] === ']') {
        cls += '\\]';
        j++;
      }
      while (j < n && p[j] !== ']') {
        cls += p[j] === '\\' ? '\\\\' : p[j];
        j++;
      }
      if (j >= n) {
        re += '\\[';
        i++;
      } else {
        re += `[${cls}]`;
        i = j + 1;
      }
    } else if (ch === '{') {
      let j = i + 1;
      let depth = 1;
      let body = '';
      while (j < n) {
        const c = p[j];
        if (c === '{') {
          depth++;
          body += c;
        } else if (c === '}') {
          depth--;
          if (depth === 0) break;
          body += c;
        } else {
          body += c;
        }
        j++;
      }
      if (depth !== 0) {
        // 未闭合：字面量 {
        re += '\\{';
        i++;
      } else {
        const alts = splitTopLevel(body).map(compileFragment);
        re += alts.length > 1 ? `(?:${alts.join('|')})` : (alts[0] ?? '');
        i = j + 1;
      }
    } else if ('\\.^$|+()}'.includes(ch)) {
      re += '\\' + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return re;
}

/** glob 模式 → 全匹配 RegExp（^...$）。输入应为 posix 风格（/ 分隔）模式 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${compileFragment(pattern)}$`);
}

/** 规整 glob 模式：反斜杠→正斜杠、去开头 ./、去尾部 / */
export function normalizeGlobPattern(pattern: string): string {
  let p = pattern.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  while (p.endsWith('/') && p.length > 1) p = p.slice(0, -1);
  return p;
}
