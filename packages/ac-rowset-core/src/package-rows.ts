// ============================================================
// package-rows.ts —— 包自述能力行聚合（cr-1033 / menu-assembly §六-5）
//
// 能力定义事实源 = 各包 package.json 的 ac.rows（「包即插件」v2.1 同
// 字段族；先例 ac.faces）。行词汇白名单同基座判据：id / requires /
// description——name 禁自写（聚合器按包根派生 link:——自指冗余 + 漂移
// 面）。多行包合法（ac-shell-rows 承 5 行、ac-web-tools 承 2 行——行
// id 全局唯一不变，包粒度拆合是独立裁决不混入）。
//
// 构建期聚合（gen-row-catalog.mjs）→ row-catalog.json 投影携带；运行
// 时零扫描（消费面经 readCatalog 读投影）。撞名 / 白名单外字段
// fail-loud。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MenuBaseEntry } from './base-docs.ts';

/** 包自述行声明（ac.rows 条目——词汇白名单：id/description/requires） */
export interface PackageRowDecl {
  id: string;
  description?: string;
  requires?: string[];
}

const PACKAGE_ROW_KEYS: readonly string[] = ['id', 'description', 'requires'];

/**
 * 扫 repoRoot 下各包 package.json（packages 目录）的 ac.rows → 能力区条目
 * （name = link: + 包目录仓库相对路径，派生单源；id 排序稳定——投影
 * diff 免抖）。fail-loud：条目缺 id / 白名单外字段 / 跨包撞名。
 */
export function aggregatePackageRows(repoRoot: string): MenuBaseEntry[] {
  const packagesDir = path.join(repoRoot, 'packages');
  const entries: MenuBaseEntry[] = [];
  const seen = new Map<string, string>();
  for (const name of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const pkgFile = path.join(packagesDir, name.name, 'package.json');
    if (!fs.existsSync(pkgFile)) continue;
    let pkg: { ac?: { rows?: unknown } };
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8')) as { ac?: { rows?: unknown } };
    } catch (err: unknown) {
      throw new Error('包 package.json 坏 JSON（能力行聚合）：' + pkgFile + '——' + String(err));
    }
    const decls = pkg.ac?.rows;
    if (decls === undefined) continue;
    if (!Array.isArray(decls)) {
      throw new Error('ac.rows 必须是条目数组：' + pkgFile);
    }
    for (const raw of decls) {
      const e = raw as Record<string, unknown> | null;
      if (typeof e?.id !== 'string') {
        throw new Error('ac.rows 条目缺 id：' + pkgFile);
      }
      for (const key of Object.keys(e)) {
        if (!PACKAGE_ROW_KEYS.includes(key)) {
          throw new Error(
            'ac.rows 行 ' + e.id + ' 含白名单外字段：' + key
            + '（包自述行词汇 = id/description/requires；name 由聚合器派生）：' + pkgFile,
          );
        }
      }
      if (seen.has(e.id)) {
        throw new Error('能力行跨包撞名：' + e.id + '（' + seen.get(e.id) + ' 与 ' + name.name + '）');
      }
      seen.set(e.id, name.name);
      entries.push({
        id: e.id,
        name: 'link:packages/' + name.name,
        ...(typeof e.description === 'string' ? { description: e.description } : {}),
        ...(Array.isArray(e.requires) ? { requires: e.requires as string[] } : {}),
      });
    }
  }
  return entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
