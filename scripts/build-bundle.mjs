#!/usr/bin/env node
/**
 * build-bundle.mjs —— 组装自包含 npm 发布产物 dist/（新轨道）
 *
 * dist/ 内容：
 *   - src/webui/dist/*      前端构建产物（需先 pnpm build:frontend）
 *   - agentchat.mjs         esbuild 打包的后端 bundle（bin/agentchat.js 的入口）
 *   - plugin-catalog.json   内置目录清单（构建期固化——生产源，见下）
 *   - version.json          版本自述（桌面装配的版本锚——version.ts 优先读）
 *   - CHANGELOG.md          更新日志（WebUI 检查更新弹窗数据源）
 *
 * 后端入口 = src/ac-app/src/bootstrap.ts（dist 直调：TREE 静态行表 +
 * 行偏好层 + 单实例锁；Loader/yml 装配是仓库形态，发布包不含 node_modules）。
 * hmr 行不在 TREE（loader 专属），bundle 无热重载——dev 请用仓库检出。
 *
 * plugin-catalog.json（内置目录的生产源）：plugin/catalog 内置组与
 * plugin/rows 行元数据在开发形态靠运行时扫描（src 各 ac-* 行包的
 * package.json + node 解析），bundle 里双空——构建期把「声明
 * agentchat.plugin 的行包元数据 + cordis.yml 行 id↔name 映射」固化为
 * 清单，运行时扫描失败/为空时读它回退（ac-plugin-core/catalog-manifest.ts，
 * AGENTCHAT_PLUGIN_MANIFEST 可显式指路）。装配状态仍是运行时事实——
 * 清单只答"有什么可装"。
 *
 * 用法：node scripts/build-bundle.mjs（通常经 pnpm build:bundle 调用）
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const webuiDist = path.join(root, 'src', 'webui', 'dist');

// ── 前置检查：前端产物必须存在 ──
if (!existsSync(webuiDist) || !statSync(webuiDist).isDirectory() || readdirSync(webuiDist).length === 0) {
  console.error('[build-bundle] 前端产物为空（src/webui/dist）：请先运行 pnpm build:frontend');
  process.exit(1);
}

// ── 组装 dist/（前端产物即 dist 根：bootstrap 以 bundle 所在目录为静态目录） ──
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(webuiDist, dist, { recursive: true });

// ── 后端 bundle：esbuild JS API（与仓库锁定版本一致，跨平台无 CLI 引号问题）──
// esbuild 由 workspace 依赖提升至根 node_modules；createRequire 以根 package.json 为锚点解析。
const requireFromRoot = createRequire(path.join(root, 'package.json'));
let esbuild;
try {
  esbuild = requireFromRoot('esbuild');
} catch {
  console.error('[build-bundle] 无法解析 esbuild（请先 pnpm install）');
  process.exit(1);
}

await esbuild.build({
  entryPoints: [path.join(root, 'src/ac-app/src/bootstrap.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.join(dist, 'agentchat.mjs'),
  // ESM 下 CJS 依赖（如 express）依赖 require；注入 createRequire 桥。
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});

// ── 内置目录清单（生产源；采集判据与 plugin/catalog 的 dev 扫描同款） ──
const srcDir = path.join(root, 'src');
const builtin = [];
for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
  if (!ent.isDirectory() || !ent.name.startsWith('ac-')) continue;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(srcDir, ent.name, 'package.json'), 'utf8'));
  } catch {
    continue; // 缺失/损坏 → 跳过（与运行时扫描同判据）
  }
  if (pkg.name !== ent.name) continue; // 名不符 → 不采信
  if (pkg.agentchat?.plugin !== true) continue; // 纯库/组合根不进目录（X2 收敛）
  builtin.push({
    name: pkg.name,
    ...(typeof pkg.version === 'string' && pkg.version ? { version: pkg.version } : {}),
    ...(typeof pkg.description === 'string' && pkg.description ? { description: pkg.description } : {}),
  });
}
builtin.sort((a, b) => a.name.localeCompare(b.name));

// cordis.yml 全量行（含 disabled——行偏好停用锚点需要未装配行的 id）
const ymlRows = yaml.load(readFileSync(path.join(srcDir, 'cordis.yml'), 'utf8'), {
  schema: yaml.JSON_SCHEMA,
});
if (!Array.isArray(ymlRows)) throw new Error('[build-bundle] src/cordis.yml 顶层必须是行数组');
const rows = [];
for (const row of ymlRows) {
  if (row === null || typeof row !== 'object') continue;
  if (typeof row.id !== 'string' || row.id === '' || typeof row.name !== 'string' || row.name === '') continue;
  rows.push({ id: row.id, name: row.name });
}

const manifest = `${JSON.stringify({ builtin, rows }, null, 2)}\n`;
writeFileSync(path.join(dist, 'plugin-catalog.json'), manifest, 'utf8');

// ── 版本自述 + changelog（更新面锚点，2026-09 更新功能修复批）──
// dist/version.json：桌面装配（resources/agentchat/）附近没有 package.json
// 可走查，版本以 bundle 随身清单为准（ac-web-api version.ts 优先读它）；
// dist/CHANGELOG.md：WebUI「检查更新」弹窗的更新日志源（缺失则弹窗隐藏该节）。
const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
writeFileSync(
  path.join(dist, 'version.json'),
  `${JSON.stringify({ name: rootPkg.name, version: rootPkg.version }, null, 2)}\n`,
  'utf8',
);
if (existsSync(path.join(root, 'CHANGELOG.md'))) {
  cpSync(path.join(root, 'CHANGELOG.md'), path.join(dist, 'CHANGELOG.md'));
}

console.log(`[build-bundle] dist/ 就绪：`, readdirSync(dist).join(', '));
console.log(`[build-bundle] 内置目录清单：${builtin.length} 个插件行 / ${rows.length} 个装配行映射`);
