#!/usr/bin/env node
// AgentChat CLI —— 唯一启动入口
// · agentchat plugin <子命令>  → CLI（dist/cli.mjs；仓库内回退 tsx 跑源码）
// · agentchat web [参数]       → Web 表面（仓库检出 → tsx 跑
//                                loader-boot.ts --profile web-app 组合引导；
//                                发布包 → dist/agentchat.mjs 单文件）
// · 其余参数                   → 运行打包后的 dist/agentchat.mjs（内联全部后端与依赖）
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function run(child) {
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

if (args[0] === 'plugin') {
  const cliArgs = args.slice(1);
  const distCli = path.join(root, 'dist', 'cli.mjs');
  if (existsSync(distCli)) {
    // 发布包：dist/cli.mjs（esbuild 产物，零源码依赖）
    run(spawn(process.execPath, [distCli, ...cliArgs], { cwd: process.cwd(), stdio: 'inherit' }));
  } else {
    // 仓库 dev：tsx 直跑源码入口（与 package.json dev 脚本同一解析路径）
    const srcCli = path.join(root, 'src', 'plugins', 'plugins', 'src', 'market', 'cli.ts');
    run(spawn(process.execPath, ['--import', 'tsx', srcCli, ...cliArgs], { cwd: process.cwd(), stdio: 'inherit' }));
  }
} else if (args[0] === 'web') {
  const rest = args.slice(1);
  // 仓库检出（src 树在）→ tsx 直跑组合引导：dev 场景源码优先，dist 可能是
  // 上次构建的旧形态（不认识 --profile 等新旗标）。
  // 发布包只有 dist（files 不含 src）→ dist 单文件（web 形态 bootstrap）。
  const loaderBoot = path.join(root, 'src', 'boot', 'boot', 'src', 'loader-boot.ts');
  if (existsSync(loaderBoot)) {
    run(spawn(
      process.execPath,
      ['--expose-internals', '--import', 'tsx', loaderBoot, '--profile', 'web-app', ...rest],
      { cwd: process.cwd(), stdio: 'inherit' },
    ));
  } else {
    const distEntry = path.join(root, 'dist', 'agentchat.mjs');
    run(spawn(process.execPath, [distEntry, ...rest], { cwd: process.cwd(), stdio: 'inherit' }));
  }
} else {
  const entry = path.join(root, 'dist', 'agentchat.mjs');
  run(spawn(process.execPath, [entry, ...args], { cwd: process.cwd(), stdio: 'inherit' }));
}
