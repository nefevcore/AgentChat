// ============================================================
// scripts/sync-office-vendor.mjs —— @vue-office UMD 产物同步
//
// 背景：@vue-office/{docx,excel,pptx} 是 UMD 单文件产物（excel 1.6MB、
// pptx 1.3MB，已 minified 无 sourcemap），进 vite 构建图后每次 build 都要
// 重新 parse + minify，占构建时间约 2/3（33s → 11s 的差距来源）。
// 方案：把三包 lib/index.js 直拷到 src/webui/public/vendor/（vite public
// 目录原样直拷零处理），浏览器侧经 client/officeVendor.ts 动态注入
// <script> 读取全局（UMD 全局名 vue-office-{docx,excel,pptx}）。
//
// 本脚本幂等：目标内容一致时跳过写盘。校验 lib/index.js 与 lib/v3/
// index.js 一致（包的 postinstall 按 vue 版本切换 v2/v3 档——不一致
// 说明切换被绕过，拒绝同步并提示重跑 pnpm install）。
// 挂载：根 package.json 的 webui / webui:build 前置执行。
// ============================================================
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KINDS = ['docx', 'excel', 'pptx'];
const require_ = createRequire(new URL('../src/ac-client-ui-workspace/package.json', import.meta.url));
const vendorDir = fileURLToPath(new URL('../src/webui/public/vendor', import.meta.url));

const md5 = (buf) => createHash('md5').update(buf).digest('hex');

async function sync() {
  let changed = 0;
  await mkdir(vendorDir, { recursive: true });
  for (const kind of KINDS) {
    const pkgDir = path.dirname(require_.resolve(`@vue-office/${kind}/package.json`));
    const lib = path.join(pkgDir, 'lib', 'index.js');
    const v3 = path.join(pkgDir, 'lib', 'v3', 'index.js');
    const [libBuf, v3Buf] = await Promise.all([readFile(lib), readFile(v3).catch(() => null)]);
    if (!v3Buf || md5(libBuf) !== md5(v3Buf)) {
      throw new Error(
        `@vue-office/${kind} 的 lib/index.js 与 lib/v3/index.js 不一致——postinstall 的 vue3 档切换可能被绕过（跳版本安装/缓存残留）。请重跑 pnpm install 后再同步。`,
      );
    }
    const dest = path.join(vendorDir, `vue-office-${kind}.js`);
    const old = await readFile(dest).catch(() => null);
    if (old && old.equals(libBuf)) continue; // 幂等：内容一致跳过
    await writeFile(dest, libBuf);
    console.log(`[sync-office-vendor] vue-office-${kind}.js ← ${libBuf.length} bytes`);
    changed++;
  }
  console.log(changed ? `[sync-office-vendor] 完成（${changed} 个文件更新）` : '[sync-office-vendor] 无变化');
}

sync().catch((err) => {
  console.error('[sync-office-vendor] 失败：', err.message);
  process.exit(1);
});
