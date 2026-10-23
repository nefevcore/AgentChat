// ============================================================
// build.mjs —— ui 树构建包装（cr-558：8.5b「Windows esbuild 受阻」根因修复）
//
// 症状：vite build 走到渲染末段（vite:esbuild-transpile）必崩
//   [vite:esbuild-transpile] remove C:\...\Temp\esbuild-<hash>: Access is denied.
// 根因：esbuild 的临时文件落在 %TEMP%，被实时防护扫描占用时删不掉——不是代码问题。
// 处置：Windows 上把 TEMP/TMP 指向包内临时目录（构建后自清），其余平台直跑。
// 用法：pnpm --filter ac-ui-app build
// ============================================================
import { mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(pkgDir, '.tmp-build');
const win = process.platform === 'win32';
if (win) {
  mkdirSync(tmp, { recursive: true });
  process.env.TEMP = tmp;
  process.env.TMP = tmp;
}

const { build } = await import('vite');
let code = 0;
try {
  await build({ root: pkgDir, configFile: path.join(pkgDir, 'vite.config.ts'), mode: 'production' });
} catch {
  code = 1; // vite 自己已打印原因（rollup/esbuild 报错面），此处只留退出码
} finally {
  if (win) rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
