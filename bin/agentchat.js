#!/usr/bin/env node
// AgentChat CLI —— 唯一启动入口
// · agentchat plugin <子命令>  → CLI（dist/cli.mjs；仓库内回退 tsx 跑源码）
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
} else {
  const entry = path.join(root, 'dist', 'agentchat.mjs');
  run(spawn(process.execPath, [entry, ...args], { cwd: process.cwd(), stdio: 'inherit' }));
}
