// ============================================================
// media：图片附件判定 + 预览直链 + 内容寻址哈希（单源工具）
// ============================================================
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { isImageRef, filePreviewUrl, contentHash12 } from '../src/utils/media';

describe('isImageRef', () => {
  it('常见图片扩展名（大小写）命中；路径与文件名任一命中即可', () => {
    expect(isImageRef('paste-0903-153045.png')).toBe(true);
    expect(isImageRef('files/user/_tmp/x.JPG')).toBe(true);
    expect(isImageRef(undefined, 'a.webp')).toBe(true);
    expect(isImageRef(null, '', 'b.jpeg')).toBe(true);
  });

  it('非图片（svg/pdf/txt/无扩展/全空）不命中', () => {
    expect(isImageRef('a.svg')).toBe(false);
    expect(isImageRef('a.pdf')).toBe(false);
    expect(isImageRef('image')).toBe(false);
    expect(isImageRef(undefined, null, '')).toBe(false);
  });
});

describe('filePreviewUrl', () => {
  it('workspace 相对路径 → /api/workspace/raw 字节直链（encodeURIComponent）', () => {
    expect(filePreviewUrl('files/user/_tmp/x.png')).toBe(
      '/api/workspace/raw?path=files%2Fuser%2F_tmp%2Fx.png',
    );
  });
});

describe('contentHash12（与服务端 saveUpload 同算法：sha1 hex 前 12 位）', () => {
  it('Blob 与 ArrayBuffer 输入同值；与 node:crypto sha1 对拍', async () => {
    const data = new TextEncoder().encode('hello world');
    const expected = createHash('sha1').update(data).digest('hex').slice(0, 12);
    expect(await contentHash12(new Blob([data]))).toBe(expected);
    expect(await contentHash12(data.buffer as ArrayBuffer)).toBe(expected);
  });

  it('不同内容不同哈希；空内容稳定', async () => {
    const a = await contentHash12(new Blob([new TextEncoder().encode('a')]));
    const b = await contentHash12(new Blob([new TextEncoder().encode('b')]));
    expect(a).not.toBe(b);
    expect(await contentHash12(new Blob([]))).toBe(
      createHash('sha1').update(new Uint8Array()).digest('hex').slice(0, 12),
    );
  });
});
