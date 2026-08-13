// ============================================================
// hashline-snapshot.ts —— 文件快照存储
//
// read 时记录文件快照（路径 → TAG + 内容），
// edit 时通过 TAG 验证文件未被外部修改。
//
// 模块级 Map，进程生命周期内有效（重启后清空，无持久化）。
// ============================================================

import { computeFileHash } from '../shared';

interface Snapshot {
  tag: string;
  content: string;
}

const snapshots = new Map<string, Snapshot>();

/**
 * 记录文件快照，返回 TAG。
 * 内容会被归一化（\r\n → \n）以保证跨平台哈希一致。
 */
export function recordSnapshot(absPath: string, rawContent: string): string {
  const normalized = rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const tag = computeFileHash(normalized);
  snapshots.set(absPath, { tag, content: normalized });
  return tag;
}

/** 快照验证失败原因（供报错诊断区分场景） */
export type SnapshotVerifyFailure =
  | { reason: 'no-snapshot'; diskHash: string }
  | { reason: 'snapshot-mismatch'; snapshotTag: string; diskHash: string }
  | { reason: 'disk-changed'; snapshotTag: string; diskHash: string };

/**
 * 详细验证文件当前内容是否匹配指定 TAG，区分失败原因：
 *   - no-snapshot：无 read 快照，且磁盘哈希 ≠ 请求 TAG
 *   - snapshot-mismatch：快照 TAG ≠ 请求 TAG（快照过期，如 write/改写后快照未同步）
 *   - disk-changed：快照 TAG = 请求 TAG，但磁盘内容已变（外部并发修改）
 * @returns { ok: true } 或 { ok: false, reason, ... }
 */
export function verifySnapshotDetailed(
  absPath: string, tag: string, currentContent: string,
): { ok: true } | ({ ok: false } & SnapshotVerifyFailure) {
  const diskHash = computeFileHash(currentContent);
  const snapshot = snapshots.get(absPath);
  if (!snapshot) {
    return diskHash === tag
      ? { ok: true }
      : { ok: false, reason: 'no-snapshot', diskHash };
  }
  if (snapshot.tag !== tag) {
    return { ok: false, reason: 'snapshot-mismatch', snapshotTag: snapshot.tag, diskHash };
  }
  if (diskHash !== tag) {
    return { ok: false, reason: 'disk-changed', snapshotTag: snapshot.tag, diskHash };
  }
  return { ok: true };
}

/**
 * 验证文件当前内容是否匹配指定 TAG。
 * @returns true 表示文件未变，false 表示文件已被修改。
 */
export function verifySnapshot(absPath: string, tag: string, currentContent: string): boolean {
  return verifySnapshotDetailed(absPath, tag, currentContent).ok;
}

/**
 * 获取快照内容（用于并发修改后的恢复/诊断）。
 * 返回 undefined 表示无快照。
 */
export function getSnapshot(absPath: string): Snapshot | undefined {
  return snapshots.get(absPath);
}

/** 清除指定文件的快照 */
export function clearSnapshot(absPath: string): void {
  snapshots.delete(absPath);
}

/** 更新快照（edit / write 成功后调用） */
export function updateSnapshot(absPath: string, newContent: string): string {
  return recordSnapshot(absPath, newContent);
}
