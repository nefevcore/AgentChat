// ============================================================
// ac-edit-core/src/line-ending.ts —— BOM 与行尾处理
//
// 行尾政策（cr-1000）：仓库统一 LF；*.bat/*.cmd 例外保持 CRLF
//（Windows 批处理执行必需——与 .gitattributes/*.editorconfig 同款）。
// 编辑写回 = 行尾收敛器：非例外文件被编辑一次即归一 LF。
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

/**
 * 写回行尾：*.bat/*.cmd 保持 CRLF（Windows 批处理执行必需），
 * 其余恒 LF——编辑即收敛（cr-1000 行尾统一）。
 */
export function restoreLineEndings(content: string, lineEnding: LineEnding, filePath?: string): string {
  if (lineEnding !== '\n' && filePath !== undefined && /\.(bat|cmd)$/i.test(filePath)) {
    return content.replace(/\n/g, '\r\n');
  }
  return content;
}

export interface RawLine {
  text: string;
  ending: '\r\n' | '\n' | '';
}

/**
 * 修复 CR 双写行尾损伤（\r{2,}\n → \r\n）。
 *
 * 2026-09-21 画像 Ⓑ 实锤形态：带 CRLF 的 new_string 混入 LF 匹配空间后，
 * 写回行尾恢复再叠一层 \r 产出 \r\r\n；后续 normalizeToLF 把 \r\r\n 拆成
 * 空行（\n\n），一次损伤放大成连环失配。读入即修（executor）+ 写回终检
 * （防御性）双向堵截。
 */
export function repairDuplicatedCr(content: string): { fixed: string; count: number } {
  let count = 0;
  const fixed = content.replace(/\r{2,}\n/g, () => {
    count += 1;
    return '\r\n';
  });
  return { fixed, count };
}

// parseRawLines/restoreLineEndingsPreserving 已删（cr-1000：写回恒 LF 后
// 混合换行保留分支不可达；按行保留行尾的历史动机——防未编辑行字节污染——
// 已由「全链 LF」政策消解）
