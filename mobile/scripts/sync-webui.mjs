// 同步 webui dist 进电容壳（mobile/app/www）——方案 §2.4「同步 webui dist 进壳的构建脚本」。
// 用法：node mobile/scripts/sync-webui.mjs [--check]
//   --check 只校验 dist 存在与自洽（CI/前置检查用，不写文件）
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const src = join(repo, 'src/webui/dist');
// 双落点（cr-43 真机实锤）：www 是 Capacitor 工具链中转，gradle 实际打包的
// 是 android/app/src/main/assets/public——只写 www 时 APK 里永远是旧 webui
// （真机加载旧 chunk、html class 空——首个症状）。两处都写，免踩同坑。
const dests = [
  join(repo, 'mobile/app/www'),
  join(repo, 'mobile/app/android/app/src/main/assets/public'),
];
const checkOnly = process.argv.includes('--check');

if (!existsSync(join(src, 'index.html'))) {
  console.error(`[sync-webui] 缺少 ${src}/index.html——先跑 pnpm webui:build`);
  process.exit(1);
}

// 自洽校验：index.html 引用的入口 chunk 必须在 assets/ 里存在
// （缺它 WebView 加载后白屏，且现场难查——M3.2 实测教训）
const html = readFileSync(join(src, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="\/([^"]+)"/g)].map((m) => m[1]);
const missing = refs.filter((r) => !existsSync(join(src, r)));
if (missing.length > 0) {
  console.error(`[sync-webui] dist 不自洽，index.html 引用了不存在的资源：${missing.join(', ')}`);
  process.exit(1);
}
console.log(`[sync-webui] dist 自洽（${refs.length} 个引用均可达，${readdirSync(src).length} 个顶层条目）`);

if (checkOnly) process.exit(0);

// 版本标记：Android 侧 WebuiAssets 据此判断是否需要重新释放 assets（幂等）
const stamp = `${Date.now().toString(36)}-${refs.length}`;
for (const dest of dests) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  writeFileSync(join(dest, 'webui-version.txt'), stamp);
  console.log(`[sync-webui] 已同步 ${src} → ${dest}（版本标记 ${stamp}）`);
}
