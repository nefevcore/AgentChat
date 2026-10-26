#!/usr/bin/env node
// gen-manifest.mjs —— 扫描 downloads/<version>/ 生成/合并 manifest.json
// 用法：node gen-manifest.mjs <downloadsRoot> [gitRepoRoot] [--keep N] [--product desktop|mobile] [--out <file>]
// 产物：downloadsRoot/<manifest.json|mobile-manifest.json>（服务器数据源）；若给
// gitRepoRoot 则同时写 <git>/downloads-manifest.json（信任锚——git 存哈希、服务器存字节）。
// --keep N（缺省 0 = 全保留）：只保留最近 N 个版本的目录（版本降序）——
// 更旧版本目录删除（下载面退役），manifest 也只含保留集。小磁盘防膨胀。
// --product（缺省 desktop）：产物线维度——desktop 扫 <root>/<ver>/、写
// manifest.json；mobile 扫 <root>/<ver>/（根即 downloads/mobile）、写
// mobile-manifest.json。两条产物线各扫各的根，互不混流（cr-306）。
import { readdirSync, statSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname, basename } from 'node:path';

const args = process.argv.slice(2);
function flagOf(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const KEEP = Number(flagOf('--keep')) || 0;
const PRODUCT = flagOf('--product') === 'mobile' ? 'mobile' : 'desktop';
const OUT_NAME = flagOf('--out') ?? (PRODUCT === 'mobile' ? 'mobile-manifest.json' : 'manifest.json');
// --base-url（可选）：url 写成绝对地址（<base>/<ver>/<file>）。mobile 线传
// 下载面绝对 base——安卓更新条直接打开；desktop 线不传，保持相对（现有消费方约定）。
const BASE_URL = typeof flagOf('--base-url') === 'string' ? String(flagOf('--base-url')).replace(/\/+$/, '') : '';
const flagIdx = new Set();
for (const name of ['--keep', '--product', '--out', '--base-url']) {
  const i = args.indexOf(name);
  if (i >= 0) { flagIdx.add(i); flagIdx.add(i + 1); }
}
const posArgs = args.filter((_, i) => !flagIdx.has(i));
const [dlRootArg, gitRootArg] = posArgs;
if (!dlRootArg) {
  console.error('usage: node gen-manifest.mjs <downloadsRoot> [gitRepoRoot] [--keep N] [--product desktop|mobile] [--out <file>]');
  process.exit(2);
}

const PLATFORM_OF_EXT = {
  '.exe': 'windows', '.msi': 'windows',
  '.dmg': 'macos', '.zip': 'macos',
  '.appimage': 'linux', '.deb': 'linux', '.rpm': 'linux',
  '.apk': 'android',
};

function ARCH_OF_NAME(name) {
  const n = name.toLowerCase();
  if (n.includes('arm64') || n.includes('-arm')) return 'arm64';
  if (n.includes('x64') || n.includes('amd64')) return 'x64';
  return 'all';
}

let versions = readdirSync(dlRootArg)
  .filter((d) => /^\d+\.\d+\.\d+$/.test(d) && statSync(join(dlRootArg, d)).isDirectory())
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

// 保留裁剪（--keep N）：旧版本目录退役删除（含日志输出，供 CI 观察清理量）
if (KEEP > 0 && versions.length > KEEP) {
  const retired = versions.slice(0, versions.length - KEEP);
  for (const v of retired) {
    const dir = join(dlRootArg, v);
    const size = readdirSync(dir).reduce((s, f) => { try { return s + statSync(join(dir, f)).size; } catch { return s; } }, 0);
    rmSync(dir, { recursive: true, force: true });
    console.log(`[gen-manifest] 退役 ${v}（${(size / 1048576).toFixed(0)}MB，--keep ${KEEP}）`);
  }
  versions = versions.slice(-KEEP);
}

const releases = [];
for (const v of versions.reverse()) {
  const dir = join(dlRootArg, v);
  const files = readdirSync(dir)
    .filter((f) => statSync(join(dir, f)).isFile() && PLATFORM_OF_EXT[extname(f).toLowerCase()])
    .map((f) => {
      const p = join(dir, f);
      return {
        name: basename(f),
        platform: PLATFORM_OF_EXT[extname(f).toLowerCase()],
        arch: ARCH_OF_NAME(f),
        size: statSync(p).size,
        sha256: createHash('sha256').update(readFileSync(p)).digest('hex'),
        url: BASE_URL ? `${BASE_URL}/${v}/${f}` : `/${v}/${f}`,
      };
    });
  // 无 per-release date：manifest 每次重算都会刷新日期——无法反映真实发布日期
  // 且无消费方（UI 不展示），字段整体移除（2026-09-23 裁决）。
  if (files.length > 0) releases.push({ version: v, files });
}

const manifest = { updated: new Date().toISOString(), releases };
const out = JSON.stringify(manifest, null, 2);
writeFileSync(join(dlRootArg, OUT_NAME), out + '\n');
console.log(`[gen-manifest] [${PRODUCT}] ${releases.length} release(s) → ${join(dlRootArg, OUT_NAME)}`);

if (gitRootArg) {
  writeFileSync(join(gitRootArg, 'downloads-manifest.json'), out + '\n');
  console.log(`[gen-manifest] trust anchor → ${join(gitRootArg, 'downloads-manifest.json')}`);
}
