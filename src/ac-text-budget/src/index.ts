// ============================================================
// ac-text-budget/src/index.ts —— token 估算 / UTF-16 安全截断纯库
//
// 五个运行时词四类消费（工具行截断 / 落盘清洗 / 请求体兜底 / 阈值估算）：
//   · estimateTokens    —— CJK 0.6 / 其他 0.3 近似（阈值判断用）
//   · safeClipByTokens  —— token 预算截取（keepTail/keepHead，不切代理对）
//   · safeTruncate      —— code unit 长度截断不切代理对
//   · sanitizeSurrogates —— lone surrogate 替换 U+FFFD（字符串面清洗）
//   · sanitizeJsonLine  —— JSON 行/请求体文本级清洗（转义面兜底）
//
// lone surrogate 三防线（2026-08-05 归档轮 DeepSeek 400 事故，9c6f8fdf）：
// 根修 = 截断不切代理对（safeClipByTokens/safeTruncate）；纵深 = 落盘前
// 字符串面清洗（sanitizeSurrogates——内存字段粒度）；兜底 = 序列化后
// 转义文本级清洗（sanitizeJsonLine——行/请求体粒度，JSON.stringify 对
// lone surrogate 输出 \udXXX 转义文本而非 U+FFFD）。
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

/** 将文本中的 lone surrogate 替换为 U+FFFD（字符串面清洗——内存字段粒度） */
export function sanitizeSurrogates(text: string): string {
  if (!text) return text;
  return text.replace(LONE_SURROGATE_RE, '\uFFFD');
}

/**
 * JSON 行/请求体文本级清洗（转义面兜底）：JSON.stringify 对 lone surrogate
 * 输出 \udXXX 转义文本（Node 20+ well-formed 序列化），网关解析时报
 * 400 "lone leading surrogate"（DeepSeek 2026-08-05 实测）。本函数在已
 * 序列化的文本上把孤立转义对（后无 low 转义跟随的 high 转义 / 前无 high
 * 转义的 low 转义）替换为 \ufffd。成对转义（合法代理对的序列化产物）不动。
 */
export function sanitizeJsonLine(text: string): string {
  return text
    .replace(/\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})/g, '\\ufffd')
    .replace(/(?<!\\u[dD][89abAB][0-9a-fA-F]{2})\\u[dD][c-fC-F][0-9a-fA-F]{2}/g, '\\ufffd');
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
