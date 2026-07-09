// ============================================================
// file-mutation-queue.ts —— 文件写入并发安全
//
// 当 LLM 在 parallel 模式下同时发起多个 edit 调用时，
// 确保同一文件的写操作被串行化，不同文件仍然并行。
//
// 设计要点：
//   1. 基于 Promise 链的无锁串行化
//   2. realpath 解析，确保不同路径形式指向同一文件时用同一把锁
//   3. 自动清理：没有后续排队时删除 Map 条目
//   4. 不同文件仍然并行 —— 只有同一文件的操作才串行
// ============================================================

import * as fs from 'fs';

const fileMutationQueues = new Map<string, Promise<void>>();

/**
 * 获取文件的规范化路径作为队列 key。
 * 使用 realpathSync 解析符号链接，确保 ./src/foo.ts 和 ../project/src/foo.ts
 * 如果指向同一文件，共享同一把锁。
 */
function getMutationQueueKey(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    // 文件可能尚不存在（write 工具创建新文件），回退到绝对路径
    return filePath;
  }
}

/**
 * 对同一文件的写操作串行化执行。
 *
 * @param filePath - 目标文件路径
 * @param fn - 要执行的写操作
 * @returns fn 的返回值
 */
export async function withFileMutationQueue<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = getMutationQueueKey(filePath);
  const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

  let releaseNext!: () => void;
  const nextQueue = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });

  const chainedQueue = currentQueue.then(() => nextQueue);
  fileMutationQueues.set(key, chainedQueue);

  await currentQueue; // 等待前一个操作完成

  try {
    return await fn(); // 执行本次操作
  } finally {
    releaseNext(); // 释放锁，让下一个操作开始
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key); // 清理：没有后续排队时删除条目
    }
  }
}
