// ============================================================
// ac-plugin-market/src/tarball.ts —— tar.gz 内存解包纯函数（零依赖）
//
// npm registry tarball（前缀 package/）与 github codeload tarball
// （前缀 <repo>-<ref>/）共用：gunzip 后按 512 字节头解析条目，剥掉首段
// 路径前缀写入目标目录。仅支持常规文件与目录（链接/扩展头跳过）——
// 插件分发的实际形状。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

/** tar 头 512 字节中的字符串字段读取（NUL 截断） */
function field(header: Buffer, offset: number, length: number): string {
  return header.subarray(offset, offset + length).toString('utf-8').replace(/\0.*$/s, '').trim();
}

/** 八进制字段（tar 以 NUL/space 结尾；GNU 空间 base-256 变体不支持——插件 tar 不会出现） */
function octal(header: Buffer, offset: number, length: number): number {
  const raw = field(header, offset, length);
  return raw ? parseInt(raw, 8) || 0 : 0;
}

/**
 * 解包 tar.gz 到目标目录（内存整读——插件体积小；失败抛错）。
 * @param stripComponents 剥掉的首段路径层数（npm/github tarball 顶层目录）
 */
export function extractTarGz(gz: Buffer, destDir: string, stripComponents: number): number {
  const buf = zlib.gunzipSync(gz);
  fs.mkdirSync(destDir, { recursive: true });
  let offset = 0;
  let files = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    const name = field(header, 0, 100);
    if (!name) break; // 结束块（两块全零）
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156]);
    const prefix = field(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    offset += 512;
    const data = buf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    const parts = fullName.split('/').filter(Boolean);
    if (parts.length <= stripComponents) continue;
    const rel = parts.slice(stripComponents).join('/');
    if (rel.startsWith('..') || rel.includes('/../') || path.isAbsolute(rel)) continue; // 防穿越
    const target = path.join(destDir, rel);
    if (type === '5' || fullName.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    if (type !== '0' && type !== '\0') continue; // 链接/PAX 头等跳过
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files++;
  }
  return files;
}
