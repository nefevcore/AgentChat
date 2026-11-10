// ============================================================
// ac-fs-tools/src/eol.ts —— 行尾归一（cr-1000 行尾统一）
//
// 仓库政策：全链 LF；*.bat/*.cmd 例外保持 CRLF（Windows 批处理执行必需，
// 与 .gitattributes / .editorconfig / ac-edit-core restoreLineEndings 同款）。
// read 显示层剥 \r（模型拿干净文本，old_string 复制不再撞行尾）；
// write 写入侧归一（堵 CRLF 内容入库的最大源头）。
// ============================================================

/** Windows 批处理文件：行尾例外的唯一形态 */
export function isBatOrCmd(p: string): boolean {
  return /\.(bat|cmd)$/i.test(p);
}

/** 显示层行尾清洗：CRLF/孤立 CR → LF（bat/cmd 不动——忠实显示） */
export function displayEol(text: string, p: string): string {
  if (isBatOrCmd(p)) return text;
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 写入侧行尾归一：同 displayEol（bat/cmd 保持 CRLF 需调用方显式给 CRLF 内容） */
export function writeEol(text: string, p: string): string {
  return displayEol(text, p);
}
