// scripts/build-supervisor.ts —— 用 esbuild 打包 supervisor 为独立 JS
// 解决：本地 dist 路径别名 MODULE_NOT_FOUND + npx/tsx detached 被杀 + Windows .cmd 问题
// 用法：npx esbuild src/supervisor.ts --bundle --platform=node --format=esm --outfile=dist/supervisor.bundle.mjs
import { execSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

const cmd = [
  'npx esbuild src/supervisor.ts',
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--packages=external', // 保留 node_modules 外部引用（发布包已带 node_modules）
  '--outfile=dist/supervisor.bundle.mjs',
  '--log-level=warning',
].join(' ');

console.log(`> ${cmd}`);
execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
console.log('✅ dist/supervisor.bundle.mjs 已生成');
