// ============================================================
// disk.ts —— 盘适配：包目录 → 规范化文件集
//
// R-7 残余钉死（cr-494）：per-entry 文件集合清单 = 包目录全量，减显式
// 排除集（node_modules / dist / .git / *.tsbuildinfo / os 垃圾）。出身不问，
// 内容寻址只看生效面——数据根装载行与仓库行同算法。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { entryDigest, normalizePath, type EntryFingerprint, type NormalizedFile } from './merkle.ts';

/** 排除目录名（环境产物，非行内容） */
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', '.vite', 'release']);
/** 排除文件名（构建中间态 / OS 垃圾） */
const EXCLUDED_FILES = new Set(['Thumbs.db', '.DS_Store']);

function isExcluded(name: string): boolean {
  return EXCLUDED_DIRS.has(name) || EXCLUDED_FILES.has(name) || name.endsWith('.tsbuildinfo');
}

/** 递归收集目录下全部规范化文件（相对 entry 根的 posix 路径） */
export function collectFiles(entryRoot: string): NormalizedFile[] {
  const out: NormalizedFile[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 读失败 = 该子树缺席（数据根装载行可能未拉全）——空集不掺假指纹
    }
    for (const ent of entries) {
      if (isExcluded(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const relPath = rel === '' ? ent.name : rel + '/' + ent.name;
      if (ent.isDirectory()) {
        walk(full, relPath);
      } else if (ent.isFile()) {
        out.push({ path: normalizePath(relPath), content: fs.readFileSync(full, 'utf-8') });
      }
      // 符号链接等非普通文件不入指纹（内容寻址只看普通文件面）
    }
  };
  walk(entryRoot, '');
  return out;
}

/** 盘上单行指纹（entryRoot = 该行包目录绝对路径） */
export function fingerprintEntryOnDisk(id: string, entryRoot: string): EntryFingerprint {
  return entryDigest(id, collectFiles(entryRoot));
}
