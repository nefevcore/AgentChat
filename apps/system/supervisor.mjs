// ============================================================
// supervisor.mjs —— system 层入口（supervisor-service-plan；cr-859 自仓库根
// 纯移动至 apps/system/——§六.1 允许的妥协：零 import 变化，cordis 不行）
//
// 【产品入口】pnpm dev（cr-859 §六.2 统一 supervised）/ node apps/system/supervisor.mjs。
// 测试沙箱形态见 apps/host/supervisor.mjs（缺省数据根/env 读取差异——cr-706
// 双布局注明；监护策略同源 ac-supervisor-core，一致性由
// apps/host/tests/supervisor-parity.test.ts 回归锁）。
//
// system 层增量面（§五，cr-859）：
//   · 心跳面（§五.2）：锁获取后 init 心跳文件 + 周期 touch——对象侧
//     （壳/host-revive）以「锁内 pid 活 ∧ 心跳新鲜」双证据判定 system
//     在场（取代 AGENTCHAT_SUPERVISED env 继承链——第三方重拉壳后失真）。
//   · 配方盘面（§五.1）：锁获取后写 host resident 配方——宿主 argv 落盘，
//     system 缺席时任何活进程可按盘面执行恢复（§三恢复边降级语义）。
//
// 自旧主线 boot 换轨（cr-556）：worker = apps/host 宿主 boot；数据根缺省
// workspace/home（AGENTCHAT_DATA_ROOT 优先）；端口缺省 3830。命运隔离
// 铁律不变：不 import 任何业务包（ac-supervisor-core 纯库除外——零 cordis）。
// 退出码协议：42 主动重拉 / 78 启动失败不拉 / 0 正常退出 / 其他 = 指数退避
// + 熔断（策略纯函数住 ac-supervisor-core）。
// 用法：pnpm dev / node apps/system/supervisor.mjs [--data-root <dir>] [--port <n>]
// ============================================================
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SUPERVISION_POLICY,
  EXIT_RESTART,
  acquireRuntimeLock,
  decideOnExit,
  initialSupervisionState,
  initSystemHeartbeat,
  removeRecipe,
  runtimeLockPath,
  touchSystemHeartbeat,
  writeRecipe,
} from 'ac-supervisor-core';

// 锚仓库根（cr-859 §六.1 纯移动）：.runtime 锁 / 缺省数据根 / worker 路径
// 全部保持移动前坐标——锁不换代、双 supervisor 仲裁语义不变。
const TRACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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

// ── system 心跳面（§五.2）+ 配方盘面（§五.1，cr-859）──
// 心跳：锁获取即 init + 周期 touch（2s 周期、新鲜窗 10s——探侧
// SYSTEM_HEARTBEAT_FRESH_MS 的 1/5，容忍调度抖动）。心跳文件住数据根
// .runtime/（对象侧探测同根对拍）；锁文件住仓库根 .runtime（双 supervisor
// 仲裁面——两文件两个坐标，见 system-heartbeat.ts 头注释）。
const HB_INTERVAL_MS = 2_000;
const SUPERVISED_DATA_ROOT = dataRootOverride ?? process.env.AGENTCHAT_DATA_ROOT ?? DEFAULT_DATA_ROOT;
initSystemHeartbeat(SUPERVISED_DATA_ROOT);
const heartbeatTimer = setInterval(() => {
  touchSystemHeartbeat(SUPERVISED_DATA_ROOT);
}, HB_INTERVAL_MS);
heartbeatTimer.unref();
// 配方：host resident（argv 落盘——system 缺席时活进程按盘面恢复宿主）。
// 每代 startChild 前重写（argv 可能换——data-root/port passthrough）。
function writeHostRecipe(dataRoot) {
  try {
    writeRecipe(dataRoot, {
      id: 'host',
      boot: { cmd: AGENTCHAT_EXE, args: ['--experimental-strip-types', WORKER_ENTRY, '--data-root', dataRoot, '--port', port, ...passthrough] },
      policy: 'crash',
      residency: 'resident',
      owner: 'supervisor',
      mode: 'authoritative',
      writtenAt: new Date().toISOString(),
    });
  } catch (err) {
    log(`host 配方写失败（盘面退化——本代守护继续，缺席恢复知识回落宿主内存）: ${err.code ?? err.message}`);
  }
}

let child = null;
let shuttingDown = false;
let restartTimer;
let policyState = null;
let restartAttempts = 0;

/** 有意退场收面：心跳停 + 盘面清（心跳文件删除——mtime 不再续期本来
 * 就会出局，但删面让「system 从未运行」与「system 退场后」对探侧同形；
 * host 配方移除——宿主恢复边随守护面一并退场）。 */
function teardownSystemSurface() {
  clearInterval(heartbeatTimer);
  try { fs.rmSync(path.join(SUPERVISED_DATA_ROOT, '.runtime', 'system-heartbeat'), { force: true }); } catch { /* 已收 */ }
  try { removeRecipe(SUPERVISED_DATA_ROOT, 'host'); } catch { /* 已收 */ }
}

function startChild() {
  restartAttempts += 1;
  const dataRoot = dataRootOverride ?? process.env.AGENTCHAT_DATA_ROOT ?? DEFAULT_DATA_ROOT;
  const args = ['--experimental-strip-types', WORKER_ENTRY, '--data-root', dataRoot, '--port', port, ...passthrough];
  writeHostRecipe(dataRoot); // §五.1：argv 落盘（system 缺席恢复的盘面知识）
  log(`spawn 宿主: ${AGENTCHAT_EXE} ${args.join(' ')}`);
  log(`AGENTCHAT_DATA_ROOT=${dataRoot}（宿主持久化目录）`);
  // 监护状态跨代延续：仅更新 childStartedAt（退避的存活基准）
  policyState = policyState === null
    ? initialSupervisionState(Date.now())
    : { ...policyState, childStartedAt: Date.now() };
  // stderr/stdout tee（cr-740 运维日志）：宿主 stdio 不再 inherit——同时转发
  // supervisor 终端与落 dataRoot/.runtime/logs/host-<ts>.log（每代宿主一文件，
  // 沙箱版 supervisor 同款先例）。终端关了/滚屏过去诊断现场仍在。
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
  child = spawn(AGENTCHAT_EXE, args, {
    cwd: TRACK_DIR,
    // cr-859 §三.1：AGENTCHAT_SUPERVISED env 退役（第三方重拉壳后失真）
    // ——system 在场判定改双证据探测（probeSystemAlive）。env 仅留数据根。
    env: { ...process.env, AGENTCHAT_DATA_ROOT: dataRoot },
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
      teardownSystemSurface();
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
    teardownSystemSurface();
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
  teardownSystemSurface();
  unlock();
  process.exit(78);
}

log('supervisor 启动（system 层——apps/host 宿主树）');
startChild();