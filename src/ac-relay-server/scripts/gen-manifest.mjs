#!/usr/bin/env node
// gen-manifest.mjs —— 扫描 downloads/<version>/ 生成/合并 manifest.json
// 用法：node gen-manifest.mjs <downloadsRoot> [gitRepoRoot] [--keep N]
// 产物：downloadsRoot/manifest.json（服务器数据源）；若给 gitRepoRoot 则
// 同时写 <git>/downloads-manifest.json（信任锚——git 存哈希、服务器存字节）。
// --keep N（缺省 0 = 全保留）：只保留最近 N 个版本的目录（版本降序）——
// 更旧版本目录删除（下载面退役），manifest 也只含保留集。小磁盘防膨胀。
import { readdirSync, statSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname, basename } from 'node:path';

const args = process.argv.slice(2);
const keepIdx = args.indexOf('--keep');
const KEEP = keepIdx >= 0 ? Number(args[keepIdx + 1]) || 0 : 0;
const posArgs = args.filter((_, i) => i !== keepIdx && i !== keepIdx + 1);
const [dlRootArg, gitRootArg] = posArgs;
if (!dlRootArg) {
  console.error('usage: node gen-manifest.mjs <downloadsRoot> [gitRepoRoot] [--keep N]');
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
        url: `/${v}/${f}`,
      };
    });
  // 无 per-release date：manifest 每次重算都会刷新日期——无法反映真实发布日期
  // 且无消费方（UI 不展示），字段整体移除（2026-09-23 裁决）。
  if (files.length > 0) releases.push({ version: v, files });
}

const manifest = { updated: new Date().toISOString(), releases };
const out = JSON.stringify(manifest, null, 2);
writeFileSync(join(dlRootArg, 'manifest.json'), out + '\n');
console.log(`[gen-manifest] ${releases.length} release(s) → ${join(dlRootArg, 'manifest.json')}`);

if (gitRootArg) {
  writeFileSync(join(gitRootArg, 'downloads-manifest.json'), out + '\n');
  console.log(`[gen-manifest] trust anchor → ${join(gitRootArg, 'downloads-manifest.json')}`);
}
