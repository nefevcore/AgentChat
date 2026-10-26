// ============================================================
// merkle.ts —— Merkle 内容树（R-7 形态裁决）
//
// 主体 = boot 单元的生效行集内容（非仓库非进程）：per-entry（= 包/行）
// 规范化内容子指纹（文件相对路径锚定仓根、EOL 归一、UTF-8、sha256、
// entry 按 id 排序）→ 聚合根。行级子指纹全局唯一：一行可属多主体
//（共享叶、根各异——跨主体归因红利）。「同指纹 ⇒ 同 boot 行为」。
// git commit + dirty = 注释性伴随（缺席不失效，注释里携带）。
// ============================================================

import { createHash } from 'node:crypto';

/** 规范化文件描述（纯函数输入——盘适配负责把 fs 事实变成这个） */
export interface NormalizedFile {
  /** 相对路径（锚定主体根，posix 分隔符，恒以 ./ 起头） */
  path: string;
  /** EOL 归一后的内容（\n） */
  content: string;
}

/** 行（entry）级内容子指纹（全局唯一——共享叶） */
export interface EntryFingerprint {
  /** 行 id（排序键） */
  id: string;
  /** 该行全部规范化文件的内容指纹（sha256 hex） */
  digest: string;
  /** 参与文件数（诊断面） */
  fileCount: number;
}

/** 主体根指纹（boot 单元聚合） */
export interface SubjectFingerprint {
  /** 聚合根（行子指纹按 id 排序后哈希） */
  root: string;
  /** git 注释性伴随（可得时携带，缺席不失效） */
  gitNote?: string;
  /** 参与行集（id → 子指纹——「变了哪行」的机器可读答案） */
  entries: Record<string, string>;
}

const sha256 = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');

/** EOL 归一（CRLF/CR → LF）——跨平台算根不漂移 */
export function normalizeEol(content: string): string {
  return content.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

/** 规范化文件路径（win 反斜杠 → posix；恒 ./ 起头） */
export function normalizePath(p: string): string {
  const posixified = p.replaceAll('\\', '/');
  return posixified.startsWith('./') ? posixified : './' + posixified;
}

/** 单文件内容指纹（路径与内容都进哈希——防同名不同内容与异名同内容歧义） */
export function fileDigest(file: NormalizedFile): string {
  return sha256(file.path + '\u0000' + normalizeEol(file.content));
}

/** 单行（entry）内容子指纹：文件按路径排序后逐文件哈希再聚合 */
export function entryDigest(id: string, files: NormalizedFile[]): EntryFingerprint {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash('sha256');
  h.update(id + '\u0000');
  for (const f of sorted) {
    h.update(fileDigest(f) + '\n');
  }
  return { id, digest: h.digest('hex'), fileCount: files.length };
}

/** 主体聚合根：行子指纹按 id 排序 → 根哈希（git 注释性伴随不进根） */
export function subjectRoot(entries: EntryFingerprint[], gitNote?: string): SubjectFingerprint {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const h = createHash('sha256');
  for (const e of sorted) {
    h.update(e.id + ':' + e.digest + '\n');
  }
  const map: Record<string, string> = {};
  for (const e of sorted) map[e.id] = e.digest;
  return { root: h.digest('hex'), ...(gitNote !== undefined ? { gitNote } : {}), entries: map };
}
