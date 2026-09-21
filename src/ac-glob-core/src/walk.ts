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
//   · mtime 遍历期不逐文件 stat（惰性：调用方对命中条目按需补 stat——
//     glob 排序只 stat 匹配集，省掉全量 stat 开销；grep 不需要 mtime）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 遍历时跳过的目录名（缺省口径）。分层：
 * - SKIP_BASE —— VCS 元数据 + 依赖 + Python 缓存（DSH rg --files 口径 + node_modules 实用豁免），
 *   与用户意图无关，任何工具面都不该扫；
 * - SKIP_DIRS —— 在 SKIP_BASE 之上叠加**构建产物/发布副本**目录名（dist/release/node 产物：
 *   09-20 grep 画像 §③——无 path 概念搜索的 60+ 文件命中里近半落在 dist/desktop/release
 *   等生成物，真实源码另在 src/ 下，产物命中是纯噪声且吃掉结果预算）。缺省跳过；
 *   调用方可用 walkOptions.skipDirs 整表覆盖（如明确要搜产物时传 SKIP_BASE 的稳定引用）。
 */
export const SKIP_BASE = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl', 'node_modules', '__pycache__']);
export const SKIP_DIRS = new Set([...SKIP_BASE, 'dist', 'release', 'out', 'build', 'coverage', '.nyc_output', '.vite', '.cache']);

/** 单次扫描的文件数硬顶（防病态工作区；超出置 capped） */
export const MAX_SCAN_FILES = 20000;

/** 收集到的文件条目（rel = 相对基准的 posix 路径；mtimeMs 惰性——由调用方按需补） */
export interface WalkEntry {
  abs: string;
  rel: string;
  /** 文件修改时间（ms）。遍历不再采集；缺省视为 0（glob 排序前对命中集补 stat） */
  mtimeMs?: number;
}

export interface WalkOptions {
  /** rel 相对基准（缺省 rootAbs 自身；返回值可直接作为 read 等工具的路径输入） */
  base?: string;
  /** 敏感路径过滤（缺省全放行；ac-fs-search 注入沙箱黑名单同口径判定） */
  isDenied?: (abs: string) => boolean;
  /** 遍历时跳过的目录名整表覆盖（缺省 SKIP_DIRS——含构建产物目录；明确要搜
   * 产物/发布副本时传 SKIP_BASE 的稳定引用，或自定集合） */
  skipDirs?: Set<string>;
  /** 目录剪枝（缺省不剪；返回 true = 整个子树不进入——rel 与 entries 同基准。
   * 调用方由 glob 模式字面量前缀推导：被剪目录不可能含匹配文件） */
  pruneDir?: (name: string, rel: string) => boolean;
}

/** 平台路径 → posix 分隔（结果相对路径统一 / 风格） */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * 递归收集 rootAbs 下全部常规文件（跳过 SKIP_DIRS/黑名单；有界）。
 * rel 为相对 base 的 posix 路径（缺省相对 rootAbs；基准外回退相对 rootAbs）。
 * skippedRoots = 根层被 skipDirs 跳过的目录段（供调用方在结果 note 里告知——
 * 搜索者若确需搜产物，知道自己被跳过了什么；深层重复段不重复收集）。
 */
export function walkFiles(
  rootAbs: string,
  options: WalkOptions = {},
): { entries: WalkEntry[]; capped: boolean; skippedRoots: string[] } {
  const base = options.base ?? rootAbs;
  const skipDirs = options.skipDirs ?? SKIP_DIRS;
  let rootRel = toPosix(path.relative(base, rootAbs));
  if (rootRel.startsWith('..') || path.isAbsolute(rootRel)) rootRel = ''; // root 在基准外：rel 退化为相对 root 自身
  const entries: WalkEntry[] = [];
  const skippedRoots: string[] = [];
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
        if (skipDirs.has(ent.name)) {
          if (dirRel === rootRel) skippedRoots.push(rel); // 只记根层段（深层是已知目录的内部结构）
          continue;
        }
        if (options.pruneDir?.(ent.name, rel)) continue; // 模式推导剪枝：子树无匹配可能
        visit(abs, rel);
      } else if (ent.isFile()) {
        if (options.isDenied?.(abs)) continue;
        entries.push({ abs, rel });
      }
      // 符号链接等其他类型：跳过（防环；文件发现以常规文件为准）
    }
  };

  visit(rootAbs, rootRel);
  return { entries, capped, skippedRoots };
}
