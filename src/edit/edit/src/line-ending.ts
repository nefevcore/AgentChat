// ============================================================
// line-ending.ts —— BOM 与行尾处理（从 edit-diff.ts 拆出）
//
// 混合换行（CRLF+LF）文件编辑必须按行保留原始行尾，
// 否则未编辑行被强制统一 → 整文件字节污染 → 后续 TAG 全失效。
// ============================================================

export type LineEnding = '\r\n' | '\n' | 'mixed';

/** 剥离 UTF-8 BOM（EF BB BF） */
export function stripBom(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) {
    return content.slice(1);
  }
  return content;
}

/** 检测文件使用的行尾风格（mixed = 同时含 CRLF 与孤立 LF） */
export function detectLineEnding(content: string): LineEnding {
  const hasCrlf = content.includes('\r\n');
  const hasLf = content.includes('\n');
  if (hasCrlf && hasLf) return 'mixed';
  if (hasCrlf) return '\r\n';
  return '\n';
}

/** 将所有行尾统一为 LF */
export function normalizeToLF(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 将 LF 恢复为原始行尾风格（非混合文件路径） */
export function restoreLineEndings(content: string, lineEnding: LineEnding): string {
  if (lineEnding === '\r\n') {
    return content.replace(/\n/g, '\r\n');
  }
  return content;
}

// ── 混合换行：按行保留原始行尾 ──

export interface RawLine { text: string; ending: '\r\n' | '\n' | ''; }

/** 解析原始内容为「行文本 + 行尾」列表（保留每行原始行尾） */
export function parseRawLines(raw: string): RawLine[] {
  const lines: RawLine[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\n') {
      const hasCR = raw[i - 1] === '\r';
      const end = hasCR ? i - 1 : i;
      lines.push({ text: raw.slice(start, end), ending: hasCR ? '\r\n' : '\n' });
      start = i + 1;
    }
  }
  if (start < raw.length) {
    lines.push({ text: raw.slice(start), ending: '' });
  }
  return lines;
}

/**
 * 按行保留原始行尾：newContent（LF 归一化后）的每一行，
 * 若与原始某行文本一致则恢复其原始行尾；新插入行使用文件主导行尾。
 *
 * 解决混合换行文件（CRLF+LF）编辑后被强制统一导致的整文件字节污染
 * （未编辑行被改字节 → git diff 整文件变化 → 后续 TAG 全失效）。
 */
export function restoreLineEndingsPreserving(originalRaw: string, newContent: string): string {
  // BOM 剥离后解析，避免第一行文本带 BOM 匹配不上
  const raw = originalRaw.charCodeAt(0) === 0xfeff ? originalRaw.slice(1) : originalRaw;
  const origLines = parseRawLines(raw);

  // 行文本 → 原始行尾（重复文本取首次出现）
  const endingByText = new Map<string, '\r\n' | '\n' | ''>();
  for (const l of origLines) {
    if (!endingByText.has(l.text)) endingByText.set(l.text, l.ending);
  }

  // 主导行尾：新插入行使用
  const crlfCount = origLines.filter(l => l.ending === '\r\n').length;
  const lfCount = origLines.filter(l => l.ending === '\n').length;
  const dominant: '\r\n' | '\n' = crlfCount > lfCount ? '\r\n' : '\n';
  const origEndsWithNewline = raw.endsWith('\n');

  const newLines = newContent.split('\n');
  const parts: string[] = [];
  for (let i = 0; i < newLines.length; i++) {
    const text = newLines[i];
    const isLast = i === newLines.length - 1;
    if (isLast) {
      // 尾随空串（newContent 以 \n 结尾）→ 无行尾，直接结束
      if (text !== '') {
        parts.push(origEndsWithNewline ? text + dominant : text);
      }
      break;
    }
    const ending = endingByText.get(text) ?? dominant;
    parts.push(text + ending);
  }
  return parts.join('');
}
