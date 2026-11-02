// ============================================================
// system-heartbeat.ts —— system 心跳面（supervisor-service-plan §五.2，cr-859）
//
// supervisor ≡ system 层：其存活判定从 AGENTCHAT_SUPERVISED env 继承链
// （第三方重拉壳后失真——§三.1 判定基础升级的动因）升级为**双证据探测**：
//   证据 1：.runtime 锁内 pid 在本机存活；
//   证据 2：心跳文件 mtime 新鲜（supervisor 周期 touch）。
// 两证据皆真 = system 在场（壳侧让路——supervisor 是常态恢复快路）；
// 任一假 = system 缺席（壳侧恢复职责即时生效——§三 恢复边降级语义）。
//
// 与 isStaleLock 的分工：锁回收判定在系统启动时一次性裁决「谁能当
// supervisor」；本模块是运行期周期探测「当前 supervisor 还活着吗」——
// 挂起场景（pid 活但卡死）由 mtime 证据覆盖。
// ============================================================
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 心跳新鲜窗（ms）：supervisor 触碰周期 2s 的 5 倍——容忍调度抖动，
 * 挡住挂起（pid 活但事件循环卡死 = 不再 touch，mtime 老化出局）。 */
export const SYSTEM_HEARTBEAT_FRESH_MS = 10_000;

/** system 心跳文件路径（<dataRoot>/.runtime/system-heartbeat） */
export function systemHeartbeatPath(dataRoot: string): string {
  return join(dataRoot, '.runtime', 'system-heartbeat');
}

/** supervisor 侧：初次落面（boot 时一次——含启动时标，非空文件便于诊断） */
export function initSystemHeartbeat(dataRoot: string, now: number = Date.now()): void {
  mkdirSync(join(dataRoot, '.runtime'), { recursive: true });
  const file = systemHeartbeatPath(dataRoot);
  writeFileSync(file, new Date(now).toISOString() + '\n', 'utf-8');
}

/** supervisor 侧：周期 touch（mtime 即心跳——零内容协议） */
export function touchSystemHeartbeat(dataRoot: string, now: number = Date.now()): void {
  const file = systemHeartbeatPath(dataRoot);
  try {
    utimesSync(file, new Date(now), new Date(now));
  } catch {
    // 文件缺席/被清（tmp 清扫等）——重建（与 init 同内容）
    try {
      mkdirSync(join(dataRoot, '.runtime'), { recursive: true });
      writeFileSync(file, new Date(now).toISOString() + '\n', 'utf-8');
    } catch { /* 下拍重试 */ }
  }
}

/** 锁文件内 pid 读取（坏/缺席 = null） */
function lockPid(lockFile: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(lockFile, 'utf-8')) as { pid?: unknown };
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return parsed.pid;
  } catch {
    return null;
  }
}

/** pid 在本机存活（EPERM = 活但非本人——保守为真；与 isStaleLock 同语义） */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SystemAliveProbe {
  /** system 存活（双证据：锁内 pid 活 ∧ 心跳 mtime 新鲜） */
  alive: boolean;
  /** 证据明细（诊断/测试断言） */
  lockPresent: boolean;
  lockPidAlive: boolean;
  heartbeatFresh: boolean;
}

/**
 * system 存活探测（对象侧守望统一判定，§三.1）。
 * now / freshMs 可注入供测试。锁文件路径由调用方给（supervisor 锚
 * 仓库根的 .runtime——双 supervisor 布局下与数据根 .runtime 是两个
 * 文件，见各自入口的注释）。
 */
export function probeSystemAlive(
  lockFile: string,
  dataRoot: string,
  now: number = Date.now(),
  freshMs: number = SYSTEM_HEARTBEAT_FRESH_MS,
): SystemAliveProbe {
  const lockPresent = existsSync(lockFile);
  const lockPidAlive = lockPresent && (() => { const pid = lockPid(lockFile); return pid !== null && pidAlive(pid); })();
  let heartbeatFresh = false;
  try {
    heartbeatFresh = statSync(systemHeartbeatPath(dataRoot)).mtimeMs >= now - freshMs;
  } catch {
    heartbeatFresh = false; // 心跳文件缺席 = 从未 touch / 被清
  }
  return { alive: lockPidAlive && heartbeatFresh, lockPresent, lockPidAlive, heartbeatFresh };
}
