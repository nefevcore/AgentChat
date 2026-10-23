// ============================================================
// supervisor.mjs —— AgentChat 宿主监护进程（8.9 cutover，cr-556）
//
// 自 src/supervisor.mjs 换轨（主线 boot 退役——旧文件原样保留于 src/，
// 终极回滚 = dev:legacy 脚本 + src/supervisor.mjs）：
//   · worker = preview 宿主 boot（行集目录 + 45 宿主行单树装配）
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
const WORKER_ENTRY = path.join(TRACK_DIR, 'preview', 'apps', 'host', 'boot.ts');
const DEFAULT_DATA_ROOT = path.resolve(TRACK_DIR, 'workspace', 'home');
const DEFAULT_PORT = '3830';
const RUNTIME_LOCK = runtimeLockPath(TRACK_DIR);
// 品牌宿主 exe（cr-620：bin/AgentChatHost.exe 在场即用——任务管理器可辨可杀；缺席回落 node 本体）
const HOST_EXE_PATH = path.join(TRACK_DIR, 'bin', 'AgentChatHost.exe');
const HOST_EXE = existsSync(HOST_EXE_PATH) ? HOST_EXE_PATH : process.execPath;

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
  log(`spawn 宿主: ${HOST_EXE} ${args.join(' ')}`);
  log(`AGENTCHAT_DATA_ROOT=${dataRoot}（宿主持久化目录）`);
  // 监护状态跨代延续：仅更新 childStartedAt（退避的存活基准）
  policyState = policyState === null
    ? initialSupervisionState(Date.now())
    : { ...policyState, childStartedAt: Date.now() };
  child = spawn(HOST_EXE, args, {
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

log('supervisor 启动（8.9 cutover——preview 宿主树）');
startChild();