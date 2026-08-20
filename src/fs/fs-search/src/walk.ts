// ============================================================
// @agentchat/fs-search/src/walk.ts —— 沙箱内递归文件收集
//
// glob/grep 共用的遍历基础：
//   · 跳过版本库元数据（.git/.svn/.hg/.bzr）、node_modules、__pycache__
//     （DSH rg --files 排除 VCS 元数据；node_modules 为原生遍历的实用豁免）
//   · 隐藏文件包含（与 DSH --hidden --no-ignore 口径一致）
//   · 逐文件过 isDeniedPath（.env 等敏感黑名单与 read/write/edit/bash 同口径）
//   · 有界扫描（MAX_SCAN_FILES 硬顶，防病态工作区挂死；capped 标记透出）
//   · 目录项按名称排序（确定序，跨平台结果稳定）；符号链接不跟随（防环）
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { isDeniedPath, sandboxWorkdir } from '@agentchat/toolkit';
import type { AgentConfig } from '@agentchat/agent-config';

/** 遍历时跳过的目录名（VCS 元数据 + 依赖 + Python 缓存；与 DSH 口径一致 + node_modules 实用豁免） */
export const SKIP_DIRS = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl', 'node_modules', '__pycache__']);

/** 单次扫描的文件数硬顶（防病态工作区；超出置 capped） */
export const MAX_SCAN_FILES = 20000;

/** 收集到的文件条目（rel = 相对工作区根的 posix 路径） */
export interface WalkEntry {
  abs: string;
  rel: string;
  mtimeMs: number;
}

/** 递归收集 rootAbs 下全部常规文件（跳过 SKIP_DIRS/黑名单；有界）
 *  rel 为相对沙箱工作目录的 posix 路径（与 resolveSafePath 相对基准一致，
 *  返回值可直接作为 read/grep 等工具的路径输入；越界回退相对 rootAbs） */
export function walkFiles(config: AgentConfig, rootAbs: string): { entries: WalkEntry[]; capped: boolean } {
  const base = sandboxWorkdir(config);
  let rootRel = toPosix(path.relative(base, rootAbs));
  if (rootRel.startsWith('..') || path.isAbsolute(rootRel)) rootRel = ''; // root 在基准外：rel 退化为 root 自身相对
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
        if (isDeniedPath(config, abs)) continue;
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

/** 平台路径 → posix 分隔（结果相对路径统一 / 风格，与 read 的相对路径用法一致） */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
