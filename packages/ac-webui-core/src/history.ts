// ============================================================
// history.ts —— 历史读 watch 投影面
//
// · watchLedger：fs.watch 投影面（messages.jsonl 追加事件 → 回调；
//   目录 watch——首建文件与追加都触发；size 增长判定防抖）
// （readLedgerFrom 增量读与 listSessions 列表索引已随 cr-957 删除——生产零消费）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
export interface WatchHandle {
  close(): void;
}

/**
 * watch 单个账本目录的 messages.jsonl（追加事件 → 回调）。
 * fs.watch 事件名跨平台不稳定（rename/change/partial）——统一按
 * "有新字节"判定：每次事件读 stat，size 增长才触发（防抖本源）。
 * 目录 watch（非文件 watch——追加写场景下文件 inode 稳定，但目录
 * watch 对首建文件同样触发，会话首行不漏）。
 */
export function watchLedger(dir: string, onChange: () => void): WatchHandle {
  const file = path.join(dir, 'messages.jsonl');
  let lastSize = statSize(file);
  let timer: NodeJS.Timeout | null = null;
  const watcher = fs.watch(dir, { persistent: false }, () => {
    // 事件合并（Windows 高频 partial 事件）
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const size = statSize(file);
      if (size > lastSize) {
        lastSize = size;
        onChange();
      }
    }, 50);
  });
  watcher.on('error', () => watcher.close());
  return { close: () => { if (timer !== null) clearTimeout(timer); watcher.close(); } };
}

function statSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
