// ============================================================
// takeover.ts —— 换代接管：socket-only 壳句柄形态
//（host-generation-takeover §4.1/4.2，cr-967）
//
// 根因（§1）：监护权的载体（spawn stdin/stdout 管道）不可继承——「host
// 管 shell」只在一代宿主内成立。本模块把无管道的接管壳（盘上活锁壳）包装
// 成 AdoptedShellFace，superviseShell 监护链全量复用：
//
//   · 心跳源：编排面 peek 的 run-state 探测成功 → handle.noteProbe（D1
//     双源——接管壳的唯一源，spawn 壳的第二源）；
//   · 判死：探测连续失败跨 warden 心跳窗 → supervise tick 判死；
//   · kill：socket system/shutdown 帧（优雅），不应答 → 按 activation.lock
//     内 pid 点名强杀（锁 = 壳自写的 kill 凭证——非进程表扫描）；
//   · 退出感知：锁观察器——锁消失 = 正常退出/idle 自杀（exit 0 → done 不
//     重拉）；锁在而 pid 死 = 崩溃（exit 1 → respawn 退避档）；锁换代
//    （新 bootId）= 本代监护终结（exit 0）；
//   · 重拉：kill 后锁自然释放 → supervise start() 常规 spawn 链。
//
// 纯域可测：manage 往返注入；锁面用真实 fs（sandbox）。
// ============================================================
import * as fs from 'node:fs';
import { readActivationLock } from 'ac-envelope-core';
import type { AdoptedShellFace } from './supervise.ts';

/** 接管目标（activation.lock 探活通过的活壳） */
export interface LiveShellLock {
  agentId: string;
  bootId: string;
  pid: number;
  hint: string;
}

export interface SocketOnlyDeps {
  /** agents/<agentId> 目录（锁观察面） */
  agentDir: string;
  /** restart_shell 复活标记文件（cr-994）：壳退出前落盘——锁观察器据此把
   * 退出映射为 42（有意重启 → warden 快路 respawn），而非 0（done 不重拉） */
  restartMarkerFile: string;
  /** socket manage 往返（编排面注入——每次独立连接，cr-656） */
  manageCall(hint: string, frame: Record<string, unknown>, ms: number): Promise<unknown>;
  /** 探测/关停帧超时档 */
  manageProbeMs: number;
  manageFrameMs: number;
}

/** 锁观察周期（退出感知粒度） */
const LOCK_WATCH_MS = 2_000;

/** 点名 pid 探活（EPERM = 在但无权限——仍视为活） */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 接管壳 → AdoptedShellFace（superviseShell 同链消费）。构造即开始锁
 * 观察；onLine 注册时喂合成 boot.ready 行驱动 warden 走完 adopt 面。
 */
export function adoptSocketShell(lock: LiveShellLock, deps: SocketOnlyDeps): AdoptedShellFace {
  let exited = false;
  let exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  const exitWaiters: Array<() => void> = [];

  const emitExit = (code: number | null, signal: string | null): void => {
    if (exited) return;
    exited = true;
    stopWatch();
    exitCb?.(code, signal);
    for (const w of exitWaiters.splice(0)) w();
  };
  const waitForExit = (): Promise<void> => (exited ? Promise.resolve() : new Promise((res) => exitWaiters.push(res)));

  // 锁观察器（退出感知——接管壳无进程退出事件，锁 = 生命周期投影）。
  // restart 意图识别（cr-994）：锁消失时读 restart marker——在场 = 壳因
  // restart_shell 退出，映射 42（warden 快路 respawn）并领取 marker；
  // 缺席才是正常退出/idle 自杀（0 不重拉）。marker 领取放观察器：42 语义
  // 单点成立（boot 扫描面只管宿主换代场景，同代不扫——marker 滞留是
  // 既有缺口，此处一并收口）。
  // 领取 = rename 成 .claimed 承载原文（cr-663 语义），不删——换代壳
  // boot 自清读取 conversationId 注入「已重启」续跑（cr-658 链路；
  // cr-994 曾实现成删除断链，cr-1034 修正）。观察器只探 .json 精确名，
  // 滞留 .claimed 不参与 42 判定（陈旧领取由宿主 boot 扫描面 TTL 清扫）。
  const consumeRestartMarker = (): boolean => {
    try {
      const raw = fs.readFileSync(deps.restartMarkerFile, 'utf-8');
      fs.writeFileSync(deps.restartMarkerFile.replace(/\.json$/, '.claimed'), raw, 'utf-8');
      fs.rmSync(deps.restartMarkerFile, { force: true });
      return true;
    } catch {
      return false;
    }
  };
  const watch = (): void => {
    if (exited) return;
    const info = readActivationLock(deps.agentDir);
    if (info === null) {
      if (fs.existsSync(deps.restartMarkerFile)) {
        consumeRestartMarker();
        emitExit(42, null); // restart_shell 退出（marker 为证）——有意重启
        return;
      }
      emitExit(0, null); // 锁已放——正常退出/idle 自杀（不重拉）
      return;
    }
    if (info.bootId !== lock.bootId) {
      emitExit(0, null); // 锁已换代——本代监护终结（新代归拉起它的宿主）
      return;
    }
    if (!pidAlive(info.pid)) emitExit(1, null); // 持锁者死——崩溃（respawn 链）
  };
  const stopWatch: () => void = (() => {
    const timer = setInterval(watch, LOCK_WATCH_MS);
    timer.unref();
    return () => clearInterval(timer);
  })();

  return {
    bootId: lock.bootId,
    transportHint: lock.hint,
    pid: lock.pid,
    events: [{ type: 'adopted', agentId: lock.agentId, bootId: lock.bootId, transportHint: lock.hint }],
    onLine(cb) {
      // 合成 boot.ready 行：驱动 warden 三节拍收尾（adopted/心跳基线）——
      // 接管壳的持续行流缺席，此后喂活全走 noteProbe（D1）。
      cb('boot.ready\t' + lock.bootId + '\t' + lock.hint);
    },
    onExit(cb) { exitCb = cb; },
    async shutdown() {
      // 优雅面：system/shutdown 帧（回执丢失无害——以锁释放为准）
      try { await deps.manageCall(lock.hint, { ctrl: 'system', op: 'shutdown' }, deps.manageFrameMs); } catch { /* 见上 */ }
      // 收面等待（cap = 控制帧档——超时视为强杀现场，交调用方兜底）
      await Promise.race([
        waitForExit(),
        new Promise<void>((res) => { setTimeout(res, deps.manageFrameMs).unref(); }),
      ]);
      return 0;
    },
    kill() {
      // 先尝试优雅帧；不应答/超时（manageProbeMs 内必结算）→ 点名强杀
      void deps.manageCall(lock.hint, { ctrl: 'system', op: 'shutdown' }, deps.manageProbeMs)
        .catch(() => { /* 帧丢失——强杀兜底 */ })
        .finally(() => {
          if (exited) return;
          try { process.kill(lock.pid); } catch { /* 已死 */ }
          emitExit(null, 'SIGKILL');
        });
    },
    control(frame) { return deps.manageCall(lock.hint, frame, deps.manageFrameMs); },
  };
}
