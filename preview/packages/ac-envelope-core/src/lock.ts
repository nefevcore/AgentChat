// ============================================================
// lock.ts —— activation 文件锁（协议规格 C1；S2 后果 4）
//
// 锁 = activation 单例（谁在跑），锁辖域恒 agent 级（A3）:
//   锁文件   agents/<agentId>/activation.lock
//   内容     JSON { pid, bootId, acquiredAt, transportHint }
//   获取     O_EXCL 创建 + 写入；已存在 → 读内容：pid 活 → fail-loud 拒绝；
//            pid 死 → 陈锁，原子接管（rename 旧锁为 stale-<bootId> 后重建）
//   释放     进程正常退出（any exit）→ 启动时注册的 exit handler 删锁文件；
//            崩溃不跑 handler → 物理兜底：OS 保证的文件存在性 + pid 探活，
//            接管方负责清理（锁的生命周期 = 进程生命周期，崩溃即放锁）
// 陈锁副本 stale-<bootId> 保留 1 个（接管时清更旧的）——诊断证据。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 锁文件内容（持锁 activation 身份） */
export interface ActivationLockInfo {
  /** 持锁进程 OS pid（诊断 / 监护对账） */
  pid: number;
  /** 本次 activation 的 UUIDv7（壳进程生命周期标识，日志关联键） */
  bootId: string;
  /** 获取时间 ISO 时间戳 */
  acquiredAt: string;
  /** 壳监听地址（unix socket 路径 / named pipe 名）——邮局/监护直连用 */
  transportHint: string;
}

export type AcquireResult =
  | { kind: 'acquired'; info: ActivationLockInfo }
  | { kind: 'refused'; holder: ActivationLockInfo };

/** Windows 与 POSIX 通用的进程存活探测（EPERM = 进程在但无权限——仍视为活） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读锁文件（缺席/损坏 = null） */
function readLock(file: string): ActivationLockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ActivationLockInfo>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    if (typeof parsed.bootId !== 'string' || parsed.bootId.length === 0) return null;
    if (typeof parsed.transportHint !== 'string') return null;
    return {
      pid: parsed.pid,
      bootId: parsed.bootId,
      acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : '',
      transportHint: parsed.transportHint,
    };
  } catch {
    return null;
  }
}

/** 陈锁副本清理：stale-* 只保留最新 1 个（接管时清更旧的） */
function pruneStaleCopies(dir: string, keep: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.name.startsWith('activation.lock.stale-') || ent.name === keep) continue;
    try {
      fs.rmSync(path.join(dir, ent.name), { force: true });
    } catch {
      // 清理失败无碍——副本是诊断证据非承重件
    }
  }
}

/**
 * 获取 activation 锁（agents/<agentId>/activation.lock）。目录按需创建。
 * 活进程持锁 → refused（fail-loud 语义；调用方决定退出码）；
 * 死进程陈锁 → 接管（rename 为 stale-<旧 bootId>，只保留 1 个副本）。
 */
export function acquireActivationLock(agentDir: string, info: ActivationLockInfo): AcquireResult {
  fs.mkdirSync(agentDir, { recursive: true });
  const file = path.join(agentDir, 'activation.lock');
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'wx'); // O_EXCL：创建即原子独占
    fs.writeFileSync(fd, JSON.stringify(info), 'utf-8');
    return { kind: 'acquired', info };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
    const holder = readLock(file);
    if (holder !== null && holder.pid !== info.pid && isAlive(holder.pid)) {
      return { kind: 'refused', holder };
    }
    // 陈锁（持锁进程死 / 锁内容损坏）→ 接管：副本留证后重建
    const staleName = `activation.lock.stale-${holder !== null ? holder.bootId : 'unreadable'}`;
    try {
      fs.renameSync(file, path.join(agentDir, staleName));
      pruneStaleCopies(agentDir, staleName);
    } catch {
      // rename 失败（如并发接管竞态）→ 下轮 O_EXCL 再试
    }
    fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, JSON.stringify(info), 'utf-8');
    return { kind: 'acquired', info };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // close 失败：fd 随进程回收
      }
    }
  }
}

/**
 * 释放锁（幂等；仅当锁内容仍是自己的 pid 才删——他人已接管时不误删）。
 * 进程正常退出路径由 exit handler 调用；崩溃路径靠 pid 探活由接管方清理。
 */
export function releaseActivationLock(agentDir: string, pid: number): void {
  const file = path.join(agentDir, 'activation.lock');
  const cur = readLock(file);
  if (cur !== null && cur.pid === pid) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // 释放失败只留孤儿锁文件，下次启动按陈锁回收
    }
  }
}

/** 读当前持锁信息（监护对账 / 诊断面；无锁 = null） */
export function readActivationLock(agentDir: string): ActivationLockInfo | null {
  return readLock(path.join(agentDir, 'activation.lock'));
}
