// ============================================================
// host-revive.ts —— D5 边 2 常态化：壳侧邮局失联探测 + 宿主复活
//
// 裁决修订（cr-612，2026-10-23 用户裁决）：D5 边 2 触发条件从「宿主自进化
// 坏」扩为「任意宿主死亡（邮局失联）」——`pnpm dev:fg` 前台直跑形态无
// supervisor，宿主崩溃时活着的壳是唯一执行者，必须承担常态恢复。
// 保底 supervisor 仅辖「宿主+壳同死」场景（D5 原裁决不变）。
//
// 让路判定（cr-859 §三.1）：system 在场 = 让路（supervisor 是快路——
// 宿主退出码 42 → 1.5s 重拉）。判定基础从 AGENTCHAT_SUPERVISED env
// 继承链（第三方重拉壳后失真）升级为**双证据探测**：仓库根 .runtime 锁
// 内 pid 活 ∧ 数据根心跳文件新鲜（probeSystemAlive）。system 缺席 =
// 本壳即时承担恢复（§三 恢复边降级语义）。
//
// 语义（rollback-not-retry 的常态版——普通崩溃拉同版本，快照回退仍只在
// 自进化失败时由 evolve 链负责）：
//   · 探测：周期 connect 邮局管道（连上即断——对宿主零载荷）；连续
//     N 次失败 = 宿主失联。
//   · 停机戳：宿主优雅退出（SIGINT/SIGTERM——用户有意停机 / supervisor
//     换代）前写 <dataRoot>/.runtime/host-stopped；戳在 = 壳侧stand down
//     （不复活）。宿主 boot 首动作清戳重新武装。硬崩溃无戳 → 复活。
//   · 仲裁：O_EXCL host-revive.lock——多壳并发探测到失联时仅一个壳去拉，
//     其余等探测面恢复。supervisor 竞态由宿主自身 EADDRINUSE fail-loud
//     （cr-560）兜住——后到者可读退出，不产生第二宿主。
//   · 退避：基档 1.5s ×2^n cap 60s（±20% jitter）——与 warden 壳级档
//     同源（cr-551）。宿主恢复即复位。idle-exit 15min 收割自然限定复活
//     窗口（壳死则环无执行者——落保底，D5 原文）。
//
// 纯域可测：探测 / system 探测 / 戳 / 锁 / spawn / 时钟全注入。
// ============================================================
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeSystemAlive } from 'ac-supervisor-core';

/** 注入面（测试替身逐项可换） */
export interface HostReviveDeps {
  /** 探测邮局管道可达（true = 宿主在） */
  probe(): Promise<boolean>;
  /** system 在场（true = 让路——supervisor 快路负责恢复；cr-859 双证据） */
  systemAlive(): boolean;
  /** 停机戳在场（宿主有意停机——stand down） */
  stampPresent(): boolean;
  /** 复活仲裁锁（O_EXCL try——false = 已有壳在拉） */
  tryLock(): boolean;
  unlock(): void;
  /** 拉起宿主（detached——与壳生死无关） */
  spawnHost(): void;
  emit(signal: string, ...fields: string[]): void;
  now(): number;
}

export interface HostReviveConfig {
  /** 连续探测失败阈值（缺省 2——约 2×探测周期确认失联） */
  failureThreshold?: number;
  /** 复活退避基档 ms（缺省 1500） */
  respawnDelayMs?: number;
  /** 退避 cap ms（缺省 60_000） */
  respawnCapMs?: number;
  /**
   * system 在场时的复活让路宽限 ms（缺省 10_000）：supervisor 是快路
   * （退出码 42 → 1.5s 重拉），壳侧必须在宽限内让路——否则 stdin EOF kick
   * 抢在 supervisor 前拉起宿主，supervisor 重拉撞 EADDRINUSE 退出 78，
   * 监督栈永久消失（cr-647 现场）。system 缺席（双证据判假——dev:fg
   * 直跑 / supervisor 挂起或死亡）无快路，宽限不适用——复活职责即时生效。
   */
  reviveGraceMs?: number;
}

export interface HostReviveState {
  failures: number;
  attempts: number;
  nextReviveAt: number;
  down: boolean;
  standdownEmitted: boolean;
  /** 失联确认时刻（宽限起算；0 = 未确认）。恢复即清零。 */
  confirmedDownAt: number;
}

