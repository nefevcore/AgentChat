// ============================================================
// utils/media.ts —— 图片附件判定、预览直链、内容寻址去重、上传前压缩（单源）：
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

/** 压缩触发的字节数下限：小于它直接原样返回（收益不抵解码/编码开销） */
const COMPRESS_MIN_BYTES = 400 * 1024;

/** 压缩目标最长边（px）：约 2MP（1600×1250 档），多模态识别足够，
 *  移动网络上传统一量级在百 KB 级 */
const COMPRESS_MAX_EDGE = 1600;

/** JPEG 质量档：0.85 视觉近无损，体积约为原图的 5%~15%（拍照兆级图） */
const COMPRESS_JPEG_QUALITY = 0.85;

/**
 * 大图上传前压缩（cr-280）：移动端拍照原图常见 3~12MB，远程链路上行
 * （base64 单帧过 relay）在 15s~120s 超时窗内大概率失败。此处对超过
 * 400KB 的位图解码重采样到约 2MP、JPEG 0.85——典型拍照图压至 200~600KB。
 * 判定按文件名扩展名（isImageRef 同源词表，svg 排除——canvas 栅格化矢量
 * 是降级而非压缩；GIF 排除——多帧动图重编码会丢动画）。
 * 解码/编码失败一律原样返回：压缩是尽力而为的优化，不是上传的前置闸。
 */
export async function maybeCompressImage(file: File): Promise<File> {
  if (file.size <= COMPRESS_MIN_BYTES) return file;
  if (!/\.(png|jpe?g|webp)$/i.test(file.name)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, COMPRESS_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) { bitmap.close(); return file; } // 尺寸本身不大——超重多为高色深，重采样收益低
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close(); return file; }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', COMPRESS_JPEG_QUALITY));
    if (!blob || blob.size >= file.size) return file; // 压完更大（已是高压缩图）——保原件
    // 名字同步换扩展（.png → .jpg）：落盘扩展名决定下游图片识别/物化判定
    const base = file.name.replace(/\.[^.]+$/, '');
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file; // createImageBitmap 不认/内存不足/EXIF 异常——原样上传
  }
}
