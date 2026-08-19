// ============================================================
// @agentchat/toolkit/src/runtime.ts —— workspace 运行时标识（单一事实源）
//
// <workspace>/.runtime 一个文件回答"这个工作区正在被谁运行"：
//   · 获取 = wx 排他创建（互斥就是创建动作本身——Windows 无可移植 flock，
//     O_EXCL 是唯一跨平台原子原语）；持锁者可后续 tmp+rename 重写补内容
//   · 三类读者：client 发现（headless 连 WS）/ owner 门禁（防双树）/
//     timer 单写者（timer-state.json 不被多写者损坏）
//   · 失败语义由调用方决定：CLI owner fail-closed（报错退出）；
//     程序化/嵌入 fail-open（继续跑但不调度定时）
//   · 迁移 shim：legacyTimerHolder 读旧 timer-instance.lock——
//     旧版本进程对门禁可见（旧代码不写 .runtime 但会占定时锁）
//
// 收敛史：原 instance.json（P2 注册表）+ timer-instance.lock（定时单执行锁）
// 合并（2026-08-19）。原子性/失败语义/fail-open 分叉在注释中标出。
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** workspace 运行时标识文件名 */
export const RUNTIME_FILENAME = '.runtime';
/** 旧版定时器实例锁（迁移可见性 shim；2026-08-19 前的进程只写这个） */
export const LEGACY_TIMER_LOCK = 'timer-instance.lock';

/** 运行形态：CLI 表面（web-app/base）或程序化嵌入（测试/宿主集成） */
export type RuntimeKind = 'web-app' | 'base' | 'embedded';

/** .runtime 记录（持久形态） */
export interface RuntimeRecord {
  pid: number;
  startedAt: string;
  kind: RuntimeKind;
  /** Web 表面端口（client 连 ws://127.0.0.1:<port>/ws；base/embedded 无） */
  port?: number;
  /** 组合 profile（audit 用；embedded 场景 = 'embedded'） */
  profile: string;
  /** workspace 绝对路径 */
  workspaceDir: string;
  nodeVersion: string;
}

/** 获取结果：held = 本进程持有（degraded=true 表示锁文件不可写，按持有继续——
 *  fail-open，与旧 timer 锁语义一致：禁用全部定时比多写风险更糟）；
 *  blocked = 他进程活着持有 */
export type RuntimeAcquire =
  | { status: 'held'; record: RuntimeRecord; degraded?: true }
  | { status: 'blocked'; holder: RuntimeRecord };

export function runtimeFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, RUNTIME_FILENAME);
}

/** 判断进程是否存活（process.kill 探活；Windows EPERM = 进程存在无权限。
 *  PID 复用为已知残余风险，记录带 startedAt 供人工排查） */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

// ---- 本进程持有缓存（workspace → 记录；同进程重复获取幂等）----
const held = new Map<string, RuntimeRecord>();

function baseRecord(workspaceDir: string, info: Partial<RuntimeRecord>): RuntimeRecord {
  return {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    kind: 'embedded',
    profile: 'embedded',
    workspaceDir,
    nodeVersion: process.version,
    ...info,
  };
}

/** 读 .runtime（缺失/损坏/结构非法 → null） */
export function readRuntime(workspaceDir: string): RuntimeRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(runtimeFilePath(workspaceDir), 'utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Partial<RuntimeRecord>;
  if (!Number.isInteger(rec.pid)) return null;
  return {
    pid: rec.pid!,
    startedAt: typeof rec.startedAt === 'string' ? rec.startedAt : '',
    kind: rec.kind ?? 'embedded',
    ...(Number.isInteger(rec.port) ? { port: rec.port } : {}),
    profile: typeof rec.profile === 'string' ? rec.profile : 'embedded',
    workspaceDir: typeof rec.workspaceDir === 'string' ? rec.workspaceDir : workspaceDir,
    nodeVersion: typeof rec.nodeVersion === 'string' ? rec.nodeVersion : '',
  };
}

/** 发现任意实例（client/门禁用）：无文件 → null；有 → { alive, record } */
export function findRuntime(workspaceDir: string): { alive: boolean; record: RuntimeRecord } | null {
  const record = readRuntime(workspaceDir);
  if (!record) return null;
  return { alive: isProcessAlive(record.pid), record };
}

/** 本进程是否持有该 workspace 的运行时标识 */
export function processHoldsRuntime(workspaceDir: string): boolean {
  return held.has(workspaceDir);
}

