// ============================================================
// @agentchat/plugins/src/market/tarball.ts —— 安全 tar.gz 解包器
//
// 市场安装的第一道口子：把【不可信】的远程 tarball 解到本地目录。
// 因为内容不可信，这里按"默认拒绝"实现：
//   · 路径逃逸防护：绝对路径 / ".." 段 / Windows 盘符 / 反斜杠全部拒绝
//   · 类型白名单：只解普通文件与目录；符号链接/硬链接/设备/FIFO 一律跳过
//     （插件源码不需要 symlink；跳过而不是报错，避免恶意包打崩安装流程）
//   · 体积上限：单文件 / 总体积 / 文件数三重上限，防 zip-bomb
//   · 截断检测：header 或内容越界直接抛错
//
// 格式支持：USTAR（prefix 字段）+ GNU longname（typeflag 'L'）+ PAX
// path 覆盖（typeflag 'x'/'g'）—— 覆盖 GitHub codeload tarball 的全部形态。
// 不支持 base-256 大尺寸字段（插件包不可能出现，出现即视为畸形）。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { gunzipSync } from 'node:zlib';

export interface ExtractOptions {
  /** 剥掉路径前 N 段（GitHub tarball 顶层是 owner-repo-ref/，通常传 1） */
  stripComponents?: number;
  /** 最大文件数（缺省 2000） */
  maxFiles?: number;
  /** 单文件字节上限（缺省 8 MiB） */
  maxFileBytes?: number;
  /** 总字节上限（缺省 64 MiB） */
  maxTotalBytes?: number;
}

export interface ExtractResult {
  files: number;
  dirs: number;
  bytes: number;
  /** 被跳过的非白名单条目（symlink/hardlink/device 等；审计/提示用） */
  skipped: string[];
}

const BLOCK = 512;

/** 解析 tar 头部 size 字段（八进制，空格/NULL 填充；base-256 视为畸形） */
function parseOctal(field: Buffer): number {
  // GNU base-256：首字节高位为 1 → 拒绝（插件包不该出现）
  if (field[0] && (field[0] & 0x80) !== 0) throw new Error('tar 尺寸字段使用 base-256 编码，视为畸形包');
  let str = '';
  for (const byte of field) {
    if (byte === 0 || byte === 0x20) continue; // NUL / 空格填充
    if (byte < 0x30 || byte > 0x39) throw new Error('tar 尺寸字段含非八进制字符');
    str += String.fromCharCode(byte);
  }
  return str === '' ? 0 : parseInt(str, 8);
}

/** 读取 NUL 结尾字符串字段 */
function readString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

/** 解析 PAX 扩展头记录（"len key=value\n" 序列），返回记录表 */
function parsePaxRecords(content: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  const text = content.toString('utf8');
  while (offset < text.length) {
    const spaceAt = text.indexOf(' ', offset);
    if (spaceAt === -1) break;
    const length = parseInt(text.slice(offset, spaceAt), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > text.length) break;
    const record = text.slice(offset + String(length).length, offset + length).trimEnd();
    const eqAt = record.indexOf('=');
    if (eqAt > 0) out[record.slice(0, eqAt)] = record.slice(eqAt + 1);
    offset += length;
  }
  return out;
}

/** 路径守卫：posix 化、拒绝逃逸，返回规范化相对路径（null = 跳过该条目） */
function safeRelativePath(raw: string): string | null {
  const normalized = raw.replaceAll('\\', '/').replace(/^\/+/, '');
  if (normalized === '') return null;
  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null; // 逃逸
    if (/^[A-Za-z]:$/.test(segment)) return null; // Windows 盘符
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join('/');
}

/**
 * 解包 tar.gz Buffer 到目标目录。
 * @throws 畸形包 / 截断 / 超限 / 路径逃逸（解包中途抛错时已写入的文件留给调用方清理）
 */
export function extractTarGz(archive: Buffer, destDir: string, options: ExtractOptions = {}): ExtractResult {
  const stripComponents = options.stripComponents ?? 1;
  const maxFiles = options.maxFiles ?? 2000;
  const maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;

  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch (err: any) {
    throw new Error(`tarball 解压失败（不是合法 gzip）: ${err?.message ?? String(err)}`);
  }
  if (tar.length < BLOCK) throw new Error('tarball 过短（不足一个 header 块）');

  const result: ExtractResult = { files: 0, dirs: 0, bytes: 0, skipped: [] };
  let offset = 0;
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    // 全零块 = 归档结束
    if (header.every((byte) => byte === 0)) break;

    const name = readString(header.subarray(0, 100));
    const size = parseOctal(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156] || 0x30); // 0x30 = '0'
    const prefix = readString(header.subarray(345, 500));
    const contentStart = offset + BLOCK;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) throw new Error(`tar 条目 "${name}" 内容截断（声明 ${size} 字节，越界）`);

    const content = tar.subarray(contentStart, contentEnd);
    offset = contentStart + Math.ceil(size / BLOCK) * BLOCK; // 内容按块对齐补齐

    // 元数据条目：不落盘，只暂存给下一个真实条目
    if (typeflag === 'L') { pendingLongName = content.toString('utf8').replace(/\0+$/, ''); continue; }
    if (typeflag === 'x' || typeflag === 'X') { pendingPaxPath = parsePaxRecords(content)['path'] ?? null; continue; }

    // 名字优先级：GNU longname > PAX per-file path > USTAR prefix+name
    const rawName = pendingLongName ?? pendingPaxPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingLongName = null;
    pendingPaxPath = null;

    // 非白名单类型：跳过（符号链接/硬链接/设备/FIFO/保留位）
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '5') {
      result.skipped.push(`${rawName}（type ${typeflag}）`);
      continue;
    }

    const safePath = safeRelativePath(rawName);
    if (!safePath) {
      result.skipped.push(`${rawName}（非法路径）`);
      continue;
    }

    // 剥前缀组件（GitHub tarball 顶层 owner-repo-ref/）
    const segments = safePath.split('/');
    if (segments.length <= stripComponents) continue; // 被剥空（顶层目录本身）
    const finalPath = segments.slice(stripComponents).join('/');

    if (typeflag === '5') {
      fs.mkdirSync(path.join(destDir, finalPath), { recursive: true });
      result.dirs++;
      continue;
    }

    if (result.files >= maxFiles) throw new Error(`tar 文件数超限（> ${maxFiles}）`);
    if (size > maxFileBytes) throw new Error(`tar 条目 "${finalPath}" 超单文件上限（${size} > ${maxFileBytes} 字节）`);
    if (result.bytes + size > maxTotalBytes) throw new Error(`tar 总体积超限（> ${maxTotalBytes} 字节）`);

    const target = path.join(destDir, finalPath);
    // 双保险：join 后必须仍在 destDir 内（防御 path.join 平台差异）
    const destRoot = path.resolve(destDir);
    if (!path.resolve(target).startsWith(destRoot + path.sep)) {
      throw new Error(`tar 条目 "${finalPath}" 路径逃逸`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    result.files++;
    result.bytes += size;
  }

  if (result.files === 0 && result.dirs === 0) throw new Error('tarball 中没有可解条目（剥前缀后为空或全部被跳过）');
  return result;
}
