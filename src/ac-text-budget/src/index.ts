// ============================================================
// ac-text-budget/src/index.ts —— token 估算 / UTF-16 安全截断纯库
//
// src toolkit shared.ts 对应物原样平移（零 cordis 依赖）：
//   · estimateTokens   —— CJK 0.6 / 其他 0.3 近似（阈值判断用）
//   · sanitizeSurrogates —— lone surrogate 替换 U+FFFD（纵深防御）
//   · safeTruncate     —— code unit 长度截断不切代理对
//   · safeClipByTokens —— token 预算截取（keepTail/keepHead）
// read 输出纳入 token 预算截断等工具行消费（地图 §3.4 缺口）。
// ============================================================

/** 估算文本 token 数（CJK 0.6 / 其他 0.3，近似值用于阈值判断） */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    tokens += /[\u4e00-\u9fff]/.test(ch) ? 0.6 : 0.3;
  }
  return Math.ceil(tokens);
}

/** 匹配 lone surrogate（孤立的高/低代理项） */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** 将文本中的 lone surrogate 替换为 U+FFFD（纵深防御） */
export function sanitizeSurrogates(text: string): string {
  if (!text) return text;
  return text.replace(LONE_SURROGATE_RE, '\uFFFD');
}

/** 按 code unit 长度安全截断：不会切断 surrogate pair */
export function safeTruncate(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text;
  let end = maxLen;
  if (end > 0 && end < text.length) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      end -= 1;
    }
  }
  return text.slice(0, end);
}

/**
 * 按 token 预算安全截取（keepTail=true 保留尾部，false 保留头部）。
 * 代理对（high+low）作为一个单位计入 token、完整拼接。
 */
export function safeClipByTokens(text: string, budgetTokens: number, keepTail: boolean): string {
  if (!text) return '';
  if (estimateTokens(text) <= budgetTokens) return text;

  const isCjk = (ch: string) => /[\u4e00-\u9fff]/.test(ch);
  const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
  const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
  let out = '';
  let tokens = 0;
  const markerMargin = 1;

  // 取当前位置的完整字符（代理对或单 code unit）
  const charAt = (i: number): string => {
    const code = text.charCodeAt(i);
    if (isHigh(code) && i + 1 < text.length && isLow(text.charCodeAt(i + 1))) {
      return text[i] + text[i + 1];
    }
    return text[i];
  };

  if (keepTail) {
    // 从尾部累积到预算，保留末尾（代理对完整）
    for (let i = text.length - 1; i >= 0; i--) {
      const code = text.charCodeAt(i);
      if (isLow(code)) continue; // low 随 high 一起处理
      const ch = charAt(i);
      tokens += isCjk(ch) ? 0.6 : 0.3;
      if (tokens + markerMargin > budgetTokens) break;
      out = ch + out;
    }
    return `…${out}`;
  }

  // 保留头部（代理对完整）
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isLow(code)) continue;
    const ch = charAt(i);
    tokens += isCjk(ch) ? 0.6 : 0.3;
    if (tokens + markerMargin > budgetTokens) break;
    out += ch;
  }
  return `${out}…`;
}