/**
 * 原子获取运行时标识（幂等：本进程已持有 → 直接返回）。
 * 陈旧持有者（pid 死）自动清理重建；他进程活持有 → blocked（调用方决定
 * fail-closed/fail-open）；锁文件不可写 → held+degraded（fail-open 语义）。
 */
export function acquireRuntime(workspaceDir: string, info: Partial<RuntimeRecord> = {}): RuntimeAcquire {
  const cached = held.get(workspaceDir);
  if (cached) return { status: 'held', record: cached };

  const file = runtimeFilePath(workspaceDir);
  const record = baseRecord(workspaceDir, info);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(workspaceDir, { recursive: true });
      // wx = 排他创建：互斥就是创建动作本身（并发双启只有一方成功）
      fs.writeFileSync(file, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
      held.set(workspaceDir, record);
      cleanLegacyLockIfStale(workspaceDir); // 迁移：顺手清死持有者的旧锁
      return { status: 'held', record };
    } catch (err: any) {
      if (err?.code !== 'EEXIST') {
        // 不可写（权限/磁盘）：按持有继续（fail-open；同旧 timer 锁降级语义）
        held.set(workspaceDir, record);
        return { status: 'held', record, degraded: true };
      }
    }
    // EEXIST：判持有者
    const holder = readRuntime(workspaceDir);
    if (holder) {
      if (holder.pid === process.pid) {
        // 同 pid 重新获取（崩溃重启 pid 复用边缘 / 同进程二次 bootstrap）→ 认领
        held.set(workspaceDir, holder);
        return { status: 'held', record: holder };
      }
      if (isProcessAlive(holder.pid)) {
        return { status: 'blocked', holder };
      }
    }
    try { fs.unlinkSync(file); } catch { /* 并发清理竞态：重试 */ }
  }
  return { status: 'blocked', holder: readRuntime(workspaceDir) ?? baseRecord(workspaceDir, {}) };
}

/**
 * 持有者重写补内容（tmp+rename 原子；仅本进程持有时生效，否则返回 null）。
 * 典型：boot 入口先获取（无端口），boot-finalize 起 Web 表面后补 port。
 */
export function updateRuntime(workspaceDir: string, patch: Partial<RuntimeRecord>): RuntimeRecord | null {
  const current = held.get(workspaceDir);
  if (!current) return null;
  const next = { ...current, ...patch, pid: process.pid };
  try {
    const file = runtimeFilePath(workspaceDir);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // 重写失败保留旧内容（发现侧读到的是启动时刻的基础信息，仍可用）
  }
  held.set(workspaceDir, next);
  return next;
}

/** 释放（仅本进程持有；他人/残留不动——活性检查兜底） */
export function releaseRuntime(workspaceDir: string): void {
  if (!held.has(workspaceDir)) return;
  held.delete(workspaceDir);
  try {
    const rec = readRuntime(workspaceDir);
    if (rec && rec.pid === process.pid) fs.unlinkSync(runtimeFilePath(workspaceDir));
  } catch { /* 文件已不存在 */
  }
}

// ---- 旧 timer-instance.lock 迁移 shim ----

/** 读旧锁持有者（旧版本进程不写 .runtime 但占定时锁；门禁需可见） */
export function legacyTimerHolder(workspaceDir: string): { alive: boolean; pid?: number; startedAt?: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workspaceDir, LEGACY_TIMER_LOCK), 'utf8')) as { pid?: number; startedAt?: string };
    if (!Number.isInteger(raw?.pid)) return null;
    return { alive: isProcessAlive(raw.pid!), pid: raw.pid, startedAt: raw.startedAt };
  } catch {
    return null;
  }
}

/** 死持有者的旧锁顺手清理（acquire 成功后调用；活的保留——它还在跑） */
function cleanLegacyLockIfStale(workspaceDir: string): void {
  try {
    const legacy = legacyTimerHolder(workspaceDir);
    if (legacy && !legacy.alive) fs.unlinkSync(path.join(workspaceDir, LEGACY_TIMER_LOCK));
  } catch { /* 清理失败无害 */
  }
}

/** 人类可读描述（错误提示/日志用） */
export function describeRuntime(rec: RuntimeRecord): string {
  return `pid=${rec.pid} kind=${rec.kind}` +
    (rec.port ? ` port=${rec.port}` : '') +
    (rec.profile && rec.profile !== rec.kind ? ` profile=${rec.profile}` : '') +
    (rec.startedAt ? ` started=${rec.startedAt}` : '');
}
