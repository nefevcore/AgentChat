#!/usr/bin/env node
/**
 * build-bundle.mjs —— 组装自包含 npm 发布产物 dist/（cr-702 发布链换轨）
 *
 * 宿主-壳架构 = 宿主 + 按需 spawn 壳 + 浏览器通道装载。发布产物三面：
 *
 * dist/ 布局（AGENTCHAT_HOME 指向此处——运行时资产锚单源，见
 * apps/host/anchors.ts）：
 *   agentchat.mjs        宿主 esbuild bundle（入口 apps/host/boot.ts）
 *   shell.mjs            壳 esbuild bundle（入口 apps/shell/boot.ts）
 *   worker.mjs           run_code 程序化模式 worker（ac-run-code 第二入口，
 *                        存在性守卫——包缺席跳过）
 *   webui/               前端静态产物（apps/ui/dist——需先
 *                        pnpm build:frontend 构建）
 *   plugins/             出厂 UI 通道产物（cr-920：build-channel 直构
 *                        packages/ac-client-ui-* 真身包 30 通道 +
 *                        apps/ui/themes/ 数据面主题包——宿主 boot 播种
 *                        进 <dataRoot>/plugins；不依赖任何数据根预置态）
 *   row-catalog.json     行集目录（宿主/壳共享——从 apps/catalog 拷贝）
 *   profile/             基座源文档 {host,shell}.patch.yml（cr-902 批1）
 *   templates/           内置 Agent 模板配置集（ac-host-rows/templates）
 *   version.json         版本自述（system/version 锚——AGENTCHAT_VERSION_JSON 指路）
 *   CHANGELOG.md         更新日志（system/version-changelog 源）
 *
 * 双入口 spawn 链（宿主 ↔ 壳）：
 *   宿主 spawn 壳 = [node, --experimental-strip-types(无害), <dist>/shell.mjs,
 *   --data-root, ...]（bootFile = anchors.shellBoot 解析产物）；壳侧
 *   subagent/host-revive 的 import.meta.url 自引用在 bundle 内天然正确。
 *   ac-run-code 的 dev/bundle 双入口候选序保持（worker.mjs 与宿主同目录）。
 *
 * 用法：node scripts/build-bundle.mjs（通常经 pnpm build:bundle 调用；
 *       pnpm release:preflight 与 CI 同序五步的一部分）
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const uiDist = path.join(root, 'apps', 'ui', 'dist');
const themesDir = path.join(root, 'apps', 'ui', 'themes');

// ── 前置检查 ──
if (!existsSync(uiDist) || !statSync(uiDist).isDirectory() || readdirSync(uiDist).length === 0) {
  console.error('[build-bundle] 前端产物为空（apps/ui/dist）：请先运行 pnpm build:frontend');
  process.exit(1);
}

// ── 组装 dist/ ──
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(uiDist, path.join(dist, 'webui'), { recursive: true });
cpSync(path.join(root, 'apps', 'catalog', 'row-catalog.json'), path.join(dist, 'row-catalog.json'));
// 基座源文档（cr-902 / cr-901 v2.1 批1）：profile/ 与 row-catalog.json 同目录
// ——readCatalog 双读按 catalogFile 同目录 profile/ 寻基座；host boot 部署链
// 以其为源物化进数据根。
cpSync(path.join(root, 'apps', 'catalog', 'profile'), path.join(dist, 'profile'), { recursive: true });
cpSync(path.join(root, 'packages', 'ac-host-rows', 'templates'), path.join(dist, 'templates'), { recursive: true });
// 出厂通道 v3（cr-932 cutover）：v3 factory 产物直构进各包 client/dist，
// 发布产物携带通道包真身（package.json + src node 半 + client/dist web 半——
// TS 源直载，Node 24 strip-only）。link:packages/... 经 catalog 同级 packages/ 解析。
const r = spawnSync(process.execPath, [path.join(root, 'apps', 'ui', 'scripts', 'build-channel.mjs')], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('[build-bundle] 出厂通道构建失败（build-channel）');
  process.exit(1);
}
const pkgOut = path.join(dist, 'packages');
mkdirSync(pkgOut, { recursive: true });
for (const ent of readdirSync(path.join(root, 'packages'), { withFileTypes: true })) {
  if (!ent.isDirectory() || !ent.name.startsWith('ac-client-ui-')) continue;
  const pkgJson = JSON.parse(readFileSync(path.join(root, 'packages', ent.name, 'package.json'), 'utf8'));
  if (pkgJson.ac?.faces?.web === undefined) continue;
  const dest = path.join(pkgOut, ent.name);
  mkdirSync(dest, { recursive: true });
  cpSync(path.join(root, 'packages', ent.name, 'package.json'), path.join(dest, 'package.json'));
  cpSync(path.join(root, 'packages', ent.name, 'src'), path.join(dest, 'src'), { recursive: true });
  cpSync(path.join(root, 'packages', ent.name, 'client', 'dist'), path.join(dest, 'client', 'dist'), { recursive: true });
}
// 数据面主题包（apps/ui/themes/<name>——v3 打包形态后继〔cr-932 记〕：installed 行 styles-only 通道）
if (existsSync(themesDir)) {
  for (const ent of readdirSync(themesDir, { withFileTypes: true })) {
    if (ent.isDirectory()) cpSync(path.join(themesDir, ent.name), path.join(dist, 'plugins', ent.name), { recursive: true });
  }
}

// ── esbuild 双入口 ──
// Windows TEMP 重定向（cr-558 同族处置：%TEMP% 被实时防护占用时 esbuild
// 写产物/临时文件偶发 Access denied——包内临时目录规避，构建后自清）
const tmpDir = path.join(root, '.tmp-bundle');
if (process.platform === 'win32') {
  mkdirSync(tmpDir, { recursive: true });
  process.env.TEMP = tmpDir;
  process.env.TMP = tmpDir;
}
const requireFromRoot = createRequire(path.join(root, 'package.json'));
let esbuild;
try {
  esbuild = requireFromRoot('esbuild');
} catch {
  console.error('[build-bundle] 无法解析 esbuild（请先 pnpm install）');
  process.exit(1);
}

const banner = { js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);" };
// write:false + node 终写（cr-920：esbuild.exe 在受实时防护约束的机器上被拒
// 直接写产物文件（cr-558 同族——彼时拦 TEMP 临时文件，本机拦终写）——产物
// 从内存 outputFiles 取出，由本进程落盘（node 写不受限），esbuild 零直写。
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node20', banner, logLevel: 'info', write: false };

async function buildEntry(entry, outfile) {
  const r = await esbuild.build({ entryPoints: [entry], ...common });
  const out = r.outputFiles?.[0];
  if (out === undefined) throw new Error('[build-bundle] 无产物面：' + entry);
  writeFileSync(outfile, out.contents);
  console.log('[build-bundle] ' + path.relative(root, outfile) + '  ' + (out.contents.length / 1024).toFixed(0) + 'kb');
}

await buildEntry(path.join(root, 'apps', 'host', 'boot.ts'), path.join(dist, 'agentchat.mjs'));
await buildEntry(path.join(root, 'apps', 'shell', 'boot.ts'), path.join(dist, 'shell.mjs'));

// 程序化模式 worker（ac-run-code——存在性守卫，包缺席跳过）
const workerEntry = path.join(root, 'packages', 'ac-run-code', 'src', 'worker.ts');
if (existsSync(workerEntry)) {
  await buildEntry(workerEntry, path.join(dist, 'worker.mjs'));
} else {
  console.log('[build-bundle] ac-run-code worker 入口缺席——跳过（独立插件形态）');
}

// ── 版本自述 + changelog ──
const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
writeFileSync(path.join(dist, 'version.json'), `${JSON.stringify({ name: rootPkg.name, version: rootPkg.version }, null, 2)}\n`, 'utf8');
if (existsSync(path.join(root, 'CHANGELOG.md'))) {
  cpSync(path.join(root, 'CHANGELOG.md'), path.join(dist, 'CHANGELOG.md'));
}

if (process.platform === 'win32') rmSync(tmpDir, { recursive: true, force: true });
console.log('[build-bundle] dist/ 就绪：', readdirSync(dist).join(', '));
console.log('[build-bundle] 出厂通道：' + readdirSync(path.join(dist, 'plugins')).filter((n) => !n.startsWith('.')).length + ' 个（宿主 boot 播种进 dataRoot/plugins）');
