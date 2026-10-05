// ============================================================
// data-root-lock.ts —— 数据根跨进程独占锁（纯函数，可独立单测）
//
// 动机（2026-09-25 fcdd8a8a 会话数据污染事故）：agent 在会话内用 pwsh
// 拉起第二 host 实例（bootTree 测试宿主）跑集成验证，AGENTCHAT_DATA_ROOT
// 随环境继承——两进程并发持有同一 sessions 目录：测试进程 probeNextSeq 从
// 主进程未 durable 的旧末行续号、recoverJournal 把主进程在途 run 误判
// 孤儿并物化第二份收束行，会话文件出现双段 seq 与重复 run-settled。
// 静默并发比崩溃更危险——本锁 fail-loud：活进程持锁时构造直接抛错。
//
// 语义：
//   · 锁文件 <root>/.data-root.lock，内容 JSON {pid, bootMs}
//   · acquire：无锁文件 / 持锁进程已死（pid 不活）→ 写入自己的 pid 获锁；
//     活进程持锁 → 抛错（消息含持锁 pid 与数据根路径）
//   · release：锁内容仍是自己的 pid 才删（幂等；他人接手后不误删）
//   · 进程死亡 → 锁文件残留但 pid 已死 → 下一实例自然回收（陈旧锁自愈）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 锁文件内容（持锁进程身份） */
export interface DataRootLockInfo {
  pid: number;
  bootMs: number;
}

/** Windows 与 POSIX 通用的进程存活探测（EVTHLN 部分 = 进程对象存在即活） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM：进程存在但无权限发信号（不同用户的进程）——仍视为活
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读锁文件（缺席/损坏 = null） */
function readLock(file: string): DataRootLockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<DataRootLockInfo>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return { pid: parsed.pid, bootMs: typeof parsed.bootMs === 'number' ? parsed.bootMs : 0 };
  } catch {
    return null;
  }
}

/** 进程内 per-root 持有计数（同 pid 多次 acquire = 多 Fiber 各持一份引用） */
const heldRoots = new Map<string, number>();

/**
 * 获取数据根独占锁（目录会按需创建）。返回释放函数（幂等）。
 * 活进程持锁 → 抛错（fail-loud——启动期可见，优于静默并发写坏会话文件）。
 * 同进程重复 acquire（测试内多 Fiber 同 root）→ 允许，引用计数管理，
 * 最后一个 release 才删锁文件——早卸载的 Fiber 不会把在跑实例的锁拆掉。
 */
export function acquireDataRootLock(root: string, opts: { pid?: number; now?: number } = {}): () => void {
  const pid = opts.pid ?? process.pid;
  const file = path.join(root, '.data-root.lock');
  fs.mkdirSync(root, { recursive: true });
  const held = readLock(file);
  if (held !== null && held.pid !== pid && isAlive(held.pid)) {
    throw new Error(
      `数据根已被进程 ${held.pid} 独占（${root}）——同一数据根禁止多进程并发写。`
      + '测试/验证实例请将 AGENTCHAT_DATA_ROOT 指向独立临时目录（如 sandbox/test-home-<n>）',
    );
  }
  // 无锁 / 陈旧锁（持锁进程已死）/ 本进程复入 → 获锁（首获写身份，复入只计数）
  if ((heldRoots.get(file) ?? 0) === 0) {
    const info: DataRootLockInfo = { pid, bootMs: opts.now ?? Date.now() };
    const tmp = `${file}.${pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(info), 'utf-8');
    fs.renameSync(tmp, file);
  }
  heldRoots.set(file, (heldRoots.get(file) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (heldRoots.get(file) ?? 0) - 1;
    if (n > 0) {
      heldRoots.set(file, n);
      return;
    }
    heldRoots.delete(file);
    const cur = readLock(file);
    if (cur !== null && cur.pid === pid) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 释放失败只留孤儿锁文件，下次启动按陈旧锁回收，无碍
      }
    }
  };
}
