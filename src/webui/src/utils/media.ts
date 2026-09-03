// ============================================================
// utils/media.ts —— 图片附件判定、预览直链、内容寻址去重（单源）：
// ChatInput 预览栏 / UserMessage 气泡 chips / 发送引用共用，防漂移。
// ============================================================

/** 图片扩展名（DeepSeek: JPEG/PNG/GIF/WebP；GLM: jpg/png/jpeg——svg 不在列） */
export const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp)$/i;

/** 任一名称（文件名/路径）命中图片扩展名即视为图片附件 */
export function isImageRef(...names: Array<string | undefined | null>): boolean {
  return names.some((n) => typeof n === 'string' && n !== '' && IMAGE_FILE_RE.test(n));
}

/** workspace 文件原始字节直链（/api/workspace/raw 按 MIME 直回——
 *  图片 <img> 缩略图/预览共用；注意不是 /api/workspace/file[JSON+base64]） */
export function filePreviewUrl(path: string): string {
  return `/api/workspace/raw?path=${encodeURIComponent(path)}`;
}

/**
 * 内容寻址哈希（sha1 hex 前 12 位——与服务端 saveUpload 的 hash 同算法）：
 * 粘贴/选择前算出即可对"同内容文件"去重——当前 compose 已挂或本会话
 * 曾上传过（uploadPaths 登记）都跳过网络与落盘。
 */
export async function contentHash12(input: Blob | ArrayBuffer): Promise<string> {
  const buf = input instanceof Blob ? await input.arrayBuffer() : input;
  const digest = await crypto.subtle.digest('SHA-1', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex.slice(0, 12);
}
