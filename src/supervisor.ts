// ============================================================
// Supervisor —— AgentChat 父进程（Supervisor 模式）
//
// 职责：
//   1. spawn 工作进程（src/index.ts 作为主入口）
//   2. 监听退出码：
//       42  = 主动重启 → 重新 spawn
//       其他非 0 = 崩溃 → 重新 spawn（记录错误）
//       0    = 正常退出 → supervisor 一并退出
//   3. 透传 CLI 参数、设置 AGENTCHAT_SUPERVISED=1
//   4. SIGINT/SIGTERM → 转发给子进程（正常退出）
//
// 用法：
//   npx tsx scripts/supervisor.ts [--port=3830] [--workspace=...]
//   或编译后：node dist/scripts/supervisor.js
// ============================================================

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const EXIT_RESTART = 42;
const ROOT = path.resolve(__dirname, '..'); // src/ 的上一级 = 项目根
const RESTART_DELAY_MS = 1500; // 端口释放等待

// ── 解析入口 ──
function resolveEntry(): string {
  // 优先 dist（生产构建，supervisor 被编译到 dist/src/supervisor.js，入口在 dist/src/index.js）
  const distEntry = path.join(ROOT, 'dist', 'src', 'index.js');
  if (fs.existsSync(distEntry)) return distEntry;
  // 否则 tsx 直跑（开发）
  return path.join(ROOT, 'src', 'index.ts');
}

function isTS(entry: string): boolean {
  return entry.endsWith('.ts');
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
  const isTs = isTS(entry);
  const args = ['-r', 'tsconfig-paths/register', entry, ...passthroughArgs];
  // TS 入口需要 tsx 作为加载器（node --import tsx），编译产物直接 node 运行
  if (isTs) {
    args.unshift('--import', 'tsx');
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
    child.kill(signal);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

// ── 启动 ──
log('Supervisor 启动');
startChild();
