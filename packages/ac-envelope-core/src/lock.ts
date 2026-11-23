// ============================================================
// lock.ts —— activation 文件锁（协议规格 C1；S2 后果 4）
//
// 锁 = activation 单例（谁在跑），锁辖域恒 agent 级（A3）:
//   锁文件   agents/<agentId>/activation.lock
//   内容     JSON { pid, bootId, acquiredAt, transportHint }
//   获取     O_EXCL 创建 + 写入；已存在 → 持有者裁决：任一证死即接管
//            （rename 旧锁为 stale-<bootId> 后重建），活 → fail-loud 拒绝
//   释放     进程正常退出（any exit）→ 启动时注册的 exit handler 删锁文件；
//            崩溃不跑 handler → 物理兜底：接管方裁决（锁的生命周期
//            = 进程生命周期，崩溃即放锁）
// 陈锁副本 stale-<bootId> 保留 1 个（接管时清更旧的）——诊断证据。
//
// 持有者裁决（cr-1255）：pid 存活不再单证——Windows pid 复用后 isAlive
// 恒真，Agent 永久锁死（writer 实测 12h）。接管权威 = 任一证死因子：
//   ① pid 已死（内核裁决，不可骗）；
//   ② 心跳租约超限（壳按 LOCK_HEARTBEAT_MS touch 锁 mtime——cr-1126
//      喂活源 ①；锁文件创建即起租）。pid 复用现场：真壳死后无人 touch，
//      租约必然超限——与 pid 假活无关，此类问题整类关死。
// pid 活 ∧ 租约在效 = 不能证死 → refused（近期崩溃的租约残温 ≤
// LOCK_DEADLINE_MS，重试即接管；探针不授权接管——装配窗口的真壳尚无
// socket，探针无应答 ≠ 死，授权即双壳 split-brain）。refused 的诊断定谳
// （真活壳 / 无应答）归调用方探针面（manage.ts probeActivationHolder）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 锁文件内容（持锁 activation 身份） */
export interface ActivationLockInfo {
  /** 持锁进程 OS pid（诊断 / 监护对账——cr-1255 起非权威判据） */
  pid: number;
  /** 本次 activation 的 UUIDv7（壳进程生命周期标识，日志关联键） */
  bootId: string;
  /** 获取时间 ISO 时间戳 */
  acquiredAt: string;
  /** 壳监听地址（unix socket 路径 / named pipe 名）——邮局/监护直连用 */
  transportHint: string;
}

export type AcquireResult =
  | { kind: 'acquired'; info: ActivationLockInfo; /** 接管判死凭据（诊断；首获无） */ staleEvidence?: string }
  | { kind: 'refused'; holder: ActivationLockInfo };

/** 获取选项（cr-1255）：deadline = 心跳租约判死阈值 ms（0 = 关闭租约判据——测试面） */
export interface AcquireOptions {
  deadline?: number;
}

/** Windows 与 POSIX 通用的进程存活探测（EPERM = 进程在但无权限——仍视为活） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 壳文件心跳周期（cr-1126 喂活源 ①——touch 锁 mtime；boot.ts 心跳同值单源） */
export const LOCK_HEARTBEAT_MS = 30_000;
/** 心跳租约判死阈值（4 周期：约 3 周期宽限 + 1 周期送达余量——cr-1255） */
export const LOCK_DEADLINE_MS = 4 * LOCK_HEARTBEAT_MS;

/**
 * 持有者裁决：任一证死因子命中即陈锁（返回判死凭据）；
 * pid 活 ∧ 租约在效 → 未证死（refused 由调用方处理）。
 */
function judgeHolder(
  file: string,
  holder: ActivationLockInfo,
  deadline: number,
): { dead: true; evidence: string } | { dead: false } {
  if (!isAlive(holder.pid)) return { dead: true, evidence: 'pid ' + holder.pid + ' 不存在' };
  if (deadline > 0) {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      // EEXIST 与 stat 之间锁被释放——证死（后续 rename 也有释放竞态兜底）
      return { dead: true, evidence: '锁文件消失（释放竞态）' };
    }
    if (Date.now() - mtimeMs > deadline) {
      return { dead: true, evidence: '心跳租约超限（mtime ' + new Date(mtimeMs).toISOString() + '，阈值 ' + deadline + 'ms）——pid ' + holder.pid + ' 存活为复用假象' };
    }
  }
  return { dead: false };
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
 * 持有者证死（pid 死 / 租约超限 / 锁损坏）→ 接管（rename 为 stale-<旧
 * bootId>，只保留 1 个副本，staleEvidence 记判死凭据）；未证死 → refused
 * （fail-loud 语义；调用方决定退出码与探针诊断）。
 */
export function acquireActivationLock(agentDir: string, info: ActivationLockInfo, opts?: AcquireOptions): AcquireResult {
  const deadline = opts?.deadline ?? LOCK_DEADLINE_MS;
  fs.mkdirSync(agentDir, { recursive: true });
  const file = path.join(agentDir, 'activation.lock');
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'wx'); // O_EXCL：创建即原子独占（mtime = 租约起租）
    fs.writeFileSync(fd, JSON.stringify(info), 'utf-8');
    return { kind: 'acquired', info };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
    const holder = readLock(file);
    let evidence: string;
    let staleBootId: string;
    if (holder === null) {
      evidence = '锁内容损坏';
      staleBootId = 'unreadable';
    } else {
      const judged = judgeHolder(file, holder, deadline);
      if (!judged.dead) {
        if (holder.pid !== info.pid) return { kind: 'refused', holder };
        // 同 pid 重入：活壳不会二获锁（boot 单次），同 pid = 前代死后 pid 复用
        // 给本进程——接管（同一进程无 split-brain 面）
        evidence = '同 pid 重入（前代已亡，pid 复用给本进程）';
      } else {
        evidence = judged.evidence;
      }
      staleBootId = holder.bootId;
    }
    try {
      fs.renameSync(file, path.join(agentDir, 'activation.lock.stale-' + staleBootId));
      pruneStaleCopies(agentDir, 'activation.lock.stale-' + staleBootId);
    } catch {
      // rename 失败（并发接管/释放竞态）→ 直落 O_EXCL：他方已成则 EEXIST 上抛
    }
    fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, JSON.stringify(info), 'utf-8');
    return { kind: 'acquired', info, staleEvidence: evidence };
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
 * 进程正常退出路径由 exit handler 调用；崩溃路径由接管方按证死因子裁决。
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
