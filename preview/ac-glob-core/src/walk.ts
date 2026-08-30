// ============================================================
// ac-glob-core/src/walk.ts —— 递归文件收集（src fs-search walk 参数化平移）
//
// glob/grep 共用的遍历基础（walk 遍历口径统一——地图 §3.4 缺口收敛点）：
//   · 跳过版本库元数据（.git/.svn/.hg/.bzr）、node_modules、__pycache__
//     （DSH rg --files 排除 VCS 元数据；node_modules 为原生遍历的实用豁免）
//   · 隐藏文件包含（与 DSH --hidden --no-ignore 口径一致）
//   · 逐文件过 isDenied 回调（.env 等敏感黑名单与 read/write 同口径——
//     参数化注入，不再耦合 AgentConfig）
//   · 有界扫描（MAX_SCAN_FILES 硬顶，防病态工作区挂死；capped 标记透出）
//   · 目录项按名称排序（确定序，跨平台结果稳定）；符号链接不跟随（防环）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 遍历时跳过的目录名（VCS 元数据 + 依赖 + Python 缓存；与 DSH 口径一致 + node_modules 实用豁免） */
export const SKIP_DIRS = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl', 'node_modules', '__pycache__']);

/** 单次扫描的文件数硬顶（防病态工作区；超出置 capped） */
export const MAX_SCAN_FILES = 20000;

/** 收集到的文件条目（rel = 相对基准的 posix 路径） */
export interface WalkEntry {
  abs: string;
  rel: string;
  mtimeMs: number;
}

export interface WalkOptions {
  /** rel 相对基准（缺省 rootAbs 自身；返回值可直接作为 read 等工具的路径输入） */
  base?: string;
  /** 敏感路径过滤（缺省全放行；ac-fs-search 注入沙箱黑名单同口径判定） */
  isDenied?: (abs: string) => boolean;
}

/** 平台路径 → posix 分隔（结果相对路径统一 / 风格） */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * 递归收集 rootAbs 下全部常规文件（跳过 SKIP_DIRS/黑名单；有界）。
 * rel 为相对 base 的 posix 路径（缺省相对 rootAbs；基准外回退相对 rootAbs）。
 */
export function walkFiles(rootAbs: string, options: WalkOptions = {}): { entries: WalkEntry[]; capped: boolean } {
  const base = options.base ?? rootAbs;
  let rootRel = toPosix(path.relative(base, rootAbs));
  if (rootRel.startsWith('..') || path.isAbsolute(rootRel)) rootRel = ''; // root 在基准外：rel 退化为相对 root 自身
  const entries: WalkEntry[] = [];
  let capped = false;

  const visit = (dirAbs: string, dirRel: string): void => {
    if (entries.length >= MAX_SCAN_FILES) {
      capped = true;
      return;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return; // 无权限/竞争删除：静默跳过该目录
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of dirents) {
      if (entries.length >= MAX_SCAN_FILES) {
        capped = true;
        return;
      }
      const abs = path.join(dirAbs, ent.name);
      const rel = dirRel ? `${dirRel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        visit(abs, rel);
      } else if (ent.isFile()) {
        if (options.isDenied?.(abs)) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(abs).mtimeMs;
        } catch {
          /* 竞争删除：mtime 缺省 0 */
        }
        entries.push({ abs, rel, mtimeMs });
      }
      // 符号链接等其他类型：跳过（防环；文件发现以常规文件为准）
    }
  };

  visit(rootAbs, rootRel);
  return { entries, capped };
}
