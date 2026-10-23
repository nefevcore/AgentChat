// ============================================================
// archive.ts —— 账本归档物理面助手（D11：archive 全壳内；归档重建
// 的写半边 = LedgerWriter.compact〔writer.ts〕，本模块持分段/锚词汇）
//
// 归档分段：sessions/<uuid>/archive/history_N.jsonl + 尾锚 sidecar
//（末段末行 seq/message_id——二次归档去重锚，O(1) 免内容比对，
// 主线 M21 步骤 7 / D8 同语义）。概要 = summary.md（单文件单源，
// 回放注入与 webui 读面同源——historyFor 概要头）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 归档重写参数（writer.compact 消费——archive 行编排组装） */
export interface CompactOptions {
  /** 归档分段（archive 区间行——写入 archive/history_N.jsonl；空数组 = 只滚动概要） */
  archive: unknown[];
  /** 尾部保留（keep 区间行——重写后账本主体） */
  keep: unknown[];
  /** B1 窗口基线（compact 快照的 maxSeq——之后新落账行由 compact 重读并入） */
  baselineSeq: number | undefined;
  /** 滚动概要（undefined = 概要不动） */
  summary?: string;
}

/** 归档重写结果 */
export interface CompactReport {
  archived: number;
  kept: number;
  segment?: string;
}

/** 下一段分段名（history_1..N 扫描取最大 + 1） */
export function nextSegmentName(sessionDir: string): string {
  let max = 0;
  try {
    for (const name of fs.readdirSync(archiveDirOf(sessionDir))) {
      const m = /^history_(\d+)\.jsonl$/.exec(name);
      if (m !== null) max = Math.max(max, Number(m[1]));
    }
  } catch {
    // 目录缺席 = 首段
  }
  return 'history_' + (max + 1) + '.jsonl';
}

export function archiveDirOf(sessionDir: string): string {
  return path.join(sessionDir, 'archive');
}

/** 尾锚（.archive-anchor.json——末段末行 seq/message_id；二次归档去重） */
export interface ArchiveAnchor {
  conversationId: string;
  seq?: number;
  messageId?: string;
}

export function readAnchor(sessionDir: string): ArchiveAnchor | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(archiveDirOf(sessionDir), '.archive-anchor.json'), 'utf-8')) as ArchiveAnchor;
  } catch {
    return null;
  }
}

export function writeAnchor(sessionDir: string, anchor: ArchiveAnchor): void {
  const file = path.join(archiveDirOf(sessionDir), '.archive-anchor.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(anchor), 'utf-8');
  fs.renameSync(tmp, file);
}
