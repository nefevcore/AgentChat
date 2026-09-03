#!/usr/bin/env node
// AgentChat CLI —— 唯一启动入口
// · 发布包：dist/agentchat.mjs（esbuild 单文件，TREE 静态行表 + 行偏好层
//   + 单实例锁；静态 WebUI 产物与 bundle 同在 dist/）
// · 仓库检出（无 dist 时）：tsx 直跑 src/ac-app/src/boot.ts（= pnpm dev
//   同参；Loader+cordis.yml 装配，支持 hmr 行的 --expose-internals）
// · 参数原样透传（--port=N 覆盖缺省 3830；数据根 = 启动文件夹）
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function run(child) {
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

// tsx 源码路径（仓库检出）需要仓库 tsconfig 的 paths 映射解析 @agentchat/*；
// cwd 是用户 profile 目录时 tsx 按 cwd 找 tsconfig/tsx 包都会失败 → 显式锚定仓库根。
function tsxEnv() {
  return { ...process.env, TSX_TSCONFIG_PATH: path.join(root, 'tsconfig.json') };
}

/** tsx loader 入口（从仓库 node_modules 解析的 file:// URL；--import 在任意 cwd/Windows 可用） */
function tsxImport() {
  try {
    return pathToFileURL(createRequire(path.join(root, 'package.json')).resolve('tsx')).href;
  } catch {
    return 'tsx'; // 仓库外兜底（node_modules 在 cwd 可达时）
  }
}

const distEntry = path.join(root, 'dist', 'agentchat.mjs');
if (existsSync(distEntry)) {
  // 发布包：dist 单文件（内联全部后端行与依赖）
  run(spawn(process.execPath, [distEntry, ...args], { cwd: process.cwd(), stdio: 'inherit' }));
} else {
  // 仓库 dev：与 pnpm dev 同参（--expose-internals 供 hmr 行构造）
  const bootSrc = path.join(root, 'src', 'ac-app', 'src', 'boot.ts');
  run(spawn(
    process.execPath,
    ['--expose-internals', '--import', tsxImport(), bootSrc, ...args],
    { cwd: process.cwd(), env: tsxEnv(), stdio: 'inherit' },
  ));
}