export function createHostReviveState(now: number): HostReviveState {
  return { failures: 0, attempts: 0, nextReviveAt: now, down: false, standdownEmitted: false, confirmedDownAt: 0 };
}

/** 退避档（±20% jitter——cr-551 warden 同源语义） */
export function reviveBackoffMs(base: number, cap: number, attempt: number, rand = Math.random): number {
  const raw = Math.min(base * 2 ** attempt, cap);
  return Math.round(raw * (0.8 + 0.4 * rand()));
}

/** 单拍推进（周期驱动方 = startHostRevive 的 interval / 测试直呼） */
export async function tickHostRevive(
  state: HostReviveState,
  deps: HostReviveDeps,
  config: HostReviveConfig = {},
): Promise<void> {
  const threshold = config.failureThreshold ?? 2;
  const base = config.respawnDelayMs ?? 1_500;
  const cap = config.respawnCapMs ?? 60_000;
  const grace = config.reviveGraceMs ?? 0;
  if (await deps.probe()) {
    if (state.down) {
      state.down = false;
      state.standdownEmitted = false;
      deps.emit('host.revived');
    }
    state.failures = 0;
    state.attempts = 0;
    state.confirmedDownAt = 0;
    state.nextReviveAt = deps.now();
    return;
  }
  state.failures += 1;
  if (state.failures < threshold) return;
  // 失联确认只记一次时刻（宽限起算点 = 确认时刻，不是首次失败——stdin EOF
  // kick 常把首败落在宿主退出前一拍，按首败起算会把宽限吃掉）。
  if (!state.down) {
    state.down = true;
    state.confirmedDownAt = deps.now();
  }
  if (deps.stampPresent()) {
    if (!state.standdownEmitted) {
      state.standdownEmitted = true;
      deps.emit('host.revive.standdown');
    }
    return; // 有意停机——不复活（宿主 boot 清戳后探测面自会恢复）
  }
  const now = deps.now();
  // system 让路判定（cr-859 §三.1）：在场 = 快路负责恢复，本壳宽限等待；
  // 缺席（双证据假）= 恢复边降级到本壳，宽限不适用（即时复活）。
  // 每拍现探——system 中途恢复（被拉起）即回到让路语义，中途死亡即时接管。
  if (deps.systemAlive()) {
    if (now < state.confirmedDownAt + grace) return; // 快路窗口内让路
  }
  if (now < state.nextReviveAt) return;
  if (!deps.tryLock()) return; // 另一壳在拉——等探测面恢复
  try {
    deps.spawnHost();
  } finally {
    deps.unlock();
  }
  deps.emit('host.revive.attempt', String(state.attempts + 1));
  state.attempts += 1;
  state.nextReviveAt = now + reviveBackoffMs(base, cap, state.attempts);
}

