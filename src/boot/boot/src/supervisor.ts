// ============================================================
// Supervisor —— AgentChat 父进程（Supervisor 模式，L3 最后防线）
//
// 命运隔离铁律（restart-design §5.1）：不 import 任何 @agentchat/* 业务包、
// 不读业务配置、不 watch 文件——只做三件事：spawn、按协议处置退出、
// 转发停止意图。策略纯函数在 ./supervisor-policy（可单测）。
//
// 职责：
//   1. spawn 工作进程（dev/Loader 路径：loader-boot.ts，--expose-internals）
//   2. 监听退出码（§5.2 协议）：
//       42  = 主动重启 → 固定 1.5s 重拉（不计退避）
//       78  = 启动期配置失败（不会自愈）→ 不重拉，非 0 退出
//       0   = 正常退出 → supervisor 一并退出
//       其他 = 崩溃 → 指数退避重拉（base 1.5s ×2 cap 60s jitter ±20%，
//              存活 ≥30s 归零；10min 内 5 次 → 熔断退出）
//   3. 透传 CLI 参数、设置 AGENTCHAT_SUPERVISED=1
//   4. SIGINT/SIGTERM → 转发停止意图（POSIX 信号；Windows 见 forwardSignal 注释）
//
// 用法：
//   pnpm dev:supervised [--port=3830] [--workspace=...]
// ============================================================

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  DEFAULT_SUPERVISION_POLICY,
  EXIT_RESTART,
  initialSupervisionState,
  decideOnExit,
  type SupervisionPolicy,
  type SupervisionState,
} from './supervisor-policy';

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

/** 监护决策一行结构化日志（§5.9：原因/延迟/第几次/存活时长可透出 WebUI） */
function logDecision(decision: { action: string; delayMs?: number; exitCode?: number; reason: string }, attempts: number): void {
  if (decision.action === 'restart') {
    log(`第 ${attempts} 次监护决策 → ${(decision.delayMs! / 1000).toFixed(1)}s 后重拉（${decision.reason}）`);
  } else {
    log(`第 ${attempts} 次监护决策 → supervisor 退出 code=${decision.exitCode}（${decision.reason}）`);
  }
}

// ── 子进程管理 ──
let child: ChildProcess | null = null;
let shuttingDown = false;
let restartTimer: NodeJS.Timeout | undefined;
let policyState: SupervisionState | null = null;
let restartAttempts = 0;
/** 测试/嵌入注入点（缺省协议常量） */
const POLICY: SupervisionPolicy = DEFAULT_SUPERVISION_POLICY;

function startChild(): void {
  const entry = resolveEntry();
  const useTsx = needsTsx(entry);
  const args = useTsx ? [entry, ...passthroughArgs] : ['-r', 'tsconfig-paths/register', entry, ...passthroughArgs];
  // TS 入口 / cordis Loader 需要 tsx（node --import tsx），编译产物直接 node 运行；
  // --expose-internals 供 hmr 行读 Node 内部 ESM loadCache（L1.5 模块热重载）
  if (useTsx) {
    args.unshift('--expose-internals', '--import', 'tsx');
  }

  restartAttempts += 1;
  log(`spawn 工作进程: ${process.execPath} ${args.join(' ')}`);
  log(`AGENTCHAT_SUPERVISED=1（重启约定：exit ${EXIT_RESTART}）`);

  policyState = initialSupervisionState(Date.now());
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

    const ruling = decideOnExit(POLICY, policyState!, code, signal, Date.now());
    policyState = ruling.state;
    logDecision(ruling.decision, restartAttempts);

    if (ruling.decision.action === 'exit') {
      process.exit(ruling.decision.exitCode);
    }
    restartTimer = setTimeout(startChild, ruling.decision.delayMs);
  });

  child.on('error', (err) => {
    log(`spawn 失败: ${err.message}`);
  });
}

// ── 信号转发 ──
function handleSignal(signal: NodeJS.Signals): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    // 无活子进程：直接退
    shuttingDown = true;
    if (restartTimer) clearTimeout(restartTimer);
    log(`收到 ${signal}，supervisor 退出（无活子进程）`);
    process.exit(0);
  }
  log(`收到 ${signal}，转发给子进程`);
  // POSIX：child.kill(signal) 投递信号，worker 的 gracefulShutdown（幂等）收尾，
  // 子进程退出后由 exit 处置路径带动 supervisor 退出。
  // Windows 事实（§5.4）：child.kill() 是硬终止（TerminateProcess 语义），子进程
  // JS 层 SIGTERM 监听不会执行——定向优雅关闭需 IPC（Phase 3）；当前共享控制台
  // Ctrl+C 父子双达，worker 侧幂等守卫保证只跑一次 gracefulShutdown。
  if (signal === 'SIGINT' && process.platform === 'win32') {
    child.kill(); // SIGTERM
  } else {
    child.kill(signal);
  }
}

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

// ── 启动（仅作为主入口运行时；被 import（boot index 再导出）不 spawn）──
/** 严格 URL 判定（与 bootstrap.ts 同口径）：runner 场景 argv[1] 是 .mjs 入口 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  log('Supervisor 启动');
  startChild();
}
