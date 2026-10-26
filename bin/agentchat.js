#!/usr/bin/env node
// AgentChat CLI —— 唯一启动入口
// · 发布包：dist/agentchat.mjs（cr-702 发布链换轨：宿主 esbuild bundle 入口
//   apps/host/boot.ts；壳 = dist/shell.mjs 按需 spawn；运行时资产
//   〔row-catalog/templates/plugins/webui 静态面〕随 dist 走，AGENTCHAT_HOME
//   注入指路——见 apps/host/anchors.ts）
// · 仓库检出（无 dist 时）：直跑 apps/host/boot.ts（8.9 cutover，
//   cr-556——旧主线 boot 退役；Node ≥22.18 原生 strip-only；数据根 = 启动
//   文件夹 AGENTCHAT_DATA_ROOT 语义不变）
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
  // 发布包：宿主 bundle + 资产面（AGENTCHAT_HOME = dist 安装根——anchors 解析）
  run(spawn(process.execPath, [distEntry, ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, AGENTCHAT_HOME: path.join(root, 'dist'), AGENTCHAT_VERSION_JSON: path.join(root, 'dist', 'version.json') },
  }));
} else {
  // 仓库 dev：与 pnpm dev 同参（apps/host 宿主 boot——cr-556 换轨）。
  // TS 加载 = Node ≥22.18 原生 strip-only；低版本 Node 无原生 strip 时兜底 tsx。
  const bootSrc = path.join(root, 'apps', 'host', 'boot.ts');
  const bootArgs = ['--data-root', path.resolve(process.env.INIT_CWD || process.cwd()), '--port', '3830'];
  // 原生 type stripping 门槛：≥23.6 或 22.18+（LTS 回移）；更早版本走 tsx
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nativeStrip = major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
  if (nativeStrip) {
    run(spawn(process.execPath, ['--experimental-strip-types', bootSrc, ...bootArgs, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, 'tsconfig.json') },
      stdio: 'inherit',
    }));
  } else {
    run(spawn(
      process.execPath,
      ['--experimental-strip-types', '--import', tsxImport(), bootSrc, ...bootArgs, ...args],
      { cwd: process.cwd(), env: tsxEnv(), stdio: 'inherit' },
    ));
  }
}
