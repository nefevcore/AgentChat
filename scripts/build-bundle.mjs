#!/usr/bin/env node
/**
 * build-bundle.mjs —— 组装自包含 npm 发布产物 dist/（新轨道）
 *
 * dist/ 内容：
 *   - src/webui/dist/*   前端构建产物（需先 pnpm build:frontend）
 *   - agentchat.mjs      esbuild 打包的后端 bundle（bin/agentchat.js 的入口）
 *
 * 后端入口 = src/ac-app/src/bootstrap.ts（dist 直调：TREE 静态行表 +
 * 行偏好层 + 单实例锁；Loader/yml 装配是仓库形态，发布包不含 node_modules）。
 * hmr 行不在 TREE（loader 专属），bundle 无热重载——dev 请用仓库检出。
 *
 * 用法：node scripts/build-bundle.mjs（通常经 pnpm build:bundle 调用）
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

console.log('[build-bundle] dist/ 就绪：', readdirSync(dist).join(', '));
