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

/**
 * 验证文件当前内容是否匹配指定 TAG。
 * @returns true 表示文件未变，false 表示文件已被修改。
 */
export function verifySnapshot(absPath: string, tag: string, currentContent: string): boolean {
  const snapshot = snapshots.get(absPath);
  if (!snapshot) {
    // 无快照：直接计算当前文件的哈希
    return computeFileHash(currentContent) === tag;
  }
  // 有快照：快照 TAG 与请求 TAG 一致，且当前内容哈希仍等于请求 TAG。
  // 否则文件在 read 后被外部修改（快照 TAG 仍旧，但磁盘内容已变），
  // 不能基于旧行号静默应用——否则行号全部偏移、改错位置。
  return snapshot.tag === tag && computeFileHash(currentContent) === tag;
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
