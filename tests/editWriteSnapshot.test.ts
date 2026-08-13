// ============================================================
// write 工具 → hashline 快照同步回归测试
//
// 背景（2026-08-12 edit 社区实测发现）：deloitte-dev-kic 在 write 覆盖
// 文件后直接用上一轮 read 的 TAG 发起 edit，报「Hashline TAG 不匹配：
// "#c4d8" vs 当前 "#c4d8"」——两个值完全相同却报不匹配，且 read 后重发
// 即成功。根因：makeWriteTool 写文件后未调用 recordSnapshot，快照仍为
// write 前的旧内容；verifySnapshot 的 `snapshot.tag === tag` 失败，但
// 报错文案显示的是「请求 TAG vs 磁盘当前哈希」（两者相同），误导用户
// 以为是哈希计算 bug。修复：write 成功后同步 recordSnapshot。
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { makeWriteTool } from '@plugins/builtin/tools/files';
import { makeEditTool } from '@plugins/builtin/tools/edit/tool';
import { recordSnapshot, clearSnapshot, verifySnapshot, verifySnapshotDetailed, getSnapshot } from '@plugins/builtin/tools/edit/hashline-snapshot';
import { computeFileHash } from '@plugins/builtin/tools/shared';
import type { AgentConfig } from '@agents/config';

describe('write 工具同步 hashline 快照（P0-2 回归修复）', () => {
  const dir = path.resolve('workspace/default');
  const rel = '__snap_write_test.md';
  const file = path.join(dir, rel);
  const writeTool = makeWriteTool({ agent_id: 'test', name: 'Test' } as AgentConfig);

  const oldContent = '# Old\nline2\nline3\nline4\n';
  const newContent = '# Edit Test\nHello "world" - it\'s a test line.\nSecond line.\nThird line.\n';

  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, oldContent);
    recordSnapshot(file, oldContent); // 模拟 write 前 read 过旧内容（快照为旧哈希）
  });

  afterEach(() => {
    clearSnapshot(file);
    fs.rmSync(file, { force: true });
  });

  it('write 后快照同步为新内容哈希（修复核心）', async () => {
    const res = await writeTool.execute({ path: rel, content: newContent }, undefined as any);
    expect(JSON.parse(res).status).toBe('ok');

    const newTag = computeFileHash(newContent);
    // 修复前：快照仍是 oldContent 的哈希 → verifySnapshot 返回 false（同值误报场景）
    // 修复后：快照已同步 → verifySnapshot 返回 true
    expect(verifySnapshot(file, newTag, newContent)).toBe(true);
    // 快照内容也是新内容
    expect(getSnapshot(file)?.content).toBe(newContent.replace(/\r\n/g, '\n'));
  });

  it('write 后 edit 用新 TAG 不再被误拒（端到端复现 deloitte 场景）', async () => {
    await writeTool.execute({ path: rel, content: newContent }, undefined as any);
    const newTag = computeFileHash(newContent);
    // 这正是 deloitte 报错的 verifySnapshot 调用：请求 TAG 与磁盘哈希相同
    // 但快照若未同步（旧快照），snapshot.tag === tag 为 false → 误报
    expect(verifySnapshot(file, newTag, newContent)).toBe(true);
  });

  it('write 后旧快照被正确覆盖（edit 用旧 TAG 仍会被拒绝）', async () => {
    await writeTool.execute({ path: rel, content: newContent }, undefined as any);
    const oldTag = computeFileHash(oldContent);
    // write 后快照是新内容，用旧 TAG（oldContent 哈希）校验 → 应拒绝（保护语义保留）
    expect(verifySnapshot(file, oldTag, newContent)).toBe(false);
  });
});

// ============================================================
// JSON 路径 edit 后快照同步（P0-6 同族：edit 写文件后快照必须跟随）
// ============================================================

describe('JSON edit 后同步 hashline 快照（连续编辑不被误拒）', () => {
  const dir = path.resolve('workspace/default');
  const rel = '__snap_edit_sync.md';
  const file = path.join(dir, rel);
  const editTool = makeEditTool({ agent_id: 'test', name: 'Test' } as AgentConfig);

  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, 'a\nb\nc\nd\n');
    recordSnapshot(file, 'a\nb\nc\nd\n'); // 模拟 read
  });

  afterEach(() => {
    clearSnapshot(file);
    fs.rmSync(file, { force: true });
  });

  it('第一次 edit 改变行数后，第二次裸行号编辑仍命中目标行', async () => {
    // 第一次：行 2 → 两行（行数 +1）
    const r1 = await editTool.execute(
      { edits: [{ filePath: rel, pos: '2', newText: 'B1\nB2' }] },
      undefined as any,
    );
    expect(JSON.parse(r1).status).toBe('success');
    // 修复前：快照仍为 a/b/c/d，第二次 pos=4 从旧快照解析（d）与磁盘（c）不符 → 误拒
    // 修复后：快照已同步，pos=4 = 原第 3 行 c → 命中
    const r2 = await editTool.execute(
      { edits: [{ filePath: rel, pos: '4', newText: 'C!' }] },
      undefined as any,
    );
    expect(JSON.parse(r2).status).toBe('success');
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nB1\nB2\nC!\nd\n');
  });

  it('edit 后快照内容与磁盘一致', async () => {
    await editTool.execute(
      { edits: [{ filePath: rel, pos: '2', newText: 'X' }] },
      undefined as any,
    );
    expect(getSnapshot(file)?.content).toBe('a\nX\nc\nd\n');
  });
});

// ============================================================
// verifySnapshotDetailed 诊断：区分失败原因（消除"同值误报"困惑）
// ============================================================

describe('verifySnapshotDetailed 失败原因诊断', () => {
  const file = path.join(tmpdir(), `agentchat-snap-diag-${Date.now()}.md`);
  const oldContent = 'a\nb\nc\n';

  beforeEach(() => {
    fs.writeFileSync(file, oldContent);
  });

  afterEach(() => {
    clearSnapshot(file);
    fs.rmSync(file, { force: true });
  });

  it('无快照 + 磁盘哈希不匹配 → no-snapshot', () => {
    const tag = computeFileHash(oldContent);
    const disk = 'a\nX\nc\n';
    const r = verifySnapshotDetailed(file, tag, disk);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-snapshot');
  });

  it('快照与请求 TAG 不一致（快照过期/写改写未同步）→ snapshot-mismatch', () => {
    recordSnapshot(file, oldContent);
    const newTag = computeFileHash('a\nb\nc\nd\n'); // 与快照不同的 TAG
    const r = verifySnapshotDetailed(file, newTag, oldContent);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('snapshot-mismatch');
      expect(r.snapshotTag).toBe(computeFileHash(oldContent));
    }
  });

  it('快照 TAG = 请求 TAG 但磁盘内容已变 → disk-changed', () => {
    recordSnapshot(file, oldContent);
    const tag = computeFileHash(oldContent);
    fs.writeFileSync(file, 'a\nX\nc\n'); // 外部并发修改
    const r = verifySnapshotDetailed(file, tag, 'a\nX\nc\n');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('disk-changed');
      expect(r.diskHash).toBe(computeFileHash('a\nX\nc\n'));
    }
  });

  it('快照与磁盘均匹配 → ok', () => {
    recordSnapshot(file, oldContent);
    const tag = computeFileHash(oldContent);
    expect(verifySnapshotDetailed(file, tag, oldContent)).toEqual({ ok: true });
  });
});
