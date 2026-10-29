// ============================================================
// supervisor.mjs —— 测试沙箱宿主监护进程（8.9 前置收敛第一批，cr-550；
// cr-527 裁定 supervisor 拉起脚本归 8.9——D6 回退通道物理外置件）
//
// 【双 supervisor 布局，cr-706 注明】与仓库根 supervisor.mjs 的分工：
//   · 根 supervisor.mjs = 产品入口（品牌 exe 自重 exec、读
//     AGENTCHAT_DATA_ROOT、缺省 workspace/home、stdio inherit）——
//     pnpm dev:supervised 用；
//   · 本文件 = 测试沙箱入口（缺省 sandbox/supervised-home、刻意不读
//     env〔隔离红线——env 随 shell 继承会落到主线数据根〕、stdio tee 落
//     dataRoot/.runtime/logs/host-<ts>.log〔cr-662 诊断面〕）。
// 两者的监护策略同源 ac-supervisor-core 纯函数（策略改一处即双入口生效
// ——该一致性由 apps/host/tests/supervisor-parity.test.ts 回归锁）。
// worker 均为 boot.ts（cr-703 后两轨合一）。
//
// 本文件纯 JS（.mjs 不经 TS strip-only 加载器——supervisor 不能依赖被监护物）。
// 用法：node apps/host/supervisor.mjs [--data-root <dir>] [--port <n>]
// ============================================================
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
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
const WORKER_ENTRY = path.join(TRACK_DIR, 'boot.ts');
const DEFAULT_DATA_ROOT = path.resolve(TRACK_DIR, '../../sandbox/supervised-home');
const RUNTIME_LOCK = runtimeLockPath(TRACK_DIR);

function log(msg) {
  console.log(`[preview-supervisor] ${new Date().toISOString()} ${msg}`);
}

// ── argv（--data-root / --port 透传 worker） ──
// 数据根优先级：显式 --data-root > sandbox 缺省。**不读
// AGENTCHAT_DATA_ROOT env**——那是主线宿主的通道（env 随 shell 继承，
// 读它会让 preview supervisor 落到主线数据根——隔离红线，冒烟实证）。
const passthrough = [];
let dataRootOverride = null;
const rawArgs = process.argv.slice(2);
// 逐项扫描（cr-670 修复）：--data-root 取值消费；值形参数成对透传；无值
// 旗标（--mock-provider 等）单独透传——此前固定步进 2 的成对循环会把尾随
// 无值旗标直接丢弃（宿主收不到诊断档标志，壳零 provider run 瞬间 error）。
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--data-root') { dataRootOverride = rawArgs[i + 1] ?? null; i += 1; continue; }
  if (rawArgs[i].startsWith('--') && rawArgs[i + 1] !== undefined && !rawArgs[i + 1].startsWith('--')) {
    passthrough.push(rawArgs[i], rawArgs[i + 1]);
    i += 1;
    continue;
  }
  passthrough.push(rawArgs[i]);
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

let child = null;
let shuttingDown = false;
let restartTimer;
let policyState = null;
let restartAttempts = 0;

function startChild() {
  restartAttempts += 1;
  const dataRoot = dataRootOverride ?? DEFAULT_DATA_ROOT;
  const args = ['--experimental-strip-types', WORKER_ENTRY, '--data-root', dataRoot, ...passthrough];
  log(`spawn 宿主: ${process.execPath} ${args.join(' ')}`);
  log(`AGENTCHAT_DATA_ROOT=${dataRoot}（宿主持久化目录——sandbox 红线）`);
  // 监护状态跨代延续（cr-428 同款）：仅更新 childStartedAt
  policyState = policyState === null
    ? initialSupervisionState(Date.now())
    : { ...policyState, childStartedAt: Date.now() };
  // stderr/stdout tee（cr-662 诊断面）：宿主 stdio 不再 inherit——同时转发
  // supervisor 终端与落 dataRoot/.runtime/logs/host-<ts>.log（每代宿主一文件），
  // 终端关了/滚屏过去诊断现场仍在。
  const logsDir = path.join(dataRoot, '.runtime', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `host-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const logFd = fs.openSync(logPath, 'a');
  const tee = (stream, passthrough) => {
    stream.on('data', (chunk) => {
      passthrough.write(chunk);
      try { fs.writeSync(logFd, chunk); } catch { /* 磁盘满不反噬监护 */ }
    });
  };
  child = spawn(process.execPath, args, {
    cwd: TRACK_DIR,
    env: { ...process.env, AGENTCHAT_SUPERVISED: '1', AGENTCHAT_DATA_ROOT: dataRoot },
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false,
  });
  tee(child.stdout, process.stdout);
  tee(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    try { fs.writeSync(logFd, `=== host exit code=${code ?? 'null'} signal=${signal ?? ''} at ${new Date().toISOString()} ===\n`); fs.closeSync(logFd); } catch { /* 已收 */ }
    if (shuttingDown) {
      log('supervisor 退出中，不再拉起');
      return;
    }
    log(`宿主退出 code=${code} signal=${signal ?? ''}（现场日志 ${logPath}）`);
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

function handleSignal(signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    shuttingDown = true;
    if (restartTimer) clearTimeout(restartTimer);
    log(`收到 ${signal}，supervisor 退出（无活子进程）`);
    unlock();
    process.exit(0);
  }
  log(`收到 ${signal}，转发给子进程`);
  if (signal === 'SIGINT' && process.platform === 'win32') {
    child.kill();
  } else {
    child.kill(signal);
  }
}

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

if (!fs.existsSync(WORKER_ENTRY)) {
  log(`工作进程入口不存在: ${WORKER_ENTRY}`);
  unlock();
  process.exit(78);
}

log('preview supervisor 启动（8.9 前置收敛第一批）');
startChild();
