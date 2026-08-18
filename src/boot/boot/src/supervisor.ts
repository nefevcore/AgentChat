// ============================================================
// Supervisor —— AgentChat 父进程（Supervisor 模式）
//
// 职责：
//   1. spawn 工作进程（cordis 4 Loader：node_modules/@agentchat/cordis/bin.js）
//   2. 监听退出码：
//       42  = 主动重启 → 重新 spawn
//       其他非 0 = 崩溃 → 重新 spawn（记录错误）
//       0    = 正常退出 → supervisor 一并退出
//   3. 透传 CLI 参数、设置 AGENTCHAT_SUPERVISED=1
//   4. SIGINT/SIGTERM → 转发给子进程（正常退出）
//
// 用法：
//   npx tsx src/boot/boot/src/supervisor.ts [--port=3830] [--workspace=...]
// ============================================================

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const EXIT_RESTART = 42;
// 项目根：向上查找 package.json + 仓库根标记（cordis.yml / pnpm-workspace.yaml）。
// 不能只按 package.json 判断：src/boot/boot 自身也有 package.json，
// 但真正的 AgentChat 根目录在更上层（含 cordis.yml）。
function findRoot(): string {
  // @ts-ignore — __dirname 在 CJS 可用，ESM bundle 用 import.meta.url
  const self = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  let dir = self;
  for (let i = 0; i < 8; i++) {
    const hasPkg = fs.existsSync(path.join(dir, 'package.json'));
    const hasRootMarker = fs.existsSync(path.join(dir, 'cordis.yml')) || fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'));
    if (hasPkg && hasRootMarker) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}
const ROOT = findRoot();
const RESTART_DELAY_MS = 1500; // 端口释放等待

// ── 解析入口 ──
function resolveEntry(): string {
  // 发布包：dist + 配套 tsconfig（baseUrl=./dist，paths 映射 dist/src）→ 用 dist
  const distEntry = path.join(ROOT, 'dist', 'src', 'app', 'index.js');
  const distTsconfig = path.join(ROOT, 'tsconfig.json');
  if (fs.existsSync(distEntry) && fs.existsSync(distTsconfig)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(distTsconfig, 'utf-8'));
      if (String(cfg?.compilerOptions?.baseUrl).startsWith('./dist')) {
        return distEntry;
      }
    } catch { /* 解析失败则回退 */ }
  }
  // 块 E 之后的主入口：DSH 形态组合引导（空 root + 补丁层，读根 cordis.yml）
  const composedEntry = path.join(ROOT, 'src', 'boot', 'boot', 'src', 'loader-boot.ts');
  if (fs.existsSync(composedEntry)) return composedEntry;
  const loaderEntry = path.join(ROOT, 'node_modules', '@agentchat', 'cordis', 'bin.js');
  if (fs.existsSync(loaderEntry)) return loaderEntry;
  const vendorLoaderEntry = path.join(ROOT, 'src', 'vendor', 'cordis', 'bin.js');
  if (fs.existsSync(vendorLoaderEntry)) return vendorLoaderEntry;
  // 兜底：当前文件同目录找 index
  return path.join(__dirname, 'index.js');
}

function needsTsx(entry: string): boolean {
  return entry.endsWith('.ts') || entry.endsWith('bin.js');
}

// ── 参数透传 ──
const passthroughArgs = process.argv.slice(2);

// ── 日志 ──
function log(msg: string): void {
  console.log(`[supervisor] ${new Date().toISOString()} ${msg}`);
}

// ── 子进程管理 ──
let child: ChildProcess | null = null;
let shuttingDown = false;

function startChild(): void {
  const entry = resolveEntry();
  const useTsx = needsTsx(entry);
  const args = useTsx ? [entry, ...passthroughArgs] : ['-r', 'tsconfig-paths/register', entry, ...passthroughArgs];
  // TS 入口 / cordis Loader 需要 tsx（node --import tsx），编译产物直接 node 运行；
  // --expose-internals 供静态行 HMR（cordis-loader 内部 fiber 接口）使用
  if (useTsx) {
    args.unshift('--expose-internals', '--import', 'tsx');
  }

  log(`spawn 工作进程: ${process.execPath} ${args.join(' ')}`);
  log(`AGENTCHAT_SUPERVISED=1（重启约定：exit ${EXIT_RESTART}）`);

  child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, AGENTCHAT_SUPERVISED: '1' },
    stdio: 'inherit',
    shell: false,
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      log('supervisor 退出中，不再拉起');
      return;
    }
    log(`工作进程退出 code=${code} signal=${signal ?? ''}`);

    if (code === EXIT_RESTART) {
      log('检测到主动重启请求 → 重新拉起');
      setTimeout(startChild, RESTART_DELAY_MS);
    } else if (code === 0) {
      log('正常退出 → supervisor 退出');
      process.exit(0);
    } else {
      log(`崩溃退出（code=${code}）→ 重新拉起`);
      setTimeout(startChild, RESTART_DELAY_MS);
    }
  });

  child.on('error', (err) => {
    log(`spawn 失败: ${err.message}`);
  });
}

// ── 信号转发 ──
function forwardSignal(signal: NodeJS.Signals): void {
  log(`收到 ${signal}，转发给子进程`);
  if (child) {
    // Windows 不支持 SIGINT 投递（child.kill('SIGINT') 无效），用无参 kill() = SIGTERM。
    // 子进程 index.ts 已注册 SIGTERM → gracefulShutdown(0)，实现优雅退出。
    if (signal === 'SIGINT' && process.platform === 'win32') {
      child.kill(); // SIGTERM
    } else {
      child.kill(signal);
    }
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

// ── 启动 ──
log('Supervisor 启动');
startChild();
