// ============================================================
// utils/clipboard-file.ts —— 剪贴板文件补名（ChatInput 粘贴附件用）
//
// 截图/复制的文件常缺扩展名（浏览器给的 blob 名如 'image.png' 之外的
// 空名/无扩展名）——补全后上传端才能正确落 storedName 扩展，图片识别
// （IMAGE_FILE_RE）与多模态物化（MIME 表）才走得通。纯函数，零依赖。
// ============================================================

/** 剪贴板常见 MIME → 扩展名 */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

/** 时间戳（MMdd-HHmmss——补名可读性，同秒多次粘贴不冲突即可） */
function stamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * 无扩展名的剪贴板文件按 MIME 补名（paste-<stamp>.<ext>）；
 * 已有扩展名 / MIME 不在表内 → 原样直通（上传端自有兜底）。
 */
export function ensurePasteName(file: File, now?: Date): File {
  if (file.name && /\.[A-Za-z0-9]+$/.test(file.name)) return file;
  const ext = MIME_EXT[file.type];
  if (!ext) return file;
  return new File([file], `paste-${stamp(now)}.${ext}`, { type: file.type });
}
