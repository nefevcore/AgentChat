#!/usr/bin/env node
/**
 * build-bundle.mjs —— 组装自包含 npm 发布产物 dist/（cr-702 发布链换轨）
 *
 * preview 架构 = 宿主 + 按需 spawn 壳 + 浏览器通道装载。发布产物三面：
 *
 * dist/ 布局（AGENTCHAT_HOME 指向此处——运行时资产锚单源，见
 * preview/apps/host/anchors.ts）：
 *   agentchat.mjs        宿主 esbuild bundle（入口 preview/apps/host/boot.ts）
 *   shell.mjs            壳 esbuild bundle（入口 preview/apps/shell/boot.ts）
 *   worker.mjs           run_code 程序化模式 worker（ac-run-code 第二入口，
 *                        存在性守卫——包缺席跳过）
 *   webui/               前端静态产物（preview/apps/ui/dist——需先
 *                        pnpm build:frontend 构建 + pnpm build:channels 出厂通道）
 *   plugins/             出厂 UI 通道产物（29 通道 + midnight 主题包——
 *                        宿主 boot 播种进 <dataRoot>/plugins）
 *   row-catalog.json     行集目录（宿主/壳共享——从 preview/apps/catalog 拷贝）
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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const uiDist = path.join(root, 'preview', 'apps', 'ui', 'dist');
const factoryPlugins = path.join(root, 'workspace', 'home', 'plugins');

// ── 前置检查 ──
if (!existsSync(uiDist) || !statSync(uiDist).isDirectory() || readdirSync(uiDist).length === 0) {
  console.error('[build-bundle] 前端产物为空（preview/apps/ui/dist）：请先运行 pnpm build:frontend');
  process.exit(1);
}
for (const ent of readdirSync(factoryPlugins, { withFileTypes: true })) {
  if (ent.isDirectory()) {
    const mf = path.join(factoryPlugins, ent.name, 'manifest.json');
    if (!existsSync(mf)) {
      console.error('[build-bundle] 出厂通道目录缺 manifest.json：' + ent.name + '——先运行 pnpm build:channels');
      process.exit(1);
    }
  }
}

// ── 组装 dist/ ──
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(uiDist, path.join(dist, 'webui'), { recursive: true });
cpSync(path.join(root, 'preview', 'apps', 'catalog', 'row-catalog.json'), path.join(dist, 'row-catalog.json'));
cpSync(path.join(root, 'preview', 'packages', 'ac-host-rows', 'templates'), path.join(dist, 'templates'), { recursive: true });
cpSync(factoryPlugins, path.join(dist, 'plugins'), { recursive: true });

// ── esbuild 双入口 ──
const requireFromRoot = createRequire(path.join(root, 'package.json'));
let esbuild;
try {
  esbuild = requireFromRoot('esbuild');
} catch {
  console.error('[build-bundle] 无法解析 esbuild（请先 pnpm install）');
  process.exit(1);
}

const banner = { js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);" };
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node20', banner, logLevel: 'info' };

await esbuild.build({
  entryPoints: [path.join(root, 'preview', 'apps', 'host', 'boot.ts')],
  outfile: path.join(dist, 'agentchat.mjs'),
  ...common,
});
await esbuild.build({
  entryPoints: [path.join(root, 'preview', 'apps', 'shell', 'boot.ts')],
  outfile: path.join(dist, 'shell.mjs'),
  ...common,
});

// 程序化模式 worker（ac-run-code——存在性守卫，包缺席跳过）
const workerEntry = path.join(root, 'src', 'ac-run-code', 'src', 'worker.ts');
if (existsSync(workerEntry)) {
  await esbuild.build({
    entryPoints: [workerEntry],
    outfile: path.join(dist, 'worker.mjs'),
    ...common,
  });
} else {
  console.log('[build-bundle] ac-run-code worker 入口缺席——跳过（独立插件形态）');
}

// ── 版本自述 + changelog ──
const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
writeFileSync(path.join(dist, 'version.json'), `${JSON.stringify({ name: rootPkg.name, version: rootPkg.version }, null, 2)}\n`, 'utf8');
if (existsSync(path.join(root, 'CHANGELOG.md'))) {
  cpSync(path.join(root, 'CHANGELOG.md'), path.join(dist, 'CHANGELOG.md'));
}

console.log('[build-bundle] dist/ 就绪：', readdirSync(dist).join(', '));
console.log('[build-bundle] 出厂通道：' + readdirSync(path.join(dist, 'plugins')).filter((n) => !n.startsWith('.')).length + ' 个（宿主 boot 播种进 dataRoot/plugins）');
