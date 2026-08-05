// ============================================================
// token 估算 —— 共享模块（2026-08-02，B3：消除前后端重复实现）
//
// 前后端（src 核心 / webui/server）共用同一套估算逻辑，
// 避免各自维护导致算法漂移。
// ============================================================

/** 可参与 token 估算的消息结构（content / reasoning_content 即可） */
export interface TokenCountable {
  content?: string | null;
  reasoning_content?: string | null;
}

/**
 * 估算文本 token 数。
 * 中文字符约 0.6 token/字，英文字符约 0.3 token/字。
 * 这是一个近似值，用于阈值判断，不要求精确匹配 LLM tokenizer。
 */
export function estimateTokens(text: string | null | undefined): number {
  // 防御：tool 消息的 content 可能为 null（PersistedMessage.content 允许 null），
  // 无保护时 for...of null 抛 TypeError 导致整个会话加载失败。
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    tokens += /[\u4e00-\u9fff]/.test(ch) ? 0.6 : 0.3;
  }
  return Math.ceil(tokens);
}

/** 估算一组消息的 token 数（content + reasoning_content） */
export function estimateMessagesTokens<T extends TokenCountable>(messages: T[]): number {
  return messages.reduce((sum, m) => {
    let t = estimateTokens(m.content);
    if (m.reasoning_content) {
      t += estimateTokens(m.reasoning_content);
    }
    return sum + t;
  }, 0);
}

// ============================================================
// UTF-16 安全截断 / 清洗（2026-08-05，lone surrogate 修复）
//
// 背景：emoji 等非 BMP 字符在 JS 中占 2 个 UTF-16 code unit（surrogate pair）。
// 按 code unit 截断（slice/substring）或逐字符循环 break 时，可能停在代理对中间，
// 产生 lone surrogate。该值无法用 UTF-8 编码，JSON.stringify 会输出 \ud83d 转义文本，
// DeepSeek 网关解析时报 400 "lone leading surrogate"（2026-08-05 归档整理轮实测）。
// ============================================================

/** 匹配 lone surrogate（孤立的高/低代理项） */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * 将文本中的 lone surrogate 替换为 U+FFFD（替换符）。
 * 用于纵深防御：持久化 / 请求前清洗，防止毒数据传播。
 */
export function sanitizeSurrogates(text: string): string {
  if (!text) return text;
  return text.replace(LONE_SURROGATE_RE, '\uFFFD');
}

/** 判断字符是否为 high surrogate（代理对前半） */
function isHighSurrogate(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0xD800 && code <= 0xDBFF;
}

/**
 * 按 code unit 长度安全截断：不会切断 surrogate pair。
 * 若截断点落在 high surrogate 上（其 low surrogate 被切掉），回退一位。
 */
export function safeTruncate(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text;
  let end = maxLen;
  // 若 end-1 是 high surrogate 且 end 处（被切掉的位置）是 low surrogate → 回退
  if (end > 0 && end < text.length) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) {
      end -= 1;
    }
  }
  return text.slice(0, end);
}

/**
 * 按 token 预算安全截取（clipByTokens 的 UTF-16 安全版）。
 * 与原实现逻辑一致（CJK 0.6 / 其他 0.3），仅修复代理对截断。
 * 代理对（high+low）作为一个单位计入 token、完整拼接。
 */
export function safeClipByTokens(text: string, budgetTokens: number, keepTail: boolean): string {
  if (!text) return '';
  if (estimateTokens(text) <= budgetTokens) return text;

  const isCjk = (ch: string) => /[\u4e00-\u9fff]/.test(ch);
  const isHigh = (code: number) => code >= 0xD800 && code <= 0xDBFF;
  const isLow = (code: number) => code >= 0xDC00 && code <= 0xDFFF;
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
