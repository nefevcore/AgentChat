// ============================================================
// supervisor.mjs —— AgentChat 宿主监护进程（8.9 cutover，cr-556）
//
// 自旧主线 boot 换轨（cr-556；旧 src/ 宿主与 supervisor 已随 cr-703 全仓
// 重组删除——本文件是唯一的仓库级 supervisor 入口）：
//   · worker = apps/host 宿主 boot（行集目录 + 宿主行单树装配）
//   · 数据根缺省 workspace/home（正式数据根；AGENTCHAT_DATA_ROOT 优先）
//   · 端口缺省 3830（与旧主线一致——前端/远程书签零改动）
// 命运隔离铁律不变：不 import 任何业务包、只做 spawn + 退出协议 +
// .runtime 单写者锁（42 主动重拉 / 78 启动失败不拉 / 0 正常退出 /
// 其他 = 指数退避 + 熔断；策略纯函数住 ac-supervisor-core）。
// 用法：pnpm dev:supervised / node supervisor.mjs [--data-root <dir>] [--port <n>]
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
const WORKER_ENTRY = path.join(TRACK_DIR, 'apps', 'host', 'boot.ts');
const DEFAULT_DATA_ROOT = path.resolve(TRACK_DIR, 'workspace', 'home');
const DEFAULT_PORT = '3830';
const RUNTIME_LOCK = runtimeLockPath(TRACK_DIR);
// 品牌单映像 exe（cr-620/624：bin/AgentChat.exe——supervisor/宿主/壳同映像，
// 任务管理器折一行「AgentChat (n)」；缺席回落 node 本体）
const AGENTCHAT_EXE_PATH = path.join(TRACK_DIR, 'bin', 'AgentChat.exe');
const AGENTCHAT_EXE = existsSync(AGENTCHAT_EXE_PATH) ? AGENTCHAT_EXE_PATH : process.execPath;

// 自重-exec 进品牌 exe（cr-623）：supervisor 自身不被品牌化则宿主/壳
// 被杀后仍会被它拉起。bin 缺席（未跑 make-node-identity）= 留在 node
// 本体，行为不变。
if (existsSync(AGENTCHAT_EXE_PATH) && path.resolve(process.execPath) !== path.resolve(AGENTCHAT_EXE_PATH)) {
  const branded = spawn(AGENTCHAT_EXE_PATH, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  branded.on('exit', (code, signal) => {
    process.exit(signal !== null ? 1 : (code ?? 0));
  });
  // 挂起本壳进程（node 包装层）——只做透传与退出码传播，不进监护逻辑
  //（子进程与 pnpm 同终端信号组，SIGINT/SIGTERM 由子进程自处置）。
  await new Promise(() => {});
}

function log(msg) {
  console.log(`[supervisor] ${new Date().toISOString()} ${msg}`);
}

// ── argv：--data-root / --port 透传 worker；其余原样透传 ──
const passthrough = [];
let dataRootOverride = null;
let port = DEFAULT_PORT;
const rawArgs = process.argv.slice(2);
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--data-root') dataRootOverride = rawArgs[++i] ?? null;
  else if (rawArgs[i] === '--port') port = rawArgs[++i] ?? DEFAULT_PORT;
  else passthrough.push(rawArgs[i]);
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
  const dataRoot = dataRootOverride ?? process.env.AGENTCHAT_DATA_ROOT ?? DEFAULT_DATA_ROOT;
  const args = ['--experimental-strip-types', WORKER_ENTRY, '--data-root', dataRoot, '--port', port, ...passthrough];
  log(`spawn 宿主: ${AGENTCHAT_EXE} ${args.join(' ')}`);
  log(`AGENTCHAT_DATA_ROOT=${dataRoot}（宿主持久化目录）`);
  // 监护状态跨代延续：仅更新 childStartedAt（退避的存活基准）
  policyState = policyState === null
    ? initialSupervisionState(Date.now())
    : { ...policyState, childStartedAt: Date.now() };
  child = spawn(AGENTCHAT_EXE, args, {
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
    log(`宿主退出 code=${code} signal=${signal ?? ''}`);
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

if (!existsSync(WORKER_ENTRY)) {
  log(`工作进程入口不存在: ${WORKER_ENTRY}`);
  unlock();
  process.exit(78);
}

log('supervisor 启动（8.9 cutover——apps/host 宿主树）');
startChild();