/** 复活执行者装配参数（真实物理面） */
export interface HostReviveJobOptions {
  postOffice: string;
  dataRoot: string;
  hostBoot: string;
  hostPort?: number;
  /** system 层 .runtime 单写者锁路径（cr-859——仓库根 <repo>/.runtime；
   * 双证据探测之 pid 证据源。缺席 undefined = 恒判 system 缺席） */
  systemLockFile?: string;
  probeIntervalMs?: number;
  /** system 在场时的让路宽限 ms（cr-647/cr-859——缺省 10_000） */
  reviveGraceMs?: number;
  emit?: (signal: string, ...fields: string[]) => void;
  tick?: typeof tickHostRevive;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export function hostStampPath(dataRoot: string): string {
  return path.join(dataRoot, '.runtime', 'host-stopped');
}

export function hostReviveLockPath(dataRoot: string): string {
  return path.join(dataRoot, '.runtime', 'host-revive.lock');
}

/** 探测一次邮局管道（连上即断——listenIpc 对裸连接零语义）。
 * 坏/空地址（net.connect 同步 RangeError）兜为失联——探测面永不抛，
 * 复活职责不得炸宿主已死的壳（诊断现场：ERR_SOCKET_BAD_PORT 全灭）。 */
export function probePostOffice(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: net.Socket;
    try {
      socket = net.connect(address, () => {
        socket.destroy();
        resolve(true);
      });
    } catch {
      resolve(false);
      return;
    }
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** 复活宿主日志路径（cr-662 诊断面：每次复活一代文件——host-revive-<ts>.log） */
export function hostReviveLogPath(dataRoot: string, now = Date.now): string {
  return path.join(dataRoot, '.runtime', 'logs', `host-revive-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.log`);
}

/** 拉起宿主进程（物理面——cr-662：stderr 不再 ignore，落代文件日志；
 * fd 由子进程继承，父侧副本 spawn 后即收） */
export function spawnHostProcess(hostBoot: string, dataRoot: string, hostPort?: number): void {
  // 品牌单映像 exe（cr-620/624：bin/AgentChat.exe 在场即用——supervisor/宿主/壳同映像，任务管理器折一行；缺席回落 node 本体）
  const brandedExe = path.join(path.resolve(fileURLToPath(new URL('../../', import.meta.url))), 'bin', 'AgentChat.exe');
  const exe = process.env.AGENTCHAT_NO_BRANDED_EXE === '1' || !fs.existsSync(brandedExe) || process.env.VITEST !== undefined
    ? process.execPath
    : brandedExe; // cr-669 诊断档：沙箱拒品牌 exe 连管道时回落 node
  fs.mkdirSync(path.join(dataRoot, '.runtime', 'logs'), { recursive: true });
  const logFd = fs.openSync(hostReviveLogPath(dataRoot), 'a');
  const child = spawn(exe, [
    '--experimental-strip-types', hostBoot,
    '--data-root', dataRoot,
    ...(hostPort !== undefined ? ['--port', String(hostPort)] : []),
  ], { stdio: ['ignore', 'ignore', logFd], detached: true });
  child.unref();
  fs.closeSync(logFd);
}

/** 真实装配：interval 驱动 tickHostRevive；返回停面 + kick（失联旁证
 * 〔stdin EOF〕触发的立即探测——不等下一拍 interval） */
export function startHostRevive(options: HostReviveJobOptions): { stop(): void; kick(): void } {
  const { postOffice, dataRoot, hostBoot, hostPort } = options;
  const runtimeDir = path.join(dataRoot, '.runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const emit = options.emit ?? (() => {});
  const grace = options.reviveGraceMs ?? 10_000;
  const state = createHostReviveState(Date.now());
  let lockFd: number | null = null;
  const deps: HostReviveDeps = {
    probe: () => probePostOffice(postOffice),
    // 双证据（cr-859 §三.1）：锁内 pid 活 ∧ 心跳新鲜——system 锚点由拉起方
    // 注入（缺省仓库根 .runtime，见 spawnHostProcess 同族锚定）。
    systemAlive: () => options.systemLockFile !== undefined
      && probeSystemAlive(options.systemLockFile, dataRoot).alive,
    stampPresent: () => fs.existsSync(hostStampPath(dataRoot)),
    tryLock: () => {
      try {
        lockFd = fs.openSync(hostReviveLockPath(dataRoot), 'wx');
        return true;
      } catch {
        return false; // 已被他壳持有或陈锁——后者由在拉壳的 spawn 结果收敛
      }
    },
    unlock: () => {
      if (lockFd !== null) {
        fs.closeSync(lockFd);
        lockFd = null;
      }
      try { fs.unlinkSync(hostReviveLockPath(dataRoot)); } catch { /* 已收 */ }
    },
    spawnHost: () => spawnHostProcess(hostBoot, dataRoot, hostPort),
    emit,
    now: () => Date.now(),
  };
  const tick = options.tick ?? tickHostRevive;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const tickConfig: HostReviveConfig = { reviveGraceMs: grace };
  const timer = setIntervalFn(() => { void tick(state, deps, tickConfig); }, options.probeIntervalMs ?? 5_000);
  timer.unref(); // Node Timeout——不阻进程自退（idle-exit 收割面）
  return {
    kick: () => { void tick(state, deps, tickConfig); },
    stop: () => {
      clearIntervalFn(timer);
      if (lockFd !== null) {
        try { fs.closeSync(lockFd); } catch { /* 已收 */ }
        lockFd = null;
      }
    },
  };
}
