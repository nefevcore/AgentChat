// ============================================================
// project.ts —— user 终稿层读时投影（cr-973 / cr-972 第一刀）
//
// viewer 物化账本（cr-698）退役：终稿层不再是落盘派生物，而是账本的
// 纯读时投影。cr-1344（user 域对称化）：谓词单源归 foldUserReplay
//（ac-ledger-core fold-core——user 域 agent 行投 peer 且同键优先、
// agent 域自著行原谓词），本文件降为薄包装——两实现并源防走散。
// ============================================================
import { foldSession } from './fold.ts';
import { foldUserReplay } from 'ac-ledger-core/src/fold-core.ts';
import type { UserReplayRow } from './user.ts';

/**
 * user 视角终稿层投影（读时纯函数——cr-973 viewer 停写后的读面）。
 * 输入 = 全域账本（conversationDirs 对桶键双端并读，行时间戳归并）。
 */
export function projectUserReplay(dataRoot: string, uuid: string): UserReplayRow[] {
  return foldUserReplay(foldSession(dataRoot, uuid));
}
