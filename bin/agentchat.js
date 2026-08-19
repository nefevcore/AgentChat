#!/usr/bin/env node
// AgentChat CLI —— 唯一启动入口
// · agentchat plugin <子命令>  → CLI（dist/cli.mjs；仓库内回退 tsx 跑源码）
// · agentchat web [参数]       → Web 表面 owner（仓库检出 → tsx 跑
//                                loader-boot.ts --profile web-app 组合引导；
//                                发布包 → dist/agentchat.mjs 单文件）
// · agentchat headless [参数]  → headless 表面 client（不 boot 树：读实例
//                                注册表 → 连 owner WS → 提交一轮 → 流式打印 → 退）
// · 其余参数                   → 运行打包后的 dist/agentchat.mjs（内联全部后端与依赖）
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

if (args[0] === 'plugin') {
  const cliArgs = args.slice(1);
  const distCli = path.join(root, 'dist', 'cli.mjs');
  if (existsSync(distCli)) {
    // 发布包：dist/cli.mjs（esbuild 产物，零源码依赖）
    run(spawn(process.execPath, [distCli, ...cliArgs], { cwd: process.cwd(), stdio: 'inherit' }));
  } else {
    // 仓库 dev：tsx 直跑源码入口（与 package.json dev 脚本同一解析路径）
    const srcCli = path.join(root, 'src', 'plugins', 'plugins', 'src', 'market', 'cli.ts');
    run(spawn(process.execPath, ['--import', tsxImport(), srcCli, ...cliArgs], { cwd: process.cwd(), env: tsxEnv(), stdio: 'inherit' }));
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
      ['--expose-internals', '--import', tsxImport(), loaderBoot, '--profile', 'web-app', ...rest],
      { cwd: process.cwd(), env: tsxEnv(), stdio: 'inherit' },
    ));
  } else {
    const distEntry = path.join(root, 'dist', 'agentchat.mjs');
    run(spawn(process.execPath, [distEntry, ...rest], { cwd: process.cwd(), stdio: 'inherit' }));
  }
} else if (args[0] === 'headless') {
  const rest = args.slice(1);
  // headless 是 client（无组合树），仓库检出与发布包同形：源码优先/回退 dist。
  const srcHeadless = path.join(root, 'src', 'boot', 'boot', 'src', 'headless.ts');
  if (existsSync(srcHeadless)) {
    run(spawn(process.execPath, ['--import', tsxImport(), srcHeadless, ...rest], { cwd: process.cwd(), env: tsxEnv(), stdio: 'inherit' }));
  } else {
    const distHeadless = path.join(root, 'dist', 'headless.mjs');
    if (existsSync(distHeadless)) {
      run(spawn(process.execPath, [distHeadless, ...rest], { cwd: process.cwd(), stdio: 'inherit' }));
    } else {
      console.error('error: headless 不可用（缺 dist/headless.mjs；请运行 pnpm build:bundle）');
      process.exit(1);
    }
  }
} else {
  const entry = path.join(root, 'dist', 'agentchat.mjs');
  run(spawn(process.execPath, [entry, ...args], { cwd: process.cwd(), stdio: 'inherit' }));
}
