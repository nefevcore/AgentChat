// ============================================================
// ac-plugin-core/src/fsx.ts —— 文件域工程语义（M23 P1b：F5/G10）
//
// 安装态文件域的原子性与串行化原语：
//   · atomicWriteFile：tmp + rename 原子写（防半写文件）
//   · renameWithRetry：Windows EBUSY/EACCES/EPERM 退避重试
//     （复用 include vendor 的 retry 语义，不 import vendor——纯库零依赖）
//   · withRootLock：同数据根的全部 mutation 共用一个进程内串行队列
//     （防 F6 可补偿分步落地后跨 await 交错写；跨进程保护靠原子 rename
//     不产生撕裂文件，完整互斥不在本期范围）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Windows 文件被占用时的 rename 错误码（include vendor 同款判定） */
function isTransientRenameError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM';
}

const RENAME_MAX_RETRIES = 10;
const RENAME_BACKOFF_MS = 25;

/** rename + Windows 瞬时占用退避重试（上限 10 次） */
export function renameWithRetry(src: string, dest: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err: unknown) {
      if (!isTransientRenameError(err) || attempt >= RENAME_MAX_RETRIES) throw err;
      const delay = RENAME_BACKOFF_MS * (attempt + 1);
      const wakeup = Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      if (wakeup !== 'timed-out') {
        /* Atomics.wait 不可用（如浏览器垫片）→ 直接重试 */
      }
    }
  }
}

/** 原子写文件：tmp 同目录写 + rename（retry）；调用方保证目录存在 */
export function atomicWriteFile(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  try {
    renameWithRetry(tmp, file);
  } catch (err: unknown) {
    // rename 失败（如 Windows 目标只读）：清掉 tmp 残留再抛（F6 补偿不留半成品文件）
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw err;
  }
}

// ============================================================
// 串行队列（per 数据根）
// ============================================================

/** 进程内串行队列：任务首尾相接执行，返回值透传 */
export interface SerialQueue {
  run<T>(task: () => T | Promise<T>): Promise<T>;
  /** 当前队列长度（诊断用） */
  readonly pending: number;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let depth = 0;
  return {
    get pending() {
      return depth;
    },
    run<T>(task: () => T | Promise<T>): Promise<T> {
      const result = tail.then(task, task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      depth++;
      const done = () => {
        depth--;
      };
      result.then(done, done);
      return result;
    },
  };
}

const queues = new Map<string, SerialQueue>();

/** 同一数据根（按 plugins 根解析）共用一个串行队列 */
export function queueForRoot(root: string): SerialQueue {
  const key = path.resolve(root, 'plugins').toLowerCase();
  let queue = queues.get(key);
  if (!queue) {
    queue = createSerialQueue();
    queues.set(key, queue);
  }
  return queue;
}

/** 在数据根串行队列内执行（全 registry mutation 入口 + patch 写共用） */
export function withRootLock<T>(root: string, task: () => T | Promise<T>): Promise<T> {
  return queueForRoot(root).run(task);
}

/** 测试辅助：清空队列注册表（隔离用例间的队列共享） */
export function resetQueuesForTest(): void {
  queues.clear();
}
