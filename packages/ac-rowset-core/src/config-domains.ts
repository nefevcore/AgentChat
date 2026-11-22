// ============================================================
// config-domains.ts —— 包级配置域聚合（cr-1199）
//
// 全局 config.json 可写域（config/set/save/merge/delete 的白名单
// 单源）：各能力包 package.json 的 ac.configDomains 声明——「读面
// 在哪，写面就归谁注册」（cr-1168 裁决的注册化）。构建期聚合并集
// → row-catalog.json 顶层 configDomains 携带；运行时零扫描。
//
// 与 ac.rows[].configKeys（cr-1037 行内配置键面——patch.yml 校验
// 词汇）语义正交：本面是全局 config.json 顶层域，两词汇不混。
//
// fail-loud：非字符串数组 / 非法域名（须 ^[a-z][A-Za-z0-9]*$ 顶层域
// 词形——点路径进域位即拒：域是顶层键，点路径校验归消费面首段拆分）→
// throw（构建期 gen 即红）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOMAIN_RE = /^[a-z][A-Za-z0-9]*$/;

/**
 * 扫 repoRoot/packages/* 的 ac.configDomains → 域 → 声明包映射
 * （排序稳定）。同域多包重复声明合法（多行共域——settings 由多包
 * 读）：聚合只取并集 + 首个声明包作溯源锚（排序稳定故确定性）。
 */
export function aggregateConfigDomains(repoRoot: string): Record<string, string> {
  const packagesDir = path.join(repoRoot, 'packages');
  const declared = new Map<string, string>();
  for (const name of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const pkgFile = path.join(packagesDir, name.name, 'package.json');
    if (!fs.existsSync(pkgFile)) continue;
    let pkg: { ac?: { configDomains?: unknown } };
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8')) as { ac?: { configDomains?: unknown } };
    } catch (err: unknown) {
      throw new Error('包 package.json 坏 JSON（配置域聚合）：' + pkgFile + '——' + String(err));
    }
    const domains = pkg.ac?.configDomains;
    if (domains === undefined) continue;
    if (!Array.isArray(domains) || !domains.every((d) => typeof d === 'string')) {
      throw new Error('ac.configDomains 必须是字符串数组：' + pkgFile);
    }
    for (const d of domains as string[]) {
      if (!DOMAIN_RE.test(d)) {
        throw new Error('ac.configDomains 域名非法（' + d + '，须 ^[a-z][A-Za-z0-9]*$ 顶层域词形）：' + pkgFile);
      }
    }
    for (const d of [...(domains as string[])].sort()) {
      if (!declared.has(d)) declared.set(d, name.name);
    }
  }
  return Object.fromEntries([...declared.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}
