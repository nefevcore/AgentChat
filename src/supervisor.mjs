// ============================================================
// src/supervisor.mjs —— AgentChat 宿主监护进程
//
// src boot/supervisor.ts 的 preview 形态（地图 §3.3 / 资产 #6）：
//   · 命运隔离铁律：不 import 任何业务包、不读业务配置、不 watch
//     文件——只做 spawn、按协议处置退出、转发停止意图
//   · 退出码协议：42 主动重拉（固定 1.5s）/ 78 启动期失败（不重拉）/
//     0 正常退出 / 其他崩溃（指数退避 + 熔断）
//   · .runtime 单写者锁（wx 排他创建——消灭双启 TOCTOU，M12 ac-timer
//     遗留项的宿主层落点）
//   · worker = 官方 boot 路径（ac-app/src/boot.ts：chdir preview 后
//     复用 vendor cordis bin.js）；--expose-internals 供 hmr 行
//   · 策略纯函数住 ac-supervisor-core（TS 纯库；本脚本经 tsx 加载）
//
// 本文件是纯 JS（.mjs 不经 TS strip-only 加载器）。
// 用法：pnpm preview:supervised
// ============================================================
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SUPERVISION_POLICY,
  EXIT_RESTART,
  acquireRuntimeLock,
  decideOnExit,
  initialSupervisionState,
  runtimeLockPath,
} from 'ac-supervisor-core';

const TRACK_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(TRACK_DIR);
const WORKER_ENTRY = path.join(TRACK_DIR, 'ac-app', 'src', 'boot.ts');
const RUNTIME_LOCK = runtimeLockPath(TRACK_DIR);

function log(msg) {
  console.log(`[supervisor] ${new Date().toISOString()} ${msg}`);
}

// ── .runtime 单写者：双启即拒绝（wx 排他创建，无 TOCTOU 窗口） ──
let unlock;
try {
  unlock = acquireRuntimeLock(RUNTIME_LOCK);
} catch (err) {
  log(`检测到另一实例正在运行（${RUNTIME_LOCK} 已被锁定）：${err.code ?? err.message}`);
  process.exit(78);
}
log(`已获取单写者锁: ${RUNTIME_LOCK}`);

// ── 子进程管理 ──
const passthroughArgs = process.argv.slice(2);
let child = null;
let shuttingDown = false;
let restartTimer;
let policyState = null;
let restartAttempts = 0;

function startChild() {
  restartAttempts += 1;
  // worker 与官方 boot 同参：--expose-internals（hmr 行）+ tsx（TS strip-only）
  const args = ['--expose-internals', '--import', 'tsx', WORKER_ENTRY, ...passthroughArgs];
  log(`spawn 工作进程: ${process.execPath} ${args.join(' ')}`);
  log(`AGENTCHAT_SUPERVISED=1（重启约定：exit ${EXIT_RESTART}）`);
  // 数据根锚点（M18）：worker 的持久化目录 = supervisor 的启动文件夹
  // （INIT_CWD 取回真·启动目录——pnpm 会把脚本 cwd 抬到包根；显式
  // AGENTCHAT_DATA_ROOT 优先）——与 preview:boot 语义一致。
  const dataRoot = process.env.AGENTCHAT_DATA_ROOT
    ?? path.resolve(process.env.INIT_CWD || process.cwd());
  log(`AGENTCHAT_DATA_ROOT=${dataRoot}（worker 持久化目录）`);

  policyState = initialSupervisionState(Date.now());
  child = spawn(process.execPath, args, {
    cwd: TRACK_DIR,
    env: { ...process.env, AGENTCHAT_SUPERVISED: '1', AGENTCHAT_DATA_ROOT: dataRoot },
    stdio: 'inherit',
    shell: false,
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      log('supervisor 退出中，不再拉起');
      return;
    }
    log(`工作进程退出 code=${code} signal=${signal ?? ''}`);

    const ruling = decideOnExit(DEFAULT_SUPERVISION_POLICY, policyState, code, signal, Date.now());
    policyState = ruling.state;
    if (ruling.decision.action === 'restart') {
      log(`第 ${restartAttempts} 次监护决策 → ${(ruling.decision.delayMs / 1000).toFixed(1)}s 后重拉（${ruling.decision.reason}）`);
      restartTimer = setTimeout(startChild, ruling.decision.delayMs);
    } else {
      log(`第 ${restartAttempts} 次监护决策 → supervisor 退出 code=${ruling.decision.exitCode}（${ruling.decision.reason}）`);
      unlock();
      process.exit(ruling.decision.exitCode);
    }
  });

  child.on('error', (err) => {
    log(`spawn 失败: ${err.message}`);
  });
}

// ── 信号转发 ──
function handleSignal(signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    shuttingDown = true;
    if (restartTimer) clearTimeout(restartTimer);
    log(`收到 ${signal}，supervisor 退出（无活子进程）`);
    unlock();
    process.exit(0);
  }
  log(`收到 ${signal}，转发给子进程`);
  // Windows 事实：child.kill() 是硬终止；共享控制台 Ctrl+C 父子双达，
  // worker 侧幂等守卫保证优雅关闭只跑一次
  if (signal === 'SIGINT' && process.platform === 'win32') {
    child.kill();
  } else {
    child.kill(signal);
  }
}

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

if (!existsSync(WORKER_ENTRY)) {
  log(`工作进程入口不存在: ${WORKER_ENTRY}`);
  unlock();
  process.exit(78);
}

log('Supervisor 启动（preview 轨道）');
startChild();
